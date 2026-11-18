export function bridgeJson(value: unknown) {
  const encoded = JSON.stringify(value);
  if (!encoded || new TextEncoder().encode(encoded).byteLength > 64 * 1024) throw new Error("Invalid bridge JSON");
  return JSON.parse(encoded);
}

/** One ACKed delivery at a time; never retain an unbounded MessagePort queue. */
export function createBridgeDelivery(fail: () => void) {
  let port: MessagePort | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
  let ready = false, awaiting = false, bytes = 0;
  const queue: { data: Record<string, unknown>; bytes: number }[] = [];
  const clearDeadline = () => { clearTimeout(deadline); deadline = undefined; };
  const arm = () => { clearDeadline(); deadline = setTimeout(fail, 10_000); };
  const flush = () => {
    if (!ready || awaiting || !port || !queue.length) return;
    const next = queue.shift()!; bytes -= next.bytes;
    awaiting = true; arm(); port.postMessage(next.data);
  };
  const reset = () => {
    // Transport generations may discard stale events/state, never terminal command
    // outcomes. A reset is not an ACK: retain the existing credit and deadline.
    const terminal = queue.filter(({ data }) => data.type === "response" || data.type === "error");
    queue.splice(0, queue.length, ...terminal);
    bytes = terminal.reduce((total, entry) => total + entry.bytes, 0);
    flush();
  };
  return {
    attach(value: MessagePort) { port = value; arm(); },
    ready() { if (!ready) { ready = true; clearDeadline(); flush(); } },
    ack() { if (awaiting) { awaiting = false; clearDeadline(); flush(); } },
    send(data: Record<string, unknown>) {
      const size = new TextEncoder().encode(JSON.stringify(data)).byteLength;
      if (queue.length >= 32 || bytes + size > 256 * 1024) { fail(); return; }
      queue.push({ data, bytes: size }); bytes += size; flush();
    },
    reset,
    dispose() { clearDeadline(); queue.length = 0; try { port?.postMessage({ type: "closed" }); } catch { /* detached */ } port?.close(); },
  };
}
