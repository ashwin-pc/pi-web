import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { resolveArtifactRead } from "../shared.js";
import { redact } from "./process.js";

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
  if (value?.version !== 1 || (!Array.isArray(value.runtimes) || value.runtimes.length > 64)) throw new Error("Expected modeling config version 1 and runtimes array.");
  const ids = new Set<string>();
  for (const r of value.runtimes) {
    if (!r || !/^[a-z][a-z0-9-]{0,63}$/.test(r.id) || ids.has(r.id) || typeof r.description !== "string" || r.description.length > 4096 || !isAbsolute(r.executable || "") || !Array.isArray(r.args) || r.args.length > 64 || !r.args.every((a: unknown) => typeof a === "string" && a.length <= 8192) || r.args.filter((a: string) => a === "{script}").length !== 1 || !/^\.[a-z0-9]+$/.test(r.scriptExtension || "") || (r.requiredPaths !== undefined && (!Array.isArray(r.requiredPaths) || r.requiredPaths.length > 64 || !r.requiredPaths.every((p: unknown) => typeof p === "string" && isAbsolute(p)))) || (r.timeoutMs !== undefined && (!Number.isInteger(r.timeoutMs) || r.timeoutMs < 1 || r.timeoutMs > 3_600_000))) throw new Error("Invalid modeling runtime descriptor.");
    if (r.args.some((a: string) => /\{/.test(a) && !["{script}", "{artifacts}", "{run}"].includes(a))) throw new Error("Unknown runtime argument placeholder.");
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
  let output = "";
  let truncated = false;
  let reason: "cancelled" | "timed-out" | undefined;
  let exitCode: number | null = null;
  let failed = false;
  try {
    await new Promise<void>(done => {
      const child = spawn(runtime.executable, args, { cwd: run, detached: true, shell: false, stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "", HOME: homedir(), TMPDIR: process.env.TMPDIR ?? "/tmp", LANG: "C.UTF-8" } });
      let cleanupStarted = false;
      let finished = false;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      // The detached child's PID identifies only our newly created process group.
      // Never enumerate processes or target a pre-existing service.
      const signalGroup = (sig: NodeJS.Signals) => {
        if (!child.pid) return;
        try { process.kill(-child.pid, sig); } catch (error: any) { if (error.code !== "ESRCH") failed = true; }
      };
      const cleanup = () => {
        if (cleanupStarted) return;
        cleanupStarted = true;
        clearTimeout(timer);
        signalGroup("SIGTERM");
        escalation = setTimeout(() => { signalGroup("SIGKILL"); finish(); }, 250);
      };
      const stop = (why: typeof reason) => { reason ??= why; cleanup(); };
      const cancel = () => stop("cancelled");
      const timer = setTimeout(() => stop("timed-out"), timeout);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      const collect = (data: Buffer) => { const text = data.toString(); const room = 256 * 1024 - output.length; output += text.slice(0, Math.max(0, room)); if (text.length > room) truncated = true; };
      child.stdout.on("data", collect); child.stderr.on("data", collect);
      // Always clean the group even when the leader exits normally: its descendants
      // may still be computing or retaining pipes. Do not wait for pipe close.
      child.once("exit", code => { exitCode = code; cleanup(); });
      child.once("error", () => { failed = true; cleanup(); });
      function finish() { if (finished) return; finished = true; clearTimeout(timer); if (escalation) clearTimeout(escalation); signal?.removeEventListener("abort", cancel); child.stdout.destroy(); child.stderr.destroy(); done(); }
    });
    const status = reason ?? (failed || exitCode !== 0 ? "failed" : "succeeded");
    const result = { id, runtime: runtime.id, reproducibility: { descriptor: { id: runtime.id, description: redact(runtime.description), executable: redact(runtime.executable), args: runtime.args.map(redact), scriptExtension: runtime.scriptExtension, requiredPaths: runtime.requiredPaths?.map(redact), timeoutMs: runtime.timeoutMs }, executable: redact(runtime.executable), args: args.map(redact), script: { source: redact(script.relative), snapshot: `/api/artifacts/modeling-runs/${id}/script${runtime.scriptExtension}`, sha256: scriptSha256 }, timeoutMs: timeout }, status, exitCode, elapsedMs: Date.now() - started, truncated, log: `/api/artifacts/modeling-runs/${id}/execution.log`, evidence: `/api/artifacts/modeling-runs/${id}/result.json`, note: "Process completion is not geometry validation. Owned POSIX process group receives SIGTERM then SIGKILL after 250ms, including after leader exit. Descendants that deliberately create new sessions escape this ownership boundary. Review generated artifacts separately." };
    await writeFile(join(run, "execution.log"), redact(output), { flag: "wx", mode: 0o600 });
    await writeFile(join(run, "result.json"), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 });
    return result;
  } finally { busy.delete(key(runtime)); }
}
