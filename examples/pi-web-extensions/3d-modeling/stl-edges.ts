import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, lstat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";

const ALGORITHM = "stl-feature-35-source-normal-weld-1e-7-v1";
export const STL_EDGE_LIMITS = { scratchBytes: 1536 * 1048576, cacheBytes: 512 * 1048576, cacheEntries: 256, outputBytes: 128 * 1048576, ttlMs: 24 * 3600000 };
const stateKey = Symbol.for("pi-web.stl-edge-derive.v1");
const globalState = globalThis as typeof globalThis & { [stateKey]?: { busy: boolean; initialized: boolean } };
const state = globalState[stateKey] ??= { busy: false, initialized: false };
const root = join(tmpdir(), `pi-web-stl-edges-${process.getuid?.() ?? "owner"}`);
const sourceIdentity = async (path: string) => { const s = await stat(path, { bigint: true }); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`; };
function check(signal: AbortSignal) { signal.throwIfAborted(); }
async function sourceHash(source: string, signal: AbortSignal) {
  const hash = createHash("sha256");
  for await (const part of createReadStream(source, { signal, highWaterMark: 1048576 })) hash.update(part);
  return hash.digest("hex");
}
async function prune() {
  const entries: { path: string; size: number; time: number }[] = [];
  const names = new Set(await readdir(root));
  for (const name of names) if (/^[a-f0-9]{64}\.edges\.json$/.test(name) && !names.has(name.slice(0, -5))) await rm(join(root, name), { force: true });
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.edges$/.test(name)) continue;
    const path = join(root, name), s = await lstat(path);
    if (!s.isFile() || Date.now() - s.mtimeMs > STL_EDGE_LIMITS.ttlMs) { await rm(path, { force: true }); await rm(path + ".json", { force: true }); }
    else entries.push({ path, size: s.size, time: s.mtimeMs });
  }
  entries.sort((a, b) => a.time - b.time); let bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  let count = entries.length;
  for (const entry of entries) { if (bytes <= STL_EDGE_LIMITS.cacheBytes && count <= STL_EDGE_LIMITS.cacheEntries) break; count--; await rm(entry.path, { force: true }); await rm(entry.path + ".json", { force: true }); bytes -= entry.size; }
}
async function initialize() {
  await mkdir(root, { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
  if (state.initialized) return;
  // Only reap scratch owned by dead processes. Never interfere with another live pi-web.
  for (const name of await readdir(root)) {
    const m = /^job-(\d+)-/.exec(name); if (!m) continue;
    let live = true; try { process.kill(Number(m[1]), 0); } catch (e: any) { live = e.code !== "ESRCH"; }
    if (!live || Number(m[1]) === process.pid) await rm(join(root, name), { recursive: true, force: true });
  }
  await prune(); state.initialized = true;
}
async function validCache(path: string, hash: string, signal: AbortSignal) {
  try {
    const s = await lstat(path), metaStat = await lstat(path + ".json");
    if (!metaStat.isFile() || metaStat.size > 8192) return false;
    const metadata = JSON.parse(await readFile(path + ".json", "utf8"));
    if (!s.isFile() || s.size > STL_EDGE_LIMITS.outputBytes || s.size % 24 || metadata.algorithm !== ALGORITHM || metadata.sourceHash !== hash || metadata.lines * 24 !== s.size) return false;
    // Private cache corruption must not become malformed GPU records.
    let rest = Buffer.alloc(0); const outputHash = createHash("sha256");
    for await (const chunk of createReadStream(path, { signal })) {
      outputHash.update(chunk); const b = Buffer.concat([rest, chunk]); const length = b.length - b.length % 4;
      for (let at = 0; at < length; at += 4) if (!Number.isFinite(b.readFloatLE(at))) return false;
      rest = b.subarray(length);
    }
    return rest.length === 0 && outputHash.digest("hex") === metadata.outputHash;
  } catch (e) { check(signal); return false; }
}
export async function deriveStlEdges(source: string, destination: string, signal: AbortSignal) {
  if (state.busy) throw new Error("Another feature-outline job is running. Try again after it completes.");
  state.busy = true; let job: string | undefined;
  try {
    check(signal); await initialize(); await prune(); const before = await sourceIdentity(source);
    const hash = await sourceHash(source, signal); if (before !== await sourceIdentity(source)) throw new Error("The source changed; reopen the model before generating outlines.");
    const key = createHash("sha256").update(ALGORITHM + ":" + hash).digest("hex"), cached = join(root, key + ".edges");
    if (!(await validCache(cached, hash, signal))) {
      await rm(cached, { force: true }); await rm(cached + ".json", { force: true });
      job = await mkdtemp(join(root, `job-${process.pid}-`)); const output = join(job, "lines.bin");
      const result = await new Promise<any>((resolve, reject) => {
        const worker = new Worker(new URL("./stl-edge-worker.mjs", import.meta.url), { workerData: { source, destination: output, scratch: join(job!, "runs"), maxScratchBytes: STL_EDGE_LIMITS.scratchBytes } });
        let settled = false;
        const finish = (error?: Error, result?: unknown) => { if (settled) return; settled = true; signal.removeEventListener("abort", abort); void worker.terminate().then(() => error ? reject(error) : resolve(result)); };
        const abort = () => finish(new Error("Feature outline generation cancelled.")); signal.addEventListener("abort", abort, { once: true });
        worker.on("message", message => { if (message.type === "complete") finish(undefined, message.result); else if (message.type === "error") finish(new Error(message.error)); });
        worker.on("error", error => finish(error)); worker.on("exit", code => { if (!settled) finish(new Error(`Feature outline worker exited (${code}).`)); });
        if (signal.aborted) abort();
      });
      check(signal);
      if (result.sourceHash !== hash || before !== await sourceIdentity(source)) throw new Error("The source changed during edge generation; reopen the model.");
      if ((await stat(output)).size > STL_EDGE_LIMITS.outputBytes) throw new Error("Feature outlines exceed the 128 MiB line budget; no edges were dropped.");
      await writeFile(cached + ".json", JSON.stringify(result), { mode: 0o600 }); await rename(output, cached); await prune();
    }
    check(signal); await copyFile(cached, destination); await chmod(destination, 0o600);
    if (before !== await sourceIdentity(source)) throw new Error("The source changed; reopen the model.");
    const now = new Date(); await utimes(cached, now, now);
  } finally { if (job) await rm(job, { recursive: true, force: true }); state.busy = false; }
}
