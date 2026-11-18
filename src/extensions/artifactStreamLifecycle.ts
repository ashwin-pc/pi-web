import { awaitPortReply } from "./artifactPortReply.js";
// One connection observer per document, not one subtree callback per preview.
const watchers = new Set<() => void>();
let observer: MutationObserver | undefined;
export function watchArtifactConnection(check: () => void): () => void {
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
  intent: (data: any) => boolean = () => false,
): Promise<{ port: MessagePort; pipelined: boolean }> {
  const channel = new MessageChannel();
  const port = channel.port1;
  return awaitPortReply({
    port, signal, timeout: 15000,
    timeoutMessage: "The renderer did not initialize. Open again to retry.",
    suspendTimeout: (data) => data?.type === "connected",
    cleanup: () => { frame.onload = null; },
    start: (failLoad) => {
      frame.onload = () => {
        frame.onload = null;
        try {
          frame.contentWindow?.postMessage(
            { type: "pi-artifact-stream", size, streamVersion: 2 },
            "*", [channel.port2],
          );
        } catch (error) { failLoad(error); }
      };
    },
    accept: (data) => {
      if (intent(data)) return undefined;
      if (data?.type === "ready") return { value: { port, pipelined: data.streamVersion === 2 } };
      if (data?.type === "error") throw new Error(data.error || "Renderer unavailable.");
      return undefined;
    },
  }).catch((error) => {
    port.close();
    channel.port2.close();
    throw error;
  });
}
