import { transferArtifact } from "./artifactStreamTransport.js";
import type { ArtifactStreamOptions } from "./artifactStream.js";

export function createOutlineController({
  frame,
  derivation,
  headers,
  current,
  getPort,
  isModelComplete,
}: {
  frame: HTMLIFrameElement;
  derivation: ArtifactStreamOptions["derivation"];
  headers: ArtifactStreamOptions["headers"];
  current: () => boolean;
  getPort: () => MessagePort | undefined;
  isModelComplete: () => boolean;
}) {
  let derivedController: AbortController | undefined;
  let derivedPort: MessagePort | undefined;
  let queuedDerivation = false;
  const derive = async () => {
    if (!derivation || !isModelComplete() || !current()) return;
    if (derivedController) {
      // ON after OFF is a new intent, not a duplicate of the cancelled job.
      // Wait for the old operation to settle rather than overlap generations.
      if (derivedController.signal.aborted) queuedDerivation = true;
      return;
    }
    const active = new AbortController();
    derivedController = active;
    getPort()?.postMessage({ type: "derive-status", status: "generating" });
    try {
      const response = await fetch("/api/web-contributions/artifact-derived", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(derivation),
        signal: active.signal,
        cache: "no-store",
        redirect: "error",
      });
      if (!response.ok || !response.body) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || "Outline generation failed");
      }
      const size = Number(response.headers.get("content-length"));
      if (!Number.isSafeInteger(size) || size < 0 || size > 128 * 1024 * 1024)
        throw new Error("Invalid derived artifact size");
      const channel = new MessageChannel();
      derivedPort = channel.port1;
      const pipelined = await new Promise<boolean>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("Outline renderer did not initialize"));
        }, 15000);
        const cleanup = () => {
          clearTimeout(timer);
          active.signal.removeEventListener("abort", abort);
          if (derivedPort) derivedPort.onmessage = null;
        };
        const abort = () => {
          cleanup();
          reject(new Error("Cancelled"));
        };
        if (active.signal.aborted) {
          abort();
          return;
        }
        active.signal.addEventListener("abort", abort, { once: true });
        derivedPort!.onmessage = (event) => {
          cleanup();
          if (event.data?.type === "ready")
            resolve(event.data.streamVersion === 2);
          else
            reject(new Error(event.data?.error || "Outline renderer failed"));
        };
        frame.contentWindow?.postMessage(
          { type: "pi-artifact-derived", size, streamVersion: 2 },
          "*",
          [channel.port2],
        );
      });
      await transferArtifact(
        response.body.getReader(),
        derivedPort,
        size,
        active.signal,
        pipelined,
        () => {},
      );
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("Outline renderer did not complete"));
        }, 30000);
        const cleanup = () => {
          clearTimeout(timer);
          active.signal.removeEventListener("abort", abort);
          if (derivedPort) derivedPort.onmessage = null;
        };
        const abort = () => {
          cleanup();
          reject(new Error("Cancelled"));
        };
        if (active.signal.aborted) {
          abort();
          return;
        }
        active.signal.addEventListener("abort", abort, { once: true });
        derivedPort!.onmessage = (event) => {
          cleanup();
          event.data?.type === "complete"
            ? resolve()
            : reject(new Error(event.data?.error || "Outline renderer failed"));
        };
        derivedPort!.postMessage({ type: "end" });
      });
    } catch (error) {
      if (current() && !active.signal.aborted)
        getPort()?.postMessage({
          type: "derive-error",
          error: error instanceof Error ? error.message : String(error),
        });
    } finally {
      active.abort();
      if (derivedController === active) {
        derivedPort?.close();
        derivedPort = undefined;
        derivedController = undefined;
        const restart = queuedDerivation;
        queuedDerivation = false;
        if (restart && current()) void derive();
      }
    }
  };
  return {
    derive,
    cancel: () => {
      queuedDerivation = false;
      derivedController?.abort();
    },
    dispose: () => {
      queuedDerivation = false;
      derivedController?.abort();
      derivedPort?.close();
    },
  };
}
