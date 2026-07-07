import { resolve } from "node:path";
import { StdioRuntimeClient } from "./stdioClient.js";
import type { RuntimeEvent } from "./protocol.js";

export type DockerRunnerOptions = {
  id?: string;
  label?: string;
  image?: string;
  hostWorkspace: string;
  containerWorkspace?: string;
  appDir: string;
  token?: string;
  envAllowlist?: string[];
  network?: "none" | "bridge";
  readOnly?: boolean;
};

export class DockerRunnerProvider {
  readonly id: string;
  readonly label: string;
  readonly hostWorkspace: string;
  readonly containerWorkspace: string;
  readonly image: string;
  readonly cwd: string;
  readonly network: "none" | "bridge";
  readonly readOnly: boolean;
  private client?: StdioRuntimeClient;
  private sessionFiles = new Map<string, { sessionFile: string; cwd?: string }>();
  private readonly appDir: string;
  private readonly token?: string;
  private readonly envAllowlist: string[];

  constructor(options: DockerRunnerOptions) {
    this.id = options.id || "docker-workspace";
    this.label = options.label || "Docker workspace";
    this.hostWorkspace = resolve(options.hostWorkspace);
    this.containerWorkspace = options.containerWorkspace || "/workspace";
    this.image = options.image || "node:22-bookworm-slim";
    this.cwd = this.containerWorkspace;
    this.network = options.network || "none";
    this.readOnly = Boolean(options.readOnly);
    this.appDir = resolve(options.appDir);
    this.token = options.token;
    this.envAllowlist = options.envAllowlist || ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"];
  }

  start(): StdioRuntimeClient {
    if (this.client && !this.client.isClosed) return this.client;
    this.client = new StdioRuntimeClient("docker", this.dockerArgs(), { cwd: this.appDir, env: process.env });
    return this.client;
  }

  stop(): void {
    this.client?.close();
    this.client = undefined;
  }

  health() { return this.start().request("health"); }
  listDirectories(path = this.containerWorkspace) { return this.start().request("fs.list", { path }); }
  async createSession(cwd = this.containerWorkspace) {
    const state = await this.start().request<any>("sessions.create", { cwd }, 30_000);
    this.rememberSession(state.sessionId, state.sessionFile, state.cwd);
    return state;
  }
  rememberSession(sessionId: string, sessionFile?: string, cwd?: string): void { if (sessionId && sessionFile) this.sessionFiles.set(sessionId, { sessionFile, cwd }); }
  private sessionParams(sessionId: string) { const remembered = this.sessionFiles.get(sessionId); return { sessionId, sessionFile: remembered?.sessionFile, cwd: remembered?.cwd || this.containerWorkspace }; }
  state(sessionId: string) { return this.start().request("sessions.state", this.sessionParams(sessionId)); }
  messages(sessionId: string) { return this.start().request("sessions.messages", this.sessionParams(sessionId)); }
  prompt(sessionId: string, message: string) { return this.start().request("sessions.prompt", { ...this.sessionParams(sessionId), message }, 30_000); }
  abort(sessionId: string) { return this.start().request("sessions.abort", this.sessionParams(sessionId)); }
  gitStatus(cwd = this.containerWorkspace) { return this.start().request("git.status", { cwd }); }
  gitDiff(options: { cwd?: string; path: string; staged?: boolean }) { return this.start().request("git.diff", { cwd: options.cwd || this.containerWorkspace, path: options.path, staged: Boolean(options.staged) }); }
  readArtifactBase64(cwd: string, name: string) { return this.start().request<{ ok: true; name: string; base64: string }>("artifacts.readBase64", { cwd, name }); }
  onEvent(listener: (event: RuntimeEvent) => void): () => void { return this.start().onEvent(listener); }

  dockerArgs(): string[] {
    const workspaceMode = this.readOnly ? "ro" : "rw";
    const args = [
      "run", "--rm", "-i",
      "--network", this.network,
      "-v", `${this.appDir}:/app:ro`,
      "-v", `${this.hostWorkspace}:${this.containerWorkspace}:${workspaceMode}`,
      "-w", "/app",
      "-e", `PI_RUNNER_CWD=${this.containerWorkspace}`,
    ];
    if (this.token) args.push("-e", "PI_WEB_TOKEN");
    for (const name of this.envAllowlist) {
      if (/^[A-Z_][A-Z0-9_]*$/i.test(name) && process.env[name]) args.push("-e", name);
    }
    args.push(this.image, "sh", "-lc", "npm exec --yes tsx server/runner.ts");
    return args;
  }
}
