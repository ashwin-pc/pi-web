import { join } from "node:path";
import { CommandRunnerProvider, type RunnerSessionState } from "./commandProvider.js";

export type { RunnerSessionState };

export class StdioRunnerProvider extends CommandRunnerProvider {
  constructor(options: { id?: string; label?: string; cwd: string; agentDir?: string }) {
    super({
      id: options.id || "local-runner",
      label: options.label || "Local runner process",
      command: process.execPath,
      args: ["--import", "tsx", join(process.cwd(), "server", "runner.ts")],
      cwd: options.cwd,
      processCwd: process.cwd(),
      env: { ...process.env, PI_RUNNER_CWD: options.cwd, ...(options.agentDir ? { PI_CODING_AGENT_DIR: options.agentDir } : {}) },
      kind: "local",
      modelBroker: false,
      disconnectable: false,
      experimental: true,
    });
  }
}
