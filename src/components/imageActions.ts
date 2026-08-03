import { createElement, Download, ExternalLink, Maximize2 } from "lucide";

function imageActionIcon(name: "download" | "external-link" | "maximize-2") {
  const icons = { Download, ExternalLink, Maximize2 } as const;
  const icon = name === "download" ? icons.Download : name === "external-link" ? icons.ExternalLink : icons.Maximize2;
  return createElement(icon, { "aria-hidden": "true" });
}

export function openImageOverlay(img: HTMLImageElement) {
  if (!img.currentSrc && !img.src) return;
  const overlay = document.createElement("div");
  overlay.className = "imageOverlay";
  const full = document.createElement("img");
  full.src = img.currentSrc || img.src;
  full.alt = img.alt || "image";
  overlay.append(full);
  overlay.addEventListener("click", () => overlay.remove());
  document.body.append(overlay);
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
