import { StdioRuntimeClient } from "./stdioClient.js";
import type { RuntimeEvent } from "./protocol.js";

export type RuntimeKind = "local" | "container" | "ssh";

export type RunnerSessionState = {
  ok: true;
  sessionId: string;
  sessionFile: string;
  cwd: string;
  sessionName?: string;
  firstMessage?: string;
  isStreaming: boolean;
  isCompacting: boolean;
  model: { provider?: string; id?: string; name?: string } | null;
  thinkingLevel?: string;
  thinkingLevels?: string[];
  messages: number;
};

export type RuntimeRunnerMetadata = {
  workspace?: string;
  hostWorkspace?: string;
  image?: string;
  network?: string;
  readOnly?: boolean;
};

export type CommandRunnerConfig = {
  id: string;
  label: string;
  command: string;
  args: string[];
  cwd: string;
  processCwd?: string;
  kind?: RuntimeKind;
};

export type RuntimeRunnerConfig = CommandRunnerConfig & {
  env?: NodeJS.ProcessEnv;
  disconnectable?: boolean;
  experimental?: boolean;
  metadata?: RuntimeRunnerMetadata;
};

export class CommandRunnerProvider {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly args: string[];
  readonly cwd: string;
  readonly processCwd?: string;
  readonly kind: RuntimeKind;
  readonly disconnectable: boolean;
  readonly experimental: boolean;
  readonly metadata: RuntimeRunnerMetadata;
  private readonly env?: NodeJS.ProcessEnv;
  private client?: StdioRuntimeClient;
  private sessionFiles = new Map<string, { sessionFile: string; cwd?: string }>();
  private subscribedSessionIds = new Set<string>();

  constructor(config: RuntimeRunnerConfig) {
    this.id = config.id;
    this.label = config.label;
    this.command = config.command;
    this.args = config.args;
    this.cwd = config.cwd;
    this.processCwd = config.processCwd;
    this.kind = config.kind || "container";
    this.disconnectable = config.disconnectable ?? true;
    this.experimental = Boolean(config.experimental);
    this.metadata = config.metadata || {};
    this.env = config.env;
  }

  start(): StdioRuntimeClient {
    if (this.client && !this.client.isClosed) return this.client;
    this.client = new StdioRuntimeClient(this.command, this.args, { cwd: this.processCwd || process.cwd(), env: this.env || process.env });
    this.subscribedSessionIds.clear();
    return this.client;
  }

  stop(): void {
    this.client?.close();
    this.client = undefined;
    this.subscribedSessionIds.clear();
  }

  health() { return this.start().request("health", undefined, 30_000); }
  listDirectories(path = this.cwd) { return this.start().request("fs.list", { path }); }

  async createSession(cwd = this.cwd) {
    const state = await this.start().request<RunnerSessionState>("sessions.create", { cwd }, 30_000);
    this.rememberSession(state.sessionId, state.sessionFile, state.cwd);
    void this.subscribe(state.sessionId).catch((error) => console.warn(`Failed to subscribe runtime session ${state.sessionId}:`, error));
    return state;
  }

  rememberSession(sessionId: string, sessionFile?: string, cwd?: string): void {
    if (sessionId && sessionFile) this.sessionFiles.set(sessionId, { sessionFile, cwd });
  }

  private sessionParams(sessionId: string) {
    const remembered = this.sessionFiles.get(sessionId);
    return { sessionId, sessionFile: remembered?.sessionFile, cwd: remembered?.cwd || this.cwd };
  }

  async subscribe(sessionId: string) {
    if (!sessionId || this.subscribedSessionIds.has(sessionId)) return { ok: true, sessionId };
    const result = await this.start().request<{ ok: true; sessionId: string }>("sessions.subscribe", this.sessionParams(sessionId));
    this.subscribedSessionIds.add(sessionId);
    return result;
  }

  async state(sessionId: string) {
    const state = await this.start().request<RunnerSessionState>("sessions.state", this.sessionParams(sessionId));
    this.rememberSession(state.sessionId, state.sessionFile, state.cwd);
    void this.subscribe(state.sessionId).catch((error) => console.warn(`Failed to subscribe runtime session ${state.sessionId}:`, error));
    return state;
  }

  messages(sessionId: string) { return this.start().request("sessions.messages", this.sessionParams(sessionId)); }

  async prompt(sessionId: string, message: string, images?: unknown[]) {
    await this.subscribe(sessionId).catch((error) => console.warn(`Failed to subscribe runtime session ${sessionId}:`, error));
    const timeout = images?.length ? 120_000 : 30_000;
    return this.start().request("sessions.prompt", { ...this.sessionParams(sessionId), message, images: images || [] }, timeout);
  }

  release(sessionId: string) {
    this.subscribedSessionIds.delete(sessionId);
    return this.start().request("sessions.release", this.sessionParams(sessionId)).catch(() => ({ ok: true, sessionId }));
  }

  async deleteSession(sessionId: string) {
    const result = await this.start().request("sessions.delete", this.sessionParams(sessionId));
    this.subscribedSessionIds.delete(sessionId);
    this.sessionFiles.delete(sessionId);
    return result;
  }

  abort(sessionId: string) { return this.start().request("sessions.abort", this.sessionParams(sessionId)); }
  gitStatus(cwd = this.cwd, fetchRemote = false) { return this.start().request("git.status", { cwd, fetchRemote }); }
  gitDiff(options: { cwd?: string; path: string; staged?: boolean }) { return this.start().request("git.diff", { cwd: options.cwd || this.cwd, path: options.path, staged: Boolean(options.staged) }); }
  readArtifactBase64(cwd: string, name: string) { return this.start().request<{ ok: true; name: string; base64: string }>("artifacts.readBase64", { cwd, name }); }
  listModels(sessionId: string) { return this.start().request("models.list", this.sessionParams(sessionId)); }
  setModel(sessionId: string, provider: string, id: string, thinkingLevel?: string) { return this.start().request("models.set", { ...this.sessionParams(sessionId), provider, id, thinkingLevel }); }
  onEvent(listener: (event: RuntimeEvent) => void): () => void { return this.start().onEvent(listener); }

  toConfig(): CommandRunnerConfig {
    return { id: this.id, label: this.label, command: this.command, args: this.args, cwd: this.cwd, processCwd: this.processCwd, kind: this.kind };
  }
}
