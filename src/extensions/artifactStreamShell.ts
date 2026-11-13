import type { StreamProgress } from "./artifactStreamTransport.js";
import type { StreamMetrics } from "./artifactStreamSource.js";

const shellStyle = `.artifact-stream {
  position:relative;
  width:100%;
  height:520px;
  min-width:0;
  min-height:0;
  background:radial-gradient(ellipse at 50% 40%,#373735,#20201f 65%,#171716);
  color:#f2f2f2;
  border-radius:0 0 10px 10px;
  overflow:hidden;
  font:13px/1.5 system-ui,sans-serif;
  color-scheme:dark
}

.artifact-stream * {
  box-sizing:border-box
}

.artifact-stream[data-layout="panel"] {
  height:100%;
  border-radius:0
}

.artifact-stream iframe {
  display:block;
  width:100%;
  height:100%;
  border:0;
  background:transparent
}

.artifact-stream-surface {
  position:absolute;
  inset:0
}

.artifact-stream-card {
  position:absolute;
  inset:0;
  z-index:1;
  overflow:auto;
  display:flex;
  align-items:center;
  justify-content:center;
  padding:28px
}

.artifact-stream-card>div {
  max-width:390px;
  width:100%
}

.artifact-stream-icon {
  display:block;
  color:#d7bb7b;
  font-size:36px;
  line-height:1;
  margin-bottom:22px
}

.artifact-stream h3 {
  font-size:20px;
  letter-spacing:-.025em;
  font-weight:550;
  margin:0 0 8px
}

.artifact-stream p {
  margin:10px 0;
  color:#a7b4c5
}

.artifact-stream .stream-meta {
  font-size:12px;
  color:#d1bc91
}

.artifact-stream .stream-warning {
  margin:22px 0;
  font-size:12px;
  line-height:1.7;
  color:#a7b4c5
}

.artifact-stream .stream-actions {
  display:flex;
  align-items:center;
  gap:9px;
  flex-wrap:wrap;
  margin-top:22px
}

.artifact-stream button,.artifact-stream a {
  font:inherit;
  border:1px solid #ffffff24;
  color:#d8e0eb;
  background:#ffffff06;
  border-radius:7px;
  padding:10px 15px;
  cursor:pointer;
  text-decoration:none;
  min-height:42px
}

.artifact-stream button:hover,.artifact-stream a:hover {
  background:#ffffff12
}

.artifact-stream button.primary {
  background:#d8bd83;
  border-color:#d8bd83;
  color:#191b20;
  font-weight:600
}

.artifact-stream button:focus-visible,.artifact-stream a:focus-visible {
  outline:2px solid #e9cc8a;
  outline-offset:3px
}

.artifact-stream progress {
  width:100%;
  height:5px;
  accent-color:#d8bd83;
  margin:18px 0 3px
}

.artifact-stream .stream-phase {
  font-size:12px;
  color:#d1bc91
}

.artifact-stream .stream-count {
  font-variant-numeric:tabular-nums;
  font-size:12px
}

.artifact-stream .stream-ready {
  position:absolute;
  z-index:2;
  right:96px;
  top:18px;
  display:flex;
  align-items:center;
  gap:8px;
  font-size:11px;
  color:#a3a3a3;
  pointer-events:none
}

.artifact-stream .stream-ready>span {
  position:absolute;
  right:0;
  top:42px;
  white-space:nowrap;
  padding:3px 7px;
  border-radius:4px;
  background:#191919b8;
  opacity:0;
  transition:opacity .15s
}

.artifact-stream .stream-ready:hover>span,.artifact-stream .stream-ready:focus-within>span {
  opacity:1
}

.artifact-stream .stream-ready button {
  pointer-events:auto;
  min-height:36px;
  height:36px;
  width:88px;
  padding:0;
  display:flex;
  align-items:center;
  justify-content:center;
  gap:5px;
  font-size:11px;
  background:#191919d9
}

.artifact-stream [hidden] {
  display:none!important
}

@media(max-width:540px) {
  .artifact-stream-card {
  padding:24px
}

.artifact-stream h3 {
  font-size:19px
}

}
`;

export function createStreamShell(
  host: HTMLElement,
  url: string,
  layout: "inline" | "panel",
) {
  const panel = document.createElement("div");
  panel.className = "artifact-stream";
  panel.setAttribute("data-layout", layout);
  const style = document.createElement("style");
  style.textContent = shellStyle;
  const card = document.createElement("div");
  card.className = "artifact-stream-card";
  const content = document.createElement("div");
  card.append(content);
  const icon = document.createElement("span");
  icon.className = "artifact-stream-icon";
  icon.textContent = "◇";
  icon.setAttribute("aria-hidden", "true");
  const title = document.createElement("h3");
  title.textContent = "Preparing 3D preview";
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.textContent = "Checking source size…";
  const meta = document.createElement("p");
  meta.className = "stream-meta";
  const warning = document.createElement("p");
  warning.className = "stream-warning";
  const progress = document.createElement("progress");
  progress.max = 100;
  progress.hidden = true;
  progress.setAttribute("aria-label", "Source bytes decoded");
  const actions = document.createElement("div");
  actions.className = "stream-actions";
  const load = document.createElement("button");
  load.type = "button";
  load.textContent = "Load full model";
  load.className = "primary";
  load.hidden = true;
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Not now";
  const download = document.createElement("a");
  download.textContent = "Download original";
  download.href = url;
  download.setAttribute("download", "");
  download.hidden = true;
  actions.append(load, cancel, download);
  content.append(icon, title, status, meta, warning, progress, actions);
  const ready = document.createElement("div");
  ready.className = "stream-ready";
  ready.hidden = true;
  const readyLabel = document.createElement("span");
  readyLabel.textContent = "Exact source mesh · no simplification";
  const close = document.createElement("button");
  close.type = "button";
  close.innerHTML =
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v9M6.3 5.7a9 9 0 1 0 11.4 0"/></svg><span class="unload-label">Unload</span>';
  close.setAttribute("aria-label", "Unload model");
  close.title = "Unload model — release GPU memory";
  ready.append(readyLabel, close);
  // Keep the interaction shield local to the rendered surface, not the
  // consent/progress card or the host-owned Close model control.
  const surface = document.createElement("div");
  surface.className = "artifact-stream-surface";
  panel.append(style, card, surface, ready);
  host.replaceChildren(panel);
  let sourceSize = 0;
  return {
    ownsPanel: () => host.contains(panel),
    clear: () => {
      surface.replaceChildren();
    },
    actions(callbacks: { cancel: () => void; close: () => void }) {
      cancel.onclick = callbacks.cancel;
      close.onclick = callbacks.close;
    },
    source(size: number, start: () => void) {
      sourceSize = size;
      meta.textContent = `${(size / 1048576).toFixed(1)} MiB · exact source geometry`;
      if (size <= 20 * 1024 * 1024) {
        start();
        return;
      }
      title.textContent = "Open full-detail 3D preview";
      status.textContent = "See the original mesh, without simplification.";
      warning.textContent =
        "This large model needs substantial GPU and browser memory—several times the source size. It may slow down or crash this tab. Only its size has been checked so far.";
      load.hidden = false;
      load.onclick = start;
    },
    prepare(frame: HTMLIFrameElement) {
      load.onclick = null;
      load.hidden = true;
      cancel.textContent = "Stop loading";
      title.textContent = "Building your full-detail preview";
      status.textContent = "Preparing the renderer…";
      warning.textContent =
        "Every source triangle is retained. You can stop at any time.";
      frame.style.width = "100%";
      frame.style.height = "100%";
      // Keep the consent/progress surface stable while initializing invisibly.
      frame.style.position = "absolute";
      frame.style.visibility = "hidden";
      surface.append(frame);
    },
    phase(phase: "receiving" | "finalizing") {
      if (phase === "receiving") progress.hidden = false;
      status.textContent =
        phase === "receiving"
          ? "Receiving source and building GPU geometry"
          : "Finalizing GPU buffers…";
    },
    progress(stats: StreamProgress) {
      progress.value = (stats.processedBytes / sourceSize) * 100;
      meta.textContent = `${(stats.receivedBytes / 1048576).toFixed(1)} / ${(sourceSize / 1048576).toFixed(1)} MiB received · ${(stats.processedBytes / 1048576).toFixed(1)} MiB processed`;
      warning.textContent = `${stats.triangles.toLocaleString()} triangles decoded · no simplification`;
    },
    complete(
      frame: HTMLIFrameElement,
      metrics: StreamMetrics,
      onReady?: (frame: HTMLIFrameElement, surface: HTMLElement) => void,
    ) {
      const seconds = (value: number | undefined) =>
        value === undefined ? "unreported" : `${(value / 1000).toFixed(2)}s`;
      panel.setAttribute("data-stream-metrics", JSON.stringify(metrics));
      ready.title = `Receive elapsed (includes backpressure): ${seconds(metrics.receiveElapsedMs)} · decode: ${seconds(metrics.decodeMs)} · GPU submission: ${seconds(metrics.uploadMs)} · ready: ${seconds(metrics.totalMs)}. Decode and upload overlap transfer; GPU submission is not GPU completion.`;
      card.hidden = true;
      ready.hidden = false;
      panel.append(ready);
      frame.style.position = "static";
      frame.style.visibility = "visible";
      onReady?.(frame, surface);
    },
    reopenRequired() {
      status.textContent = "Reopen this artifact to check its current source.";
    },
    recover(heading: string, message: string, retry: () => void) {
      ready.hidden = true;
      card.hidden = false;
      title.textContent = heading;
      status.textContent = message;
      warning.textContent =
        "The original file is unchanged. Opening again starts a fresh stream; no reduced-detail fallback is used.";
      meta.textContent = sourceSize
        ? `Source: ${(sourceSize / 1048576).toFixed(1)} MiB`
        : "";
      meta.style.color = "#9aabbe";
      progress.hidden = true;
      load.hidden = false;
      load.textContent = "Open again";
      load.onclick = retry;
      cancel.hidden = true;
      download.hidden = false;
    },
  };
}
