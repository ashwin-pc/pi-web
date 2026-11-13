import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { resolveArtifactRead } from "../shared.js";
import { redact, runOwnedProcess } from "./process.js";

export interface RuntimeDescriptor {
  id: string;
  description: string;
  executable: string;
  args: string[];
  scriptExtension: string;
  requiredPaths?: string[];
  timeoutMs?: number;
}
export interface ModelingConfig { version: 1; runtimes: RuntimeDescriptor[] }
export const configPath = () => process.env.PI_MODELING_CONFIG || join(homedir(), ".pi", "modeling.json");

export async function loadConfig(path = configPath()): Promise<ModelingConfig | undefined> {
  let source: string;
  try { if ((await lstat(path)).size > 1024 * 1024) throw new Error("Configuration too large."); source = await readFile(path, "utf8"); } catch (error: any) { if (error.code === "ENOENT") return; throw new Error("Cannot read modeling configuration."); }
  let value: any;
  try { value = JSON.parse(source); } catch { throw new Error("Invalid modeling configuration JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Modeling configuration: expected an object.");
  if (value.version !== 1) throw new Error("version: expected modeling config version 1.");
  if (!Array.isArray(value.runtimes) || value.runtimes.length > 64) throw new Error("runtimes: expected an array of at most 64 runtime descriptors.");
  const ids = new Set<string>();
  for (const [index, r] of value.runtimes.entries()) {
    const invalid = (field: string, message: string): never => { throw new Error(`runtimes[${index}]${field ? `.${field}` : ""}: ${message}`); };
    if (!r || typeof r !== "object" || Array.isArray(r)) invalid("", "expected an object.");
    if (typeof r.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(r.id)) invalid("id", "expected a lowercase identifier (1–64 letters, digits or hyphens, starting with a letter).");
    if (ids.has(r.id)) invalid("id", "duplicate runtime identifier.");
    if (typeof r.description !== "string" || r.description.length > 4096) invalid("description", "expected a string of at most 4096 characters.");
    const absolutePath = (p: unknown): p is string => typeof p === "string" && !p.includes("\0") && isAbsolute(p);
    if (!absolutePath(r.executable)) invalid("executable", "expected an absolute path without NUL characters.");
    if (!Array.isArray(r.args) || r.args.length > 64) invalid("args", "expected an array of at most 64 arguments.");
    for (const [i, arg] of r.args.entries()) {
      if (typeof arg !== "string" || arg.length > 8192 || arg.includes("\0")) invalid(`args[${i}]`, "expected a string of at most 8192 characters without NUL characters.");
      if (/[{}]/.test(arg) && !["{script}", "{artifacts}", "{run}"].includes(arg)) invalid(`args[${i}]`, "unknown placeholder; placeholders must occupy the whole argument.");
    }
    if (r.args.filter((a: string) => a === "{script}").length !== 1) invalid("args", "expected exactly one {script} argument.");
    if (typeof r.scriptExtension !== "string" || !/^\.[a-z0-9]+$/.test(r.scriptExtension)) invalid("scriptExtension", "expected a dot followed by lowercase letters or digits.");
    if (r.requiredPaths !== undefined) {
      if (!Array.isArray(r.requiredPaths) || r.requiredPaths.length > 64) invalid("requiredPaths", "expected an array of at most 64 absolute paths.");
      for (const [i, p] of r.requiredPaths.entries()) if (!absolutePath(p)) invalid(`requiredPaths[${i}]`, "expected an absolute path without NUL characters.");
    }
    if (r.timeoutMs !== undefined && (!Number.isInteger(r.timeoutMs) || r.timeoutMs < 1 || r.timeoutMs > 3_600_000)) invalid("timeoutMs", "expected an integer from 1 to 3600000.");
    ids.add(r.id);
  }
  return value;
}

// Advisory process-wide admission survives extension reloads. Never probe or kill external jobs.
const stateKey = Symbol.for("pi-web.modeling.owned-runs.v1");
const globalState = globalThis as typeof globalThis & { [stateKey]?: Set<string> };
const busy = globalState[stateKey] ??= new Set<string>();
const key = (r: RuntimeDescriptor) => r.executable;
async function installationEvidence(r: RuntimeDescriptor) {
  const check = async (path: string, executable: boolean) => {
    try {
      await access(path, executable ? constants.X_OK : constants.F_OK);
      if (executable && !(await lstat(await realpath(path))).isFile()) return { path: redact(path), present: false, reason: "not-file" };
      return { path: redact(path), present: true, reason: "checked" };
    } catch (error: any) { return { path: redact(path), present: false, reason: error.code === "ENOENT" ? "missing" : "inaccessible" }; }
  };
  return { executable: await check(r.executable, true), requiredPaths: await Promise.all((r.requiredPaths ?? []).map(p => check(p, false))) };
}
async function installed(r: RuntimeDescriptor) {
  const evidence = await installationEvidence(r);
  return evidence.executable.present && evidence.requiredPaths.every(p => p.present);
}
export async function discover(path?: string) {
  const config = await loadConfig(path);
  return { configured: !!config, runtimes: await Promise.all((config?.runtimes ?? []).map(async r => {
    const evidence = await installationEvidence(r);
    const present = evidence.executable.present && evidence.requiredPaths.every(p => p.present);
    const ownedBusy = busy.has(key(r));
    return { id: r.id, description: redact(r.description), scriptExtension: r.scriptExtension, args: r.args.map(redact), timeoutMs: r.timeoutMs ?? 120_000, evidence, executionSupported: process.platform !== "win32", contract: "One artifact script; whole-argument placeholders: {script}, {artifacts}, {run}. Unsandboxed POSIX owned process group; no persistent services.", configured: true, installed: present, available: process.platform === "win32" || !present || ownedBusy ? false : "unknown", busy: ownedBusy ? true : "unknown", note: "Filesystem checks only; external jobs, dependencies and device capacity are not probed." };
  })) };
}

function inside(root: string, path: string) {
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Artifact symlink escapes the artifact directory.");
}
export interface ExecuteInput { runtime: string; script: string; acknowledgeUnsandboxed: boolean; timeoutMs?: number }
export async function executeModeling(cwd: string, input: ExecuteInput, signal?: AbortSignal, path?: string) {
  if (process.platform === "win32") throw new Error("Modeling execution requires POSIX owned process groups; Windows execution is unsupported.");
  if (input.acknowledgeUnsandboxed !== true) throw new Error("acknowledgeUnsandboxed:true is required; scripts run with user permissions, not in a sandbox.");
  const config = await loadConfig(path);
  const runtime = config?.runtimes.find(r => r.id === input.runtime);
  if (!runtime) throw new Error("Runtime is not configured; use discover first.");
  if (!await installed(runtime)) throw new Error("Runtime executable or required paths are missing.");
  if (busy.has(key(runtime))) throw new Error("This extension already owns an active run for that executable.");
  if (signal?.aborted) throw new Error("Modeling execution cancelled before launch.");
  const maxTimeout = runtime.timeoutMs ?? 120_000;
  const timeout = input.timeoutMs ?? maxTimeout;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > maxTimeout) throw new Error("timeoutMs must be positive and cannot exceed the configured runtime limit.");
  const script = await resolveArtifactRead(cwd, input.script, runtime.scriptExtension, 1024 * 1024, "Modeling script");
  const root = await realpath(join(cwd, ".pi/web/artifacts"));
  const runs = resolve(root, "modeling-runs");
  // Check existing parent before mkdir: do not create directories through escaping links.
  try { inside(root, await realpath(runs)); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
  await mkdir(runs, { recursive: true });
  inside(root, await realpath(runs));
  const id = randomUUID();
  const run = join(runs, id);
  await mkdir(run, { mode: 0o700 });
  const snapshot = join(run, `script${runtime.scriptExtension}`);
  const scriptBytes = await readFile(script.path);
  const scriptSha256 = createHash("sha256").update(scriptBytes).digest("hex");
  await writeFile(snapshot, scriptBytes, { flag: "wx", mode: 0o600 });
  const args = runtime.args.map(a => a === "{script}" ? snapshot : a === "{artifacts}" ? root : a === "{run}" ? run : a);
  if (busy.has(key(runtime))) throw new Error("This extension already owns an active run for that executable.");
  busy.add(key(runtime));
  const started = Date.now();
  try {
    const owned = await runOwnedProcess(runtime.executable, args, {
      cwd: run, signal, timeout, outputLimit: 256 * 1024,
      // Explicit allowlist: never spread the host environment or forward secrets.
      env: { PATH: process.env.PATH ?? "", HOME: homedir(), TMPDIR: process.env.TMPDIR ?? "/tmp", LANG: "C.UTF-8" },
    });
    const { code: exitCode, truncated } = owned;
    const status = owned.reason ?? (owned.error || exitCode !== 0 ? "failed" : "succeeded");
    const result = { id, runtime: runtime.id, reproducibility: { descriptor: { id: runtime.id, description: redact(runtime.description), executable: redact(runtime.executable), args: runtime.args.map(redact), scriptExtension: runtime.scriptExtension, requiredPaths: runtime.requiredPaths?.map(redact), timeoutMs: runtime.timeoutMs }, executable: redact(runtime.executable), args: args.map(redact), script: { source: redact(script.relative), snapshot: `/api/artifacts/modeling-runs/${id}/script${runtime.scriptExtension}`, sha256: scriptSha256 }, timeoutMs: timeout }, status, exitCode, elapsedMs: Date.now() - started, truncated, log: `/api/artifacts/modeling-runs/${id}/execution.log`, evidence: `/api/artifacts/modeling-runs/${id}/result.json`, note: "Process completion is not geometry validation. Owned POSIX process group receives SIGTERM then SIGKILL after 250ms, including after leader exit. Descendants that deliberately create new sessions escape this ownership boundary. Review generated artifacts separately." };
    await writeFile(join(run, "execution.log"), redact(owned.output + (owned.error ? `\nProcess error: ${owned.error.message}` : "")), { flag: "wx", mode: 0o600 });
    await writeFile(join(run, "result.json"), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 });
    return result;
  } finally { busy.delete(key(runtime)); }
}
