// Host-owned recovery only; renderer-specific controls live inside the iframe.
export function createStreamShell(host: HTMLElement, layout: "inline" | "panel") {
  const panel = document.createElement("div");
  panel.className = "artifact-stream";
  panel.dataset.layout = layout;
  panel.style.cssText = `position:relative;width:100%;height:${layout === "panel" ? "100%" : "520px"};min-height:0;overflow:hidden`;
  const surface = document.createElement("div");
  surface.className = "artifact-stream-surface";
  surface.style.cssText = "width:100%;height:100%";
  const status = document.createElement("div");
  status.setAttribute("role", "status");
  status.textContent = "Loading preview…";
  panel.append(status, surface);
  host.replaceChildren(panel);
  return {
    ownsPanel: () => host.contains(panel),
    clear: () => surface.replaceChildren(),
    prepare(frame: HTMLIFrameElement, onReady?: (frame: HTMLIFrameElement, surface: HTMLElement) => void) {
      status.hidden = true;
      frame.style.cssText = "width:100%;height:100%;border:0";
      surface.append(frame);
      onReady?.(frame, surface);
    },
    reopenRequired() {
      status.hidden = false;
      status.textContent = "Reopen this artifact to check its current source.";
    },
    recover(heading: string, message: string, retry: () => void) {
      status.hidden = false;
      status.style.cssText = "position:absolute;inset:0;display:grid;align-content:center;justify-content:center;padding:24px;text-align:center";
      const title = document.createElement("h3");
      title.textContent = heading;
      const detail = document.createElement("p");
      detail.textContent = message;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Open again";
      button.onclick = retry;
      status.replaceChildren(title, detail, button);
    },
  };
}
