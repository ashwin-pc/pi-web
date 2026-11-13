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
  const finish = (stats: StreamProgress, started: number) =>
    new Promise<void>((resolve, reject) => {
      let completed = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        cancelCompletion = () => {};
      };
      const fail = (error: Error) => {
        cleanup();
        if (completed) options.error(error);
        else reject(error);
      };
      const abort = () => fail(new Error("Cancelled"));
      const timer = setTimeout(
        () =>
          fail(
            new Error(
              "The full model did not finish decoding. Try a larger-memory device.",
            ),
          ),
        30000,
      );
      cancelCompletion = abort;
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
      port!.onmessage = (event) => {
        if (!current()) return;
        if (event.data?.type === "derive") {
          options.derive();
          return;
        }
        if (event.data?.type === "derive-cancel") {
          options.cancelDerivation();
          return;
        }
        if (event.data?.type !== "complete") {
          fail(
            new Error(
              event.data?.error ||
                "The renderer failed. Open again or download the original.",
            ),
          );
          return;
        }
        cleanup();
        if (!completed) {
          completed = true;
          options.ready(completionMetrics(stats, event.data, started));
          resolve();
        }
      };
      // Install the completion/intent handler before asking the renderer to finish.
      port!.postMessage({ type: "end" });
    });
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
