import { StdioRuntimeClient } from "./stdioClient.js";
import type { RuntimeEvent } from "./protocol.js";
import type { RunnerSessionState } from "./stdioProvider.js";

export type CommandRunnerConfig = {
  id: string;
  label: string;
  command: string;
  args: string[];
  cwd: string;
  processCwd?: string;
  kind?: "local" | "container" | "ssh";
};

export class CommandRunnerProvider {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly args: string[];
  readonly cwd: string;
  readonly processCwd?: string;
  readonly kind: "local" | "container" | "ssh";
  private client?: StdioRuntimeClient;
  private sessionFiles = new Map<string, { sessionFile: string; cwd?: string }>();

  constructor(config: CommandRunnerConfig) {
    this.id = config.id;
    this.label = config.label;
    this.command = config.command;
    this.args = config.args;
    this.cwd = config.cwd;
    this.processCwd = config.processCwd;
    this.kind = config.kind || "container";
  }

  start(): StdioRuntimeClient {
    if (this.client && !this.client.isClosed) return this.client;
    this.client = new StdioRuntimeClient(this.command, this.args, { cwd: this.processCwd || process.cwd(), env: process.env });
    return this.client;
  }

  stop(): void {
    this.client?.close();
    this.client = undefined;
  }

  health() { return this.start().request("health", undefined, 30_000); }
  listDirectories(path = this.cwd) { return this.start().request("fs.list", { path }); }
  async createSession(cwd = this.cwd) {
    const state = await this.start().request<RunnerSessionState>("sessions.create", { cwd }, 30_000);
    this.rememberSession(state.sessionId, state.sessionFile, state.cwd);
    return state;
  }
  rememberSession(sessionId: string, sessionFile?: string, cwd?: string): void { if (sessionId && sessionFile) this.sessionFiles.set(sessionId, { sessionFile, cwd }); }
  private sessionParams(sessionId: string) { const remembered = this.sessionFiles.get(sessionId); return { sessionId, sessionFile: remembered?.sessionFile, cwd: remembered?.cwd || this.cwd }; }
  state(sessionId: string) { return this.start().request<RunnerSessionState>("sessions.state", this.sessionParams(sessionId)); }
  messages(sessionId: string) { return this.start().request("sessions.messages", this.sessionParams(sessionId)); }
  prompt(sessionId: string, message: string) { return this.start().request("sessions.prompt", { ...this.sessionParams(sessionId), message }, 30_000); }
  abort(sessionId: string) { return this.start().request("sessions.abort", this.sessionParams(sessionId)); }
  gitStatus(cwd = this.cwd) { return this.start().request("git.status", { cwd }); }
  gitDiff(options: { cwd?: string; path: string; staged?: boolean }) { return this.start().request("git.diff", { cwd: options.cwd || this.cwd, path: options.path, staged: Boolean(options.staged) }); }
  readArtifactBase64(cwd: string, name: string) { return this.start().request<{ ok: true; name: string; base64: string }>("artifacts.readBase64", { cwd, name }); }
  onEvent(listener: (event: RuntimeEvent) => void): () => void { return this.start().onEvent(listener); }

  toConfig(): CommandRunnerConfig {
    return { id: this.id, label: this.label, command: this.command, args: this.args, cwd: this.cwd, processCwd: this.processCwd, kind: this.kind };
  }
}
