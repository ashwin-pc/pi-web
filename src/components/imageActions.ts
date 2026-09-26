import { createElement, ChevronLeft, ChevronRight, Download, ExternalLink, Maximize2 } from "lucide";

function imageActionIcon(name: "download" | "external-link" | "maximize-2") {
  const icons = { Download, ExternalLink, Maximize2 } as const;
  const icon = name === "download" ? icons.Download : name === "external-link" ? icons.ExternalLink : icons.Maximize2;
  return createElement(icon, { "aria-hidden": "true" });
}

export function openImageOverlay(img: HTMLImageElement) {
  if (!img.currentSrc && !img.src) return;
  // Only images in the current session participate; composer previews remain standalone.
  const session = img.closest("#messages");
  const images = session ? Array.from(session.querySelectorAll<HTMLImageElement>(".imageFrame > img")) : [img];
  let index = Math.max(0, images.indexOf(img));
  let scale = 1;
  let panX = 0;
  let panY = 0;
  const overlay = document.createElement("div");
  overlay.className = "imageOverlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", "Image viewer");
  overlay.tabIndex = -1;
  const full = document.createElement("img");
  full.alt = img.alt || "image";
  full.draggable = false;
  const show = () => {
    const selected = images[index];
    full.src = selected.currentSrc || selected.src;
    full.alt = selected.alt || "image";
    scale = 1;
    panX = panY = 0;
    full.style.transform = "";
  };
  const step = (direction: number) => {
    if (images.length < 2) return;
    index = (index + direction + images.length) % images.length;
    show();
  };
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKeyDown);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") close();
    else if (event.key === "ArrowLeft") { event.preventDefault(); step(-1); }
    else if (event.key === "ArrowRight") { event.preventDefault(); step(1); }
  };
  overlay.append(full);
  if (images.length > 1) {
    for (const [direction, label] of [[-1, "Previous image"], [1, "Next image"]] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `imageOverlayNav ${direction < 0 ? "previous" : "next"}`;
      button.setAttribute("aria-label", label);
      button.append(createElement(direction < 0 ? ChevronLeft : ChevronRight, { "aria-hidden": "true" }));
      button.addEventListener("click", () => step(direction));
      overlay.append(button);
    }
  }
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;
  let pinchDistance = 0;
  let pinchScale = 1;
  const transform = () => {
    const maxX = Math.max(0, (full.clientWidth * scale - overlay.clientWidth) / 2);
    const maxY = Math.max(0, (full.clientHeight * scale - overlay.clientHeight) / 2);
    panX = Math.max(-maxX, Math.min(maxX, panX));
    panY = Math.max(-maxY, Math.min(maxY, panY));
    full.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
  };
  overlay.addEventListener("touchstart", (event) => {
    if (event.touches.length === 2) {
      pinchDistance = Math.hypot(event.touches[0].clientX - event.touches[1].clientX, event.touches[0].clientY - event.touches[1].clientY);
      pinchScale = scale;
    } else if (event.touches.length === 1) {
      startX = lastX = event.touches[0].clientX;
      startY = lastY = event.touches[0].clientY;
    }
  }, { passive: true });
  overlay.addEventListener("touchmove", (event) => {
    if (event.touches.length === 2 && pinchDistance) {
      event.preventDefault();
      const distance = Math.hypot(event.touches[0].clientX - event.touches[1].clientX, event.touches[0].clientY - event.touches[1].clientY);
      scale = Math.max(1, Math.min(6, pinchScale * distance / pinchDistance));
      transform();
    } else if (event.touches.length === 1 && scale > 1 && !pinchDistance) {
      event.preventDefault();
      panX += event.touches[0].clientX - lastX;
      panY += event.touches[0].clientY - lastY;
      lastX = event.touches[0].clientX;
      lastY = event.touches[0].clientY;
      transform();
    }
  }, { passive: false });
  overlay.addEventListener("touchend", (event) => {
    if (event.touches.length === 0 && !pinchDistance && scale === 1 && event.changedTouches.length === 1) {
      const dx = event.changedTouches[0].clientX - startX;
      const dy = event.changedTouches[0].clientY - startY;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
    }
    if (event.touches.length < 2) pinchDistance = 0;
    if (event.touches.length === 1) {
      lastX = event.touches[0].clientX;
      lastY = event.touches[0].clientY;
    }
  });
  let dragging = false;
  overlay.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "mouse" || event.button !== 0 || scale <= 1 || event.target !== full) return;
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    full.setPointerCapture(event.pointerId);
  });
  overlay.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    panX += event.clientX - lastX;
    panY += event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    transform();
  });
  overlay.addEventListener("pointerup", () => { dragging = false; });
  overlay.addEventListener("pointercancel", () => { dragging = false; });
  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
  document.addEventListener("keydown", onKeyDown);
  show();
  document.body.append(overlay);
  overlay.focus();
}

export function attachImageActions(img: HTMLImageElement) {
  if (img.closest(".imageFrame")) return;

  const frame = document.createElement("span");
  frame.className = "imageFrame";

  const toolbar = document.createElement("span");
  toolbar.className = "imageActions";

  const fullScreen = document.createElement("button");
  fullScreen.type = "button";
  fullScreen.className = "imageAction";
  fullScreen.title = "Fullscreen";
  fullScreen.setAttribute("aria-label", fullScreen.title);
  fullScreen.append(imageActionIcon("maximize-2"));
  fullScreen.addEventListener("click", () => openImageOverlay(img));
  img.addEventListener("click", () => openImageOverlay(img));

  const download = document.createElement("a");
  download.className = "imageAction";
  download.title = "Download";
  download.setAttribute("aria-label", download.title);
  download.href = img.currentSrc || img.src;
  download.download = img.alt || "image";
  download.append(imageActionIcon("download"));

  const open = document.createElement("a");
  open.className = "imageAction";
  open.title = "Open in new tab";
  open.setAttribute("aria-label", open.title);
  open.href = img.currentSrc || img.src;
  open.target = "_blank";
  open.rel = "noopener noreferrer";
  open.append(imageActionIcon("external-link"));

  toolbar.append(fullScreen, download, open);
  img.before(frame);
  frame.append(img, toolbar);
}
