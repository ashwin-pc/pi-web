const inlineRasterImage = /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i;
const automaticImagePath = /^\/api\/(?:artifacts\/|session-artifacts\/|attachments\/|messages\/image(?:[/?#]|$))/;
const unsafeUrlSyntax = /[\u0000-\u001F\u007F\\]/;

export type MarkdownImageSource =
  | { kind: "automatic"; src: string }
  | { kind: "remote"; src: string; host: string }
  | { kind: "rejected" };

export function classifyMarkdownImageSource(value: string, origin = window.location.origin): MarkdownImageSource {
  const source = value.trim();
  if (!source || unsafeUrlSyntax.test(source) || source.startsWith("//")) return { kind: "rejected" };
  if (inlineRasterImage.test(source)) return { kind: "automatic", src: source };

  let url: URL;
  try {
    url = new URL(source, origin);
  } catch {
    return { kind: "rejected" };
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return { kind: "rejected" };

  if (url.origin === origin) {
    const normalized = `${url.pathname}${url.search}${url.hash}`;
    return automaticImagePath.test(normalized)
      ? { kind: "automatic", src: normalized }
      : { kind: "rejected" };
  }
  if (!/^https?:/i.test(source)) return { kind: "rejected" };
  return { kind: "remote", src: url.href, host: url.host };
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

export function enhanceRemoteMarkdownImages(root: ParentNode, enhanceImage: (image: HTMLImageElement) => void) {
  for (const placeholder of root.querySelectorAll<HTMLElement>(".remoteMarkdownImage[data-remote-image-src]")) {
    if (placeholder.dataset.remoteImageEnhanced) continue;
    placeholder.dataset.remoteImageEnhanced = "true";
    placeholder.setAttribute("role", "group");
    placeholder.setAttribute("aria-label", "Remote image blocked");

    const detail = document.createElement("span");
    detail.className = "remoteMarkdownImageDetail";
    detail.append("Remote image from ");
    const host = document.createElement("code");
    host.textContent = placeholder.dataset.remoteImageHost || "unknown host";
    detail.append(host);

    const load = document.createElement("button");
    load.type = "button";
    load.className = "remoteMarkdownImageLoad";
    load.textContent = "Load image";
    load.addEventListener("click", () => {
      const checked = classifyMarkdownImageSource(placeholder.dataset.remoteImageSrc || "");
      if (checked.kind !== "remote" || checked.host !== placeholder.dataset.remoteImageHost) {
        placeholder.textContent = "Remote image URL is no longer valid.";
        return;
      }
      const image = document.createElement("img");
      image.alt = placeholder.dataset.remoteImageAlt || "";
      if (placeholder.dataset.remoteImageTitle) image.title = placeholder.dataset.remoteImageTitle;
      image.referrerPolicy = "no-referrer";
      image.loading = "lazy";
      image.src = checked.src;
      placeholder.replaceWith(image);
      enhanceImage(image);
    });
    placeholder.replaceChildren(detail, load);
  }
}
