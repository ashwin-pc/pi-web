import { bridgeJson } from "./artifactBridgeDelivery.js";
import { BridgeHttpError } from "./artifactBridgeHttp.js";
import type { BridgeConnection } from "./artifactBridgeConnection.js";

export function createBridgeCommands(options: {
  connection: BridgeConnection; current: () => boolean; send: (data: Record<string, unknown>) => void;
  ready: () => void; ack: () => void; close: () => void; reopen: () => void;
}) {
  const pending = new Map<string, AbortController>();
  const error = (id: string, code: string, message: string) => options.send({ type: "error", id, error: { code, message } });
  const validId = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(id);
  const request = (data: Record<string, unknown>) => {
    if (!validId(data.id) || typeof data.command !== "string" || !data.command || data.command.length > 80 || pending.has(data.id) || pending.size >= 16) { options.close(); return; }
    const id = data.id, attempt = options.connection.get();
    if (!attempt) { error(id, "DISCONNECTED", "Preview is not connected; request was not sent."); return; }
    let payload: unknown;
    try { bridgeJson({ command: data.command, ...(data.payload !== undefined ? { payload: data.payload } : {}) }); if (data.payload !== undefined) payload = bridgeJson(data.payload); }
    catch { options.close(); return; }
    const controller = new AbortController(); pending.set(id, controller);
    const live = () => pending.get(id) === controller && !controller.signal.aborted && options.connection.isCurrent(attempt);
    void options.connection.http.invoke(attempt, "request", { id, command: data.command, ...(payload !== undefined ? { payload } : {}) }, controller.signal)
      .then(result => { if (live()) options.send({ type: "response", id, result: bridgeJson(result.result) }); })
      .catch(failure => {
        if (!live()) return;
        if (failure instanceof BridgeHttpError && [403, 404, 409].includes(failure.status)) options.connection.unavailable();
        else error(id, "REQUEST_FAILED", "Preview request failed; its outcome may be unknown. It was not retried.");
      }).finally(() => { if (pending.get(id) === controller) pending.delete(id); });
  };
  const handlers: Record<string, (data: Record<string, unknown>) => void> = {
    ready: options.ready, ack: options.ack, close: options.close, reopen: options.reopen, request,
    cancel: data => {
      if (!validId(data.id)) { options.close(); return; }
      const controller = pending.get(data.id), attempt = options.connection.get();
      controller?.abort(); pending.delete(data.id);
      if (attempt) void options.connection.http.invoke(attempt, "cancel", { id: data.id }).catch(() => {});
      if (controller) error(data.id, "CANCELLED", "Request cancelled; its outcome may be unknown.");
    },
  };
  return {
    dispatch(data: unknown) {
      if (!options.current() || !data || typeof data !== "object") { options.close(); return; }
      const message = data as Record<string, unknown>;
      if (typeof message.type !== "string" || !Object.hasOwn(handlers, message.type)) { options.close(); return; }
      handlers[message.type](message);
    },
    reset() {
      for (const [id, controller] of pending) { controller.abort(); error(id, "OUTCOME_UNKNOWN", "Connection lost; request outcome may be unknown. It was not retried."); }
      pending.clear();
    },
  };
}
