import { createBridgeHttp, type BridgeAttempt, type BridgeAuthority } from "./artifactBridgeHttp.js";

const connections = new Set<{ socketChanged: () => void }>();
const routes = new Map<string, (data: Record<string, unknown>) => void>();
let socket = "";
export function setArtifactBridgeSocket(value: unknown) {
  const next = typeof value === "string" ? value : "";
  if (socket === next) return;
  socket = next;
  for (const connection of [...connections]) connection.socketChanged();
}
export function receiveArtifactBridgeEvent(data: Record<string, unknown>) {
  if (data.replay !== true && typeof data.preview === "string") routes.get(data.preview)?.(data);
}
export type BridgeState = "connecting" | "ready" | "disconnected" | "reopen-required" | "closed";

/** Reconnect only transport authority: same selected artifact, fresh preview ID, never command replay. */
export function createBridgeConnection(options: BridgeAuthority & {
  current: () => boolean; send: (data: Record<string, unknown>) => void;
  reset: () => void; state: (state: BridgeState) => void;
}) {
  const http = createBridgeHttp(options);
  let attempt: BridgeAttempt | undefined, ready = false, started = false, disposed = false;
  const state = (value: BridgeState) => { options.state(value); options.send({ type: "connection-state", state: value }); };
  const disconnect = () => {
    const old = attempt; attempt = undefined; ready = false;
    if (old) { routes.delete(old.id); old.controller.abort(); options.reset(); }
    if (old?.opened) void http.invoke(old, "close", {}, new AbortController().signal).catch(() => {});
  };
  const unavailable = () => { disconnect(); state("reopen-required"); };
  const connect = () => {
    disconnect();
    if (disposed || !started || !options.current()) return;
    if (!socket) { state("disconnected"); return; }
    const next: BridgeAttempt = { id: crypto.randomUUID(), controller: new AbortController(), opened: false };
    const selectedSocket = socket; attempt = next; state("connecting");
    routes.set(next.id, data => {
      if (attempt !== next || !options.current()) return;
      if (data.closed === true) unavailable(); else options.send({ type: "event", event: data.event });
    });
    void (async () => {
      await http.probe(next.controller.signal);
      if (attempt !== next || disposed || next.controller.signal.aborted) return;
      await http.invoke(next, "open", { socket: selectedSocket, selection: options.selection });
      next.opened = true;
      if (attempt !== next || disposed || !options.current()) {
        void http.invoke(next, "close", {}, new AbortController().signal).catch(() => {}); return;
      }
      ready = true; state("ready");
    })().catch(() => { if (attempt === next && !disposed) unavailable(); });
  };
  const subscriber = { socketChanged: connect }; connections.add(subscriber);
  return {
    http,
    get: () => ready && options.current() ? attempt : undefined,
    isCurrent: (value: BridgeAttempt) => attempt === value && ready && !disposed && options.current(),
    start() { started = true; connect(); },
    unavailable,
    dispose() { disposed = true; connections.delete(subscriber); disconnect(); },
  };
}
export type BridgeConnection = ReturnType<typeof createBridgeConnection>;
