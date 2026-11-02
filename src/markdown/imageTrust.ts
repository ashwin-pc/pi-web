import type { Role } from "../app/types.js";
import { alwaysAllowHost, blockContentHost, decideContent, type ContentResource, type ContentPolicyVerdict } from "../security/contentPolicy.js";

const inlineRasterImage = /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i;
const unsafeUrlSyntax = /[\u0000-\u001F\u007F\\]/;
const livePlaceholderEvaluators = new WeakMap<HTMLElement, () => void>();
const linkedButtonContainers = new WeakSet<HTMLElement>();
let policyListenerDocument: Document | undefined;

export type MarkdownImageSource =
  | { kind: "automatic"; src: string }
  | { kind: "remote"; src: string; host: string }
  | { kind: "rejected" };

export function classifyMarkdownImageSource(value: string, origin = window.location.origin): MarkdownImageSource {
  const source = value.trim();
  if (!source || unsafeUrlSyntax.test(source) || source.startsWith("//")) return { kind: "rejected" };
  if (inlineRasterImage.test(source) || source.startsWith("blob:")) return { kind: "automatic", src: source };
  let url: URL;
  try { url = new URL(source, origin); } catch { return { kind: "rejected" }; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return { kind: "rejected" };
  if (url.origin === origin) return { kind: "automatic", src: `${url.pathname}${url.search}${url.hash}` };
  if (!/^https?:/i.test(source)) return { kind: "rejected" };
  return { kind: "remote", src: url.href, host: url.host.toLowerCase() };
}

export function remoteMarkdownImagePlaceholder(source: Extract<MarkdownImageSource, { kind: "remote" }>, alt: string, title: string) {
  const placeholder = document.createElement("span");
  placeholder.className = "remoteMarkdownImage";
  placeholder.dataset.remoteImageSrc = source.src;
  placeholder.dataset.remoteImageHost = source.host;
  placeholder.dataset.remoteImageAlt = alt;
  if (title) placeholder.dataset.remoteImageTitle = title;
  return placeholder;
}

function createImage(placeholder: HTMLElement, source: Extract<MarkdownImageSource, { kind: "remote" }>) {
  const image = document.createElement("img");
  image.alt = placeholder.dataset.remoteImageAlt || "";
  if (placeholder.dataset.remoteImageTitle) image.title = placeholder.dataset.remoteImageTitle;
  image.referrerPolicy = "no-referrer";
  image.loading = "lazy";
  image.src = source.src;
  return image;
}

function suppressLinkedButtonActivation(container: HTMLElement) {
  if (linkedButtonContainers.has(container)) return;
  linkedButtonContainers.add(container);
  container.addEventListener("click", (event) => {
    if (!(event.target instanceof Element) || !event.target.closest("button")) return;
    event.preventDefault();
    event.stopPropagation();
  });
}

function blockedImageNotice(host: string) {
  const blocked = document.createElement("span");
  blocked.className = "remoteMarkdownImage";
  blocked.setAttribute("role", "status");
  blocked.textContent = `Remote image from ${host} was blocked.`;
  return blocked;
}

function warnedImage(
  placeholder: HTMLElement,
  source: Extract<MarkdownImageSource, { kind: "remote" }>,
  verdict: ContentPolicyVerdict,
  enhanceImage: (image: HTMLImageElement) => void,
) {
  const wrapper = document.createElement("span");
  wrapper.className = "remoteMarkdownImageWarning";
  const image = createImage(placeholder, source);
  const marker = document.createElement("span");
  marker.className = "remoteMarkdownImageWarningMarker";
  marker.setAttribute("role", "status");
  const detail = document.createElement("span");
  detail.className = "remoteMarkdownImageWarningDetail";
  detail.textContent = `${verdict.by}: ${verdict.reason || "Remote content needs attention"}`;
  const block = document.createElement("button");
  block.type = "button";
  block.textContent = "Block host";
  block.setAttribute("aria-label", `Block images from ${source.host} for this app session`);
  block.addEventListener("click", () => {
    blockContentHost(source.host);
    wrapper.replaceWith(blockedImageNotice(source.host));
  });
  marker.append(detail, block);
  wrapper.append(image, marker);
  suppressLinkedButtonActivation(wrapper);
  placeholder.replaceWith(wrapper);
  enhanceImage(image);
}

function stopTrackingPlaceholder(placeholder: HTMLElement) {
  livePlaceholderEvaluators.delete(placeholder);
}

function trackPlaceholder(placeholder: HTMLElement, evaluate: () => void) {
  livePlaceholderEvaluators.set(placeholder, evaluate);
  if (policyListenerDocument === document) return;
  policyListenerDocument = document;
  const owner = document;
  owner.addEventListener("pi-web-content-policy-changed", () => {
    for (const live of owner.querySelectorAll<HTMLElement>(".remoteMarkdownImage[data-remote-image-enhanced]")) {
      if (live.isConnected) livePlaceholderEvaluators.get(live)?.();
    }
  });
}

export function enhanceRemoteMarkdownImages(
  root: ParentNode,
  enhanceImage: (image: HTMLImageElement) => void,
  from: { sessionId: string; role: Role },
) {
  for (const placeholder of root.querySelectorAll<HTMLElement>(".remoteMarkdownImage[data-remote-image-src]")) {
    if (placeholder.dataset.remoteImageEnhanced) continue;
    placeholder.dataset.remoteImageEnhanced = "true";
    const checked = classifyMarkdownImageSource(placeholder.dataset.remoteImageSrc || "");
    if (checked.kind !== "remote" || checked.host !== placeholder.dataset.remoteImageHost) {
      placeholder.textContent = "Remote image URL is invalid.";
      continue;
    }
    const resource: ContentResource = { kind: "image", url: checked.src, from };
    const evaluate = () => void decideContent(resource).then((verdict) => {
      if (!placeholder.isConnected) {
        stopTrackingPlaceholder(placeholder);
        return;
      }
      const show = () => {
        stopTrackingPlaceholder(placeholder);
        const image = createImage(placeholder, checked);
        placeholder.replaceWith(image);
        enhanceImage(image);
      };
      if (verdict.action === "allow") {
        show();
        return;
      }
      if (verdict.action === "warn") {
        stopTrackingPlaceholder(placeholder);
        warnedImage(placeholder, checked, verdict, enhanceImage);
        return;
      }
      if (verdict.action === "block") {
        stopTrackingPlaceholder(placeholder);
        placeholder.replaceWith(blockedImageNotice(checked.host));
        return;
      }
      placeholder.setAttribute("role", "group");
      placeholder.setAttribute("aria-label", "Remote image");
      suppressLinkedButtonActivation(placeholder);
      const detail = document.createElement("span");
      detail.className = "remoteMarkdownImageDetail";
      detail.append("Image from ");
      const host = document.createElement("code");
      host.textContent = checked.host;
      detail.append(host);
      const load = document.createElement("button");
      load.type = "button";
      load.textContent = "Load";
      load.addEventListener("click", show);
      const persist = document.createElement("button");
      persist.type = "button";
      persist.textContent = "Always allow this host";
      persist.addEventListener("click", async () => {
        persist.disabled = true;
        try { await alwaysAllowHost(checked.host); show(); }
        catch (error) {
          persist.disabled = false;
          persist.title = error instanceof Error ? error.message : String(error);
        }
      });
      placeholder.replaceChildren(detail, load, persist);
    });
    trackPlaceholder(placeholder, evaluate);
    evaluate();
  }
}
