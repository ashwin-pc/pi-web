// Classic-script helpers embedded into the opaque iframe; no network imports.
// ACKs are sent only after the consumer has decoded/uploaded the complete chunk.
function listenForStlSource({
  onOpen,
  onChunk,
  onEnd,
  onDeriveError,
  onDeriveStatus,
  isFailed,
  onError,
}) {
  let port,
    ended = false;
  window.addEventListener("message", (event) => {
    if (
      port ||
      event.source !== parent ||
      event.data?.type !== "pi-artifact-stream" ||
      event.ports.length !== 1
    )
      return;
    port = event.ports[0];
    const pipelined = event.data.streamVersion === 2;
    let nextChunk = 0;
    onOpen(port, event.data.size);
    port.onmessage = ({ data }) => {
      try {
        if (isFailed()) return;
        if (data?.type === "derive-error") {
          onDeriveError(
            data.error ||
              "Feature outline generation failed. The full mesh remains available.",
          );
          return;
        }
        if (data?.type === "derive-status") {
          onDeriveStatus();
          return;
        }
        if (ended) throw Error("Stream already completed.");
        if (data?.type === "chunk") {
          if (
            !(data.bytes instanceof ArrayBuffer) ||
            (pipelined &&
              (data.bytes.byteLength > 1024 * 1024 || data.id !== nextChunk++))
          )
            throw Error("Invalid source chunk.");
          const metrics = onChunk(new Uint8Array(data.bytes));
          port.postMessage({
            type: "ack",
            id: data.id,
            bytes: data.bytes.byteLength,
            ...metrics,
          });
        } else if (data?.type === "end") {
          const metrics = onEnd();
          ended = true;
          port.postMessage({ type: "complete", ...metrics });
        }
      } catch (error) {
        onError(error);
      }
    };
    port.postMessage({ type: "ready", streamVersion: pipelined ? 2 : 1 });
  });
}

function receiveStlEdges({ port, size, onBatch, onComplete, onError }) {
  let received = 0,
    nextChunk = 0,
    tail = new Uint8Array(0),
    lines = 0;
  port.onmessage = ({ data }) => {
    try {
      if (data?.type === "chunk") {
        if (
          !(data.bytes instanceof ArrayBuffer) ||
          data.id !== nextChunk++ ||
          data.bytes.byteLength > 1048576
        )
          throw Error("Invalid feature edge chunk.");
        const chunk = new Uint8Array(data.bytes);
        received += chunk.length;
        if (received > size) throw Error("Feature edge resource changed.");
        const joined = new Uint8Array(tail.length + chunk.length);
        joined.set(tail);
        joined.set(chunk, tail.length);
        const length = joined.length - (joined.length % 24);
        tail = joined.slice(length);
        if (length) {
          const coordinates = new Float32Array(joined.buffer, 0, length / 4);
          for (const coordinate of coordinates)
            if (!Number.isFinite(coordinate))
              throw Error("Invalid feature edge coordinate.");
          onBatch(coordinates);
          lines += length / 24;
        }
        port.postMessage({ type: "ack", id: data.id, bytes: chunk.length });
      } else if (data?.type === "end") {
        if (received !== size || tail.length)
          throw Error("Incomplete feature edge resource.");
        onComplete(lines);
        port.postMessage({ type: "complete" });
        port.close();
      }
    } catch (error) {
      port.postMessage({ type: "error", error: error.message });
      onError(error.message);
    }
  };
  port.postMessage({ type: "ready", streamVersion: 2 });
}
