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

export interface StreamMetrics extends StreamProgress {
  totalMs: number;
}
interface RendererStreamOptions {
  source: ReturnType<typeof createArtifactSource>;
  frame: HTMLIFrameElement;
  signal: AbortSignal;
  current: () => boolean;
  phase: (phase: "receiving" | "finalizing") => void;
  progress: (stats: StreamProgress) => void;
  ready: (metrics: StreamMetrics) => void;
  derive: () => void;
  cancelDerivation: () => void;
  error: (error: unknown) => void;
}

function completionMetrics(
  stats: StreamProgress,
  message: Record<string, unknown>,
  started: number,
): StreamMetrics {
  const timing = (key: "decodeMs" | "uploadMs") =>
    typeof message[key] === "number" &&
    Number.isFinite(message[key]) &&
    message[key] >= (stats[key] ?? 0)
      ? message[key]
      : stats[key];
  return {
    ...stats,
    totalMs: performance.now() - started,
    decodeMs: timing("decodeMs"),
    uploadMs: timing("uploadMs"),
  };
}

// Owns the source port from initialization through GPU completion and subsequent
// outline intents. No renderer-visible URL, selection, or authentication headers.
export function streamArtifactIntoRenderer(options: RendererStreamOptions) {
  const { source, frame, signal, current } = options;
  let port: MessagePort | undefined;
  let cancelCompletion = () => {};
  const rendererError = (data: any) => new Error(
    data?.error || "The renderer failed. Open again or download the original.",
  );
  const intent = (data: any) => {
    if (data?.type === "derive") { options.derive(); return true; }
    if (data?.type === "derive-cancel") { options.cancelDerivation(); return true; }
    return false;
  };
  // The completed wait relinquishes its listener, but outline intents remain live.
  const receiveIntent = (event: MessageEvent) => {
    if (!current() || intent(event.data) || event.data?.type === "complete") return;
    options.error(rendererError(event.data));
  };
  const finish = async (stats: StreamProgress, started: number) => {
    const completion = new AbortController();
    const abort = () => completion.abort();
    cancelCompletion = abort;
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      const message = await awaitPortReply<Record<string, unknown>>({
        port: port!, signal: completion.signal, timeout: 30000,
        timeoutMessage: "The full model did not finish decoding. Try a larger-memory device.",
        start: () => port!.postMessage({ type: "end" }),
        accept: (data) => {
          if (!current() || intent(data)) return undefined;
          if (data?.type === "complete") {
            port!.onmessage = receiveIntent;
            return { value: data };
          }
          throw rendererError(data);
        },
      });
      options.ready(completionMetrics(stats, message, started));
    } finally {
      signal.removeEventListener("abort", abort);
      cancelCompletion = () => {};
    }
  };
  return {
    getPort: () => port,
    async run(size: number) {
      const started = performance.now();
      const renderer = await openRendererPort(frame, size, signal);
      port = renderer.port;
      if (!current()) {
        port.close();
        return;
      }
      const reader = await source.open(size);
      options.phase("receiving");
      let lastProgress = -Infinity;
      const stats = await transferArtifact(
        reader,
        port,
        size,
        signal,
        renderer.pipelined,
        (stats) => {
          const now = performance.now();
          if (now - lastProgress < 100 && stats.processedBytes !== size) return;
          lastProgress = now;
          options.progress(stats);
        },
      );
      if (!current()) return;
      options.phase("finalizing");
      await finish(stats, started);
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
