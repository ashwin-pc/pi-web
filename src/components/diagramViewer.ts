import { createElement, Expand, Focus, X, ZoomIn, ZoomOut } from "lucide";

type Point = { x: number; y: number };

type Icon = Parameters<typeof createElement>[0];

let closeActiveViewer: (() => void) | undefined;

function button(label: string, icon: Icon) {
  const element = document.createElement("button");
  element.type = "button";
  element.setAttribute("aria-label", label);
  element.title = label;
  element.append(createElement(icon, { "aria-hidden": "true" }));
  return element;
}

export function openDiagramViewer(svg: SVGSVGElement, trigger?: HTMLElement): void {
  closeActiveViewer?.();

  const parent = svg.parentNode;
  if (!parent) return;
  const placeholder = document.createComment("mermaid diagram viewer placeholder");
  parent.replaceChild(placeholder, svg);

  const dialog = document.createElement("dialog");
  dialog.className = "diagramViewer";
  dialog.setAttribute("aria-label", "Diagram viewer");
  const toolbar = document.createElement("div");
  toolbar.className = "diagramViewerToolbar";
  const closeButton = button("Close diagram viewer", X);
  const zoomOut = button("Zoom out", ZoomOut);
  const zoomIn = button("Zoom in", ZoomIn);
  const fitButton = button("Fit diagram", Focus);
  const output = document.createElement("output");
  output.className = "diagramViewerZoom";
  output.setAttribute("aria-label", "Zoom level");
  toolbar.append(zoomOut, zoomIn, fitButton, output, closeButton);

  const canvas = document.createElement("div");
  canvas.className = "diagramViewerCanvas";
  canvas.tabIndex = 0;
  canvas.setAttribute("aria-label", "Diagram. Drag to pan, pinch or use the mouse wheel to zoom.");
  const layer = document.createElement("div");
  layer.className = "diagramViewerLayer";
  canvas.append(layer);
  dialog.append(toolbar, canvas);
  document.body.append(dialog);

  const box = svg.viewBox.baseVal;
  const bounds = svg.getBoundingClientRect();
  const width = box.width || bounds.width || 1;
  const height = box.height || bounds.height || 1;
  layer.style.width = `${width}px`;
  layer.style.height = `${height}px`;
  layer.append(svg);

  let x = 0;
  let y = 0;
  let scale = 1;
  let fitScale = 1;
  const pointers = new Map<number, Point>();

  const clampPan = () => {
    const viewport = canvas.getBoundingClientRect();
    const renderedWidth = width * scale;
    const renderedHeight = height * scale;
    const margin = 48;
    x = renderedWidth <= viewport.width ? (viewport.width - renderedWidth) / 2 : Math.min(margin, Math.max(viewport.width - renderedWidth - margin, x));
    y = renderedHeight <= viewport.height ? (viewport.height - renderedHeight) / 2 : Math.min(margin, Math.max(viewport.height - renderedHeight - margin, y));
  };
  const render = () => {
    clampPan();
    layer.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
    output.value = `${Math.round(scale / fitScale * 100)}%`;
  };
  const zoomAt = (next: number, ax: number, ay: number) => {
    const bounded = Math.min(fitScale * 12, Math.max(fitScale * .5, next));
    const localX = (ax - x) / scale;
    const localY = (ay - y) / scale;
    scale = bounded;
    x = ax - localX * scale;
    y = ay - localY * scale;
    render();
  };
  const fit = () => {
    const viewport = canvas.getBoundingClientRect();
    fitScale = Math.min(viewport.width / width, viewport.height / height);
    scale = fitScale;
    x = (viewport.width - width * scale) / 2;
    y = (viewport.height - height * scale) / 2;
    render();
  };

  const close = () => { if (dialog.open) dialog.close(); else cleanup(); };
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    resizeObserver.disconnect();
    window.visualViewport?.removeEventListener("resize", fit);
    if (placeholder.parentNode) placeholder.parentNode.replaceChild(svg, placeholder);
    dialog.remove();
    closeActiveViewer = undefined;
    // Native dialog focus restoration runs after the close event in some browsers.
    requestAnimationFrame(() => trigger?.focus());
  };
  closeActiveViewer = close;
  dialog.addEventListener("close", cleanup, { once: true });
  closeButton.addEventListener("click", close);
  fitButton.addEventListener("click", fit);
  zoomIn.addEventListener("click", () => zoomAt(scale * 1.25, canvas.clientWidth / 2, canvas.clientHeight / 2));
  zoomOut.addEventListener("click", () => zoomAt(scale / 1.25, canvas.clientWidth / 2, canvas.clientHeight / 2));
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    zoomAt(scale * Math.exp(-event.deltaY * .002), event.clientX - rect.left, event.clientY - rect.top);
  }, { passive: false });
  canvas.addEventListener("dblclick", (event) => {
    const rect = canvas.getBoundingClientRect();
    zoomAt(scale * 1.5, event.clientX - rect.left, event.clientY - rect.top);
  });
  canvas.addEventListener("pointerdown", (event) => {
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try { canvas.setPointerCapture(event.pointerId); } catch { /* unsupported/synthetic event */ }
  });
  canvas.addEventListener("pointermove", (event) => {
    const old = pointers.get(event.pointerId);
    if (!old) return;
    const before = [...pointers.values()];
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const after = [...pointers.values()];
    if (after.length === 1) {
      x += event.clientX - old.x;
      y += event.clientY - old.y;
      render();
    } else if (after.length >= 2) {
      const [a0, b0] = before;
      const [a1, b1] = after;
      const oldMid = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
      const newMid = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 };
      const oldDistance = Math.hypot(a0.x - b0.x, a0.y - b0.y) || 1;
      const newDistance = Math.hypot(a1.x - b1.x, a1.y - b1.y);
      const rect = canvas.getBoundingClientRect();
      const oldX = oldMid.x - rect.left;
      const oldY = oldMid.y - rect.top;
      const newX = newMid.x - rect.left;
      const newY = newMid.y - rect.top;
      const localX = (oldX - x) / scale;
      const localY = (oldY - y) / scale;
      scale = Math.min(fitScale * 12, Math.max(fitScale * .5, scale * newDistance / oldDistance));
      x = newX - localX * scale;
      y = newY - localY * scale;
      render();
    }
  });
  const release = (event: PointerEvent) => pointers.delete(event.pointerId);
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  dialog.addEventListener("keydown", (event) => {
    const amount = 40;
    if (event.key === "+" || event.key === "=") zoomIn.click();
    else if (event.key === "-") zoomOut.click();
    else if (event.key === "0") fit();
    else if (event.key.startsWith("Arrow")) {
      if (event.key === "ArrowLeft") x += amount;
      if (event.key === "ArrowRight") x -= amount;
      if (event.key === "ArrowUp") y += amount;
      if (event.key === "ArrowDown") y -= amount;
      render();
    } else return;
    event.preventDefault();
  });

  const resizeObserver = new ResizeObserver(fit);
  resizeObserver.observe(canvas);
  window.visualViewport?.addEventListener("resize", fit);
  dialog.showModal();
  requestAnimationFrame(() => { fit(); canvas.focus(); });
}

export function attachDiagramViewer(container: HTMLElement, svg: SVGSVGElement): void {
  if (container.querySelector(".diagramViewerOpen")) return;
  const open = button("Open diagram viewer", Expand);
  open.className = "diagramViewerOpen";
  open.addEventListener("click", () => openDiagramViewer(svg, open));
  container.append(open);
}
