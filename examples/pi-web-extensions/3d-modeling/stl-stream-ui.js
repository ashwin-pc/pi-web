// Format-specific consent and diagnostics stay in the opaque STL renderer.
function createStlStreamUI(port, size) {
  const overlay = document.createElement("section");
  overlay.className = "stl-stream-overlay";
  overlay.innerHTML = `<div class="stl-stream-card"><h2>Open full-detail 3D preview</h2><p>See the original mesh, without simplification.</p><p class="stl-size"></p><p class="stl-warning">This large model needs substantial GPU and browser memory—several times the source size. It may slow down or crash this tab. Only its size has been checked so far.</p><progress max="100" hidden aria-label="Source bytes decoded"></progress><div><button class="stl-load">Load 3D preview</button><button class="stl-stop">Not now</button></div></div>`;
  document.body.append(overlay);
  const title = overlay.querySelector("h2"),
    status = overlay.querySelector("p"),
    meta = overlay.querySelector(".stl-size"),
    warning = overlay.querySelector(".stl-warning"),
    progress = overlay.querySelector("progress"),
    load = overlay.querySelector(".stl-load"),
    stop = overlay.querySelector(".stl-stop");
  meta.textContent = `${(size / 1048576).toFixed(1)} MiB · exact source geometry`;
  warning.hidden = size <= 20 * 1024 * 1024;
  stop.onclick = () => port.postMessage({ type: "release" });
  let received = 0, started;
  return {
    start(ready) {
      const begin = () => {
        started = performance.now();
        load.hidden = true;
        load.onclick = null;
        stop.textContent = "Stop loading";
        title.textContent = "Building your full-detail preview";
        status.textContent = "Receiving source and building GPU geometry";
        warning.textContent = "Every source triangle is retained. You can stop at any time.";
        progress.hidden = false;
        ready();
      };
      load.onclick = begin;
      // All previews require intent: historical cards must not allocate a GPU
      // context or request the full source merely because they are visible.
    },
    progress(bytes, metrics) {
      received += bytes;
      progress.value = received / size * 100;
      meta.textContent = `${(received / 1048576).toFixed(1)} / ${(size / 1048576).toFixed(1)} MiB processed`;
      warning.textContent = `${metrics.triangles.toLocaleString()} triangles decoded · no simplification`;
    },
    complete(metrics, transport) {
      overlay.remove();
      const unload = document.createElement("button");
      unload.className = "stl-unload";
      unload.textContent = "Unload";
      unload.setAttribute("aria-label", "Unload model");
      unload.title = `Unload model — release GPU memory. Decode: ${(metrics.decodeMs / 1000).toFixed(2)}s · GPU submission: ${(metrics.uploadMs / 1000).toFixed(2)}s · ready: ${((performance.now() - started) / 1000).toFixed(2)}s. Upload submission is not GPU completion.`;
      unload.onclick = () => port.postMessage({ type: "release" });
      if (transport) {
        const details = document.createElement("p");
        details.className = "stream-diagnostics";
        details.textContent = `${(transport.receivedBytes / 1048576).toFixed(1)} MiB received · ${(transport.processedBytes / 1048576).toFixed(1)} MiB processed · ${(transport.peakQueuedBytes / 1048576).toFixed(1)} MiB peak application queue · reader wait ${(transport.readerWaitMs / 1000).toFixed(2)}s · receive elapsed ${(transport.receiveElapsedMs / 1000).toFixed(2)}s (includes backpressure). Browser/network buffers are not included.`;
        document.querySelector(".information").append(details);
      }
      document.body.append(unload);
    },
  };
}
