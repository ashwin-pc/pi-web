// Selected bytes only; no URLs or credentials cross this private port.
export const STREAM_CHUNK_BYTES = 1024 * 1024;
export const STREAM_WINDOW_BYTES = 2 * STREAM_CHUNK_BYTES;
export interface StreamProgress {
  receivedBytes: number; processedBytes: number; triangles: number; peakQueuedBytes: number;
  chunks: number; readerWaitMs: number; receiveElapsedMs: number;
  decodeMs?: number; uploadMs?: number;
}
export async function transferArtifact(reader: ReadableStreamDefaultReader<Uint8Array>, port: MessagePort, size: number, signal: AbortSignal, pipelined: boolean, update: (progress: StreamProgress) => void): Promise<StreamProgress> {
  const stats: StreamProgress = { receivedBytes: 0, processedBytes: 0, triangles: 0, peakQueuedBytes: 0, chunks: 0, readerWaitMs: 0, receiveElapsedMs: 0 };
  const start = performance.now(), pending: { id: number; bytes: number }[] = [];
  let queued = 0, failure: Error | undefined, waiter: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const wake = () => { waiter?.(); waiter = undefined; };
  const fail = (message: string) => { failure = new Error(message); void reader.cancel().catch(() => {}); wake(); };
  const arm = () => {
    clearTimeout(timeout);
    if (pending.length) timeout = setTimeout(() => fail("The renderer stopped responding. Close other graphics-heavy tabs or try a larger-memory device."), 30000);
  };
  const abort = () => fail("Cancelled");
  signal.addEventListener("abort", abort, { once: true });
  port.onmessage = event => {
    const message = event.data, first = pending[0];
    if (message?.type !== "ack" || !first || (pipelined && (message.id !== first.id || message.bytes !== first.bytes))) {
      fail(typeof message?.error === "string" ? message.error : "Invalid renderer acknowledgment."); return;
    }
    pending.shift(); queued -= first.bytes; stats.processedBytes += first.bytes;
    if (Number.isSafeInteger(message.triangles) && message.triangles >= stats.triangles) stats.triangles = message.triangles;
    for (const key of ["decodeMs", "uploadMs"] as const) if (Number.isFinite(message[key]) && message[key] >= (stats[key] ?? 0)) stats[key] = message[key];
    arm(); update({ ...stats }); wake();
  };
  const check = () => { if (signal.aborted) throw new Error("Cancelled"); if (failure) throw failure; };
  const wait = async () => { check(); await new Promise<void>(resolve => { waiter = resolve; }); check(); };
  const send = (data: Uint8Array) => {
    check(); const id = stats.chunks++, length = data.byteLength;
    pending.push({ id, bytes: length }); queued += length; stats.peakQueuedBytes = Math.max(stats.peakQueuedBytes, queued);
    const bytes = data.buffer as ArrayBuffer;
    port.postMessage({ type: "chunk", id, bytes }, [bytes]); arm();
  };
  try {
    let batch = new Uint8Array(STREAM_CHUNK_BYTES), used = 0;
    while (true) {
      // Do not read ahead while all credits are occupied. Browser/network internal
      // read-ahead is browser-owned and is deliberately not called application queue.
      while (queued >= (pipelined ? STREAM_WINDOW_BYTES : STREAM_CHUNK_BYTES)) await wait();
      check(); const before = performance.now(); const { value, done } = await reader.read(); stats.readerWaitMs += performance.now() - before; check();
      if (done) break;
      stats.receivedBytes += value.byteLength;
      if (stats.receivedBytes > size) throw new Error("The source changed during loading. Open again to load a consistent file.");
      let offset = 0;
      while (offset < value.byteLength) {
        const take = Math.min(batch.length - used, value.byteLength - offset);
        batch.set(value.subarray(offset, offset + take), used); used += take; offset += take;
        if (used === batch.length) {
          while (queued + used > (pipelined ? STREAM_WINDOW_BYTES : STREAM_CHUNK_BYTES)) await wait();
          send(batch); batch = new Uint8Array(STREAM_CHUNK_BYTES); used = 0;
        }
      }
      update({ ...stats });
    }
    stats.receiveElapsedMs = performance.now() - start;
    if (stats.receivedBytes !== size) throw new Error("The download ended before the full model arrived. Check your connection and open again.");
    if (used) { while (queued + used > (pipelined ? STREAM_WINDOW_BYTES : STREAM_CHUNK_BYTES)) await wait(); send(batch.slice(0, used)); }
    while (pending.length) await wait();
    check(); return stats;
  } finally {
    clearTimeout(timeout); signal.removeEventListener("abort", abort); port.onmessage = null;
    await reader.cancel().catch(() => {});
  }
}
