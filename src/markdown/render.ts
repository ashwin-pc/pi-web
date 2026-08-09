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
const maxInlineHtmlSourceLength = 50_000;
const inlineHtmlFrames = new Set<HTMLIFrameElement>();
let inlineHtmlListenerAttached = false;
let mermaidImportPromise: Promise<typeof import("mermaid")> | null = null;
let mermaidRenderCounter = 0;
const allowedMarkdownTags = new Set([
  "a", "blockquote", "br", "code", "del", "div", "em", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "img",
  "li", "ol", "p", "pre", "span", "strong", "table", "tbody", "td", "th", "thead", "tr", "ul",
]);
const allowedMarkdownAttributes = new Set(["alt", "class", "href", "rel", "src", "target", "title"]);

type ArtifactPreviewAction = { key?: unknown; title?: unknown; label?: unknown; kinds?: unknown; extensions?: unknown };
let artifactPreviewActions: ArtifactPreviewAction[] = [];
let artifactActionHeaders: () => Record<string, string> = () => ({ "content-type": "application/json" });
let artifactActionSessionId = () => "";

export function configureArtifactPreviewActions(options: { headers: () => Record<string, string>; getSessionId: () => string }) {
  artifactActionHeaders = options.headers;
  artifactActionSessionId = options.getSessionId;
}

export function setArtifactPreviewActions(value: unknown) {
  artifactPreviewActions = Array.isArray(value) ? value : [];
  for (const card of document.querySelectorAll<HTMLElement>(".artifactPreview[data-artifact-path]")) {
    renderArtifactActions(card, card.dataset.artifactName || "artifact", card.dataset.artifactPath || "", card.dataset.artifactKind || "");
  }
}

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
      theme: "dark",
      themeVariables: {
        background: "#18181b",
        primaryColor: "#27272a",
        primaryTextColor: "#f2f2f2",
        primaryBorderColor: "#71717a",
        lineColor: "#a1a1aa",
        secondaryColor: "#3f3f46",
        tertiaryColor: "#27272a",
        textColor: "#f2f2f2",
        edgeLabelBackground: "#18181b",
      },
      flowchart: { htmlLabels: false },
    });
    return mod;
  });
  return mermaidImportPromise;
}

function parseRgb(color: string): [number, number, number] | null {
  const values = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  return values?.length === 3 ? values as [number, number, number] : null;
}

function relativeLuminance(rgb: [number, number, number]) {
  const channels = rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(first: [number, number, number], second: [number, number, number]) {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function ensureMermaidNodeContrast(svg: SVGSVGElement) {
  const dark: [number, number, number] = [17, 24, 39];
  const light: [number, number, number] = [248, 250, 252];
  for (const node of svg.querySelectorAll<SVGGElement>("g.node")) {
    const shape = node.querySelector<SVGElement>("rect, polygon, ellipse, circle, path");
    const labels = Array.from(node.querySelectorAll<HTMLElement | SVGElement>(".label text, .label tspan, .label foreignObject *"));
    if (!shape || labels.length === 0) continue;
    const background = parseRgb(getComputedStyle(shape).fill);
    const labelStyle = getComputedStyle(labels[0]);
    const foreground = parseRgb(labels[0] instanceof SVGElement ? labelStyle.fill : labelStyle.color);
    if (!background || !foreground || contrastRatio(background, foreground) >= 4.5) continue;
    const replacement = contrastRatio(background, dark) >= contrastRatio(background, light) ? "#111827" : "#f8fafc";
    for (const label of labels) {
      label.style.setProperty("fill", replacement, "important");
      label.style.setProperty("color", replacement, "important");
    }
  }
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
      if (renderedSvg) {
        ensureMermaidNodeContrast(renderedSvg);
        attachDiagramViewer(container, renderedSvg);
      }
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

function ensureInlineHtmlResizeListener() {
  if (inlineHtmlListenerAttached) return;
  inlineHtmlListenerAttached = true;
  window.addEventListener("message", (event) => {
    for (const frame of inlineHtmlFrames) {
      if (!frame.isConnected) {
        inlineHtmlFrames.delete(frame);
        continue;
      }
      if (event.source !== frame.contentWindow) continue;
      const data = event.data as { type?: unknown; height?: unknown; width?: unknown } | null;
      if (data?.type !== "pi-web-html-preview-size" || typeof data.height !== "number" || typeof data.width !== "number") return;
      const container = frame.closest<HTMLElement>(".htmlPreview");
      if (!container) return;
      frame.style.height = `${Math.min(Math.max(Math.ceil(data.height), 1), 720)}px`;
      container.style.width = `${Math.max(Math.ceil(data.width), 1)}px`;
      container.classList.toggle("htmlPreview--compact", data.height <= 140);
      return;
    }
  });
}

function inlineHtmlReporter() {
  return `<script>(()=>{const report=()=>{const b=document.body,e=document.documentElement,cs=getComputedStyle(b);let right=0,bottom=0;for(const n of b.children){const r=n.getBoundingClientRect();right=Math.max(right,r.right);bottom=Math.max(bottom,r.bottom)}const width=Math.ceil(right+parseFloat(cs.marginRight||'0')+parseFloat(cs.paddingRight||'0'));parent.postMessage({type:'pi-web-html-preview-size',height:Math.ceil(bottom+parseFloat(cs.marginBottom||'0')+parseFloat(cs.paddingBottom||'0')),width},'*')};addEventListener('load',report);new ResizeObserver(report).observe(document.documentElement);new MutationObserver(report).observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});report()})()<\/script>`;
}

function enhanceInlineHtmlPreviews(root: ParentNode) {
  for (const code of Array.from(root.querySelectorAll<HTMLElement>("pre > code.language-html-preview"))) {
    const pre = code.closest<HTMLPreElement>("pre");
    if (!pre || pre.dataset.htmlPreviewEnhanced) continue;
    const source = code.textContent || "";
    if (!source.trim() || source.length > maxInlineHtmlSourceLength) continue;
    pre.dataset.htmlPreviewEnhanced = "true";
    code.classList.remove("language-html-preview");
    code.classList.add("language-html");
    pre.hidden = true;

    const container = document.createElement("div");
    container.className = "htmlPreview";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "htmlPreviewToggle";
    toggle.textContent = "Source";
    toggle.title = "Show HTML source";
    toggle.setAttribute("aria-label", toggle.title);
    const frame = document.createElement("iframe");
    frame.className = "htmlPreviewFrame";
    frame.title = "Interactive HTML preview";
    frame.setAttribute("sandbox", "allow-scripts");
    frame.srcdoc = source + inlineHtmlReporter();
    toggle.addEventListener("click", () => {
      const showingSource = pre.hidden;
      pre.hidden = !showingSource;
      frame.hidden = showingSource;
      container.classList.toggle("htmlPreview--source", showingSource);
      toggle.textContent = showingSource ? "Preview" : "Source";
      toggle.title = showingSource ? "Show interactive preview" : "Show HTML source";
      toggle.setAttribute("aria-label", toggle.title);
    });
    pre.replaceWith(container);
    container.append(frame, pre, toggle);
    inlineHtmlFrames.add(frame);
    ensureInlineHtmlResizeListener();
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

function matchingArtifactActions(name: string, kind: string) {
  return artifactPreviewActions.flatMap((raw) => {
    if (typeof raw.key !== "string" || !raw.key) return [];
    if (Array.isArray(raw.kinds) && raw.kinds.length && !raw.kinds.includes(kind)) return [];
    if (Array.isArray(raw.extensions) && raw.extensions.length && !raw.extensions.some((extension) => typeof extension === "string" && name.toLowerCase().endsWith(extension.toLowerCase()))) return [];
    return [{ key: raw.key, title: typeof raw.title === "string" ? raw.title : raw.key, label: typeof raw.label === "string" ? raw.label : undefined }];
  });
}

async function downloadArtifact(path: string, filename: string) {
  const response = await fetch(path, { headers: artifactActionHeaders() });
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  const objectUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename || "artifact";
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}

function renderArtifactActions(card: HTMLElement, name: string, path: string, kind: string) {
  card.querySelector(".artifactPreviewActions")?.remove();
  const actions = matchingArtifactActions(name, kind);
  if (!actions.length) return;
  const container = document.createElement("span");
  container.className = "artifactPreviewActions";
  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "artifactPreviewAction";
    button.textContent = action.label || action.title;
    button.title = action.title;
    button.addEventListener("click", async () => {
      button.disabled = true;
      const original = button.textContent;
      button.textContent = "Working…";
      try {
        const res = await fetch("/api/web-contributions/invoke", { method: "POST", headers: artifactActionHeaders(), body: JSON.stringify({ sessionId: artifactActionSessionId(), slot: "artifact-action", key: action.key, event: { context: { name, path, kind } } }) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || res.statusText);
        if (data.download && typeof data.download.path === "string") {
          await downloadArtifact(data.download.path, typeof data.download.filename === "string" ? data.download.filename : name);
          if (typeof data.markdown !== "string" && typeof data.message !== "string") {
            card.querySelector(".artifactPreviewActionResult")?.remove();
            button.textContent = "Downloaded";
            window.setTimeout(() => { if (button.isConnected) button.textContent = original; }, 1_500);
            return;
          }
        }
        let result = card.querySelector<HTMLElement>(".artifactPreviewActionResult");
        if (!result) {
          result = document.createElement("div");
          result.className = "artifactPreviewActionResult markdownBody";
          card.querySelector(".artifactPreviewHeader")?.insertAdjacentElement("afterend", result);
        }
        if (typeof data.markdown === "string") result.innerHTML = markdownHtml(data.markdown);
        else result.textContent = String(data.message || (data.download ? `Downloaded ${data.download.filename || name}` : "Done"));
      } catch (error) {
        button.title = error instanceof Error ? error.message : String(error);
        button.textContent = "Failed";
        return;
      } finally {
        button.disabled = false;
      }
      button.textContent = original;
    });
    container.append(button);
  }
  card.querySelector(".artifactPreviewHeader")?.append(container);
}

function enhanceArtifactLinks(root: ParentNode) {
  for (const link of Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href^="/api/artifacts/"]'))) {
    if (link.dataset.artifactPreviewEnhanced) continue;
    const url = new URL(link.href, window.location.origin);
    const kind = artifactKind(url.pathname);
    if (!kind) continue;
    link.dataset.artifactPreviewEnhanced = "true";

    const fileName = artifactName(url.pathname);
    const displayName = link.textContent?.trim() || fileName;
    const card = document.createElement("div");
    card.className = `artifactPreview artifactPreview--${kind}`;
    const header = document.createElement("div");
    header.className = "artifactPreviewHeader";
    const title = document.createElement("span");
    title.className = "artifactPreviewTitle";
    title.textContent = displayName;
    const open = document.createElement("a");
    open.href = kind === "markdown"
      ? `/artifact-preview.html?src=${encodeURIComponent(url.pathname)}&name=${encodeURIComponent(displayName)}`
      : url.pathname;
    if (isStandalonePwa()) {
      open.target = "_top";
    } else {
      open.target = "_blank";
      open.rel = "noopener noreferrer";
    }
    open.textContent = "Open";
    const builtInActions = document.createElement("span");
    builtInActions.className = "artifactPreviewBuiltInActions";
    builtInActions.append(open);
    header.append(title, builtInActions);
    const content = document.createElement("div");
    content.className = "artifactPreviewContent";
    content.textContent = "Loading preview…";
    card.append(header, content);
    card.dataset.artifactName = title.textContent;
    card.dataset.artifactPath = url.pathname;
    card.dataset.artifactKind = kind;
    renderArtifactActions(card, title.textContent, url.pathname, kind);

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
  enhanceInlineHtmlPreviews(body);
  enhanceCodeBlocks(body);
  enhanceImages(body);
  enhanceArtifactLinks(body);
}

function renderAssistantMarkdown(body: HTMLElement, text: string) {
  renderStandaloneMarkdown(body, text);
  body.dataset.markdownRendered = "true";
  delete body.dataset.markdownText;
}

export function createMarkdownRenderer(messagesEl: HTMLElement, onAssistantRendered?: (body: HTMLElement) => void): MarkdownRenderer {
  const render = (body: HTMLElement, text: string) => {
    renderAssistantMarkdown(body, text);
    onAssistantRendered?.(body);
  };
  const requestIdle = window.requestIdleCallback || ((callback: IdleRequestCallback) => window.setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 0 }), 1));
  const markdownRenderObserver = "IntersectionObserver" in window
    ? new IntersectionObserver((entries, observer) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const body = entry.target as HTMLElement;
        observer.unobserve(body);
        const text = body.dataset.markdownText || "";
        requestIdle(() => {
          if (body.isConnected && text && !body.dataset.markdownRendered) render(body, text);
        });
      }
    }, { root: messagesEl, rootMargin: "600px 0px" })
    : null;

  return {
    renderAssistantMarkdown: render,
    queueAssistantMarkdownRender(body, text) {
      body.dataset.markdownText = text;
      if (markdownRenderObserver) markdownRenderObserver.observe(body);
      else requestIdle(() => {
        if (body.isConnected && !body.dataset.markdownRendered) render(body, text);
      });
    },
    unobserve(body) {
      markdownRenderObserver?.unobserve(body);
    },
  };
}
