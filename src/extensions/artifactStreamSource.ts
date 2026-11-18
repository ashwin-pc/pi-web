import { awaitPortReply } from "./artifactPortReply.js";
import { openRendererPort } from "./artifactStreamLifecycle.js";
import {
  transferArtifact,
  type StreamProgress,
} from "./artifactStreamTransport.js";
import type { ArtifactStreamOptions } from "./artifactStream.js";

// Source authority stays host-owned: never send headers or the selection to the iframe.
export function createArtifactSource(
  {
    url,
    headers,
    derivation,
  }: Pick<ArtifactStreamOptions, "url" | "headers" | "derivation">,
  signal: AbortSignal,
) {
  const request = (extra: Record<string, string> = {}) =>
    fetch(url, {
      headers: {
        ...headers(),
        ...(derivation
          ? { "x-pi-artifact-selection": derivation.selection }
          : {}),
        ...extra,
      },
      signal,
      redirect: "error",
      cache: "no-store",
    });
  return {
    async probe(): Promise<number> {
      const response = await request({ Range: "bytes=0-0" });
      const match = /^bytes 0-0\/(\d+)$/.exec(
        response.headers.get("content-range") || "",
      );
      await response.body?.cancel();
      if (!response.ok || !match)
        throw new Error(
          "Source size could not be checked safely. Check your connection and open again.",
        );
      const size = Number(match[1]);
      if (!Number.isSafeInteger(size) || size <= 0)
        throw new Error("The source file is empty or has an invalid size.");
      return size;
    },
    async open(size: number) {
      const response = await request();
      if (
        !response.ok ||
        !response.body ||
        Number(response.headers.get("content-length")) !== size
      )
        throw new Error(
          "The source changed or the download failed. Open again to check the current file.",
        );
      return response.body.getReader();
    },
  };
}

interface RendererStreamOptions {
  source: ReturnType<typeof createArtifactSource>;
  frame: HTMLIFrameElement;
  signal: AbortSignal;
  current: () => boolean;
  ready: () => void;
  derive: () => void;
  cancelDerivation: () => void;
  release: () => void;
  reopen: () => void;
  error: (error: unknown) => void;
}

// Owns the source port from initialization through completion and subsequent
// derived-stream intents. No renderer-visible URL, selection, or authentication headers.
export function streamArtifactIntoRenderer(options: RendererStreamOptions) {
  const { source, frame, signal, current } = options;
  let port: MessagePort | undefined;
  let cancelCompletion = () => {};
  const rendererError = (data: any) => new Error(
    data?.error || "The renderer failed. Open again or download the original.",
  );
  const intent = (data: any) => {
    if (data?.type === "release") { options.release(); return true; }
    if (data?.type === "reopen") { options.reopen(); return true; }
    if (data?.type === "derive") { options.derive(); return true; }
    if (data?.type === "derive-cancel") { options.cancelDerivation(); return true; }
    return false;
  };
  // The completed wait relinquishes its listener, but derived-stream intents remain live.
  const receiveIntent = (event: MessageEvent) => {
    if (!current() || intent(event.data) || event.data?.type === "complete") return;
    options.error(rendererError(event.data));
  };
  const finish = async (stats: StreamProgress) => {
    const completion = new AbortController();
    const abort = () => completion.abort();
    cancelCompletion = abort;
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      await awaitPortReply<Record<string, unknown>>({
        port: port!, signal: completion.signal, timeout: 30000,
        timeoutMessage: "The renderer did not finish processing the artifact. Open again to retry.",
        start: () => port!.postMessage({ type: "end", stats }),
        accept: (data) => {
          if (!current() || intent(data)) return undefined;
          if (data?.type === "complete") {
            port!.onmessage = receiveIntent;
            return { value: data };
          }
          throw rendererError(data);
        },
      });
      options.ready();
    } finally {
      signal.removeEventListener("abort", abort);
      cancelCompletion = () => {};
    }
  };
  return {
    getPort: () => port,
    async run(size: number) {
      const renderer = await openRendererPort(frame, size, signal, intent);
      port = renderer.port;
      if (!current()) {
        port.close();
        return;
      }
      const reader = await source.open(size);
      const stats = await transferArtifact(reader, port, size, signal, renderer.pipelined, () => {}, intent);
      if (!current()) return;
      await finish(stats);
    },
    dispose() {
      cancelCompletion();
      if (port) {
        port.onmessage = null;
        port.close();
      }
    },
  };
}
