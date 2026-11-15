import { randomUUID } from "node:crypto";
import type { PiWebArtifactConnect, PiWebArtifactConnection, PiWebJson } from "../../src/extensions.js";
import type { ArtifactDerivations } from "./artifactDerived.js";
import { HttpError } from "../shared/httpError.js";

export const BRIDGE_JSON_BYTES = 64 * 1024;
/** Reject lossy/non-JSON values as well as excessive wire size. */
export function bridgeJson(value: unknown): PiWebJson {
  const seen = new Set<object>();
  const visit = (v: unknown, depth: number): void => {
    if (depth > 64) throw new Error("Invalid bridge JSON");
    if (v === null || typeof v === "string" || typeof v === "boolean") return;
    if (typeof v === "number" && Number.isFinite(v)) return;
    if (typeof v !== "object" || !v || seen.has(v) || (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype)) throw new Error("Invalid bridge JSON");
    seen.add(v);
    for (const entry of Object.values(v)) visit(entry, depth + 1);
    seen.delete(v);
  };
  visit(value, 0);
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > BRIDGE_JSON_BYTES) throw new Error("Bridge JSON exceeds 64 KiB");
  return JSON.parse(encoded) as PiWebJson;
}

type Target = { send(event: unknown): boolean; onClose(close: () => void): () => void };
type Connection = {
  owner: string; sessionId: string; key: string; selection: string; socket: string;
  controller: AbortController; handler?: PiWebArtifactConnection; requests: Map<string, AbortController>;
  timer: ReturnType<typeof setTimeout>; detach: () => void; target: Target; events: number; window: number;
};
type Connect = (sessionId: string, selected: ReturnType<ArtifactDerivations["selected"]>, options: Parameters<PiWebArtifactConnect>[1]) => ReturnType<PiWebArtifactConnect>;

/** Bounded preview lifetimes, not jobs or subscriptions. All routing authority stays in the host. */
export class ArtifactBridges {
  private readonly connections = new Map<string, Connection>();
  private connecting = 0;
  private pending = 0;
  constructor(private readonly selections: ArtifactDerivations, private readonly target: (id: string, owner: string) => Target | undefined, private readonly connect: Connect) {}

  close(id: string) {
    const value = this.connections.get(id);
    if (value) this.closeEntry(id, value);
  }
  /** Async callbacks must never resolve a reused ID to a replacement connection. */
  private closeEntry(id: string, value: Connection) {
    if (this.connections.get(id) !== value) return;
    this.connections.delete(id);
    // Notify before abort handlers can synchronously open a replacement under this ID.
    try { value.target.send({ type: "artifact_bridge_event", preview: id, closed: true }); } catch { /* receiver already gone */ }
    value.controller.abort();
    for (const controller of value.requests.values()) controller.abort();
    clearTimeout(value.timer); value.detach();
  }
  releaseSession(sessionId: string, key?: string) {
    for (const [id, value] of this.connections) if (value.sessionId === sessionId && (key === undefined || value.key === key)) this.closeEntry(id, value);
  }
  private selected(value: Connection) {
    const selected = this.selections.selected(value.selection, value.sessionId, value.key);
    if (!selected.bridge || (selected.owner !== undefined && selected.owner !== value.owner)) throw new HttpError("Preview bridge unavailable", 403);
    return selected;
  }
  async invoke(owner: string, sessionId: string, key: string, input: Record<string, unknown>, signal: AbortSignal) {
    const operation = input.operation;
    if (operation === "open") {
      if (typeof input.socket !== "string" || typeof input.selection !== "string") throw new HttpError("Invalid preview connection", 400);
      const target = this.target(input.socket, owner);
      if (!target) throw new HttpError("Preview connection unavailable", 403);
      if (this.connecting >= 128 || this.connections.size >= 128 || [...this.connections.values()].filter(v => v.owner === owner).length >= 32) throw new HttpError("Too many preview connections", 429);
      const id = typeof input.preview === "string" && /^[a-f0-9-]{36}$/.test(input.preview) ? input.preview : randomUUID();
      if (this.connections.has(id)) throw new HttpError("Preview connection already open", 409);
      const controller = new AbortController();
      const timer = setTimeout(() => this.closeEntry(id, value), 30 * 60_000); timer.unref?.();
      const value: Connection = { owner, sessionId, key, selection: input.selection, socket: input.socket, controller, requests: new Map(), timer, detach: () => {}, target, events: 0, window: Date.now() };
      this.connections.set(id, value);
      value.detach = target.onClose(() => this.closeEntry(id, value));
      const abort = () => this.closeEntry(id, value);
      signal.addEventListener("abort", abort, { once: true });
      this.connecting++;
      try {
        signal.throwIfAborted();
        const selected = this.selected(value);
        clearTimeout(value.timer);
        value.timer = setTimeout(() => this.closeEntry(id, value), Math.max(0, selected.expires - Date.now())); value.timer.unref?.();
        value.handler = await this.connect(sessionId, selected, { source: selected.source, signal: controller.signal, emit: event => {
          if (controller.signal.aborted || this.connections.get(id) !== value) return false;
          try {
            this.selected(value);
            if (Date.now() - value.window >= 1000) { value.window = Date.now(); value.events = 0; }
            if (++value.events > 32) throw new Error("Preview event rate exceeded");
            if (!target.send({ type: "artifact_bridge_event", preview: id, event: bridgeJson(event) })) throw new Error("Preview receiver too slow");
            return true;
          } catch { this.closeEntry(id, value); return false; }
        } });
        if (controller.signal.aborted || this.connections.get(id) !== value || typeof value.handler?.request !== "function") throw new Error("Preview connection failed");
        return { preview: id };
      } catch { this.closeEntry(id, value); throw new HttpError("Preview connection failed", 422); }
      finally { this.connecting--; signal.removeEventListener("abort", abort); }
    }
    if (typeof input.preview !== "string") throw new HttpError("Invalid preview connection", 400);
    const value = this.connections.get(input.preview);
    if (!value || value.owner !== owner || value.sessionId !== sessionId || value.key !== key) throw new HttpError("Preview connection unavailable", 403);
    if (operation === "close") { this.closeEntry(input.preview, value); return {}; }
    try { this.selected(value); } catch { this.closeEntry(input.preview, value); throw new HttpError("Preview source unavailable; reopen", 409); }
    if (typeof input.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.id)) throw new HttpError("Invalid request ID", 400);
    if (operation === "cancel") { value.requests.get(input.id)?.abort(); return {}; }
    if (operation !== "request" || typeof input.command !== "string" || input.command.length > 80 || !input.command) throw new HttpError("Invalid preview request", 400);
    if (this.pending >= 256 || !value.handler || value.requests.size >= 16 || value.requests.has(input.id)) throw new HttpError("Preview requests busy", 429);
    let payload: PiWebJson | undefined;
    try { bridgeJson({ command: input.command, ...(input.payload !== undefined ? { payload: input.payload } : {}) }); if (input.payload !== undefined) payload = bridgeJson(input.payload); } catch { throw new HttpError("Invalid preview JSON", 400); }
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timeout = setTimeout(abort, 180_000); timeout.unref?.();
    value.requests.set(input.id, controller);
    this.pending++;
    try {
      controller.signal.throwIfAborted();
      const result = await value.handler.request({ command: input.command, ...(payload !== undefined ? { payload } : {}) }, { signal: controller.signal });
      controller.signal.throwIfAborted();
      this.selected(value);
      return { result: bridgeJson(result) };
    } catch { throw new HttpError(controller.signal.aborted ? "Preview request cancelled" : "Preview request failed", 422); }
    finally { this.pending--; clearTimeout(timeout); signal.removeEventListener("abort", abort); value.requests.delete(input.id); }
  }
}
