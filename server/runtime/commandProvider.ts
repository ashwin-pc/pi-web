import { StdioRuntimeClient } from "./stdioClient.js";
import type { RuntimeEvent, RuntimeRequestHandler } from "./protocol.js";

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

export type RunnerSessionInfo = {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  sessionName?: string;
  firstMessage?: string;
  created: string;
  modified: string;
  messages: number;
  isStreaming: boolean;
  isCompacting: boolean;
};

export type RunnerSessionList = {
  ok: true;
  sessions: RunnerSessionInfo[];
  nextCursor?: string;
  total: number;
};

export type RuntimeRunnerMetadata = {
  workspace?: string;
  hostWorkspace?: string;
  image?: string;
  network?: string;
  readOnly?: boolean;
  sessionPersistence?: "runtime" | "volume" | "disposable";
  sessionVolume?: string;
  modelTransport?: "runtime" | "host-broker";
  networkPolicy?: "none" | "provider-only" | "unrestricted" | "unverified";
};

export type CommandRunnerConfig = {
  id: string;
  label: string;
  command: string;
  args: string[];
  cwd: string;
  processCwd?: string;
  agentDir?: string;
  kind?: RuntimeKind;
  modelBroker?: boolean;
  network?: string;
  networkPolicy?: RuntimeRunnerMetadata["networkPolicy"];
};

export type RuntimeRunnerConfig = CommandRunnerConfig & {
  env?: NodeJS.ProcessEnv;
  disconnectable?: boolean;
  experimental?: boolean;
  metadata?: RuntimeRunnerMetadata;
  blockedReason?: string;
};

export type RuntimeProviderStatus = {
  state: "connecting" | "connected" | "disconnected";
  attempt: number;
  error?: string;
};

export class CommandRunnerProvider {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly args: string[];
  readonly cwd: string;
  readonly processCwd?: string;
  readonly agentDir?: string;
  readonly kind: RuntimeKind;
  readonly disconnectable: boolean;
  readonly experimental: boolean;
  readonly metadata: RuntimeRunnerMetadata;
  readonly modelBroker: boolean;
  private readonly env?: NodeJS.ProcessEnv;
  private runtimeRequestHandlerFactory?: () => RuntimeRequestHandler;
  private client?: StdioRuntimeClient;
  private sessionFiles = new Map<string, { sessionFile: string; cwd?: string }>();
  private subscribedSessionIds = new Set<string>();
  private desiredSubscriptionIds = new Set<string>();
  private eventListeners = new Set<(event: RuntimeEvent) => void>();
  private statusListeners = new Set<(status: RuntimeProviderStatus) => void>();
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempt = 0;
  private stopped = false;
  private currentStatus: RuntimeProviderStatus;
  private readonly blockedReason?: string;

  get status(): RuntimeProviderStatus {
    return { ...this.currentStatus };
  }

  constructor(config: RuntimeRunnerConfig) {
    this.id = config.id;
    this.label = config.label;
    this.command = config.command;
    this.modelBroker = config.modelBroker ?? (config.kind === "container");
    this.args = this.modelBroker ? config.args.map((arg) => enableBrokerInRunnerCommand(arg)) : config.args;
    this.cwd = config.cwd;
    this.processCwd = config.processCwd;
    this.agentDir = config.agentDir;
    this.kind = config.kind || "container";
    this.disconnectable = config.disconnectable ?? true;
    this.experimental = Boolean(config.experimental);
    this.blockedReason = config.blockedReason;
    this.currentStatus = { state: "disconnected", attempt: 0, ...(this.blockedReason ? { error: this.blockedReason } : {}) };
    this.metadata = {
      ...(config.metadata || {}),
      ...(config.network ? { network: config.network } : {}),
      networkPolicy: config.networkPolicy || config.metadata?.networkPolicy || (config.kind === "container" ? "unverified" : undefined),
      modelTransport: this.modelBroker ? "host-broker" : (config.metadata?.modelTransport || "runtime"),
    };
    this.env = config.agentDir
      ? { ...(config.env || process.env), PI_CODING_AGENT_DIR: config.agentDir }
      : config.env;
  }

  start(): StdioRuntimeClient {
    if (this.blockedReason) throw new Error(this.blockedReason);
    if (this.client && !this.client.isClosed) return this.client;
    this.stopped = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.emitStatus({ state: "connecting", attempt: this.reconnectAttempt });
    const client = new StdioRuntimeClient(this.command, this.args, {
      cwd: this.processCwd || process.cwd(),
      env: this.env || process.env,
      runtimeRequestHandler: this.runtimeRequestHandlerFactory?.(),
    });
    this.client = client;
    this.subscribedSessionIds.clear();
    client.onEvent((event) => {
      for (const listener of this.eventListeners) listener(event);
    });
    client.onClose((error) => this.handleClientClose(client, error));
    void client.request("health", undefined, 30_000).then(() => {
      if (this.client !== client || client.isClosed) return;
      this.reconnectAttempt = 0;
      this.emitStatus({ state: "connected", attempt: 0 });
      void this.restoreSubscriptions(client);
    }).catch(() => undefined);
    return client;
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const client = this.client;
    this.client = undefined;
    client?.close();
    this.subscribedSessionIds.clear();
    this.desiredSubscriptionIds.clear();
  }

  private async restoreSubscriptions(client: StdioRuntimeClient) {
    for (const sessionId of this.desiredSubscriptionIds) {
      if (this.client !== client || client.isClosed) return;
      try {
        await client.request("sessions.subscribe", this.sessionParams(sessionId));
        this.subscribedSessionIds.add(sessionId);
      } catch (error) {
        console.warn(`Failed to restore runtime session subscription ${sessionId}:`, error);
      }
    }
  }

  private handleClientClose(client: StdioRuntimeClient, error: Error) {
    if (this.client !== client) return;
    this.client = undefined;
    this.subscribedSessionIds.clear();
    this.emitStatus({ state: "disconnected", attempt: this.reconnectAttempt, error: error.message });
    if (this.stopped) return;
    this.reconnectAttempt += 1;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.reconnectAttempt - 1, 6));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.stopped) this.start();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private emitStatus(status: RuntimeProviderStatus) {
    this.currentStatus = status;
    for (const listener of this.statusListeners) listener(status);
  }

  setRuntimeRequestHandlerFactory(factory: (() => RuntimeRequestHandler) | undefined): void {
    this.runtimeRequestHandlerFactory = factory;
  }

  health() { return this.start().request("health", undefined, 30_000); }
  listDirectories(path = this.cwd) { return this.start().request("fs.list", { path }); }

  async listSessions(options: { limit?: number; cursor?: string } = {}) {
    const result = await this.start().request<RunnerSessionList>("sessions.list", options, 30_000);
    for (const item of result.sessions) this.rememberSession(item.sessionId, item.sessionFile, item.cwd);
    return result;
  }

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
    if (!sessionId) return { ok: true, sessionId };
    this.desiredSubscriptionIds.add(sessionId);
    if (this.subscribedSessionIds.has(sessionId)) return { ok: true, sessionId };
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
    this.desiredSubscriptionIds.delete(sessionId);
    return this.start().request("sessions.release", this.sessionParams(sessionId)).catch(() => ({ ok: true, sessionId }));
  }

  async deleteSession(sessionId: string) {
    const result = await this.start().request("sessions.delete", this.sessionParams(sessionId));
    this.subscribedSessionIds.delete(sessionId);
    this.desiredSubscriptionIds.delete(sessionId);
    this.sessionFiles.delete(sessionId);
    return result;
  }

  abort(sessionId: string) { return this.start().request("sessions.abort", this.sessionParams(sessionId)); }
  conversationTree(sessionId: string) { return this.start().request("sessions.tree", this.sessionParams(sessionId)); }
  navigateTree(sessionId: string, options: Record<string, unknown>) { return this.start().request("sessions.tree.navigate", { ...this.sessionParams(sessionId), ...options }, 120_000); }
  abortBranchSummary(sessionId: string) { return this.start().request("sessions.tree.abortSummary", this.sessionParams(sessionId)); }
  gitStatus(cwd = this.cwd, fetchRemote = false) { return this.start().request("git.status", { cwd, fetchRemote }); }
  gitDiff(options: { cwd?: string; path: string; staged?: boolean }) { return this.start().request("git.diff", { cwd: options.cwd || this.cwd, path: options.path, staged: Boolean(options.staged) }); }
  readArtifactBase64(cwd: string, name: string) { return this.start().request<{ ok: true; name: string; base64: string }>("artifacts.readBase64", { cwd, name }); }
  listModels(sessionId: string) { return this.start().request("models.list", this.sessionParams(sessionId)); }
  setModel(sessionId: string, provider: string, id: string, thinkingLevel?: string) { return this.start().request("models.set", { ...this.sessionParams(sessionId), provider, id, thinkingLevel }); }
  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.eventListeners.add(listener);
    this.start();
    return () => this.eventListeners.delete(listener);
  }
  onStatus(listener: (status: RuntimeProviderStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  toConfig(): CommandRunnerConfig {
    return { id: this.id, label: this.label, command: this.command, args: this.args, cwd: this.cwd, processCwd: this.processCwd, agentDir: this.agentDir, kind: this.kind, modelBroker: this.modelBroker, network: this.metadata.network, networkPolicy: this.metadata.networkPolicy };
  }
}

function enableBrokerInRunnerCommand(value: string): string {
  if (!value.includes("server/runner") || value.includes("PI_RUNNER_MODEL_BROKER=")) return value;
  return value.replace(/\bnpm\s+exec\b/, "PI_RUNNER_MODEL_BROKER=1 npm exec");
}
