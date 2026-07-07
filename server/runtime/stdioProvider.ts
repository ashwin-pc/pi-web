import { join } from "node:path";
import { StdioRuntimeClient } from "./stdioClient.js";
import type { RuntimeEvent } from "./protocol.js";

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
  messages: number;
};

export class StdioRunnerProvider {
  readonly id: string;
  readonly label: string;
  private client?: StdioRuntimeClient;
  private sessionFiles = new Map<string, { sessionFile: string; cwd?: string }>();

  constructor(options: { id?: string; label?: string; cwd: string }) {
    this.id = options.id || "local-runner";
    this.label = options.label || "Local runner process";
    this.cwd = options.cwd;
  }

  readonly cwd: string;

  start(): StdioRuntimeClient {
    if (this.client && !this.client.isClosed) return this.client;
    this.client = new StdioRuntimeClient(process.execPath, ["--import", "tsx", join(process.cwd(), "server", "runner.ts")], {
      cwd: process.cwd(),
      env: { ...process.env, PI_RUNNER_CWD: this.cwd },
    });
    return this.client;
  }

  stop(): void {
    this.client?.close();
    this.client = undefined;
  }

  health() {
    return this.start().request("health", undefined, 30_000);
  }

  listDirectories(path = this.cwd) {
    return this.start().request("fs.list", { path });
  }

  gitStatus(cwd = this.cwd) {
    return this.start().request("git.status", { cwd });
  }

  gitDiff(options: { cwd?: string; path: string; staged?: boolean }) {
    return this.start().request("git.diff", { cwd: options.cwd || this.cwd, path: options.path, staged: Boolean(options.staged) });
  }

  readArtifactBase64(cwd: string, name: string) {
    return this.start().request<{ ok: true; name: string; base64: string }>("artifacts.readBase64", { cwd, name });
  }

  async createSession(cwd = this.cwd) {
    const state = await this.start().request<RunnerSessionState>("sessions.create", { cwd }, 30_000);
    this.rememberSession(state.sessionId, state.sessionFile, state.cwd);
    return state;
  }

  rememberSession(sessionId: string, sessionFile?: string, cwd?: string): void {
    if (sessionId && sessionFile) this.sessionFiles.set(sessionId, { sessionFile, cwd });
  }

  private sessionParams(sessionId: string) {
    const remembered = this.sessionFiles.get(sessionId);
    return { sessionId, sessionFile: remembered?.sessionFile, cwd: remembered?.cwd || this.cwd };
  }

  state(sessionId: string) {
    return this.start().request<RunnerSessionState>("sessions.state", this.sessionParams(sessionId));
  }

  messages(sessionId: string) {
    return this.start().request("sessions.messages", this.sessionParams(sessionId));
  }

  prompt(sessionId: string, message: string) {
    return this.start().request("sessions.prompt", { ...this.sessionParams(sessionId), message }, 30_000);
  }

  abort(sessionId: string) {
    return this.start().request("sessions.abort", this.sessionParams(sessionId));
  }

  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    return this.start().onEvent(listener);
  }
}
