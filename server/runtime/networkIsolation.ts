import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ContainerAdapter = "apple" | "docker" | "podman";
type CommandResult = { stdout: string };
type RunCommand = (command: string, args: string[]) => Promise<CommandResult>;

function parseJson(value: string, description: string): any {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Could not parse ${description}`);
  }
}

function first(value: any): any {
  return Array.isArray(value) ? value[0] : value;
}

function attachedNetworkNames(adapter: ContainerAdapter, inspect: any): string[] {
  const item = first(inspect) || {};
  if (adapter === "apple") {
    const networks = item?.status?.networks || item?.configuration?.networks || [];
    return networks.map((network: any) => String(network?.network || "")).filter(Boolean);
  }
  const mode = String(item?.HostConfig?.NetworkMode || item?.hostConfig?.networkMode || "");
  if (mode === "none") return ["none"];
  const networks = item?.NetworkSettings?.Networks || item?.networkSettings?.networks || {};
  return Object.keys(networks);
}

function isInternalNetwork(adapter: ContainerAdapter, name: string, inspect: any): boolean {
  if (name === "none") return true;
  const item = first(inspect) || {};
  return adapter === "apple" && item?.configuration?.mode === "hostOnly";
}

export function guidedContainerTarget(config: { command: string; args: string[]; kind?: string }): { adapter: ContainerAdapter; target: string } | undefined {
  if (config.kind !== "container" || config.args[0] !== "exec") return undefined;
  const executable = config.command.split(/[\\/]/).at(-1);
  const adapter = executable === "container" ? "apple" : executable === "docker" || executable === "podman" ? executable : undefined;
  if (!adapter) return undefined;
  for (let index = 1; index < config.args.length; index += 1) {
    const arg = config.args[index];
    if (arg === "-i" || arg === "--interactive" || arg === "-t" || arg === "--tty") continue;
    if (arg === "-e" || arg === "--env" || arg === "--env-file" || arg === "-u" || arg === "--user" || arg === "-w" || arg === "--workdir" || arg === "--cwd") {
      index += 1;
      continue;
    }
    if (!arg.startsWith("-")) return { adapter, target: arg };
  }
  return undefined;
}

function inspectBasics(adapter: ContainerAdapter, target: string, containerInspect: any) {
  const container = first(containerInspect) || {};
  const networks = attachedNetworkNames(adapter, containerInspect);
  if (networks.length === 0) throw new Error("Container network isolation could not be verified");
  const mounts = adapter === "apple" ? container?.configuration?.mounts : container?.Mounts || container?.mounts;
  if (/docker\.sock|podman\.sock/i.test(JSON.stringify(mounts || []))) {
    throw new Error(`Container ${target} exposes a container-engine socket mount and cannot be treated as isolated.`);
  }
  if (adapter !== "apple" && (networks.length !== 1 || networks[0] !== "none")) {
    throw new Error(`Container ${target} must use --network none. Internal bridge DNS can still provide an egress channel.`);
  }
  if (adapter === "apple" && container?.configuration?.dns != null) {
    throw new Error(`Container ${target} must be created with --no-dns as well as an internal network.`);
  }
  return { container, networks };
}

function isolationResult(adapter: ContainerAdapter, target: string, container: any, networks: string[]) {
  const containerId = String(container?.Id || container?.id || container?.configuration?.id || target).trim();
  if (!containerId) throw new Error(`Container ${target} identity could not be verified`);
  return { network: networks.join(", "), networkPolicy: adapter === "apple" ? "host-only" as const : "none" as const, containerId, networkVerifiedAt: new Date().toISOString() };
}

/** Verify the container immediately before attaching the runner transport. */
export function verifyGuidedContainerIsolationSync(adapter: ContainerAdapter, target: string, commandOverride?: string) {
  const command = commandOverride || (adapter === "apple" ? "container" : adapter);
  const run = (args: string[]) => parseJson(String(execFileSync(command, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })), `${adapter} inspection`);
  const { container, networks } = inspectBasics(adapter, target, run(["inspect", target]));
  for (const network of networks) {
    if (network === "none") continue;
    if (!isInternalNetwork(adapter, network, run(["network", "inspect", network]))) {
      throw new Error(`Container ${target} has internet-capable network ${network}.`);
    }
  }
  return isolationResult(adapter, target, container, networks);
}

/**
 * Refuse managed container connections unless every attached network has no
 * internet route. Model traffic does not need container egress because it is
 * carried by the host model broker.
 */
export async function verifyGuidedContainerIsolation(
  adapter: ContainerAdapter,
  target: string,
  run: RunCommand = async (command, args) => execFileAsync(command, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }),
  commandOverride?: string,
): Promise<{ network: string; networkPolicy: "none" | "host-only"; containerId: string }> {
  const command = commandOverride || (adapter === "apple" ? "container" : adapter);
  const containerInspect = parseJson((await run(command, ["inspect", target])).stdout, `${adapter} container inspection`);
  const { container, networks } = inspectBasics(adapter, target, containerInspect);

  for (const network of networks) {
    if (network === "none") continue;
    const networkInspect = parseJson((await run(command, ["network", "inspect", network])).stdout, `${adapter} network inspection`);
    if (!isInternalNetwork(adapter, network, networkInspect)) {
      const hint = adapter === "apple"
        ? "Recreate it on a network created with `container network create --internal <name>`."
        : "Recreate it with --network none.";
      throw new Error(`Container ${target} has internet-capable network ${network}. ${hint}`);
    }
  }
  return isolationResult(adapter, target, container, networks);
}
