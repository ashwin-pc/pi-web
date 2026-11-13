// One bounded wait; the caller retains ownership of the port.
export function awaitPortReply<T>({
  port, signal, timeout, timeoutMessage, start, accept, cleanup: cleanupStart,
}: {
  port: MessagePort;
  signal: AbortSignal;
  timeout: number;
  timeoutMessage: string;
  start: (fail: (error: unknown) => void) => void;
  accept: (data: any) => { value: T } | undefined;
  cleanup?: () => void;
}): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (port.onmessage === receive) port.onmessage = null;
      cleanupStart?.();
    };
    const settle = (error?: unknown, result?: { value: T }) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (result) resolve(result.value);
      else reject(error);
    };
    const abort = () => settle(new Error("Cancelled"));
    const receive = (event: MessageEvent) => {
      try {
        const result = accept(event.data);
        if (result) settle(undefined, result);
      } catch (error) { settle(error); }
    };
    const timer = setTimeout(() => settle(new Error(timeoutMessage)), timeout);
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    port.onmessage = receive;
    try { start((error) => settle(error)); } catch (error) { settle(error); }
  });
}
