// One connection observer per document, not one subtree callback per preview.
const watchers = new Set<() => void>();
let observer: MutationObserver | undefined;
export function watchStreamConnection(check: () => void): () => void {
  watchers.add(check);
  if (!observer) {
    observer = new MutationObserver(() => {
      // MutationObserver already coalesces a synchronous reparent into one delivery.
      for (const watcher of [...watchers]) watcher();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }
  return () => {
    watchers.delete(check);
    if (!watchers.size) {
      observer?.disconnect();
      observer = undefined;
    }
  };
}

export function openRendererPort(
  frame: HTMLIFrameElement,
  size: number,
  signal: AbortSignal,
): Promise<{ port: MessagePort; pipelined: boolean }> {
  return new Promise((resolve, reject) => {
    let port: MessagePort | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      frame.onload = null;
      if (port) port.onmessage = null;
    };
    const fail = (message: string) => {
      cleanup();
      port?.close();
      reject(new Error(message));
    };
    const abort = () => fail("Cancelled");
    const timer = setTimeout(
      () =>
        fail(
          "The renderer did not initialize. Try a browser with WebGL 2 support.",
        ),
      15000,
    );
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    frame.onload = () => {
      frame.onload = null;
      const channel = new MessageChannel();
      port = channel.port1;
      port.onmessage = (event) => {
        if (event.data?.type === "ready") {
          cleanup();
          resolve({ port: port!, pipelined: event.data.streamVersion === 2 });
        } else if (event.data?.type === "error")
          fail(event.data.error || "WebGL renderer unavailable.");
      };
      frame.contentWindow?.postMessage(
        { type: "pi-artifact-stream", size, streamVersion: 2 },
        "*",
        [channel.port2],
      );
    };
  });
}
