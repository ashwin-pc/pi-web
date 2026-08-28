import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { SessionService } from "./dto.js";
import { SESSION_PROTOCOL_VERSION, serializeError, type SessionRequest, type SessionResponse } from "./protocol.js";

export type DispatcherOptions = { input: Readable; output: Writable; service: SessionService; build: string };

/** NDJSON policy: empty/whitespace lines are ignored; malformed JSON and invalid envelopes are fatal. */
export function dispatchSessionService({ input, output, service, build }: DispatcherOptions): () => void {
  let stopped = false;
  const write = (message: SessionResponse) => { if (!stopped) output.write(`${JSON.stringify(message)}\n`); };
  const unsubscribe = service.subscribe((event) => write({ type: "event", event }));
  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on("line", async (line) => {
    if (!line.trim()) return;
    let request: SessionRequest;
    try {
      request = JSON.parse(line) as SessionRequest;
      if (!request || typeof request !== "object" || typeof request.id !== "string" || !["health", "request"].includes(request.type)) throw new Error("invalid request envelope");
    } catch (error) {
      stopped = true; unsubscribe(); lines.close(); input.destroy(new Error(`Invalid NDJSON: ${serializeError(error).message}`)); return;
    }
    if (request.type === "health") {
      write({ type: "health", id: request.id, protocolVersion: SESSION_PROTOCOL_VERSION, build });
      return;
    }
    try {
      const member = service[request.method] as unknown;
      if (typeof member !== "function") throw new Error(`Unknown SessionService method: ${String(request.method)}`);
      const result = await Reflect.apply(member, service, request.args);
      write({ type: "response", id: request.id, result });
    } catch (error) { write({ type: "error", id: request.id, error: serializeError(error) }); }
  });
  const stop = () => { if (stopped) return; stopped = true; unsubscribe(); lines.close(); };
  lines.once("close", () => { stopped = true; unsubscribe(); });
  return stop;
}
