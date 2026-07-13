import type { ApiClient } from "../app/api.js";
import type { RuntimeRef } from "../app/types.js";

export type RuntimeOption = RuntimeRef & {
  id: string;
  command?: string;
  args?: string[];
  processCwd?: string;
  workspace?: string;
  network?: string;
  readOnly?: boolean;
  sessionPersistence?: "runtime" | "volume" | "disposable";
  sessionVolume?: string;
  connection?: { state: "connecting" | "connected" | "disconnected"; attempt?: number; error?: string };
  disconnectable?: boolean;
};

export type RuntimeConfig = {
  id: string;
  label: string;
  kind?: "local" | "container" | "ssh";
  command: string;
  args: string[];
  cwd: string;
  processCwd?: string;
};

export type GuidedRuntimeConfig = {
  id: string;
  label: string;
  adapter: "apple" | "docker" | "podman" | "ssh";
  target: string;
  cwd: string;
  runnerDir: string;
};

export type RuntimeConnectConfig = RuntimeConfig | GuidedRuntimeConfig;

export function localRuntimeRef(cwd = ""): RuntimeOption {
  return { id: "local", kind: "local", label: "Local machine", cwd };
}

export function normalizeRuntimeOptions(value: unknown): RuntimeOption[] {
  if (!Array.isArray(value)) return [localRuntimeRef()];
  const seen = new Set<string>();
  const result: RuntimeOption[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const runtime = item as Record<string, unknown>;
    const id = typeof runtime.id === "string" && runtime.id.trim() ? runtime.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      kind: typeof runtime.kind === "string" ? runtime.kind : undefined,
      label: typeof runtime.label === "string" ? runtime.label : undefined,
      cwd: typeof runtime.cwd === "string" ? runtime.cwd : undefined,
      experimental: Boolean(runtime.experimental),
      command: typeof runtime.command === "string" ? runtime.command : undefined,
      args: Array.isArray(runtime.args) ? runtime.args.map(String) : undefined,
      processCwd: typeof runtime.processCwd === "string" ? runtime.processCwd : undefined,
      workspace: typeof runtime.workspace === "string" ? runtime.workspace : undefined,
      network: typeof runtime.network === "string" ? runtime.network : undefined,
      readOnly: typeof runtime.readOnly === "boolean" ? runtime.readOnly : undefined,
      sessionPersistence: runtime.sessionPersistence === "runtime" || runtime.sessionPersistence === "volume" || runtime.sessionPersistence === "disposable" ? runtime.sessionPersistence : undefined,
      sessionVolume: typeof runtime.sessionVolume === "string" ? runtime.sessionVolume : undefined,
      connection: runtime.connection && typeof runtime.connection === "object" && (runtime.connection as any).state ? runtime.connection as RuntimeOption["connection"] : undefined,
      disconnectable: typeof runtime.disconnectable === "boolean" ? runtime.disconnectable : undefined,
    });
  }
  if (!seen.has("local")) result.unshift(localRuntimeRef());
  return result;
}

export async function parseApiError(response: Response, fallback = "Request failed") {
  const text = await response.text();
  try {
    const data = text ? JSON.parse(text) : {};
    const runtime = data?.runtimeRef?.label || data?.runtimeRef?.id;
    return new Error(runtime && data?.error ? `${runtime}: ${data.error}` : data?.error || text || fallback);
  } catch {
    return new Error(text || fallback);
  }
}

async function readJson(response: Response, fallback: string) {
  const text = await response.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    if (!response.ok) throw new Error(text || fallback);
    throw new Error(`Invalid JSON response: ${text}`);
  }
  if (!response.ok || data?.ok === false) throw new Error(data?.error || text || fallback);
  return data;
}

export async function listRuntimes(api: ApiClient): Promise<RuntimeOption[]> {
  const res = await fetch("/api/runtimes", { headers: api.headers() });
  const data = await readJson(res, "Could not load runtimes");
  return normalizeRuntimeOptions(data.runtimes);
}

export async function connectRuntime(api: ApiClient, config: RuntimeConnectConfig): Promise<RuntimeOption> {
  const res = await fetch("/api/runtimes/connect", {
    method: "POST",
    headers: api.headers(),
    body: JSON.stringify(config),
  });
  const data = await readJson(res, "Could not connect runtime");
  const runtimes = normalizeRuntimeOptions([data.runtime]);
  return runtimes.find((runtime) => runtime.id === data.runtime?.id) || runtimes[0];
}

export async function disconnectRuntime(api: ApiClient, id: string): Promise<{ ok: true; id: string }> {
  const res = await fetch("/api/runtimes/disconnect", {
    method: "POST",
    headers: api.headers(),
    body: JSON.stringify({ id }),
  });
  return readJson(res, "Could not disconnect runtime");
}
