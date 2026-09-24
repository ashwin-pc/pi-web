import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { AdapterCreateInput, AdapterOpenInput, AdapterPromptInput, AdapterSessionInfo, SessionAdapter, SessionHandle } from "../../adapter.js";
import { jsonRoundTrip, type ActiveExecutionDto, type HarnessCapabilitiesDto, type InteractionRequestDto, type InteractionResponseDto, type InterruptReceiptDto, type JsonValue, type MessageDto, type MessagePartDto, type NativeSessionRefDto, type PromptReceiptDto, type SessionServiceEvent, type SessionSnapshotDto, type TranscriptMessageDto } from "../../dto.js";
import { codexApproval, unsupportedControlResponse, type CodexApproval } from "./approvals.js";
import { itemMessageId, projectItem } from "./projection.js";
import { CodexRpcError, CodexTransport, diagnostic, object, type CodexLaunchOptions, type NativeObject, type NativeRequest, type RpcId } from "./transport.js";

const capabilities: HarnessCapabilitiesDto = {
  harness: "codex", queue: false, steering: false, followUp: false, thinkingLevel: false,
  tree: false, compaction: false, retry: false, bash: false, extensions: false, interactions: true,
  models: false, context: false, attachments: false, historyFork: false,
};
export interface CodexAdapterOptions extends Omit<CodexLaunchOptions, "cwd"> { interactionTimeoutMs?: number }
type Turn = { executionId?: string; status: "inProgress" | "completed" | "interrupted" | "failed" };
type Item = { native: NativeObject; timestamp?: string; completed: boolean };
type PendingControl = { native: NativeRequest; turnId: string; approval: CodexApproval; request: InteractionRequestDto; timer: ReturnType<typeof setTimeout> };
const requestKey = (id: RpcId): string => `${typeof id}:${id}`;
const emptyStats = (): SessionSnapshotDto["stats"] => ({ userMessages: 0, assistantMessages: 0, toolResults: 0, totalMessages: 0 });

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value.length > 4_096) throw new CodexRpcError(`Invalid Codex ${field}`, "protocol");
  return value;
}
function nativeThread(response: unknown): NativeObject {
  const thread = object(object(response)?.thread);
  if (!thread) throw new CodexRpcError("Codex did not return thread metadata", "protocol");
  requiredString(thread.id, "thread ID");
  if (typeof thread.ephemeral !== "boolean") throw new CodexRpcError("Codex did not expose native persistence", "protocol");
  return thread;
}
async function initialize(rpc: CodexTransport): Promise<void> {
  const result = object(await rpc.request("initialize", {
    clientInfo: { name: "pi_web", title: "Pi Web", version: "0.6.0" },
    // Negotiates approval choices/context, not native configuration or new public endpoints.
    capabilities: { experimentalApi: true, requestAttestation: false },
  }));
  if (!result || typeof result.userAgent !== "string" || !/\b0\.154\.0\b/.test(result.userAgent)) {
    throw new CodexRpcError("This integration is validated for Codex app-server 0.154.0; check the installed protocol version", "protocol");
  }
  rpc.notify("initialized");
}

class CodexHandle implements SessionHandle {
  readonly harnessId = "codex" as const;
  readonly sessionId: string;
  private snapshot: SessionSnapshotDto;
  private rpc?: CodexTransport;
  private readonly listeners = new Set<(event: SessionServiceEvent) => void>();
  private readonly transcript = new Map<string, TranscriptMessageDto>();
  private readonly items = new Map<string, Item>();
  private readonly turns = new Map<string, Turn>();
  private readonly controls = new Map<string, PendingControl>();
  private readonly nativeControlIds = new Map<string, string>();
  private readonly cancelledItems = new Set<string>();
  private readonly observations: JsonValue[] = [];
  private activeTurnId?: string;
  private threadStatus = "idle";
  private activeFlags: string[] = [];
  private submitting?: AdapterPromptInput;
  private disposing = false;

  constructor(private readonly cwd: string, sessionId: string, nativeSession: NativeSessionRefDto, private readonly options: CodexAdapterOptions) {
    this.sessionId = sessionId;
    this.snapshot = { cwd, sessionId, sessionTitle: "Codex session", harnessId: "codex", nativeSession,
      phase: "starting", activity: "idle", pendingInteractions: [], capabilities: { ...capabilities },
      isStreaming: false, isRetrying: false, isCompacting: false, stats: emptyStats() };
  }

  async start(input: AdapterCreateInput | AdapterOpenInput): Promise<this> {
    if ("nativeSession" in input && (input.nativeSession.persistence === "ephemeral" || !input.nativeSession.sessionId)) {
      this.unavailable("This ephemeral Codex session expired with its native process. Remove it or create a new session.");
      return this;
    }
    this.rpc = new CodexTransport({ ...this.options, cwd: this.cwd }, {
      notification: (message) => this.notification(message.method, message.params),
      request: (message) => this.requiredControl(message),
      closed: (error) => this.unavailable(error.message),
      observation: (kind, bytes) => this.observe(kind, undefined, bytes),
    });
    try {
      await initialize(this.rpc);
      const opening = "nativeSession" in input;
      const response = await this.rpc.request(opening ? "thread/resume" : "thread/start", opening
        ? { threadId: input.nativeSession.sessionId }
        : { cwd: this.cwd, ...(input.persistence ? { ephemeral: input.persistence === "ephemeral" } : {}) });
      const thread = nativeThread(response);
      if (opening && thread.id !== input.nativeSession.sessionId) throw new CodexRpcError("Codex resumed a different native thread", "protocol");
      this.hydrate(thread, object(response)!, opening);
      return this;
    } catch (error) {
      this.unavailable(error instanceof Error ? error.message : "Could not open Codex");
      await this.rpc.dispose();
      if (!("nativeSession" in input)) throw error;
      return this;
    }
  }

  state(): SessionSnapshotDto {
    return jsonRoundTrip({ ...this.snapshot, pendingInteractions: [...this.controls.values()].map((control) => control.request) });
  }
  async messages(): Promise<MessageDto[]> { return jsonRoundTrip([...this.transcript.values()]); }
  subscribe(listener: (event: SessionServiceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async prompt(input: AdapterPromptInput): Promise<PromptReceiptDto> {
    const rpc = this.live();
    if (input.mode !== "prompt") throw new Error(`Codex ${input.mode} input is not supported`);
    if (input.attachments.length) throw new Error("Codex attachments are not supported by this integration");
    if (!input.message.trim()) throw new Error("A Codex prompt must not be empty");
    if (this.submitting || this.snapshot.phase !== "idle" || this.activeTurnId) throw new Error("Codex is already active; concurrent prompts and steering are disabled");
    if (input.expectedExecutionId) throw new Error("Codex steering is disabled; an expected execution cannot start a new turn");
    this.submitting = input;
    this.snapshot.activeExecution = { id: input.executionId, owner: "host" };
    this.snapshot.phase = "starting";
    this.snapshot.activity = "working";
    delete this.snapshot.error;
    this.emitState();
    try {
      const result = object(await rpc.request("turn/start", {
        threadId: this.nativeId(), input: [{ type: "text", text: input.message, text_elements: [] }],
        ...(input.clientMessageId ? { clientUserMessageId: input.clientMessageId } : {}),
      }));
      const turn = object(result?.turn);
      const turnId = requiredString(turn?.id, "accepted turn ID");
      const existing = this.turns.get(turnId);
      if (!existing) this.turns.set(turnId, { executionId: input.executionId, status: "inProgress" });
      // Native events can precede this response, including a terminal event. Do not resurrect it.
      if (!existing || existing.status === "inProgress") {
        this.activeTurnId = turnId;
        this.snapshot.activeExecution = { id: input.executionId, owner: "host", nativeExecutionId: turnId };
        if (this.threadStatus === "idle") this.threadStatus = "active";
        this.reconcile();
      }
      return { sessionId: this.sessionId, executionId: input.executionId, acknowledgement: "accepted", nativeExecutionId: turnId };
    } catch (error) {
      if (error instanceof CodexRpcError && error.ambiguous && !rpc.closed) {
        // The request may have executed. Keep observed native state; never retry it automatically.
        if (!this.activeTurnId) {
          this.snapshot.phase = "error";
          this.snapshot.activity = "idle";
          delete this.snapshot.activeExecution;
        }
        this.snapshot.error = diagnostic(error.message);
        this.emitState();
        return { sessionId: this.sessionId, executionId: input.executionId, acknowledgement: "pending",
          ...(this.activeTurnId ? { nativeExecutionId: this.activeTurnId } : {}) };
      }
      if (!this.activeTurnId && this.state().phase !== "unavailable") {
        this.snapshot.phase = "idle"; this.snapshot.activity = "idle"; delete this.snapshot.activeExecution;
      }
      this.snapshot.error = diagnostic(error instanceof Error ? error.message : "Codex rejected the prompt");
      this.emitState();
      throw error;
    } finally { this.submitting = undefined; }
  }

  async interrupt(expectedExecutionId: string): Promise<InterruptReceiptDto> {
    const rpc = this.live();
    const execution = this.snapshot.activeExecution;
    const turnId = this.activeTurnId;
    if (!execution || execution.id !== expectedExecutionId || !turnId || this.turns.get(turnId)?.status !== "inProgress") {
      throw new Error("The Codex execution is no longer active; refresh before interrupting");
    }
    await rpc.request("turn/interrupt", { threadId: this.nativeId(), turnId });
    return { sessionId: this.sessionId, executionId: expectedExecutionId, nativeExecutionId: turnId, acknowledged: true };
  }

  respondInteraction(response: InteractionResponseDto): boolean {
    const pending = this.controls.get(response.id);
    if (!pending || response.sessionId !== this.sessionId || typeof response.choiceID !== "string"
      || Object.keys(response).some((key) => !["id", "sessionId", "choiceID"].includes(key))) return false;
    if (Date.parse(pending.request.expiresAt!) <= Date.now()) { this.cancelControl(response.id, "expired"); return false; }
    if (this.rpc?.closed || this.activeTurnId !== pending.turnId) return false;
    const result = pending.approval.responses.get(response.choiceID);
    if (!result) return false;
    try { this.rpc?.respond(pending.native.id, result); }
    catch { return false; }
    if (result.decision === "cancel") this.noteCancelledItem(pending);
    this.removeControl(response.id, "responded");
    return true;
  }

  cancelInteractions(reason: "timeout" | "disconnect" | "disposed"): void {
    for (const id of [...this.controls.keys()]) this.cancelControl(id, reason === "timeout" ? "expired" : reason === "disposed" ? "disposed" : "cancelled");
  }

  async dispose(): Promise<void> {
    if (this.disposing) return this.rpc?.dispose();
    this.disposing = true;
    this.cancelInteractions("disposed");
    await this.rpc?.dispose();
    this.listeners.clear();
  }

  private live(): CodexTransport {
    if (this.disposing || !this.rpc || this.rpc.closed || this.snapshot.phase === "unavailable") throw new Error(this.snapshot.error ?? "Codex is unavailable");
    return this.rpc;
  }
  private nativeId(): string { return requiredString(this.snapshot.nativeSession.sessionId, "thread ID"); }
  private emit(event: SessionServiceEvent): void {
    const wire = jsonRoundTrip(event);
    for (const listener of this.listeners) { try { listener(wire); } catch { /* Serving listeners are isolated. */ } }
  }
  private emitState(): void { this.emit({ type: "state", state: this.state() }); }

  private hydrate(thread: NativeObject, settings: NativeObject, opening: boolean): void {
    const id = requiredString(thread.id, "thread ID");
    const ephemeral = thread.ephemeral === true;
    this.snapshot.nativeSession = { harnessId: "codex", sessionId: id, persistence: ephemeral ? "ephemeral" : "persistent",
      status: ephemeral ? "live-only" : opening ? "resumable" : "unmaterialized" };
    const model = typeof settings.model === "string" ? settings.model : typeof thread.model === "string" ? thread.model : undefined;
    const provider = typeof settings.modelProvider === "string" ? settings.modelProvider : String(thread.modelProvider ?? "codex");
    const effort = typeof settings.reasoningEffort === "string" ? settings.reasoningEffort : undefined;
    if (typeof settings.cwd === "string") this.snapshot.cwd = settings.cwd;
    this.snapshot.nativeSettings = {
      ...(model ? { model } : {}), ...(effort ? { reasoningEffort: effort } : {}),
      ...(typeof settings.approvalPolicy === "string" ? { permissionMode: `${settings.approvalPolicy}${typeof settings.approvalsReviewer === "string" ? ` (${settings.approvalsReviewer})` : ""}` } : {}),
      ...(typeof object(settings.sandbox)?.type === "string" ? { sandboxMode: String(object(settings.sandbox)!.type) } : {}),
    };
    if (model) this.snapshot.model = { id: model, provider, name: model, reasoning: Boolean(effort) };
    if (typeof thread.name === "string") { this.snapshot.sessionName = thread.name; this.snapshot.sessionTitle = thread.name; }
    this.threadStatus = String(object(thread.status)?.type ?? "idle");
    if (Array.isArray(thread.turns)) for (const value of thread.turns) {
      const turn = object(value);
      if (!turn || typeof turn.id !== "string") continue;
      const status = this.turnStatus(turn.status);
      const active = status === "inProgress" && this.threadStatus === "active";
      this.turns.set(turn.id, { status, ...(active ? { executionId: randomUUID() } : {}) });
      if (active) this.activeTurnId = turn.id;
      if (Array.isArray(turn.items)) for (const value of turn.items) {
        const item = object(value);
        const completed = !active || item?.type === "userMessage" || ["completed", "failed", "declined"].includes(String(item?.status));
        this.updateItem(turn.id, item, completed, undefined, false);
      }
    }
    this.snapshot.phase = "idle";
    delete this.snapshot.error;
    this.reconcile();
  }

  private turnStatus(value: unknown): Turn["status"] {
    if (value === "inProgress" || value === "completed" || value === "interrupted" || value === "failed") return value;
    throw new CodexRpcError("Unknown required Codex turn status", "protocol");
  }

  private reconcile(): void {
    if (this.snapshot.phase === "unavailable") return;
    const active = this.activeTurnId ? this.turns.get(this.activeTurnId) : undefined;
    if (active?.status === "inProgress") {
      this.snapshot.activeExecution = { id: active.executionId!, owner: "host", nativeExecutionId: this.activeTurnId };
      this.snapshot.phase = this.threadStatus === "idle" ? "settling" : "running";
    } else {
      delete this.snapshot.activeExecution;
      this.snapshot.phase = this.threadStatus === "active" ? "settling" : this.threadStatus === "systemError" ? "error" : "idle";
    }
    this.snapshot.isStreaming = this.snapshot.phase === "running";
    this.snapshot.activity = this.controls.size || this.activeFlags.includes("waitingOnApproval") ? "waiting-approval"
      : this.activeFlags.includes("waitingOnUserInput") ? "waiting-input"
      : this.snapshot.isRetrying ? "retrying"
      : this.snapshot.phase === "idle" || this.snapshot.phase === "error" ? "idle" : "working";
    this.emitState();
  }

  private notification(method: string, value: unknown): void {
    const params = object(value);
    if (method === "thread/started") return; // Start/resume response is the initial identity authority.
    if (!params || params.threadId !== this.snapshot.nativeSession.sessionId) { this.observe(method, value); return; }
    if (method === "thread/status/changed") {
      const status = object(params.status);
      if (!status || !["idle", "active", "notLoaded", "systemError"].includes(String(status.type))) throw new CodexRpcError("Unknown required Codex thread state", "protocol");
      this.threadStatus = String(status.type);
      this.activeFlags = Array.isArray(status.activeFlags) ? status.activeFlags.filter((flag): flag is string => typeof flag === "string") : [];
      if (this.threadStatus === "notLoaded") { this.unavailable("Codex unloaded this native thread"); void this.rpc?.dispose(); }
      else this.reconcile();
      return;
    }
    if (method === "serverRequest/resolved") {
      const id = typeof params.requestId === "string" || typeof params.requestId === "number" ? this.nativeControlIds.get(requestKey(params.requestId)) : undefined;
      if (id) this.removeControl(id, "native");
      return;
    }
    if (method === "thread/closed") { this.unavailable("Codex closed this native thread"); void this.rpc?.dispose(); return; }
    if (method === "thread/tokenUsage/updated") { this.usage(object(params.tokenUsage)); return; }
    if (method === "turn/started") {
      const turn = object(params.turn);
      const id = requiredString(turn?.id, "turn ID");
      if (this.turns.get(id)?.status && this.turns.get(id)?.status !== "inProgress") { this.observe("late-turn-start", params); return; }
      this.turns.set(id, { status: "inProgress", executionId: this.turns.get(id)?.executionId ?? this.submitting?.executionId ?? randomUUID() });
      this.activeTurnId = id; this.threadStatus = "active"; this.snapshot.isRetrying = false;
      this.reconcile(); return;
    }
    if (method === "turn/completed") { this.completeTurn(object(params.turn)); return; }
    const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
    if (method === "error") {
      if (turnId && turnId !== this.activeTurnId) { this.observe("late-native-error", params); return; }
      this.snapshot.error = diagnostic(object(params.error)?.message);
      if (turnId === this.activeTurnId && params.willRetry === true) this.snapshot.isRetrying = true;
      this.emit({ type: "error", sessionId: this.sessionId, error: this.snapshot.error }); this.reconcile(); return;
    }
    if (!turnId || !this.turns.has(turnId) || this.turns.get(turnId)!.status !== "inProgress") { this.observe(`late-or-unbound:${method}`, params); return; }
    if (method === "item/started" || method === "item/completed") {
      this.updateItem(turnId, object(params.item), method === "item/completed", typeof params.startedAtMs === "number" ? new Date(params.startedAtMs).toISOString() : undefined);
      return;
    }
    if (method === "item/agentMessage/delta" || method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      this.textDelta(method, params, turnId); return;
    }
    if (method === "item/reasoning/summaryPartAdded") return; // A text delta supplies the actual native content.
    if (method === "item/commandExecution/outputDelta") {
      const itemId = requiredString(params.itemId, "item ID");
      const item = this.items.get(itemMessageId(turnId, itemId));
      if (!item || item.completed || typeof params.delta !== "string") { this.observe(method, params); return; }
      this.commandOutputDelta(turnId, itemId, item, params.delta); return;
    }
    if (method === "turn/plan/updated" || method === "turn/diff/updated") {
      const text = method === "turn/diff/updated" ? `Changes\n\`\`\`diff\n${typeof params.diff === "string" ? params.diff : ""}\n\`\`\``
        : `Plan\n${Array.isArray(params.plan) ? params.plan.map((step) => { const value = object(step); return `${String(value?.status ?? "pending")}: ${String(value?.step ?? "")}`; }).join("\n") : ""}`;
      const id = `codex:${turnId}:${method}`;
      const message: TranscriptMessageDto = { role: "system", id, nativeExecutionId: turnId, status: "completed", parts: [{ type: "text", id: `${id}:text`, text }], text };
      this.transcript.set(id, message); this.countMessages(); this.emit({ type: "message_replace", sessionId: this.sessionId, message, final: true }); return;
    }
    this.observe(method, params);
  }

  private updateItem(turnId: string, native: NativeObject | undefined, completed: boolean, timestamp?: string, publish = true): void {
    if (!native || typeof native.id !== "string") throw new CodexRpcError("Codex item has no identity", "protocol");
    const key = itemMessageId(turnId, native.id);
    const previous = this.items.get(key);
    if (previous?.completed) { this.observe("duplicate-item", { threadId: this.nativeId(), turnId }); return; }
    const observedAt = previous?.timestamp ?? timestamp ?? (publish ? new Date().toISOString() : undefined);
    const item: Item = { native: { ...previous?.native, ...native }, completed, ...(observedAt ? { timestamp: observedAt } : {}) };
    if (!completed && previous) for (const field of ["text", "aggregatedOutput", "summary", "content"]) {
      if (native[field] == null || native[field] === "" || (Array.isArray(native[field]) && !native[field].length)) item.native[field] = previous.native[field];
    }
    const mapped = projectItem(item.native, turnId, this.turns.get(turnId)?.executionId, item.timestamp, completed);
    if (!mapped) { if (publish) this.observe(`item:${String(item.native.type)}`, item.native); return; }
    // Unknown native variants are observed in bounded/redacted form, never retained as raw items.
    this.items.set(key, item);
    this.publishItem(turnId, item, completed, publish, mapped);
    if (native.type === "userMessage" && completed && this.snapshot.nativeSession.persistence === "persistent") {
      this.snapshot.nativeSession.status = "resumable";
      if (publish) this.emitState();
    }
  }

  private publishItem(turnId: string, item: Item, final: boolean, publish = true, mapped?: TranscriptMessageDto): void {
    const message = mapped ?? projectItem(item.native, turnId, this.turns.get(turnId)?.executionId, item.timestamp, final);
    if (!message) { if (publish) this.observe(`item:${String(item.native.type)}`, item.native); return; }
    if (item.native.status === "declined" && this.cancelledItems.has(message.id)) {
      message.status = "interrupted";
      for (const part of message.parts) if (part.type === "toolCall") part.status = "cancelled";
    }
    const previous = this.transcript.get(message.id);
    this.transcript.set(message.id, message);
    this.countMessages();
    if (!publish) return;
    const correlation = { sessionId: this.sessionId, executionId: message.executionId, nativeExecutionId: turnId, nativeItemId: message.nativeItemId,
      ...(typeof item.native.clientId === "string" ? { clientMessageId: item.native.clientId } : {}),
      ...(this.submitting?.sourceClientId ? { sourceClientId: this.submitting.sourceClientId } : {}) };
    if (!previous) this.emit({ ...correlation, type: "message_start", message });
    if (final || previous) this.emit({ ...correlation, type: "message_replace", message, final });
  }

  private commandOutputDelta(turnId: string, itemId: string, item: Item, delta: string): void {
    const messageId = itemMessageId(turnId, itemId);
    const message = this.transcript.get(messageId);
    const index = message?.parts.findIndex((part) => part.type === "toolCall") ?? -1;
    const tool = message?.parts[index];
    if (!message || tool?.type !== "toolCall") throw new CodexRpcError("Codex command output has no tool part", "protocol");
    if (!tool.result) {
      tool.result = { parts: [{ type: "text", id: `${messageId}:result`, text: "", nativeItemId: itemId, nativeExecutionId: turnId }], isError: false };
      this.emit({ type: "message_part", sessionId: this.sessionId, messageId, index, part: tool });
    }
    const text = tool.result.parts.find((part) => part.type === "text");
    if (!text || text.type !== "text") throw new CodexRpcError("Codex command output changed result kind", "protocol");
    text.text += delta;
    item.native.aggregatedOutput = text.text;
    // The same stable message/part delta reaches nested tool-result text. Only the
    // final item sends its authoritative aggregate; each chunk is not a prefix resend.
    this.emit({ type: "message_delta", sessionId: this.sessionId, executionId: message.executionId, nativeExecutionId: turnId,
      nativeItemId: itemId, messageId, partId: text.id, delta });
  }

  private textDelta(method: string, params: NativeObject, turnId: string): void {
    const itemId = requiredString(params.itemId, "item ID");
    if (typeof params.delta !== "string") throw new CodexRpcError("Invalid Codex text delta", "protocol");
    const reasoning = method !== "item/agentMessage/delta";
    const index = reasoning ? (method === "item/reasoning/textDelta" ? params.contentIndex : params.summaryIndex) : 0;
    if (reasoning && (!Number.isSafeInteger(index) || Number(index) < 0 || Number(index) > 100)) throw new CodexRpcError("Invalid Codex reasoning part index", "protocol");
    const key = itemMessageId(turnId, itemId);
    let item = this.items.get(key);
    if (!item) { this.updateItem(turnId, { type: reasoning ? "reasoning" : "agentMessage", id: itemId, text: "", summary: [], content: [] }, false); item = this.items.get(key)!; }
    if (item.completed) { this.observe("late-text-delta", params); return; }
    const message = this.transcript.get(key);
    if (!message) { this.observe("unmapped-text-delta", params); return; }
    const field = !reasoning ? "text" : method === "item/reasoning/textDelta" ? "content" : "summary";
    const partId = `${key}:${reasoning ? `${field}:${index}` : "text"}`;
    let part: MessagePartDto | undefined = message.parts.find((entry) => entry.id === partId);
    if (!part) {
      const created: MessagePartDto = { type: reasoning ? "thinking" : "text", id: partId, text: "", nativeItemId: itemId, nativeExecutionId: turnId };
      message.parts.push(created);
      this.emit({ type: "message_part", sessionId: this.sessionId, messageId: key, index: message.parts.length - 1, part: created });
      part = created;
    }
    if (!part || (part.type !== "text" && part.type !== "thinking")) throw new CodexRpcError("Codex delta changed item kind", "protocol");
    part.text += params.delta;
    if (!reasoning) { item.native.text = part.text; message.text = part.text; }
    else {
      const values = Array.isArray(item.native[field]) ? item.native[field] as string[] : [];
      while (values.length <= Number(index)) values.push("");
      values[Number(index)] = part.text; item.native[field] = values;
    }
    this.emit({ type: "message_delta", sessionId: this.sessionId, executionId: message.executionId, nativeExecutionId: turnId, nativeItemId: itemId, messageId: key, partId, delta: params.delta });
  }

  private completeTurn(native: NativeObject | undefined): void {
    const id = requiredString(native?.id, "completed turn ID");
    const turn = this.turns.get(id);
    if (!turn || turn.status !== "inProgress") { this.observe("late-turn-completion", native); return; }
    if (Array.isArray(native?.items)) for (const item of native.items) this.updateItem(id, object(item), true);
    turn.status = this.turnStatus(native?.status);
    if (turn.status === "inProgress") throw new CodexRpcError("Codex completed a nonterminal turn", "protocol");
    for (const [key, item] of this.items) if (key.startsWith(`codex:${id}:`) && !item.completed) {
      const message = this.transcript.get(key);
      if (!message) continue;
      item.completed = true;
      const incompleteTool = message.parts.some((part) => part.type === "toolCall" && part.status === "running");
      message.status = turn.status === "interrupted" ? "interrupted" : turn.status === "failed" || incompleteTool ? "error" : "completed";
      if (incompleteTool && turn.status !== "interrupted") message.errorMessage = "Codex ended the turn before this tool's final result";
      for (const part of message.parts) if (part.type === "toolCall" && part.status === "running") {
        part.status = turn.status === "interrupted" ? "cancelled" : "error";
        if (part.result) part.result.isError = true;
      }
      this.emit({ type: "message_replace", sessionId: this.sessionId, message, final: true });
    }
    for (const [webId, control] of this.controls) if (control.turnId === id) this.removeControl(webId, "native");
    if (id === this.activeTurnId) {
      this.activeTurnId = undefined; this.snapshot.isRetrying = false;
      if (turn.status === "failed") this.snapshot.error = diagnostic(object(native?.error)?.message);
      else if (turn.status === "completed") delete this.snapshot.error;
    }
    this.reconcile();
  }

  private requiredControl(native: NativeRequest): void {
    const params = object(native.params);
    const foreignThread = typeof params?.threadId === "string" && params.threadId !== this.snapshot.nativeSession.sessionId;
    const staleTurn = typeof params?.turnId === "string" && params.turnId !== this.activeTurnId;
    if (foreignThread || staleTurn) {
      // `cancel` means Abort in Codex, not merely deny this callback. A stale
      // callback must never abort a newer turn (or another native thread).
      this.observe("out-of-scope-control", native.params);
      this.rpc?.reject(native.id, "This decision does not target the active Codex execution", -32600);
      const conflicting = this.nativeControlIds.get(requestKey(native.id));
      if (conflicting) this.removeControl(conflicting, "native");
      return;
    }
    const duplicate = this.nativeControlIds.get(requestKey(native.id));
    if (duplicate) {
      if (JSON.stringify(this.controls.get(duplicate)?.native) !== JSON.stringify(native)) {
        this.observe("conflicting-control-replay", native.params);
        void this.rpc?.dispose();
      }
      return;
    }
    const turnId = typeof params?.turnId === "string" ? params.turnId : undefined;
    const matches = params?.threadId === this.snapshot.nativeSession.sessionId && turnId === this.activeTurnId && !!turnId;
    const item = turnId && typeof params?.itemId === "string" ? this.items.get(itemMessageId(turnId, params.itemId)) : undefined;
    const approval = matches ? codexApproval(native, item?.native) : undefined;
    if (!matches || !approval) { this.rejectControl(native, matches); return; }
    const id = randomUUID();
    const timeout = this.options.interactionTimeoutMs ?? 120_000;
    const request: InteractionRequestDto = { id, sessionId: this.sessionId, source: "approval", kind: "approval", title: approval.title,
      body: approval.description, payload: { harness: "codex", ...(item && turnId ? { messageId: itemMessageId(turnId, String(item.native.id)) } : {}) },
      choices: approval.choices.map((choice) => ({ ...choice, meaning: choice.id === "decline" ? "decline" : choice.id === "cancel" ? "cancel" : "accept" })),
      timeout, expiresAt: new Date(Date.now() + timeout).toISOString() };
    const timer = setTimeout(() => this.cancelControl(id, "expired"), timeout); timer.unref?.();
    this.controls.set(id, { native, turnId, approval, request, timer });
    this.nativeControlIds.set(requestKey(native.id), id);
    this.emit({ type: "interaction", request }); this.reconcile();
  }

  private rejectControl(native: NativeRequest, activeMatch: boolean): void {
    this.observe(`required:${native.method}`, native.params);
    try {
      const params = object(native.params);
      const standaloneMcp = native.method === "mcpServer/elicitation/request" && params?.threadId === this.snapshot.nativeSession.sessionId && params?.turnId == null;
      const result = activeMatch || standaloneMcp ? unsupportedControlResponse(native) : undefined;
      if (result) this.rpc?.respond(native.id, result); else this.rpc?.reject(native.id);
      const turnId = this.activeTurnId;
      if (activeMatch && turnId) void this.rpc?.request("turn/interrupt", { threadId: this.nativeId(), turnId }).catch((error: unknown) => {
        // A native cancel may have already ended this exact turn. Never dispose a
        // newer execution because its predecessor's interrupt acknowledgement raced.
        if (this.activeTurnId !== turnId || (error instanceof CodexRpcError && error.code === -32600)) return;
        return this.rpc?.dispose();
      });
      else if (!result && !unsupportedControlResponse(native) && typeof params?.turnId !== "string") void this.rpc?.dispose();
    } catch { void this.rpc?.dispose(); }
    this.snapshot.error = "A required Codex decision could not be reviewed safely; it was not approved.";
    this.emit({ type: "error", sessionId: this.sessionId, error: this.snapshot.error }); this.emitState();
  }

  private cancelControl(id: string, reason: "expired" | "cancelled" | "disposed"): void {
    const pending = this.controls.get(id);
    if (!pending) return;
    try { if (!this.rpc?.closed) this.rpc?.respond(pending.native.id, pending.approval.dismiss); } catch { /* Process loss still clears UI state. */ }
    if (pending.approval.dismiss.decision === "cancel") this.noteCancelledItem(pending);
    this.removeControl(id, reason);
  }
  private noteCancelledItem(pending: PendingControl): void {
    const itemId = object(pending.native.params)?.itemId;
    if (typeof itemId === "string") this.cancelledItems.add(itemMessageId(pending.turnId, itemId));
  }
  private removeControl(id: string, reason: "responded" | "expired" | "cancelled" | "native" | "disposed"): void {
    const pending = this.controls.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.controls.delete(id); this.nativeControlIds.delete(requestKey(pending.native.id));
    this.emit({ type: "interaction_resolved", sessionId: this.sessionId, id, reason }); this.reconcile();
  }

  private unavailable(error: string): void {
    if (this.snapshot.phase === "unavailable") return;
    for (const message of this.transcript.values()) if (message.status === "streaming") {
      message.status = "error"; message.errorMessage = "The native Codex connection was lost before this item completed.";
      for (const part of message.parts) if (part.type === "toolCall" && part.status === "running") {
        part.status = "error";
        if (part.result) part.result.isError = true;
      }
      this.emit({ type: "message_replace", sessionId: this.sessionId, message, final: true });
    }
    this.snapshot.phase = "unavailable"; this.snapshot.activity = "idle";
    this.snapshot.isStreaming = false; this.snapshot.isRetrying = false; this.snapshot.isCompacting = false;
    this.snapshot.error = diagnostic(error); delete this.snapshot.activeExecution; this.activeTurnId = undefined;
    if (this.snapshot.nativeSession.persistence === "ephemeral") this.snapshot.nativeSession.status = "unavailable";
    for (const id of [...this.controls.keys()]) this.removeControl(id, "disposed");
    this.emitState();
    if (!this.disposing) this.emit({ type: "error", sessionId: this.sessionId, error: this.snapshot.error });
  }
  private observe(method: string, value?: unknown, bytes?: number): void {
    if (this.observations.length >= 32) return;
    const observation: JsonValue = { type: "harness_observation", harnessId: "codex", sessionId: this.sessionId,
      method: /^[\w/.: -]{1,96}$/.test(method) ? diagnostic(method) : "[unrecognized method]",
      bytes: bytes ?? Buffer.byteLength(JSON.stringify(value ?? null)), payloadOmitted: true };
    this.observations.push(observation); this.emit({ type: "wire", value: observation });
  }
  private countMessages(): void {
    const messages = [...this.transcript.values()];
    this.snapshot.stats.userMessages = messages.filter((message) => message.role === "user").length;
    this.snapshot.stats.assistantMessages = messages.filter((message) => message.role === "assistant").length;
    this.snapshot.stats.toolResults = messages.reduce((count, message) => count + message.parts.filter((part) => part.type === "toolCall" && part.result).length, 0);
    this.snapshot.stats.totalMessages = messages.length;
  }
  private usage(usage: NativeObject | undefined): void {
    const total = object(usage?.total);
    if (!total) return;
    const number = (name: string): number | undefined => typeof total[name] === "number" && Number.isFinite(total[name]) && total[name] >= 0 ? total[name] : undefined;
    const input = number("inputTokens"), output = number("outputTokens"), cacheRead = number("cachedInputTokens"), reportedTotal = number("totalTokens");
    // Only this field has an explicit zero default in the pinned native schema.
    const cacheWrite = total.cacheWriteInputTokens === undefined ? 0 : number("cacheWriteInputTokens");
    if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined || reportedTotal === undefined) return;
    this.snapshot.stats.tokens = { input, output, cacheRead, cacheWrite, total: reportedTotal };
    const contextWindow = usage?.modelContextWindow;
    if (typeof contextWindow === "number" && contextWindow > 0 && this.snapshot.model) this.snapshot.model.contextWindow = contextWindow;
    // Native token usage is not measured context occupancy. Do not invent a context percentage.
    this.emitState();
  }
}

function executableAvailable(command: string, env: NodeJS.ProcessEnv): boolean {
  const paths = isAbsolute(command) || command.includes("/") ? [command] : (env.PATH ?? "").split(delimiter).map((path) => join(path, command));
  return paths.some((path) => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } });
}

export function createCodexAdapter(options: CodexAdapterOptions = {}): SessionAdapter {
  const available = executableAvailable(options.command ?? "codex", options.env ?? process.env);
  return {
    harness: { id: "codex", name: "Codex", enabled: true, available, capabilities: { ...capabilities },
      ...(!available ? { unavailableReason: "Codex executable is not available on PATH" } : {}) },
    create: (input) => new CodexHandle(input.cwd, input.sessionId ?? randomUUID(), { harnessId: "codex", persistence: input.persistence ?? "persistent", status: input.persistence === "ephemeral" ? "live-only" : "unmaterialized" }, options).start(input),
    // Cached metadata is only a last observation. Probe every persistent native ID, including
    // one marked unmaterialized just before a host crash; never recreate or replay its prompt.
    open: (input) => input.nativeSession.harnessId !== "codex"
      ? Promise.reject(new Error("Cannot open another harness's native reference with Codex"))
      : new CodexHandle(input.cwd, input.sessionId, { ...input.nativeSession }, options).start(input),
    async list(cwd): Promise<AdapterSessionInfo[]> {
      let rpc: CodexTransport;
      rpc = new CodexTransport({ ...options, cwd }, { notification: () => {}, request: (request) => { rpc.reject(request.id); void rpc.dispose(); }, closed: () => {}, observation: () => {} });
      try {
        await initialize(rpc);
        const sessions: AdapterSessionInfo[] = [];
        const cursors = new Set<string>();
        let cursor: string | undefined;
        do {
          const response = object(await rpc.request("thread/list", { cwd, sourceKinds: ["appServer", "cli", "vscode", "exec"], modelProviders: [], limit: 100, ...(cursor ? { cursor } : {}) }));
          if (!Array.isArray(response?.data)) throw new CodexRpcError("Invalid Codex thread listing", "protocol");
          for (const entry of response.data) {
            const thread = object(entry);
            if (!thread || typeof thread.ephemeral !== "boolean") throw new CodexRpcError("Invalid Codex listed persistence", "protocol");
            if (thread.ephemeral) continue;
            const nativeId = requiredString(thread.id, "listed thread ID");
            const created = Number(thread.createdAt); const modified = Number(thread.updatedAt);
            if (!Number.isFinite(created) || !Number.isFinite(modified)) throw new CodexRpcError("Invalid Codex thread timestamps", "protocol");
            sessions.push({ nativeSession: { harnessId: "codex", sessionId: nativeId, persistence: "persistent", status: "resumable" },
              cwd: typeof thread.cwd === "string" ? thread.cwd : cwd, ...(typeof thread.name === "string" ? { name: thread.name } : {}),
              ...(typeof thread.preview === "string" ? { firstMessage: thread.preview } : {}), created: new Date(created * 1_000).toISOString(), modified: new Date(modified * 1_000).toISOString() });
          }
          cursor = typeof response.nextCursor === "string" ? response.nextCursor : undefined;
          if (cursor && cursors.has(cursor)) throw new CodexRpcError("Codex repeated a history cursor", "protocol");
          if (cursor) cursors.add(cursor);
        } while (cursor);
        return sessions;
      } finally { await rpc.dispose(); }
    },
  };
}
