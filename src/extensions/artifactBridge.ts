import type { PiWebJson } from "../extensions.js";
import { watchArtifactConnection } from "./artifactStreamLifecycle.js";

const active = new Map<string, { receive: (data: Record<string, unknown>) => void; close: () => void }>();
let socket = "";
export function setArtifactBridgeSocket(value: unknown) {
  for (const connection of active.values()) connection.close();
  socket = typeof value === "string" ? value : "";
}
export function receiveArtifactBridgeEvent(data: Record<string, unknown>) {
  if (data.replay === true || typeof data.preview !== "string") return;
  active.get(data.preview)?.receive(data);
}
function json(value: unknown): PiWebJson {
  const encoded = JSON.stringify(value);
  if (!encoded || new TextEncoder().encode(encoded).byteLength > 64 * 1024) throw new Error("Invalid bridge JSON");
  return JSON.parse(encoded) as PiWebJson;
}

/** Private command/event port, independent of original/derived byte stream ports. */
export function mountArtifactBridge(options: {
  frame: HTMLIFrameElement; sessionId: string; key: string; selection: string; url: string;
  headers: () => Record<string, string>; current: () => boolean;
}) {
  const { frame } = options;
  const preview = crypto.randomUUID();
  const lifetime = new AbortController();
  const requests = new Map<string, AbortController>();
  let port: MessagePort | undefined;
  let opened = false;
  let started = false;
  let attached = frame.isConnected;
  let unwatch = () => {};
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const clearDeadline = () => { clearTimeout(deadline); deadline = undefined; };
  const armDeadline = (ms: number) => { clearDeadline(); deadline = setTimeout(close, ms); };
  let ready = false;
  let queuedBytes = 0;
  const queue: Record<string, unknown>[] = [];
  const call = async (operation: string, extra: Record<string, unknown> = {}, signal = lifetime.signal) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timeout = setTimeout(abort, operation === "request" ? 180_000 : 10_000);
    try {
      const response = await fetch("/api/web-contributions/invoke", {
        method: "POST", headers: options.headers(), signal: controller.signal,
        body: JSON.stringify({ sessionId: options.sessionId, slot: "artifact-preview", key: options.key,
          preview: { operation, preview, ...extra } }),
      });
      const data = await response.json();
      if (!response.ok || data.ok !== true) throw new Error("Preview operation failed");
      return data;
    } finally { clearTimeout(timeout); signal.removeEventListener("abort", abort); }
  };
  const send = (data: Record<string, unknown>) => {
    if (lifetime.signal.aborted) return;
    if (!options.current()) { close(); return; }
    const bytes = new TextEncoder().encode(JSON.stringify(data)).byteLength;
    if (queue.length >= 32 || queuedBytes + bytes > 256 * 1024) { close(); return; }
    queue.push(data); queuedBytes += bytes;
    flush();
  };
  // One acknowledged delivery at a time bounds the browser's MessagePort queue.
  let awaitingAck = false;
  const flush = () => {
    if (!ready || awaitingAck || !port || !queue.length) return;
    const next = queue.shift()!;
    queuedBytes -= new TextEncoder().encode(JSON.stringify(next)).byteLength;
    awaitingAck = true;
    armDeadline(10_000);
    port.postMessage(next);
  };
  const close = () => {
    if (lifetime.signal.aborted) return;
    lifetime.abort();
    for (const request of requests.values()) request.abort();
    active.delete(preview); unwatch(); clearDeadline();
    frame.removeEventListener("load", start);
    try { port?.postMessage({ type: "closed" }); } catch { /* detached */ }
    port?.close(); queue.length = 0;
    if (opened) void call("close", {}, new AbortController().signal).catch(() => {});
  };
  active.set(preview, {
    close,
    receive: data => { if (data.closed === true) close(); else send({ type: "event", event: data.event }); },
  });
  const checkConnection = () => {
    if (frame.isConnected) attached = true;
    if (!options.current() || (attached && !frame.isConnected)) close();
  };
  unwatch = watchArtifactConnection(checkConnection);
  const start = () => { if (started) close(); else void initialize().catch(close); };
  const initialize = async () => {
    if (started || lifetime.signal.aborted) return;
    started = true;
    attached = frame.isConnected;
    clearDeadline();
    if (!socket || !options.current()) throw new Error("Preview connection unavailable");
    const probeTimeout = setTimeout(close, 10_000);
    let response: Response;
    try { response = await fetch(options.url, { headers: { ...options.headers(), Range: "bytes=0-0", "x-pi-artifact-selection": options.selection }, signal: lifetime.signal, redirect: "error", cache: "no-store" }); }
    finally { clearTimeout(probeTimeout); }
    await response.body?.cancel();
    if (response.status !== 206 || !/^bytes 0-0\/\d+$/.test(response.headers.get("content-range") || "")) throw new Error("Preview source unavailable");
    await call("open", { socket, selection: options.selection });
    opened = true;
    if (lifetime.signal.aborted || !options.current()) { void call("close", {}, new AbortController().signal).catch(() => {}); close(); return; }
    const channel = new MessageChannel(); port = channel.port1;
    port.onmessage = event => {
      if (!options.current()) { close(); return; }
      const data = event.data;
      if (!data || typeof data !== "object") { close(); return; }
      if (data.type === "ready") { if (!ready) { ready = true; clearDeadline(); flush(); } return; }
      if (data.type === "ack") { if (awaitingAck) { awaitingAck = false; clearDeadline(); flush(); } return; }
      if (data.type === "close") { close(); return; }
      if (typeof data.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(data.id)) { close(); return; }
      if (data.type === "cancel") {
        requests.get(data.id)?.abort();
        void call("cancel", { id: data.id }).catch(() => {});
        return;
      }
      if (data.type !== "request" || typeof data.command !== "string" || !data.command || data.command.length > 80 || requests.has(data.id) || requests.size >= 16) { close(); return; }
      let payload: PiWebJson | undefined;
      try { if (data.payload !== undefined) payload = json(data.payload); } catch { close(); return; }
      const controller = new AbortController(); requests.set(data.id, controller);
      void call("request", { id: data.id, command: data.command, ...(payload !== undefined ? { payload } : {}) }, controller.signal)
        .then(result => { if (!controller.signal.aborted) send({ type: "response", id: data.id, result: json(result.result) }); })
        .catch(() => { if (!controller.signal.aborted) send({ type: "error", id: data.id, error: { code: "REQUEST_FAILED", message: "Preview request failed" } }); })
        .finally(() => requests.delete(data.id));
    };
    port.start();
    armDeadline(10_000);
    frame.contentWindow?.postMessage({ type: "pi-artifact-bridge", version: 1 }, "*", [channel.port2]);
  };
  frame.addEventListener("load", start);
  armDeadline(30_000);
  checkConnection();
  return close;
}
