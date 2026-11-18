import { describe, expect, it, vi } from "vitest";
import { transferArtifact, STREAM_CHUNK_BYTES as CHUNK, STREAM_WINDOW_BYTES as WINDOW } from "../src/extensions/artifactStreamTransport.js";

function setup(total: number, readSize = 65536) {
  const controller = new AbortController();
  let readBytes = 0;
  const reader = { read: vi.fn(async () => {
    if (readBytes === total) return { done: true };
    const length = Math.min(readSize, total - readBytes); readBytes += length;
    return { done: false, value: new Uint8Array(length) };
  }), cancel: vi.fn(async () => {}) };
  const messages: any[] = [];
  const port = { onmessage: null as any, postMessage: (message: any) => messages.push(message) };
  const ack = (index: number) => { const { id, bytes } = messages[index]; port.onmessage({ data: { type: "ack", id, bytes: bytes.byteLength, triangles: id + 1, decodeMs: 1, uploadMs: .5 } }); };
  const progress = vi.fn();
  const result = transferArtifact(reader as any, port as any, total, controller.signal, true, progress);
  return { controller, reader, port, messages, ack, result, progress };
}
describe("bounded artifact transport", () => {
  it("aggregates small reads and never exceeds two MiB of unacknowledged bytes", async () => {
    const h = setup(4 * CHUNK + 19);
    await vi.waitFor(() => expect(h.messages).toHaveLength(2));
    expect(h.reader.read).toHaveBeenCalledTimes(32);
    expect(h.messages.map(m => m.bytes.byteLength)).toEqual([CHUNK, CHUNK]);
    h.ack(0); await vi.waitFor(() => expect(h.messages).toHaveLength(3));
    h.ack(1); await vi.waitFor(() => expect(h.messages).toHaveLength(4));
    h.ack(2); await vi.waitFor(() => expect(h.messages).toHaveLength(5));
    h.ack(3); h.ack(4);
    const stats = await h.result;
    expect(stats.peakQueuedBytes).toBe(WINDOW);
    expect(stats.receivedBytes).toBe(4 * CHUNK + 19);
    expect(stats.processedBytes).toBe(stats.receivedBytes);
    expect(stats.chunks).toBe(5);
    expect(h.reader.cancel).toHaveBeenCalled();
  });
  it.each(["duplicate", "out-of-order", "error"])("rejects %s acknowledgments and cancels the reader", async kind => {
    const h = setup(3 * CHUNK); const rejected = expect(h.result).rejects.toThrow();
    await vi.waitFor(() => expect(h.messages).toHaveLength(2));
    if (kind === "error") h.port.onmessage({ data: { type: "error", error: "GPU context lost" } });
    else if (kind === "out-of-order") h.ack(1);
    else { h.ack(0); h.ack(0); }
    await rejected; expect(h.reader.cancel).toHaveBeenCalled();
  });
  it("aborts while credits are exhausted without reading the rest", async () => {
    const h = setup(8 * CHUNK); const rejected = expect(h.result).rejects.toThrow("Cancelled");
    await vi.waitFor(() => expect(h.messages).toHaveLength(2));
    h.controller.abort(); await rejected;
    expect(h.reader.read).toHaveBeenCalledTimes(32);
  });
  it("times out a renderer that does not acknowledge", async () => {
    vi.useFakeTimers();
    try {
      const h = setup(3 * CHUNK, CHUNK); const rejected = expect(h.result).rejects.toThrow("stopped responding");
      await vi.advanceTimersByTimeAsync(30001); await rejected;
      expect(h.reader.cancel).toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it("rejects excess or truncated source bytes", async () => {
    const h = setup(3); h.controller.abort(); await expect(h.result).rejects.toThrow("Cancelled");
    const reader = { read: async () => ({ done: true }), cancel: async () => {} };
    await expect(transferArtifact(reader as any, {onmessage:null} as any, 10, new AbortController().signal, true, () => {})).rejects.toThrow("ended before");
  });
});
