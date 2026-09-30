// The image renderer is shared by file-backed and transient image previews.
// All listeners belong to the rendered node and are released when it is replaced.
export function mountImagePreview(host: HTMLElement, source: string, alt: string, onSwipe: (direction: number) => void, onError: () => void): () => void {
  const controller = new AbortController();
  const { signal } = controller;
  host.className = "artifactBrowserPreviewBody artifactBrowserPreviewBody--image";
  host.textContent = "";
  const image = document.createElement("img");
  image.src = source;
  image.alt = alt;
  image.draggable = false;
  image.addEventListener("error", onError, { once: true, signal });
  const controls = document.createElement("div");
  controls.className = "artifactImageZoom";
  const out = document.createElement("button"); out.type = "button"; out.textContent = "−"; out.title = "Zoom out"; out.setAttribute("aria-label", out.title);
  const reset = document.createElement("button"); reset.type = "button"; reset.textContent = "100%"; reset.title = "Reset zoom"; reset.setAttribute("aria-label", reset.title);
  const into = document.createElement("button"); into.type = "button"; into.textContent = "+"; into.title = "Zoom in"; into.setAttribute("aria-label", into.title);
  controls.append(out, reset, into);
  host.append(image, controls);
  let scale = 1;
  let x = 0, y = 0;
  const transform = () => {
    const maxX = Math.max(0, (image.clientWidth * scale - host.clientWidth) / 2);
    const maxY = Math.max(0, (image.clientHeight * scale - host.clientHeight) / 2);
    x = Math.max(-maxX, Math.min(maxX, x));
    y = Math.max(-maxY, Math.min(maxY, y));
    image.dataset.zoomed = String(scale > 1);
    image.style.transform = scale === 1 ? "" : `translate(${x}px, ${y}px) scale(${scale})`;
    reset.textContent = `${Math.round(scale * 100)}%`;
  };
  const zoom = (next: number, point?: { x: number; y: number }) => {
    const previous = scale; scale = Math.max(1, Math.min(6, next));
    if (point && previous !== scale) {
      const rect = image.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2, centerY = rect.top + rect.height / 2;
      x += (centerX - point.x) * (scale / previous - 1);
      y += (centerY - point.y) * (scale / previous - 1);
    }
    if (scale === 1) x = y = 0; transform();
  };
  out.addEventListener("click", () => zoom(scale / 1.25), { signal });
  into.addEventListener("click", () => zoom(scale * 1.25), { signal });
  reset.addEventListener("click", () => zoom(1), { signal });
  image.addEventListener("wheel", (event) => {
    if (!event.ctrlKey && !event.metaKey) return; // ordinary scrolling stays native
    event.preventDefault(); zoom(scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15), { x: event.clientX, y: event.clientY });
  }, { passive: false, signal });
  let mouse: { pointerId: number; startX: number; startY: number; lastX: number; lastY: number } | undefined;
  let suppressClick = false;
  image.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "mouse" || event.button !== 0 || scale <= 1) return;
    mouse = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY };
    suppressClick = false;
    image.setPointerCapture(event.pointerId);
  }, { signal });
  image.addEventListener("pointermove", (event) => {
    if (!mouse || event.pointerId !== mouse.pointerId) return;
    if (Math.hypot(event.clientX - mouse.startX, event.clientY - mouse.startY) > 3) suppressClick = true;
    x += event.clientX - mouse.lastX; y += event.clientY - mouse.lastY;
    mouse.lastX = event.clientX; mouse.lastY = event.clientY;
    transform();
  }, { signal });
  const finishMouse = () => { mouse = undefined; };
  image.addEventListener("pointerup", finishMouse, { signal });
  image.addEventListener("pointercancel", finishMouse, { signal });
  image.addEventListener("click", (event) => { if (suppressClick) { event.preventDefault(); suppressClick = false; } }, { signal });
  let touchStart: { x: number; y: number } | undefined;
  let pinchDistance = 0, pinchScale = 1, pinched = false;
  let lastTouch: { x: number; y: number } | undefined;
  image.addEventListener("touchstart", (event) => {
    if (event.touches.length === 2) {
      pinched = true;
      pinchDistance = Math.hypot(event.touches[0].clientX - event.touches[1].clientX, event.touches[0].clientY - event.touches[1].clientY);
      pinchScale = scale;
    } else if (event.touches.length === 1) {
      if (!pinchDistance) pinched = false;
      touchStart = lastTouch = { x: event.touches[0].clientX, y: event.touches[0].clientY };
    }
  }, { passive: true, signal });
  image.addEventListener("touchmove", (event) => {
    if (event.touches.length === 2 && pinchDistance) {
      event.preventDefault();
      const distance = Math.hypot(event.touches[0].clientX - event.touches[1].clientX, event.touches[0].clientY - event.touches[1].clientY);
      zoom(pinchScale * distance / pinchDistance);
    } else if (event.touches.length === 1 && scale > 1 && lastTouch && !pinchDistance) {
      event.preventDefault();
      x += event.touches[0].clientX - lastTouch.x;
      y += event.touches[0].clientY - lastTouch.y;
      lastTouch = { x: event.touches[0].clientX, y: event.touches[0].clientY };
      transform();
    }
  }, { passive: false, signal });
  image.addEventListener("touchend", (event) => {
    if (!event.touches.length && !pinched && !pinchDistance && scale === 1 && touchStart && event.changedTouches.length === 1) {
      const dx = event.changedTouches[0].clientX - touchStart.x;
      const dy = event.changedTouches[0].clientY - touchStart.y;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) { event.preventDefault(); onSwipe(dx < 0 ? 1 : -1); }
    }
    if (event.touches.length < 2) pinchDistance = 0;
    if (!event.touches.length) { touchStart = lastTouch = undefined; }
    else lastTouch = { x: event.touches[0].clientX, y: event.touches[0].clientY };
  }, { signal });
  return () => controller.abort();
}
