import { awaitPortReply } from "./artifactPortReply.js";
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
    let remotePort: MessagePort | undefined;
    try {
      getPort()?.postMessage({ type: "derive-status", status: "generating" });
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
      remotePort = channel.port2;
      const port = derivedPort;
      const pipelined = await awaitPortReply({
        port, signal: active.signal, timeout: 15000,
        timeoutMessage: "Outline renderer did not initialize",
        start: () => frame.contentWindow?.postMessage(
          { type: "pi-artifact-derived", size, streamVersion: 2 }, "*", [channel.port2],
        ),
        accept: (data) => {
          if (data?.type === "ready") return { value: data.streamVersion === 2 };
          throw new Error(data?.error || "Outline renderer failed");
        },
      });
      await transferArtifact(
        response.body.getReader(),
        derivedPort,
        size,
        active.signal,
        pipelined,
        () => {},
      );
      await awaitPortReply({
        port, signal: active.signal, timeout: 30000,
        timeoutMessage: "Outline renderer did not complete",
        start: () => port.postMessage({ type: "end" }),
        accept: (data) => {
          if (data?.type === "complete") return { value: undefined };
          throw new Error(data?.error || "Outline renderer failed");
        },
      });
    } catch (error) {
      if (current() && !active.signal.aborted)
        getPort()?.postMessage({
          type: "derive-error",
          error: error instanceof Error ? error.message : String(error),
        });
    } finally {
      active.abort();
      remotePort?.close();
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
