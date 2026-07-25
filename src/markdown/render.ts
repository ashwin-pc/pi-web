import hljs from "highlight.js/lib/common";
import { marked } from "marked";
import { Check, Copy, createElement } from "lucide";
import { attachImageActions } from "../components/imageActions.js";
import { attachDiagramViewer } from "../components/diagramViewer.js";

marked.setOptions({
  async: false,
  breaks: true,
  gfm: true,
});

const markdownCache = new Map<string, string>();
const maxCachedMarkdown = 160;
const mermaidSvgCache = new Map<string, string>();
const maxCachedMermaid = 32;
const maxMermaidSourceLength = 20_000;
let mermaidImportPromise: Promise<typeof import("mermaid")> | null = null;
let mermaidRenderCounter = 0;
const allowedMarkdownTags = new Set([
  "a", "blockquote", "br", "code", "del", "div", "em", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "img",
  "li", "ol", "p", "pre", "span", "strong", "table", "tbody", "td", "th", "thead", "tr", "ul",
]);
const allowedMarkdownAttributes = new Set(["alt", "class", "href", "rel", "src", "target", "title"]);

export type MarkdownRenderer = {
  renderAssistantMarkdown: (body: HTMLElement, text: string) => void;
  queueAssistantMarkdownRender: (body: HTMLElement, text: string) => void;
  unobserve: (body: HTMLElement) => void;
};

function sanitizeMarkdownHtml(html: string) {
  const template = document.createElement("template");
  template.innerHTML = html;

  for (const element of Array.from(template.content.querySelectorAll("*"))) {
    const tagName = element.tagName.toLowerCase();
    if (!allowedMarkdownTags.has(tagName)) {
      element.replaceWith(...Array.from(element.childNodes));
      continue;
    }

    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (!allowedMarkdownAttributes.has(name) || name.startsWith("on")) {
        element.removeAttribute(attribute.name);
        continue;
      }

      if (name === "href") {
        const href = attribute.value.trim();
        if (!/^(https?:|mailto:|#|\/)/i.test(href)) element.removeAttribute(attribute.name);
      }

      if (name === "src") {
        const src = attribute.value.trim();
        if (!/^(https?:|data:image\/(png|jpeg|jpg|gif|webp);base64,|\/api\/artifacts\/)/i.test(src)) {
          element.removeAttribute(attribute.name);
        }
      }
    }

    if (tagName === "a") {
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "noopener noreferrer");
    }

    if (tagName === "img" && !element.getAttribute("src")) {
      element.remove();
    }
  }

  return template.innerHTML;
}

function requestIdle(callback: IdleRequestCallback) {
  if ("requestIdleCallback" in window) return window.requestIdleCallback(callback, { timeout: 1500 });
  return globalThis.setTimeout(() => callback({ didTimeout: true, timeRemaining: () => 0 }), 1);
}

function highlightCodeBlock(code: HTMLElement) {
  if (code.dataset.highlighted) return;
  code.dataset.highlighted = "true";
  code.classList.add("hljs");

  const languageClass = Array.from(code.classList).find((className) => className.startsWith("language-"));
  const language = languageClass?.slice("language-".length);
  if (!language || !hljs.getLanguage(language)) return;

  code.innerHTML = hljs.highlight(code.textContent || "", { language }).value;
  code.classList.add(`language-${language}`);
}

function markdownHtml(text: string) {
  const cached = markdownCache.get(text);
  if (cached !== undefined) {
    markdownCache.delete(text);
    markdownCache.set(text, cached);
    return cached;
  }

  const html = sanitizeMarkdownHtml(marked.parse(text) as string);
  markdownCache.set(text, html);
  if (markdownCache.size > maxCachedMarkdown) markdownCache.delete(markdownCache.keys().next().value as string);
  return html;
}

function mermaidCachedSvg(source: string) {
  const cached = mermaidSvgCache.get(source);
  if (cached === undefined) return undefined;
  mermaidSvgCache.delete(source);
  mermaidSvgCache.set(source, cached);
  return cached;
}

function cacheMermaidSvg(source: string, svg: string) {
  mermaidSvgCache.set(source, svg);
  if (mermaidSvgCache.size > maxCachedMermaid) mermaidSvgCache.delete(mermaidSvgCache.keys().next().value as string);
}

async function loadMermaid() {
  mermaidImportPromise ??= import("mermaid").then((mod) => {
    mod.default.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      flowchart: { htmlLabels: false },
    });
    return mod;
  });
  return mermaidImportPromise;
}

function scheduleMermaidRender(container: HTMLElement, render: () => void) {
  if (!("IntersectionObserver" in window)) {
    requestIdle(render as IdleRequestCallback);
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    observer.disconnect();
    requestIdle(render as IdleRequestCallback);
  }, { rootMargin: "600px 0px" });
  observer.observe(container);
}

function enhanceMermaid(root: ParentNode) {
  for (const code of Array.from(root.querySelectorAll<HTMLElement>("pre > code.language-mermaid, pre > code.mermaid"))) {
    const pre = code.closest("pre");
    if (!pre || pre.dataset.mermaidEnhanced) continue;

    const source = (code.textContent || "").trim();
    if (!source || source.length > maxMermaidSourceLength) continue;

    pre.dataset.mermaidEnhanced = "true";
    const container = document.createElement("div");
    container.className = "mermaidDiagram";
    container.textContent = "Rendering diagram…";
    pre.replaceWith(container);

    const setSvg = (svg: string) => {
      container.innerHTML = svg;
      const renderedSvg = container.querySelector<SVGSVGElement>("svg");
      if (renderedSvg) attachDiagramViewer(container, renderedSvg);
    };
    const render = async () => {
      if (!container.isConnected) return;
      try {
        const cached = mermaidCachedSvg(source);
        if (cached !== undefined) {
          setSvg(cached);
          return;
        }

        const mermaid = await loadMermaid();
        const id = `mermaid-${++mermaidRenderCounter}`;
        const { svg } = await mermaid.default.render(id, source);
        cacheMermaidSvg(source, svg);
        if (container.isConnected) setSvg(svg);
      } catch {
        if (!container.isConnected) return;
        container.replaceWith(pre);
        enhanceCodeBlocks(pre.parentNode || pre);
      }
    };

    scheduleMermaidRender(container, render);
  }
}

function enhanceCodeBlocks(root: ParentNode) {
  for (const pre of Array.from(root.querySelectorAll<HTMLPreElement>("pre"))) {
    if (pre.querySelector(".copyCode")) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copyCode";
    btn.title = "Copy code";
    btn.setAttribute("aria-label", btn.title);
    btn.append(createElement(Copy, { "aria-hidden": "true" }));
    btn.dataset.icon = "copy";
    btn.addEventListener("click", () => {
      btn.innerHTML = "";
      btn.append(createElement(Check, { "aria-hidden": "true" }));
      btn.dataset.icon = "check";
      setTimeout(() => {
        btn.innerHTML = "";
        btn.append(createElement(Copy, { "aria-hidden": "true" }));
        btn.dataset.icon = "copy";
      }, 1500);
      const code = pre.querySelector("code");
      navigator.clipboard.writeText(code?.textContent || pre.textContent || "").catch(() => {});
    });
    pre.style.position = "relative";
    pre.append(btn);

    const code = pre.querySelector<HTMLElement>("code");
    if (code) requestIdle(() => {
      if (code.isConnected) highlightCodeBlock(code);
    });
  }
}

function enhanceImages(root: ParentNode) {
  for (const img of Array.from(root.querySelectorAll<HTMLImageElement>("img"))) attachImageActions(img);
}

function artifactName(pathname: string) {
  try { return decodeURIComponent(pathname.split("/").pop() || "artifact"); } catch { return pathname.split("/").pop() || "artifact"; }
}

function artifactKind(pathname: string) {
  const lower = pathname.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".mp4") || lower.endsWith(".webm") || lower.endsWith(".mov") || lower.endsWith(".ogv")) return "video";
  return "";
}

function videoMimeType(pathname: string) {
  const lower = pathname.toLowerCase();
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".ogv")) return "video/ogg";
  return "video/*";
}

function isStandalonePwa() {
  return window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function enhanceArtifactLinks(root: ParentNode) {
  for (const link of Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href^="/api/artifacts/"]'))) {
    if (link.dataset.artifactPreviewEnhanced) continue;
    const url = new URL(link.href, window.location.origin);
    const kind = artifactKind(url.pathname);
    if (!kind) continue;
    link.dataset.artifactPreviewEnhanced = "true";

    const card = document.createElement("div");
    card.className = `artifactPreview artifactPreview--${kind}`;
    const header = document.createElement("div");
    header.className = "artifactPreviewHeader";
    const title = document.createElement("span");
    title.className = "artifactPreviewTitle";
    title.textContent = artifactName(url.pathname);
    const open = document.createElement("a");
    open.href = kind === "markdown"
      ? `/artifact-preview.html?src=${encodeURIComponent(url.pathname)}&name=${encodeURIComponent(artifactName(url.pathname))}`
      : url.pathname;
    if (isStandalonePwa()) {
      open.target = "_top";
    } else {
      open.target = "_blank";
      open.rel = "noopener noreferrer";
    }
    open.textContent = "Open";
    header.append(title, open);
    const content = document.createElement("div");
    content.className = "artifactPreviewContent";
    content.textContent = "Loading preview…";
    card.append(header, content);

    const container = link.closest("p") || link;
    container.insertAdjacentElement("afterend", card);

    if (kind === "html") {
      content.textContent = "";
      const iframe = document.createElement("iframe");
      iframe.className = "artifactPreviewFrame";
      iframe.src = url.pathname;
      iframe.title = `Preview of ${title.textContent}`;
      // Allow artifact scripts (for diagrams and interactive previews) while omitting
      // allow-same-origin so the frame keeps an opaque origin and cannot access app storage.
      iframe.setAttribute("sandbox", "allow-scripts");
      content.append(iframe);
      continue;
    }

    if (kind === "video") {
      content.textContent = "";
      const video = document.createElement("video");
      video.className = "artifactPreviewVideo";
      video.controls = true;
      video.playsInline = true;
      video.preload = "metadata";
      const source = document.createElement("source");
      source.src = url.pathname;
      source.type = videoMimeType(url.pathname);
      video.append(source);
      content.append(video);
      continue;
    }

    fetch(url.pathname)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Preview failed (${res.status})`);
        return res.text();
      })
      .then((text) => {
        if (!card.isConnected) return;
        content.classList.add("markdownBody");
        content.innerHTML = markdownHtml(text);
        enhanceMermaid(content);
        enhanceCodeBlocks(content);
        enhanceImages(content);
        enhanceArtifactLinks(content);
      })
      .catch((error) => {
        content.textContent = error instanceof Error ? error.message : String(error);
        card.classList.add("artifactPreview--error");
      });
  }
}

export function renderStandaloneMarkdown(body: HTMLElement, text: string) {
  body.classList.add("markdownBody");
  body.innerHTML = markdownHtml(text);
  enhanceMermaid(body);
  enhanceCodeBlocks(body);
  enhanceImages(body);
  enhanceArtifactLinks(body);
}

function renderAssistantMarkdown(body: HTMLElement, text: string) {
  renderStandaloneMarkdown(body, text);
  body.dataset.markdownRendered = "true";
  delete body.dataset.markdownText;
}

export function createMarkdownRenderer(messagesEl: HTMLElement): MarkdownRenderer {
  const requestIdle = window.requestIdleCallback || ((callback: IdleRequestCallback) => window.setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 0 }), 1));
  const markdownRenderObserver = "IntersectionObserver" in window
    ? new IntersectionObserver((entries, observer) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const body = entry.target as HTMLElement;
        observer.unobserve(body);
        const text = body.dataset.markdownText || "";
        requestIdle(() => {
          if (body.isConnected && text && !body.dataset.markdownRendered) renderAssistantMarkdown(body, text);
        });
      }
    }, { root: messagesEl, rootMargin: "600px 0px" })
    : null;

  return {
    renderAssistantMarkdown,
    queueAssistantMarkdownRender(body, text) {
      body.dataset.markdownText = text;
      if (markdownRenderObserver) markdownRenderObserver.observe(body);
      else requestIdle(() => {
        if (body.isConnected && !body.dataset.markdownRendered) renderAssistantMarkdown(body, text);
      });
    },
    unobserve(body) {
      markdownRenderObserver?.unobserve(body);
    },
  };
}
