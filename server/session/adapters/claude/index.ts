import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { getSessionInfo, getSessionMessages, listSessions, type Options, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AdapterCreateInput, AdapterOpenInput, AdapterPromptInput, AdapterSessionInfo, SessionAdapter, SessionHandle } from "../../adapter.js";
import type { HarnessDescriptorDto, InteractionResponseDto, InterruptReceiptDto, NativeSessionRefDto, PromptReceiptDto, SessionServiceEvent, SessionSnapshotDto, SessionStatsDto } from "../../dto.js";
import { SessionServiceError } from "../../errors.js";
import { nativeChildEnvironment } from "../nativeEnvironment.js";
import { ClaudeApprovals } from "./approvals.js";
import { CLAUDE_CODE_VERSION, createClaudeQuery, type ClaudeIngressObservation } from "./native.js";
import { ClaudeTranscript } from "./transcript.js";

interface ClaudeAdapterOptions {
  pathToClaudeCodeExecutable?: string;
  /** Native public ingress seams for deterministic tests; never browser input. */
  spawnClaudeCodeProcess?: Options["spawnClaudeCodeProcess"];
  env?: Options["env"];
  sessionApi?: { getSessionInfo: typeof getSessionInfo; getSessionMessages: typeof getSessionMessages; listSessions: typeof listSessions };
  interactionTimeoutMs?: number;
  initializationTimeoutMs?: number;
  controlTimeoutMs?: number;
}
const sessions = { getSessionInfo, getSessionMessages, listSessions };
const finite = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const cleanError = (value: unknown): string => (value instanceof Error ? value.message : typeof value === "string" ? value : "Claude execution failed")
  .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 1200);
const capabilities = {
  harness: "claude", queue: false, steering: false, followUp: false, thinkingLevel: false, tree: false,
  compaction: false, retry: false, bash: false, extensions: false, interactions: true,
  models: false, context: false, attachments: false, historyFork: false,
};

function installed(options: ClaudeAdapterOptions): boolean {
  if (options.spawnClaudeCodeProcess) return true;
  if (options.pathToClaudeCodeExecutable) return isAbsolute(options.pathToClaudeCodeExecutable) && existsSync(options.pathToClaudeCodeExecutable);
  const require = createRequire(import.meta.url);
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const candidates = process.platform === "linux" ? [base, `${base}-musl`] : [base];
  return candidates.some((name) => { try { return existsSync(require.resolve(`${name}/claude${process.platform === "win32" ? ".exe" : ""}`)); } catch { return false; } });
}

function bounded<T>(promise: Promise<T>, ms: number, operation = "initialization"): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SessionServiceError(`Claude ${operation} timed out`, 503)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Factory is lazy: no native process, auth, model or configuration work here. */
export function createClaudeAdapter(options: ClaudeAdapterOptions = {}): SessionAdapter {
  const api = options.sessionApi ?? sessions;
  const available = installed(options);
  const harness: HarnessDescriptorDto = { id: "claude", name: `Claude Agent (${CLAUDE_CODE_VERSION})`, enabled: true, available, capabilities: { ...capabilities },
    ...(!available ? { unavailableReason: "Claude SDK bundled executable is unavailable; install optional dependencies or configure an absolute executable path" } : {}) };
  const check = () => { if (!available) throw new SessionServiceError(harness.unavailableReason!, 503); };
  return {
    harness,
    async create(input: AdapterCreateInput) {
      check();
      return new ClaudeHandle(input.sessionId ?? randomUUID(), input.cwd, {
        harnessId: "claude", sessionId: randomUUID(), persistence: input.persistence ?? "persistent",
        status: input.persistence === "ephemeral" ? "live-only" : "unmaterialized",
      }, options, false);
    },
    async open(input: AdapterOpenInput) {
      check();
      const ref = input.nativeSession;
      if (ref.harnessId !== "claude" || !uuid(ref.sessionId)) throw new SessionServiceError("Invalid Claude native session reference", 400);
      if (ref.persistence === "ephemeral") throw new SessionServiceError("Ephemeral Claude sessions cannot be resumed after their process exits", 410);
      // Cached status is not authority: native acceptance/persistence can precede
      // the last host binding write. Ask supported native readers even when the
      // cached reference says unmaterialized or unavailable. Never recreate it.
      let info = await api.getSessionInfo(ref.sessionId, { dir: input.cwd });
      let history = await api.getSessionMessages(ref.sessionId, { dir: input.cwd, includeSystemMessages: true });
      if (!info && !history.length) {
        // Native UUID lookup across projects is supported; a stale cwd must not
        // turn into a private-store scan or an automatic replacement session.
        info = await api.getSessionInfo(ref.sessionId);
        history = await api.getSessionMessages(ref.sessionId, { includeSystemMessages: true });
      }
      if (!info && !history.length) throw new SessionServiceError("Claude session has no resumable native history", 410);
      const handle = new ClaudeHandle(input.sessionId, info?.cwd ?? input.cwd, { ...ref, status: "resumable" }, options, true);
      handle.load(history, info?.customTitle ?? info?.summary);
      return handle;
    },
    async list(cwd: string): Promise<AdapterSessionInfo[]> {
      check();
      return (await api.listSessions({ dir: cwd })).filter((info) => uuid(info.sessionId)).map((info) => ({
        nativeSession: { harnessId: "claude", sessionId: info.sessionId, persistence: "persistent", status: "resumable" },
        cwd: info.cwd ?? cwd, name: info.customTitle ?? info.summary, firstMessage: info.firstPrompt,
        created: new Date(info.createdAt ?? info.lastModified).toISOString(), modified: new Date(info.lastModified).toISOString(),
      }));
    },
  };
}

type Execution = { id: string; promptId: string; input: AdapterPromptInput; accepted: boolean; result: boolean; interrupted: boolean; error?: string };

class ClaudeHandle implements SessionHandle {
  readonly harnessId = "claude" as const;
  private readonly listeners = new Set<(event: SessionServiceEvent) => void>();
  private readonly transcript: ClaudeTranscript;
  private readonly approvals: ClaudeApprovals;
  private readonly observed = new Set<string>();
  private readonly submissions = new Set<string>();
  private stateValue: SessionSnapshotDto;
  private execution?: Execution;
  private query?: Query;
  private reading?: Promise<void>;
  private input?: { push(message: SDKUserMessage): void; end(): void };
  private generation = 0;
  private disposed = false;
  private resume: boolean;
  private lastResultIndex = -1;
  private observedUsage: SessionStatsDto["tokens"];
  private cost?: number;
  private executableChecked = false;

  constructor(readonly sessionId: string, cwd: string, nativeSession: NativeSessionRefDto, private readonly options: ClaudeAdapterOptions, resume: boolean) {
    this.resume = resume;
    this.transcript = new ClaudeTranscript(sessionId, (event) => this.emit(event), (type) => this.observation({ kind: "message", bytes: 0, type: "content_block", subtype: type }));
    this.approvals = new ClaudeApprovals(sessionId, options.interactionTimeoutMs ?? 60_000, (event) => this.emit(event), () => this.publishState());
    this.stateValue = { sessionId, cwd, harnessId: "claude", nativeSession, phase: "idle", activity: "idle", pendingInteractions: [],
      sessionTitle: "Claude session", capabilities: { ...capabilities }, isStreaming: false, isRetrying: false, isCompacting: false,
      stats: this.transcript.counts(), nativeSettings: {} };
  }

  load(history: Awaited<ReturnType<typeof getSessionMessages>>, title?: string): void {
    this.transcript.load(history);
    if (title) { this.stateValue.sessionTitle = title; this.stateValue.sessionName = title; }
  }

  state(): SessionSnapshotDto {
    const pending = this.approvals.requests();
    const activity = pending.length ? pending.some((request) => request.source === "clarify") ? "waiting-input" : "waiting-approval" : this.stateValue.activity;
    return structuredClone({ ...this.stateValue, activity, pendingInteractions: pending,
      stats: { ...this.transcript.counts(), ...(this.observedUsage === undefined ? {} : { tokens: this.observedUsage }), ...(this.cost === undefined ? {} : { cost: this.cost }) } });
  }
  async messages() { return this.transcript.messages(); }
  subscribe(listener: (event: SessionServiceEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  respondInteraction(response: InteractionResponseDto): boolean { return this.approvals.respond(response); }
  cancelInteractions(reason: "timeout" | "disconnect" | "disposed"): void { this.approvals.cancel(reason); }

  private emit(event: SessionServiceEvent): void { for (const listener of this.listeners) { try { listener(structuredClone(event)); } catch { /* One client cannot break native processing. */ } } }
  private publishState(): void { this.emit({ type: "state", state: this.state() }); }
  private correlation() { return this.execution ? { executionId: this.execution.id, clientMessageId: this.execution.input.clientMessageId, sourceClientId: this.execution.input.sourceClientId } : {}; }
  private observation(observation: ClaudeIngressObservation): void {
    if (this.disposed) return;
    const safe = (value: string | undefined) => value && /^[a-z][a-z0-9_]{0,63}$/i.test(value) ? value : undefined;
    this.emit({ type: "wire", value: { type: "native_observation", sessionId: this.sessionId, harnessId: "claude",
      observation: { kind: observation.kind, bytes: observation.bytes, ...(safe(observation.type) ? { type: safe(observation.type)! } : {}), ...(safe(observation.subtype) ? { subtype: safe(observation.subtype)! } : {}) } } });
  }

  async prompt(input: AdapterPromptInput): Promise<PromptReceiptDto> {
    if (this.disposed) throw new SessionServiceError("Claude session is disposed", 410);
    if (this.stateValue.phase === "unavailable") throw new SessionServiceError("Claude process is no longer available; reopen the native session before continuing", 410);
    if (input.mode !== "prompt") throw new SessionServiceError(`Claude does not support ${input.mode} input`, 400);
    if (input.attachments.length) throw new SessionServiceError("Claude attachments are not enabled in this integration", 400);
    if (!input.message.trim()) throw new SessionServiceError("A prompt is required", 400);
    if (/^\/(clear|resume|fork|new)(?:\s|$)/.test(input.message.trim())) throw new SessionServiceError("Claude conversation-switch commands are not enabled; create or open a session in the drawer", 400);
    if (this.execution) throw new SessionServiceError("Claude is still running or settling; concurrent input is not supported", 409);
    if (input.clientMessageId && this.submissions.has(input.clientMessageId)) throw new SessionServiceError("This client message was already dispatched; it will not be replayed", 409);
    this.execution = { id: input.executionId, promptId: randomUUID(), input, accepted: false, result: false, interrupted: false };
    this.stateValue.activeExecution = { id: input.executionId, owner: "host" };
    this.stateValue.phase = "starting";
    this.stateValue.activity = "working";
    this.stateValue.error = undefined;
    this.stateValue.isStreaming = true;
    if (!this.stateValue.sessionName) this.stateValue.sessionTitle = input.message.slice(0, 100);
    this.publishState();
    try {
      await this.ensureQuery();
      if (!this.execution || this.execution.id !== input.executionId || !this.input) throw new SessionServiceError("Claude execution ended before input dispatch", 503);
      if (input.clientMessageId) {
        this.submissions.add(input.clientMessageId);
        if (this.submissions.size > 256) this.submissions.delete(this.submissions.values().next().value!);
      }
      this.input.push({ type: "user", uuid: this.execution.promptId as `${string}-${string}-${string}-${string}-${string}`, session_id: this.stateValue.nativeSession.sessionId,
        parent_tool_use_id: null, origin: { kind: "human" }, message: { role: "user", content: input.message } });
      // Dispatch is not native acceptance. Replay/first-reply correlation produces
      // the acknowledged user transcript event later; never invent a native turn ID.
      return { sessionId: this.sessionId, executionId: input.executionId, acknowledgement: this.execution.accepted ? "accepted" : "pending" };
    } catch (error) {
      this.fail(error);
      throw new SessionServiceError(cleanError(error), 503);
    }
  }

  async interrupt(expectedExecutionId: string): Promise<InterruptReceiptDto> {
    const execution = this.execution;
    const query = this.query;
    const generation = this.generation;
    if (!execution || execution.id !== expectedExecutionId || !query) throw new SessionServiceError("Stale Claude execution interrupt", 409);
    let receipt;
    try { receipt = await bounded(query.interrupt(), this.options.controlTimeoutMs ?? 10_000, "interrupt acknowledgement"); }
    catch (error) {
      // An older control can fail after its turn settled and a newer one began.
      // Report that call's failure without touching the newer execution/process.
      if (this.execution === execution && this.query === query && generation === this.generation) this.fail(error);
      throw error;
    }
    if (this.disposed || generation !== this.generation) throw new SessionServiceError("Claude query changed while interrupting", 409);
    return { sessionId: this.sessionId, executionId: expectedExecutionId, acknowledged: true,
      ...(receipt ? { stillQueued: receipt.still_queued.length > 0 } : {}) };
  }

  private async ensureQuery(): Promise<void> {
    if (this.query) return;
    if (this.resume && this.stateValue.nativeSession.persistence === "ephemeral") throw new SessionServiceError("Ephemeral Claude process is no longer available", 410);
    if (!this.executableChecked && this.options.pathToClaudeCodeExecutable && !this.options.spawnClaudeCodeProcess) {
      const path = this.options.pathToClaudeCodeExecutable;
      const script = /\.(?:m?js|cjs|ts|tsx|jsx)$/.test(path);
      const result = await promisify(execFile)(script ? process.execPath : path, script ? [path, "--version"] : ["--version"], {
        env: nativeChildEnvironment(this.options.env ?? process.env), timeout: 5000, maxBuffer: 16 * 1024, windowsHide: true,
      });
      if (result.stdout.trim().split(/\s/)[0] !== CLAUDE_CODE_VERSION) throw new Error(`Unsupported Claude executable version (expected ${CLAUDE_CODE_VERSION})`);
      this.executableChecked = true;
    }
    if (this.disposed) throw new SessionServiceError("Claude session was disposed during startup", 410);
    const generation = ++this.generation;
    const queued: SDKUserMessage[] = [];
    let wake: (() => void) | undefined;
    let closed = false;
    this.input = { push(message) { if (closed) throw new Error("Claude input is closed"); queued.push(message); wake?.(); wake = undefined; }, end() { closed = true; queued.length = 0; wake?.(); wake = undefined; } };
    const iterable = (async function* () {
      while (!closed) {
        if (!queued.length) await new Promise<void>((resolve) => { wake = resolve; });
        if (closed) return;
        const message = queued.shift();
        if (message) yield message;
      }
    })();
    const ref = this.stateValue.nativeSession;
    const query = createClaudeQuery({ prompt: iterable, options: {
      cwd: this.stateValue.cwd, pathToClaudeCodeExecutable: this.options.pathToClaudeCodeExecutable,
      spawnClaudeCodeProcess: this.options.spawnClaudeCodeProcess, env: this.options.env,
      persistSession: ref.persistence === "persistent", ...(this.resume ? { resume: ref.sessionId } : { sessionId: ref.sessionId }),
      forwardSubagentText: true,
      canUseTool: (name, input, context) => generation === this.generation && !this.disposed
        ? this.approvals.request(generation, name, input, context) : Promise.resolve({ behavior: "deny", message: "Claude query is no longer active" }),
      onElicitation: async () => { this.observation({ kind: "message", bytes: 0, type: "elicitation", subtype: "unsupported_declined" }); return { action: "decline" }; },
    }, observe: (observation) => {
      const supported = new Set(["can_use_tool", "hook_callback", "mcp_message", "elicitation", "request_user_dialog", "oauth_token_refresh", "host_auth_token_refresh"]);
      if (generation === this.generation && (observation.kind !== "message" || observation.type === "control_request" && !supported.has(observation.subtype ?? ""))) this.observation(observation);
    } });
    this.query = query;
    this.resume = true;
    this.lastResultIndex = -1;
    // Native accounting is query-cumulative, not a fabricated lifetime bill.
    this.observedUsage = undefined;
    this.cost = undefined;
    this.reading = (async () => {
      try {
        for await (const message of query) {
          if (this.disposed || generation !== this.generation) break;
          this.receive(message);
        }
        if (!this.disposed && generation === this.generation) this.fail(new Error("Claude process ended; reopen the native session before continuing"));
      } catch (error) { if (!this.disposed && generation === this.generation) this.fail(error); }
      finally { if (this.query === query) { this.query = undefined; this.input?.end(); this.input = undefined; } }
    })();
    try { await bounded(query.initializationResult(), this.options.initializationTimeoutMs ?? 30_000); }
    catch (error) { query.close(); throw error; }
  }

  private accept(nativeUser?: Record<string, unknown>): void {
    const execution = this.execution;
    if (!execution || execution.accepted) return;
    execution.accepted = true;
    this.transcript.user(nativeUser ?? { uuid: execution.promptId, message: { role: "user", content: execution.input.message } }, this.correlation());
    this.stateValue.phase = "running";
    this.publishState();
  }

  private receive(message: SDKMessage): void {
    const frame = message as unknown as Record<string, unknown>;
    const id = typeof frame.uuid === "string" ? frame.uuid : undefined;
    if (id && this.observed.has(id)) return;
    if (id) { this.observed.add(id); if (this.observed.size > 4096) this.observed.delete(this.observed.values().next().value!); }
    const ref = this.stateValue.nativeSession;
    if (typeof frame.session_id === "string" && frame.session_id !== ref.sessionId) {
      this.observation({ kind: "message", bytes: 0, type: "foreign_session" });
      if (message.type === "result" || message.type === "assistant" || message.type === "system" && message.subtype === "init") throw new Error("Claude emitted a different native session identity");
      return;
    }
    const echoed = Array.isArray(frame.user_message_uuids) ? frame.user_message_uuids : typeof frame.user_message_uuid === "string" ? [frame.user_message_uuid] : [];
    if (echoed.length && this.execution && !echoed.includes(this.execution.promptId)) { this.observation({ kind: "message", bytes: 0, type: "stale_execution" }); return; }
    if (echoed.length && this.execution && (message.type === "assistant" || message.type === "stream_event")) this.accept();
    const correlation = this.correlation();
    if ((message.type === "assistant" || message.type === "stream_event") && this.stateValue.isRetrying) {
      this.stateValue.isRetrying = false; this.stateValue.activity = "working"; this.publishState();
    }
    if (message.type === "stream_event") this.transcript.stream(frame, correlation);
    else if (message.type === "assistant") this.transcript.assistant(frame, correlation);
    else if (message.type === "user") {
      if (this.execution && frame.isReplay === true && frame.uuid === this.execution.promptId) this.accept(frame);
      this.transcript.user(frame, correlation);
    } else if (message.type === "result") {
      if (!this.execution || this.execution.result) return;
      if (typeof message.result_index === "number" && message.result_index <= this.lastResultIndex) return;
      if (typeof message.result_index === "number") this.lastResultIndex = message.result_index;
      this.execution.result = true;
      const interrupted = message.terminal_reason === "aborted_streaming" || message.terminal_reason === "aborted_tools";
      this.execution.interrupted = interrupted;
      // Native 2.1.270 can report an intentional abort as error_during_execution
      // with is_error=true. Its structured abort reason wins over that envelope;
      // unrelated native failures remain errors, even after an interrupt request.
      this.execution.error = message.is_error && !interrupted ? cleanError(message.subtype === "success" ? message.result : message.errors.join("; ")) : undefined;
      if (this.execution.error) this.emit({ type: "error", sessionId: this.sessionId, error: this.execution.error, clientMessageId: this.execution.input.clientMessageId });
      this.transcript.finish(this.execution.id, interrupted ? "interrupted" : message.is_error ? "error" : "completed", this.execution.error);
      this.stateValue.phase = "settling";
      this.stateValue.error = this.execution.error;
      this.recordUsage(message);
      this.publishState();
    } else if (message.type === "system" && message.subtype === "init") {
      if (message.claude_code_version !== CLAUDE_CODE_VERSION) throw new Error(`Unsupported Claude integration CLI version (expected ${CLAUDE_CODE_VERSION})`);
      this.stateValue.nativeSettings = { model: message.model, permissionMode: message.permissionMode, ...(message.effort ? { reasoningEffort: message.effort } : {}) };
      this.publishState();
    } else if (message.type === "system" && message.subtype === "session_state_changed") {
      if (message.state === "running" && this.execution && !this.execution.result) { this.stateValue.phase = "running"; this.stateValue.activity = "working"; this.publishState(); }
      else if (message.state === "idle" && this.execution?.result && this.approvals.requests().length === 0) this.settle();
      // A late idle from the previous execution cannot settle an unfinalized one.
    } else if (message.type === "system" && message.subtype === "status") {
      this.stateValue.isCompacting = message.status === "compacting";
      this.stateValue.activity = message.status === "compacting" ? "compacting" : this.execution ? "working" : "idle";
      if (message.permissionMode) this.stateValue.nativeSettings = { ...this.stateValue.nativeSettings, permissionMode: message.permissionMode };
      this.publishState();
    } else if (message.type === "system" && message.subtype === "api_retry") {
      this.stateValue.isRetrying = true; this.stateValue.activity = "retrying"; this.publishState();
    } else if (message.type === "system" && (message.subtype === "informational" || message.subtype === "local_command_output")) {
      this.transcript.notice(message.uuid, message.content, correlation);
    } else if (message.type === "conversation_reset") {
      throw new Error("Claude changed conversation identity; close this view and open the native session explicitly");
    } else if (message.type === "auth_status") {
      // Auth output can contain login secrets. Never forward it as transcript/debug text.
      if (message.error) this.observation({ kind: "message", bytes: 0, type: "auth_status", subtype: "authentication_error" });
    } else {
      this.observation({ kind: "message", bytes: 0, type: message.type, subtype: typeof frame.subtype === "string" ? frame.subtype : undefined });
    }
  }

  private recordUsage(message: Extract<SDKMessage, { type: "result" }>): void {
    const models = Object.values(message.modelUsage ?? {});
    const measured = models.length > 0 && models.every((model) => model &&
      [model.inputTokens, model.outputTokens, model.cacheReadInputTokens, model.cacheCreationInputTokens]
        .every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0));
    if (measured) {
      const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
      for (const model of models) {
        tokens.input += model.inputTokens; tokens.output += model.outputTokens;
        tokens.cacheRead += model.cacheReadInputTokens; tokens.cacheWrite += model.cacheCreationInputTokens;
      }
      tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
      // Fatal startup/crash results can zero running totals. Never erase known use.
      if (Number.isFinite(tokens.total) && (tokens.total || !this.observedUsage?.total)) this.observedUsage = tokens;
    }
    if (typeof message.total_cost_usd === "number" && (message.total_cost_usd > 0 || this.cost === undefined || message.subtype === "success" && message.local_command === "clear")) this.cost = finite(message.total_cost_usd);
  }

  private settle(): void {
    if (!this.execution) return;
    this.stateValue.phase = this.execution.error ? "error" : "idle";
    this.stateValue.activity = "idle";
    this.stateValue.isStreaming = false; this.stateValue.isRetrying = false; this.stateValue.isCompacting = false;
    this.stateValue.activeExecution = undefined;
    this.execution = undefined;
    this.publishState();
    const nativeId = this.stateValue.nativeSession.sessionId;
    const generation = this.generation;
    if (nativeId && this.stateValue.nativeSession.persistence === "persistent") {
      void (this.options.sessionApi ?? sessions).getSessionInfo(nativeId, { dir: this.stateValue.cwd }).then((info) => {
        if (info && !this.disposed && generation === this.generation) { this.stateValue.nativeSession.status = "resumable"; this.publishState(); }
      }).catch(() => this.observation({ kind: "message", bytes: 0, type: "history", subtype: "verification_failed" }));
    }
  }

  private fail(error: unknown): void {
    if (this.disposed || !this.execution && this.stateValue.phase === "unavailable") return;
    const execution = this.execution;
    if (execution) this.transcript.finish(execution.id, execution.interrupted ? "interrupted" : "error", cleanError(error));
    this.execution = undefined;
    this.stateValue.activeExecution = undefined;
    const ephemeral = this.stateValue.nativeSession.persistence === "ephemeral";
    // Model-result errors may leave a healthy query usable. This path tears the
    // query down: mark transport loss unavailable so explicit service.open()
    // replaces the handle using authoritative SDK history, never stale memory.
    this.stateValue.phase = ephemeral || this.query ? "unavailable" : "error"; this.stateValue.activity = "idle"; this.stateValue.error = cleanError(error);
    if (ephemeral) this.stateValue.nativeSession.status = "unavailable";
    this.stateValue.isStreaming = false; this.stateValue.isRetrying = false; this.stateValue.isCompacting = false;
    this.approvals.cancel("disposed");
    this.input?.end();
    this.query?.close();
    if (!execution?.result || !execution.error) this.emit({ type: "error", sessionId: this.sessionId, error: cleanError(error), clientMessageId: execution?.input.clientMessageId });
    this.publishState();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.execution = undefined;
    this.stateValue.activeExecution = undefined;
    this.stateValue.phase = "unavailable";
    this.stateValue.activity = "idle";
    this.stateValue.isStreaming = false;
    if (this.stateValue.nativeSession.persistence === "ephemeral") this.stateValue.nativeSession.status = "unavailable";
    this.approvals.cancel("disposed");
    this.input?.end();
    this.query?.close();
    await this.reading;
    this.listeners.clear();
  }
}
