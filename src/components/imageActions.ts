import { createElement, Download, ExternalLink, Maximize2 } from "lucide";

// Image actions delegate presentation and lifecycle to the shared files panel.
// The source remains the original image URL (including authenticated and blob URLs).
let openImage: ((source: string, name: string, opener: HTMLElement) => void) | undefined;
export function configureImagePreviewOpener(open: (source: string, name: string, opener: HTMLElement) => void) { openImage = open; }

export function openImagePreview(img: HTMLImageElement, opener: HTMLElement = img) {
  const source = img.currentSrc || img.src;
  if (source) openImage?.(source, img.alt || "Image", opener);
}

// The toolbar is visibility:hidden until its frame is focused. Reveal it by
// focusing the tabbable image before the panel manager restores its button.
export function revealImageOpener(opener: HTMLElement) {
  if (getComputedStyle(opener).visibility === "hidden") {
    opener.closest(".imageFrame")?.querySelector<HTMLElement>("img[tabindex]")?.focus({ preventScroll: true });
  }
  return opener;
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
  fullScreen.title = "Preview";
  fullScreen.setAttribute("aria-label", "Preview image");
  fullScreen.append(createElement(Maximize2, { "aria-hidden": "true" }));
  fullScreen.addEventListener("click", () => openImagePreview(img, fullScreen));
  img.tabIndex = 0;
  img.setAttribute("role", "button");
  img.setAttribute("aria-label", `Preview ${img.alt || "image"}`);
  img.addEventListener("click", () => openImagePreview(img));
  img.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openImagePreview(img); }
  });

  const download = document.createElement("a");
  download.className = "imageAction";
  download.title = "Download";
  download.setAttribute("aria-label", download.title);
  download.href = img.currentSrc || img.src;
  download.download = img.alt || "image";
  download.append(createElement(Download, { "aria-hidden": "true" }));

  const external = document.createElement("a");
  external.className = "imageAction";
  external.title = "Open in new tab";
  external.setAttribute("aria-label", external.title);
  external.href = img.currentSrc || img.src;
  external.target = "_blank";
  external.rel = "noopener noreferrer";
  external.append(createElement(ExternalLink, { "aria-hidden": "true" }));

  toolbar.append(fullScreen, download, external);
  img.before(frame);
  frame.append(img, toolbar);
}
