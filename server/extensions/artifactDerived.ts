import { randomUUID } from "node:crypto";
import { constants, statSync } from "node:fs";
import { mkdtemp, open, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiWebArtifactDeriveOptions } from "../../src/extensions.js";
import { HttpError } from "../shared/httpError.js";

export const MAX_DERIVED_BYTES = 128 * 1024 * 1024;
export function artifactIdentity(path: string) {
  try {
    const s = statSync(path, { bigint: true });
    if (!s.isFile()) throw new Error("Not a regular file");
    return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
  } catch {
    // Filesystem errors contain absolute private paths. Fail closed without
    // forwarding those messages through the host into the renderer iframe.
    throw new HttpError("Source unavailable or changed; reopen the model", 409);
  }
}
type Selection = { sessionId: string; key: string; registration: string; artifact: { name: string; path: string; kind: string }; url: string; expires: number; source?: string; identity?: string; running: boolean; controller?: AbortController };
/** Tokens are selected-source authority, never filesystem paths or browser credentials. */
export class ArtifactDerivations {
  private selections = new Map<string, Selection>();
  private running = 0;
  constructor(private timeoutMs = 180_000, private maxBytes = MAX_DERIVED_BYTES) {}
  select(input: Omit<Selection, "expires" | "running">) {
    for (const [token, value] of this.selections) if (value.expires < Date.now() && !value.running) this.selections.delete(token);
    if (this.selections.size >= 128) {
      // Eviction explicitly invalidates old authority rather than rebinding it.
      // In-flight generation is protected; subsequent requests for an evicted
      // preview must obtain a fresh selection by reopening the artifact.
      const oldest = [...this.selections].find(([, value]) => !value.running);
      if (!oldest) throw new HttpError("Too many active preview selections", 429);
      this.selections.delete(oldest[0]);
    }
    const token = randomUUID();
    this.selections.set(token, { ...input, expires: Date.now() + 30 * 60_000, running: false });
    return token;
  }
  releaseSession(sessionId: string) {
    for (const [token, value] of this.selections) if (value.sessionId === sessionId) {
      value.controller?.abort(new Error("Preview session closed"));
      this.selections.delete(token);
    }
  }
  bind(token: string, sessionId: string, url: string, source: string) {
    const value = this.get(token, sessionId);
    if (value.url !== url) throw new HttpError("Unselected artifact", 403);
    const identity = artifactIdentity(source);
    if (value.identity && (value.identity !== identity || value.source !== source)) throw new HttpError("Source changed; reopen the model", 409);
    value.source = source; value.identity = identity;
    return () => { if (artifactIdentity(source) !== identity) throw new HttpError("Source changed; reopen the model", 409); };
  }
  private get(token: string, sessionId: string) {
    const value = this.selections.get(token);
    if (!value || value.sessionId !== sessionId || value.expires < Date.now()) throw new HttpError("Preview selection expired or unavailable", 403);
    // Map insertion order is the bounded selection LRU.
    this.selections.delete(token); this.selections.set(token, value);
    return value;
  }
  async derive(token: string, sessionId: string, key: string, signal: AbortSignal,
    invoke: (value: Selection, options: PiWebArtifactDeriveOptions) => Promise<void>) {
    const value = this.get(token, sessionId);
    if (value.key !== key || !value.source || !value.identity) throw new HttpError("Unselected artifact renderer", 403);
    // The current STL adapter admits one job per server; reject at the host
    // boundary with a typed busy response rather than an opaque adapter failure.
    if (value.running || this.running >= 1) throw new HttpError("Artifact generation is busy", 429);
    if (artifactIdentity(value.source) !== value.identity) throw new HttpError("Source changed; reopen the model", 409);
    signal.throwIfAborted();
    value.running = true; this.running++;
    const controller = new AbortController(); value.controller = controller;
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    let directory = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let quota: ReturnType<typeof setInterval> | undefined;
    let work: Promise<void> | undefined;
    let released = false;
    const release = () => { if (!released) { released = true; value.running = false; this.running--; } };
    try {
      directory = await mkdtemp(join(tmpdir(), "pi-artifact-derived-"));
      const destination = join(directory, "output");
      timer = setTimeout(() => controller.abort(new Error("Artifact generation timed out")), this.timeoutMs);
      quota = setInterval(() => { void lstat(destination).then(s => { if (s.size > this.maxBytes) controller.abort(new Error("Derived artifact exceeds size limit")); }).catch(() => {}); }, 100);
      work = Promise.resolve().then(() => invoke(value, { signal: controller.signal, source: value.source!, destination }));
      const cancelled = new Promise<never>((_, reject) => {
        const fail = () => reject(controller.signal.reason || new Error("Artifact generation cancelled"));
        controller.signal.addEventListener("abort", fail, { once: true });
        if (controller.signal.aborted) fail();
      });
      await Promise.race([work, cancelled]);
      controller.signal.throwIfAborted();
      if (artifactIdentity(value.source) !== value.identity) throw new HttpError("Source changed; reopen the model", 409);
      const metadata = await lstat(destination);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 0 || metadata.size > this.maxBytes) throw new HttpError("Invalid derived output", 422);
      const file = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await file.stat();
      if (!opened.isFile() || opened.ino !== metadata.ino || opened.dev !== metadata.dev || opened.size !== metadata.size) { await file.close(); throw new HttpError("Derived output changed", 409); }
      return { file, size: opened.size, cleanup: async () => { await file.close().catch(() => {}); await rm(directory, { recursive: true, force: true }); } };
    } catch (error) {
      controller.abort(error);
      // Non-cooperating trusted handlers cannot be killed in-process. Retain the
      // concurrency slot until they settle; remove any late output again.
      if (work) void work.catch(() => {}).finally(async () => { await rm(directory, { recursive: true, force: true }); release(); });
      if (error instanceof HttpError) throw error;
      const message = error instanceof Error ? error.message : "";
      if (["Artifact generation timed out", "Derived artifact exceeds size limit", "Preview session closed"].includes(message)) throw new HttpError(message, 422);
      throw new HttpError(controller.signal.aborted && signal.aborted ? "Artifact generation cancelled" : "Artifact generation failed", 422);
    } finally {
      clearTimeout(timer); clearInterval(quota); signal.removeEventListener("abort", abort);
      value.controller = undefined;
      if (!controller.signal.aborted) release();
      else { await rm(directory, { recursive: true, force: true }); if (!work) release(); }
    }
  }
}
