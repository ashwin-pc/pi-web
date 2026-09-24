import { randomUUID } from "node:crypto";
import type { InitializeRequest, InitializeResponse, LoadSessionRequest, NewSessionRequest, PromptRequest, SessionNotification, SessionUpdate, StopReason } from "@agentclientprotocol/sdk";
import type { AdapterCreateInput, AdapterOpenInput, AdapterPromptInput, AdapterSessionInfo, SessionAdapter, SessionHandle } from "../../adapter.js";
import type { HarnessCapabilitiesDto, InteractionRequestDto, InteractionResponseDto, InterruptReceiptDto, PromptReceiptDto, SessionServiceEvent, SessionSnapshotDto } from "../../dto.js";
import { SessionServiceError } from "../../errors.js";
import { approval, cancelled, type KiroApproval } from "./approvals.js";
import { ACP_VERSION, installed, metadata, preflight } from "./native.js";
import { KiroTranscript } from "./projection.js";
import { KiroRpcError, KiroTransport, object, type KiroLaunchOptions, type NativeRequest } from "./transport.js";

const capabilities: HarnessCapabilitiesDto = { harness: "kiro", queue: false, steering: false, followUp: false, thinkingLevel: false, tree: false,
  compaction: false, retry: false, bash: false, extensions: false, interactions: true, models: false, context: false, attachments: false, historyFork: false };
export interface KiroAdapterOptions extends Omit<KiroLaunchOptions, "cwd"> { interactionTimeoutMs?: number }
type Control = { native: NativeRequest; executionId: string; request: InteractionRequestDto; approval: KiroApproval; timer: ReturnType<typeof setTimeout> };
const requiredId = (value: unknown): string => {
  if (typeof value !== "string" || !value || value.length > 4096) throw new KiroRpcError("Invalid Kiro session identity", "protocol");
  return value;
};
const stopReasons = new Set<StopReason>(["end_turn", "cancelled", "max_tokens", "max_turn_requests", "refusal"]);

class KiroHandle implements SessionHandle {
  readonly harnessId = "kiro" as const;
  private readonly listeners = new Set<(event: SessionServiceEvent) => void>();
  private readonly transcript: KiroTranscript;
  private readonly controls = new Map<string, Control>();
  private readonly requestIds = new Set<string>();
  private rpc?: KiroTransport;
  private snapshot: SessionSnapshotDto;
  private execution?: AdapterPromptInput;
  private disposed = false;
  private replay = true;
  private buffered: SessionNotification[] = [];
  private bufferedBytes = 0;
  private observations = 0;
  private updateBytes = 0;
  constructor(readonly sessionId: string, private readonly cwd: string, private readonly options: KiroAdapterOptions) {
    this.transcript = new KiroTranscript(sessionId, (event) => this.emit(event), (kind) => this.observe(kind, this.updateBytes));
    this.snapshot = { sessionId, cwd, sessionTitle: "Kiro session", harnessId: "kiro", nativeSession: { harnessId: "kiro", persistence: "persistent", status: "unmaterialized" },
      phase: "starting", activity: "idle", pendingInteractions: [], capabilities: { ...capabilities }, isStreaming: false, isRetrying: false, isCompacting: false,
      stats: { ...this.transcript.counts(), tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  }
  async start(input: AdapterCreateInput | AdapterOpenInput): Promise<this> {
    const opening = "nativeSession" in input;
    if (opening) this.snapshot.nativeSession = { ...input.nativeSession };
    await preflight({ ...this.options, cwd: this.cwd });
    this.rpc = new KiroTransport({ ...this.options, cwd: this.cwd, command: this.options.command ?? "kiro-cli" }, {
      notification: (message) => this.notification(message.method, message.params), request: (message) => this.requiredControl(message),
      closed: () => this.lost(), observation: (kind, bytes) => this.observe(kind, bytes),
    });
    try {
      const init = { protocolVersion: ACP_VERSION, clientCapabilities: {}, clientInfo: { name: "pi-web", version: "0.6.0" } } satisfies InitializeRequest;
      const initialized = object(await this.rpc.request("initialize", init)) as InitializeResponse | undefined;
      if (initialized?.protocolVersion !== ACP_VERSION || opening && initialized.agentCapabilities?.loadSession !== true) throw new KiroRpcError("Unsupported Kiro ACP protocol or load capability", "protocol");
      const params = { cwd: this.cwd, mcpServers: [] } satisfies NewSessionRequest;
      const result = object(await this.rpc.request(opening ? "session/load" : "session/new", opening
        ? { ...params, sessionId: requiredId(input.nativeSession.sessionId) } satisfies LoadSessionRequest : params));
      if (!result) throw new KiroRpcError("Invalid Kiro session response", "protocol");
      const nativeId = opening ? requiredId(input.nativeSession.sessionId) : requiredId(result.sessionId);
      if (opening && result.sessionId != null && result.sessionId !== nativeId) throw new KiroRpcError("Kiro loaded a different session", "protocol");
      this.snapshot.nativeSession = { harnessId: "kiro", sessionId: nativeId, persistence: "persistent", status: opening ? "resumable" : "unmaterialized" };
      const model = object(result.models)?.currentModelId ?? result.model;
      const config = Array.isArray(result.configOptions) ? result.configOptions.map(object) : [];
      const configured = config.find((item) => item?.category === "model")?.currentValue;
      const effort = config.find((item) => item?.category === "thought_level")?.currentValue;
      const mode = object(result.modes)?.currentModeId ?? config.find((item) => item?.category === "mode")?.currentValue;
      this.snapshot.nativeSettings = { ...(typeof model === "string" ? { model } : typeof configured === "string" ? { model: configured } : {}),
        ...(typeof effort === "string" ? { reasoningEffort: effort } : {}), ...(typeof mode === "string" ? { mode } : {}) };
      for (const frame of this.buffered) this.project(frame);
      this.buffered = []; this.bufferedBytes = 0;
      this.transcript.finish(); this.replay = false;
      this.snapshot.phase = "idle"; this.publish(); return this;
    } catch (error) { await this.dispose(); throw error; }
  }
  state(): SessionSnapshotDto {
    return structuredClone({ ...this.snapshot, pendingInteractions: [...this.controls.values()].map((c) => c.request),
      stats: { ...this.snapshot.stats, ...this.transcript.counts() } });
  }
  async messages() { return this.transcript.messages(); }
  subscribe(listener: (event: SessionServiceEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit(event: SessionServiceEvent) { for (const listener of this.listeners) { try { listener(structuredClone(event)); } catch { /* isolate clients */ } } }
  private publish() {
    this.snapshot.activity = this.controls.size ? "waiting-approval" : this.execution ? "working" : "idle";
    this.snapshot.isStreaming = !!this.execution;
    this.emit({ type: "state", state: this.state() });
  }
  async prompt(input: AdapterPromptInput): Promise<PromptReceiptDto> {
    if (this.disposed || !this.rpc || this.rpc.closed || this.snapshot.phase === "unavailable") throw new SessionServiceError("Kiro process is unavailable; explicitly reopen", 410);
    if (input.mode !== "prompt" || input.attachments.length || input.expectedExecutionId) throw new SessionServiceError("Kiro supports idle text prompts only", 400);
    if (!input.message.trim()) throw new SessionServiceError("A prompt is required", 400);
    if (this.execution) throw new SessionServiceError("Kiro is still running or settling", 409);
    this.execution = input;
    this.snapshot.activeExecution = { id: input.executionId, owner: "host" };
    this.snapshot.phase = "running"; delete this.snapshot.error;
    this.transcript.begin(input.message, input); this.publish();
    const params = { sessionId: this.snapshot.nativeSession.sessionId!, prompt: [{ type: "text", text: input.message }] } satisfies PromptRequest;
    // ACP prompt responses end the turn. A short uniform RPC timeout is incorrect.
    void this.rpc.request("session/prompt", params, null).then((value) => {
      if (this.execution !== input) return;
      const reason = object(value)?.stopReason;
      if (!stopReasons.has(reason as StopReason)) { void this.rpc?.dispose(); return; }
      this.settle(input, reason as StopReason);
    }, (error: unknown) => {
      if (this.execution !== input) return;
      if (this.rpc?.closed) this.lost();
      else this.settle(input, undefined, error instanceof KiroRpcError ? `Kiro prompt RPC failed (${error.code}); no input was retried` : "Kiro prompt failed");
    });
    return { sessionId: this.sessionId, executionId: input.executionId, acknowledgement: "not-exposed" };
  }
  private settle(input: AdapterPromptInput, reason?: StopReason, error?: string) {
    if (this.execution !== input) return;
    this.clearControls("native");
    this.transcript.finish(input.executionId, reason, error);
    this.execution = undefined; delete this.snapshot.activeExecution;
    this.snapshot.phase = error ? "error" : "idle";
    this.snapshot.error = error;
    if (error) this.emit({ type: "error", sessionId: this.sessionId, error, clientMessageId: input.clientMessageId });
    this.publish();
  }
  async interrupt(expectedExecutionId: string): Promise<InterruptReceiptDto> {
    if (!this.execution || this.execution.executionId !== expectedExecutionId || this.rpc?.closed || this.disposed) throw new SessionServiceError("Kiro execution is no longer active", 409);
    this.cancelExecution(expectedExecutionId);
    // This acknowledges host dispatch only; ACP cancel is a notification.
    return { sessionId: this.sessionId, executionId: expectedExecutionId, acknowledged: true };
  }
  private cancelExecution(id: string) {
    if (this.execution?.executionId !== id || this.rpc?.closed) return;
    this.rpc?.notify("session/cancel", { sessionId: this.snapshot.nativeSession.sessionId });
    this.snapshot.phase = "settling";
    this.clearControls("cancelled"); this.publish();
  }
  private notification(method: string, params: unknown) {
    const frame = object(params);
    if (method !== "session/update" || !frame || !object(frame.update)) { this.observe(method, Buffer.byteLength(JSON.stringify(params ?? null))); return; }
    if (this.replay) {
      this.bufferedBytes += Buffer.byteLength(JSON.stringify(params));
      if (this.bufferedBytes > 8 * 1024 * 1024) throw new KiroRpcError("Kiro replay exceeds buffer limit", "protocol");
      this.buffered.push(params as SessionNotification); return;
    }
    this.project(params as SessionNotification);
  }
  private project(frame: SessionNotification) {
    if (frame.sessionId !== this.snapshot.nativeSession.sessionId || !this.replay && !this.execution) { this.observe("unbound-update"); return; }
    this.updateBytes = Buffer.byteLength(JSON.stringify(frame.update));
    try { this.transcript.update(frame.update as SessionUpdate, this.execution ?? {}, this.replay); }
    finally { this.updateBytes = 0; }
  }
  private requiredControl(native: NativeRequest) {
    const params = object(native.params);
    const executionId = this.execution?.executionId;
    const key = `${typeof native.id}:${native.id}`;
    if (this.requestIds.has(key)) {
      const pending = [...this.controls.values()].find((c) => `${typeof c.native.id}:${c.native.id}` === key);
      if (pending && JSON.stringify(pending.native) === JSON.stringify(native)) return;
      this.rpc?.reject(native.id, "Reused Kiro request identity", -32600); return;
    }
    this.requestIds.add(key);
    if (this.requestIds.size > 4096) { this.rpc?.reject(native.id, "Kiro control request limit exceeded"); void this.rpc?.dispose(); return; }
    if (!executionId || !params || params.sessionId !== this.snapshot.nativeSession.sessionId || this.snapshot.phase === "settling") {
      this.rpc?.reject(native.id, "Decision does not target the active Kiro prompt", -32600);
      if (native.method !== "session/request_permission" && !params?.sessionId) void this.rpc?.dispose();
      return;
    }
    const toolId = object(params.toolCall)?.toolCallId;
    if (typeof toolId === "string" && this.transcript.staleTool(toolId, executionId)) {
      this.rpc?.reject(native.id, "Decision targets a previous Kiro execution", -32600); return;
    }
    const context = typeof toolId === "string" ? this.transcript.toolContext(toolId, executionId) : undefined;
    const mapped = native.method === "session/request_permission" ? approval(params, context) : undefined;
    if (!mapped) {
      if (native.method === "session/request_permission") this.rpc?.respond(native.id, cancelled);
      else this.rpc?.reject(native.id);
      this.observe(`required:${native.method}`); this.cancelExecution(executionId); return;
    }
    const id = randomUUID(); const timeout = this.options.interactionTimeoutMs ?? 120_000;
    const request: InteractionRequestDto = { id, sessionId: this.sessionId, source: "approval", kind: "approval", title: "Allow Kiro tool?", body: mapped.body,
      payload: { harness: "kiro" }, choices: mapped.choices, timeout, expiresAt: new Date(Date.now() + timeout).toISOString() };
    const timer = setTimeout(() => { this.resolve(id, "expired"); this.cancelExecution(executionId); }, timeout); timer.unref();
    this.controls.set(id, { native, executionId, request, approval: mapped, timer });
    this.emit({ type: "interaction", request }); this.publish();
  }
  respondInteraction(response: InteractionResponseDto): boolean {
    const pending = this.controls.get(response.id);
    if (!pending || response.sessionId !== this.sessionId || pending.executionId !== this.execution?.executionId || this.rpc?.closed
      || Object.keys(response).some((k) => !["id", "sessionId", "choiceID", "cancelled"].includes(k))) return false;
    if (Date.parse(pending.request.expiresAt!) <= Date.now()) { this.resolve(response.id, "expired"); this.cancelExecution(pending.executionId); return false; }
    if (response.cancelled === true && response.choiceID !== undefined) return false;
    const choice = response.cancelled === true ? "cancel" : response.choiceID;
    const result = choice ? pending.approval.responses.get(choice) : undefined;
    if (!result) return false;
    this.rpc?.respond(pending.native.id, result); this.removeControl(response.id, "responded");
    if (result.outcome.outcome === "cancelled") this.cancelExecution(pending.executionId);
    return true;
  }
  private removeControl(id: string, reason: "responded" | "expired" | "cancelled" | "native" | "disposed") {
    const pending = this.controls.get(id); if (!pending) return;
    clearTimeout(pending.timer); this.controls.delete(id);
    this.emit({ type: "interaction_resolved", sessionId: this.sessionId, id, reason }); this.publish();
  }
  private resolve(id: string, reason: "expired" | "cancelled" | "native" | "disposed") {
    const pending = this.controls.get(id); if (!pending) return;
    try { if (!this.rpc?.closed) this.rpc?.respond(pending.native.id, cancelled); } catch { /* disconnected */ }
    this.removeControl(id, reason);
  }
  private clearControls(reason: "expired" | "cancelled" | "native" | "disposed") { for (const id of [...this.controls.keys()]) this.resolve(id, reason); }
  cancelInteractions(reason: "timeout" | "disconnect" | "disposed") {
    const owned = new Set([...this.controls.values()].map((c) => c.executionId));
    this.clearControls(reason === "timeout" ? "expired" : reason === "disposed" ? "disposed" : "cancelled");
    for (const id of owned) this.cancelExecution(id);
  }
  private lost() {
    if (this.snapshot.phase === "unavailable") return;
    if (this.execution) this.transcript.finish(this.execution.executionId, undefined, "Kiro process connection was lost");
    this.execution = undefined; delete this.snapshot.activeExecution;
    this.snapshot.phase = "unavailable"; this.snapshot.error = "Kiro process connection was lost; explicitly reopen without replaying input";
    this.clearControls("disposed"); this.publish();
  }
  private observe(method: string, bytes = 0) {
    if (this.observations++ >= 32) return;
    this.emit({ type: "wire", value: { type: "harness_observation", harnessId: "kiro", sessionId: this.sessionId,
      method: /^[\w/.: -]{1,96}$/.test(method) ? method : "[unknown]", bytes, payloadOmitted: true } });
  }
  async dispose() {
    if (this.disposed) return this.rpc?.dispose();
    this.disposed = true;
    if (this.execution) this.cancelExecution(this.execution.executionId);
    this.clearControls("disposed"); await this.rpc?.dispose(); this.listeners.clear();
  }
}

/** Lazy catalog, and only publicly validated bindings until real source-routing
 * canaries establish which CLI source values belong to the selected v2 engine. */
export function createKiroAdapter(options: KiroAdapterOptions = {}): SessionAdapter {
  const available = installed(options);
  const validated = new Set<string>();
  async function start(input: AdapterCreateInput | AdapterOpenInput) {
    const opening = "nativeSession" in input;
    if (opening && input.nativeSession.harnessId !== "kiro") throw new SessionServiceError("Cannot open another harness with Kiro", 400);
    if ((opening ? input.nativeSession.persistence : input.persistence) === "ephemeral") throw new SessionServiceError("Kiro ephemeral sessions are unsupported", opening ? 410 : 400);
    if (!available) throw new SessionServiceError("Kiro executable is unavailable", 503);
    const handle = await new KiroHandle(input.sessionId ?? randomUUID(), input.cwd, options).start(input);
    validated.add(`${input.cwd}\0${handle.state().nativeSession.sessionId}`); return handle;
  }
  return {
    harness: { id: "kiro", name: "Kiro", enabled: true, available, capabilities: { ...capabilities }, ...(!available ? { unavailableReason: "Kiro CLI is not available on PATH" } : {}) },
    create: start, open: start,
    async list(cwd): Promise<AdapterSessionInfo[]> {
      if (![...validated].some((key) => key.startsWith(`${cwd}\0`))) return [];
      await preflight({ ...options, cwd });
      const output: unknown = JSON.parse(await metadata({ ...options, cwd }, ["chat", "--agent-engine", "v2", "--list-sessions", "--format", "json"]));
      if (!Array.isArray(output)) throw new KiroRpcError("Invalid Kiro catalog", "protocol");
      const rows: AdapterSessionInfo[] = [];
      for (const envelope of output) {
        const group = object(envelope);
        if (!group || group.cwd !== cwd || !Array.isArray(group.sessions)) continue;
        for (const entry of group.sessions) {
          const value = object(entry);
          if (!value || typeof value.sessionId !== "string" || !validated.has(`${cwd}\0${value.sessionId}`)) continue;
          if (typeof value.source !== "string" || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) continue;
          rows.push({ nativeSession: { harnessId: "kiro", sessionId: value.sessionId, persistence: "persistent", status: "resumable" }, cwd,
            modified: value.updatedAt, ...(typeof value.title === "string" ? { name: value.title } : {}),
            ...(Number.isSafeInteger(value.messageCount) && Number(value.messageCount) >= 0 ? { messageCount: Number(value.messageCount) } : {}) });
        }
      }
      return rows;
    },
  };
}
