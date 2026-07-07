import { resolve } from "node:path";
import { CommandRunnerProvider, type RuntimeRunnerConfig } from "./commandProvider.js";

export type DockerRunnerOptions = {
  id?: string;
  label?: string;
  image?: string;
  hostWorkspace: string;
  containerWorkspace?: string;
  appDir: string;
  envAllowlist?: string[];
  network?: "none" | "bridge";
  readOnly?: boolean;
};

function dockerArgs(options: Required<Pick<DockerRunnerOptions, "image" | "hostWorkspace" | "containerWorkspace" | "appDir" | "network" | "readOnly" | "envAllowlist">>): string[] {
  const workspaceMode = options.readOnly ? "ro" : "rw";
  const args = [
    "run", "--rm", "-i",
    "--network", options.network,
    "-v", `${options.appDir}:/app:ro`,
    "-v", `${options.hostWorkspace}:${options.containerWorkspace}:${workspaceMode}`,
    "-w", "/app",
    "-e", `PI_RUNNER_CWD=${options.containerWorkspace}`,
  ];
  for (const name of options.envAllowlist) {
    if (/^[A-Z_][A-Z0-9_]*$/i.test(name) && process.env[name]) args.push("-e", name);
  }
  args.push(options.image, "sh", "-lc", "npm exec --yes tsx server/runner.ts");
  return args;
}

function dockerRunnerConfig(options: DockerRunnerOptions): RuntimeRunnerConfig & Required<Pick<DockerRunnerOptions, "image" | "hostWorkspace" | "containerWorkspace" | "appDir" | "network" | "readOnly" | "envAllowlist">> {
  const normalized = {
    id: options.id || "docker-workspace",
    label: options.label || "Docker workspace",
    image: options.image || "node:22-bookworm-slim",
    hostWorkspace: resolve(options.hostWorkspace),
    containerWorkspace: options.containerWorkspace || "/workspace",
    appDir: resolve(options.appDir),
    network: options.network || "none" as const,
    readOnly: Boolean(options.readOnly),
    envAllowlist: options.envAllowlist || ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
  };
  return {
    ...normalized,
    command: "docker",
    args: dockerArgs(normalized),
    cwd: normalized.containerWorkspace,
    processCwd: normalized.appDir,
    kind: "container",
    disconnectable: false,
    metadata: {
      workspace: normalized.containerWorkspace,
      hostWorkspace: normalized.hostWorkspace,
      image: normalized.image,
      network: normalized.network,
      readOnly: normalized.readOnly,
    },
  };
}

export class DockerRunnerProvider extends CommandRunnerProvider {
  readonly hostWorkspace: string;
  readonly containerWorkspace: string;
  readonly image: string;
  readonly network: "none" | "bridge";
  readonly readOnly: boolean;

  constructor(options: DockerRunnerOptions) {
    const config = dockerRunnerConfig(options);
    super(config);
    this.hostWorkspace = config.hostWorkspace;
    this.containerWorkspace = config.containerWorkspace;
    this.image = config.image;
    this.network = config.network;
    this.readOnly = config.readOnly;
  }

  dockerArgs(): string[] {
    return [...this.args];
  }
}
