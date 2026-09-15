import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { SessionService } from "../server/session/dto.js";
import { dispatchSessionService } from "../server/session/stdioDispatcher.js";

function harness() {
  const input = new PassThrough(); const output = new PassThrough(); const frames: any[] = [];
  output.setEncoding("utf8"); let buffered = ""; output.on("data", chunk => { buffered += chunk; const lines = buffered.split("\n"); buffered = lines.pop()!; frames.push(...lines.filter(Boolean).map(JSON.parse)); });
  let listener: any;
  const service = { subscribe: (fn: any) => { listener = fn; return () => {}; }, state: vi.fn(async (id: string) => ({ sessionId: id })), navigate: vi.fn(async () => ({ state: { sessionId: "s" } })) } as unknown as SessionService;
  dispatchSessionService({ input, output, service, build: "fixture-build" }); return { input, frames, listener };
}
const wait = () => new Promise(resolve => setTimeout(resolve, 10));
describe("SessionService NDJSON dispatcher", () => {
  it("correlates requests, handshakes, forwards events, and tolerates blank lines", async () => {
    const h = harness(); h.input.write("  \n"); h.input.write(JSON.stringify({ type: "health", id: "h", protocolVersion: 1, build: "fixture-build" }) + "\n"); h.input.write(JSON.stringify({ type: "request", id: "2", method: "state", args: ["s"] }) + "\n"); h.listener({ type: "wire", value: "event" }); await wait();
    expect(h.frames).toContainEqual({ type: "health", id: "h", protocolVersion: 1, build: "fixture-build" });
    expect(h.frames).toContainEqual({ type: "response", id: "2", result: { sessionId: "s" } }); expect(h.frames).toContainEqual({ type: "event", event: { type: "wire", value: "event" } });
  });
  it("returns navigation data without inventing a remote finish callback", async () => { const h = harness(); h.input.write(JSON.stringify({ type: "request", id: "n", method: "navigate", args: ["s", "x", {}] }) + "\n"); await wait(); expect(h.frames[0].result).toEqual({ state: { sessionId: "s" } }); expect(h.frames[0].result).not.toHaveProperty("finish"); });
});
