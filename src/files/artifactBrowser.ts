import { renderStandaloneMarkdown } from "../markdown/render.js";

type ArtifactEntry = { name: string; path: string; kind: "file" | "directory" | "symlink"; size?: number };
type ArtifactKind = "image" | "html" | "markdown" | "video" | "pdf" | "file";

export const artifactRootPath = ".pi/web/artifacts";
const artifactHistoryStateKey = "piWebArtifactView";

type ArtifactHistoryState =
  | { view: "gallery" }
  | { view: "preview"; entry: ArtifactEntry };

class ArtifactRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ArtifactRequestError";
  }
}

function artifactKind(path: string): ArtifactKind {
  const lower = path.toLowerCase();
  if (/\.(?:png|jpe?g|gif|webp|svg|bmp)$/.test(lower)) return "image";
  if (/\.(?:html?|xhtml)$/.test(lower)) return "html";
  if (/\.(?:md|markdown)$/.test(lower)) return "markdown";
  if (/\.(?:mp4|webm|mov|ogv)$/.test(lower)) return "video";
  if (lower.endsWith(".pdf")) return "pdf";
  return "file";
}

function artifactKindLabel(kind: ArtifactKind) {
  return ({ image: "Image", html: "Interactive HTML", markdown: "Markdown", video: "Video", pdf: "PDF", file: "File" } as const)[kind];
}

function videoMimeType(path: string) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".ogv")) return "video/ogg";
  return "video/*";
}

function formatFileSize(size?: number) {
  if (!Number.isFinite(size)) return "";
  const bytes = Number(size);
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KB`;
  return `${(bytes / 1_024 / 1_024).toFixed(bytes < 10 * 1_024 * 1_024 ? 1 : 0)} MB`;
}

function fileExtension(name: string) {
  const extension = name.includes(".") ? name.split(".").pop() || "" : "";
  return extension.slice(0, 5).toUpperCase() || "FILE";
}

function artifactRelativePath(path: string) {
  if (path === artifactRootPath) return "";
  return path.startsWith(`${artifactRootPath}/`) ? path.slice(artifactRootPath.length + 1) : path;
}

function parentArtifactPath(path: string) {
  if (path === artifactRootPath) return artifactRootPath;
  const parent = path.split("/").slice(0, -1).join("/");
  return parent.startsWith(artifactRootPath) ? parent : artifactRootPath;
}

export type ArtifactBrowserController = {
  refresh(): void;
  reset(): void;
};

export function initArtifactBrowser(options: {
  panel: HTMLElement;
  tree: HTMLElement;
  apiHeaders: () => HeadersInit;
  getSessionId: () => string;
}): ArtifactBrowserController {
  const { panel, tree, apiHeaders, getSessionId } = options;
  const explorer = panel.querySelector<HTMLElement>(".filesExplorer")!;
  const galleryBack = panel.querySelector<HTMLButtonElement>("#artifactsGalleryBack")!;
  const breadcrumb = panel.querySelector<HTMLElement>("#artifactsGalleryBreadcrumb")!;
  const galleryCount = panel.querySelector<HTMLElement>("#artifactsGalleryCount")!;
  const preview = panel.querySelector<HTMLElement>("#artifactBrowserPreview")!;
  const previewBack = panel.querySelector<HTMLButtonElement>("#artifactBrowserPreviewBack")!;
  const previewTitle = panel.querySelector<HTMLElement>("#artifactBrowserPreviewTitle")!;
  const previewBody = panel.querySelector<HTMLElement>("#artifactBrowserPreviewBody")!;
  const previewOpen = panel.querySelector<HTMLAnchorElement>("#artifactBrowserPreviewOpen")!;
  const previewDownload = panel.querySelector<HTMLAnchorElement>("#artifactBrowserPreviewDownload")!;
  let deferredObserver: IntersectionObserver | undefined;
  let deferredLoads = new WeakMap<Element, () => void>();
  const directoryScrollPositions = new Map<string, number>();
  let currentDirectory = artifactRootPath;
  let activeEntry: ArtifactEntry | undefined;
  let loadGeneration = 0;
  let previewGeneration = 0;

  function historyRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }

  function artifactHistoryState(value: unknown = history.state): ArtifactHistoryState | undefined {
    const candidate = historyRecord(value)[artifactHistoryStateKey];
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
    const record = candidate as Record<string, unknown>;
    if (record.view === "gallery") return { view: "gallery" };
    const entry = record.entry as Partial<ArtifactEntry> | undefined;
    if (record.view !== "preview" || !entry || typeof entry.name !== "string" || typeof entry.path !== "string" || !entry.path.startsWith(`${artifactRootPath}/`) || !["file", "symlink"].includes(entry.kind || "")) return undefined;
    return { view: "preview", entry: { name: entry.name, path: entry.path, kind: entry.kind as ArtifactEntry["kind"], size: typeof entry.size === "number" ? entry.size : undefined } };
  }

  function replaceArtifactHistory(state: ArtifactHistoryState) {
    history.replaceState({ ...historyRecord(history.state), [artifactHistoryStateKey]: state }, "");
  }

  function pushArtifactPreviewHistory(entry: ArtifactEntry) {
    replaceArtifactHistory({ view: "gallery" });
    history.pushState({ ...historyRecord(history.state), [artifactHistoryStateKey]: { view: "preview", entry } satisfies ArtifactHistoryState }, "");
  }

  function query(path = "") {
    const params = new URLSearchParams({ sessionId: getSessionId() });
    if (path) params.set("path", path);
    return params;
  }

  async function responseJson(res: Response) {
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new ArtifactRequestError(data.error || res.statusText, res.status);
    return data;
  }

  function artifactUrl(path: string) {
    const relative = artifactRelativePath(path);
    const encoded = relative.split("/").filter(Boolean).map(encodeURIComponent).join("/");
    const sessionId = getSessionId();
    return sessionId
      ? `/api/session-artifacts/${encodeURIComponent(sessionId)}/${encoded}`
      : `/api/artifacts/${encoded}`;
  }

  function clearDeferredPreviews() {
    deferredObserver?.disconnect();
    deferredObserver = undefined;
    deferredLoads = new WeakMap();
  }

  function deferPreview(element: Element, load: () => void) {
    if (!("IntersectionObserver" in window)) { load(); return; }
    deferredObserver ??= new IntersectionObserver((entries, observer) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        const loadEntry = deferredLoads.get(entry.target);
        deferredLoads.delete(entry.target);
        loadEntry?.();
      }
    }, { root: explorer, rootMargin: "240px 0px" });
    deferredLoads.set(element, load);
    deferredObserver.observe(element);
  }

  function renderGalleryState(kind: "loading" | "empty" | "error", title: string, description = "") {
    tree.textContent = "";
    tree.className = "filesTree artifactGallery fileTreeContainer--state";
    const state = document.createElement("div");
    state.className = `artifactGalleryState artifactGalleryState--${kind}`;
    state.setAttribute("role", kind === "error" ? "alert" : "status");
    const icon = document.createElement("span"); icon.className = "artifactGalleryStateIcon"; icon.setAttribute("aria-hidden", "true");
    if (kind === "loading") icon.classList.add("artifactGallerySpinner");
    else icon.innerHTML = kind === "error"
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 9v5m0 3h.01"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="m12 3 1.35 3.65L17 8l-3.65 1.35L12 13l-1.35-3.65L7 8l3.65-1.35L12 3Z"/><path d="m18 13 .85 2.15L21 16l-2.15.85L18 19l-.85-2.15L15 16l2.15-.85L18 13Z"/></svg>';
    const copy = document.createElement("span"); copy.className = "artifactGalleryStateCopy";
    const heading = document.createElement("strong"); heading.textContent = title; copy.append(heading);
    if (description) { const detail = document.createElement("span"); detail.textContent = description; copy.append(detail); }
    state.append(icon, copy); tree.append(state);
  }

  function directoryPathAt(index: number, segments: string[]) {
    return [artifactRootPath, ...segments.slice(0, index + 1)].join("/");
  }

  function renderBreadcrumb(count?: number) {
    breadcrumb.textContent = "";
    const relative = artifactRelativePath(currentDirectory);
    const segments = relative ? relative.split("/") : [];
    const root = document.createElement("button"); root.type = "button"; root.textContent = "Artifacts";
    root.disabled = !segments.length; root.addEventListener("click", () => void loadDirectory(artifactRootPath)); breadcrumb.append(root);
    segments.forEach((segment, index) => {
      const separator = document.createElement("span"); separator.textContent = "/"; separator.setAttribute("aria-hidden", "true"); breadcrumb.append(separator);
      const item = document.createElement("button"); item.type = "button"; item.textContent = segment; item.disabled = index === segments.length - 1;
      item.addEventListener("click", () => void loadDirectory(directoryPathAt(index, segments))); breadcrumb.append(item);
    });
    galleryBack.disabled = currentDirectory === artifactRootPath;
    galleryCount.textContent = typeof count === "number" ? `${count} ${count === 1 ? "item" : "items"}` : "";
  }

  function renderFolderPreview(host: HTMLElement) {
    host.className = "artifactGalleryCardVisual artifactGalleryCardVisual--folder";
    host.innerHTML = '<span class="artifactGalleryFolder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3 6h6l2 2h10v10H3z"/></svg><i></i><i></i><i></i></span>';
  }

  async function loadMarkdownExcerpt(entry: ArtifactEntry, host: HTMLElement, generation: number) {
    try {
      const data = await responseJson(await fetch(`/api/files/read?${query(entry.path)}`, { headers: apiHeaders() }));
      if (generation !== loadGeneration || !host.isConnected) return;
      const lines = String(data.content || "").split(/\r?\n/).map((line) => line.replace(/^\s{0,3}#{1,6}\s+/, "").replace(/[*_`>#]/g, "").trim()).filter(Boolean);
      host.textContent = "";
      const heading = document.createElement("strong"); heading.textContent = lines[0] || entry.name; host.append(heading);
      const excerpt = document.createElement("span"); excerpt.textContent = lines.slice(1).join(" ").slice(0, 180) || "Rendered Markdown artifact"; host.append(excerpt);
    } catch { /* Keep the designed Markdown placeholder. */ }
  }

  function renderCardPreview(entry: ArtifactEntry, host: HTMLElement, generation: number) {
    if (entry.kind === "directory") { renderFolderPreview(host); return; }
    const kind = artifactKind(entry.path);
    host.className = `artifactGalleryCardVisual artifactGalleryCardVisual--${kind}`;
    const url = artifactUrl(entry.path);
    if (kind === "image") {
      const image = document.createElement("img"); image.alt = ""; image.loading = "lazy"; image.decoding = "async"; host.append(image);
      deferPreview(image, () => { image.src = url; });
      return;
    }
    if (kind === "html") {
      const frame = document.createElement("iframe"); frame.title = `Thumbnail of ${entry.name}`; frame.tabIndex = -1; frame.inert = true; frame.loading = "lazy"; frame.setAttribute("aria-hidden", "true"); frame.setAttribute("sandbox", "allow-scripts"); host.append(frame);
      deferPreview(frame, () => { frame.src = url; });
      return;
    }
    if (kind === "markdown") {
      host.innerHTML = '<span class="artifactGalleryMarkdownMark">M↓</span><strong>Markdown</strong><i></i><i></i><i></i>';
      deferPreview(host, () => { void loadMarkdownExcerpt(entry, host, generation); });
      return;
    }
    if (kind === "video") {
      const video = document.createElement("video"); video.muted = true; video.playsInline = true; video.preload = "metadata"; host.append(video);
      const play = document.createElement("span"); play.className = "artifactGalleryPlay"; play.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="m8 5 11 7-11 7V5Z"/></svg>'; host.append(play);
      deferPreview(video, () => { video.src = url; });
      return;
    }
    const mark = document.createElement("span"); mark.className = "artifactGalleryFileMark"; mark.textContent = fileExtension(entry.name); host.append(mark);
  }

  function createGalleryCard(entry: ArtifactEntry, generation: number) {
    const card = document.createElement("article");
    card.className = `artifactGalleryCard${entry.kind === "directory" ? " artifactGalleryCard--folder" : ""}`;
    card.dataset.artifactPath = entry.path;
    const visual = document.createElement("div"); renderCardPreview(entry, visual, generation);
    const metadata = document.createElement("div"); metadata.className = "artifactGalleryCardMeta";
    const name = document.createElement("strong"); name.textContent = entry.name; name.title = entry.name;
    const detail = document.createElement("span");
    detail.textContent = entry.kind === "directory" ? "Folder" : [artifactKindLabel(artifactKind(entry.path)), formatFileSize(entry.size)].filter(Boolean).join(" · ");
    metadata.append(name, detail);
    const open = document.createElement("button"); open.type = "button"; open.className = "artifactGalleryCardOpen";
    open.setAttribute("aria-label", entry.kind === "directory" ? `Open folder ${entry.name}` : `Preview ${entry.name}`);
    open.addEventListener("click", () => entry.kind === "directory" ? void loadDirectory(entry.path) : showPreview(entry));
    card.append(visual, metadata, open); return card;
  }

  function renderGallery(entries: ArtifactEntry[], generation: number) {
    tree.textContent = "";
    tree.className = "filesTree artifactGallery";
    for (const entry of entries) tree.append(createGalleryCard(entry, generation));
  }

  async function loadDirectory(path: string) {
    directoryScrollPositions.set(currentDirectory, explorer.scrollTop);
    currentDirectory = path;
    activeEntry = undefined;
    panel.dataset.artifactView = "gallery";
    const generation = ++loadGeneration;
    clearDeferredPreviews(); renderBreadcrumb(); renderGalleryState("loading", "Loading artifacts…"); tree.setAttribute("aria-busy", "true");
    try {
      const data = await responseJson(await fetch(`/api/files/tree?${query(path)}`, { headers: apiHeaders() }));
      if (generation !== loadGeneration) return;
      const entries = (data.entries as ArtifactEntry[]).filter((entry) => !entry.name.startsWith("."));
      renderBreadcrumb(entries.length);
      if (entries.length) renderGallery(entries, generation);
      else renderGalleryState("empty", path === artifactRootPath ? "No artifacts yet" : "Nothing in this folder", path === artifactRootPath ? "Generated images, pages, reports, and videos will appear here." : "This artifact folder is empty.");
    } catch (error) {
      if (generation !== loadGeneration) return;
      renderBreadcrumb(0);
      if (path === artifactRootPath && error instanceof ArtifactRequestError && error.status === 404) {
        renderGalleryState("empty", "No artifacts yet", "Generated images, pages, reports, and videos will appear here.");
      } else {
        renderGalleryState("error", "Couldn’t load artifacts", error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (generation === loadGeneration) {
        tree.removeAttribute("aria-busy");
        const scrollTop = directoryScrollPositions.get(path) || 0;
        requestAnimationFrame(() => {
          if (generation === loadGeneration && currentDirectory === path && panel.dataset.filesScope === "artifacts" && panel.dataset.artifactView === "gallery") explorer.scrollTop = scrollTop;
        });
      }
    }
  }

  function renderPreviewLoading(label = "Loading preview…") {
    previewBody.className = "artifactBrowserPreviewBody artifactBrowserPreviewBody--loading";
    previewBody.textContent = "";
    const spinner = document.createElement("span"); spinner.className = "artifactBrowserPreviewSpinner"; spinner.setAttribute("aria-hidden", "true");
    const text = document.createElement("span"); text.textContent = label; previewBody.append(spinner, text);
  }

  function renderPreviewError(message: string) {
    previewBody.className = "artifactBrowserPreviewBody artifactBrowserPreviewBody--error";
    previewBody.textContent = "";
    const title = document.createElement("strong"); title.textContent = "Preview unavailable";
    const detail = document.createElement("span"); detail.textContent = message; previewBody.append(title, detail);
  }

  async function renderTextPreview(entry: ArtifactEntry, kind: ArtifactKind, generation: number) {
    try {
      const data = await responseJson(await fetch(`/api/files/read?${query(entry.path)}`, { headers: apiHeaders() }));
      if (generation !== previewGeneration || activeEntry?.path !== entry.path) return;
      previewBody.className = `artifactBrowserPreviewBody artifactBrowserPreviewBody--${kind}`;
      previewBody.textContent = "";
      if (kind === "markdown") renderStandaloneMarkdown(previewBody, String(data.content || ""));
      else { const pre = document.createElement("pre"); pre.textContent = String(data.content || ""); previewBody.append(pre); }
    } catch (error) {
      if (generation !== previewGeneration) return;
      renderPreviewError(error instanceof Error ? error.message : String(error));
    }
  }

  function renderPreview(entry: ArtifactEntry) {
    const generation = ++previewGeneration;
    const kind = artifactKind(entry.path);
    const url = artifactUrl(entry.path);
    preview.dataset.artifactKind = kind;
    previewTitle.textContent = entry.name;
    previewOpen.href = url;
    previewDownload.href = url;
    previewDownload.download = entry.name;
    renderPreviewLoading();
    if (kind === "image") {
      previewBody.className = "artifactBrowserPreviewBody artifactBrowserPreviewBody--image"; previewBody.textContent = "";
      const image = document.createElement("img"); image.alt = entry.name; image.src = url;
      image.addEventListener("error", () => { if (generation === previewGeneration) renderPreviewError("The image could not be loaded."); }, { once: true });
      previewBody.append(image); return;
    }
    if (kind === "html") {
      previewBody.className = "artifactBrowserPreviewBody artifactBrowserPreviewBody--html"; previewBody.textContent = "";
      const frame = document.createElement("iframe"); frame.src = url; frame.title = `Interactive preview of ${entry.name}`; frame.setAttribute("sandbox", "allow-scripts"); previewBody.append(frame); return;
    }
    if (kind === "video") {
      previewBody.className = "artifactBrowserPreviewBody artifactBrowserPreviewBody--video"; previewBody.textContent = "";
      const video = document.createElement("video"); video.controls = true; video.playsInline = true; video.preload = "metadata";
      const source = document.createElement("source"); source.src = url; source.type = videoMimeType(entry.path); video.append(source); previewBody.append(video); return;
    }
    if (kind === "pdf") {
      previewBody.className = "artifactBrowserPreviewBody artifactBrowserPreviewBody--pdf"; previewBody.textContent = "";
      const frame = document.createElement("iframe"); frame.src = url; frame.title = `Preview of ${entry.name}`; previewBody.append(frame); return;
    }
    void renderTextPreview(entry, kind, generation);
  }

  function showPreview(entry: ArtifactEntry, pushHistory = true) {
    if (pushHistory && !panel.hidden) pushArtifactPreviewHistory(entry);
    activeEntry = entry;
    panel.dataset.artifactView = "preview";
    renderPreview(entry);
    requestAnimationFrame(() => previewBack.focus());
  }

  function showGallery() {
    const previousPath = activeEntry?.path;
    activeEntry = undefined;
    ++previewGeneration;
    panel.dataset.artifactView = "gallery";
    previewBody.className = "artifactBrowserPreviewBody";
    previewBody.textContent = "";
    if (previousPath) requestAnimationFrame(() => {
      for (const card of tree.querySelectorAll<HTMLElement>(".artifactGalleryCard")) {
        if (card.dataset.artifactPath === previousPath) { card.querySelector<HTMLButtonElement>(".artifactGalleryCardOpen")?.focus(); break; }
      }
    });
  }

  function refresh() {
    if (panel.dataset.artifactView === "preview" && activeEntry) renderPreview(activeEntry);
    else void loadDirectory(currentDirectory);
  }

  function reset() {
    ++loadGeneration; ++previewGeneration; clearDeferredPreviews();
    directoryScrollPositions.clear();
    currentDirectory = artifactRootPath; activeEntry = undefined; panel.dataset.artifactView = "gallery";
    tree.className = "filesTree artifactGallery"; tree.textContent = ""; tree.removeAttribute("aria-busy");
    previewBody.className = "artifactBrowserPreviewBody"; previewBody.textContent = ""; renderBreadcrumb();
  }

  galleryBack.addEventListener("click", () => { if (currentDirectory !== artifactRootPath) void loadDirectory(parentArtifactPath(currentDirectory)); });
  previewBack.addEventListener("click", () => { showGallery(); replaceArtifactHistory({ view: "gallery" }); });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && panel.dataset.filesScope === "artifacts" && panel.dataset.artifactView === "preview") {
      event.preventDefault(); showGallery(); replaceArtifactHistory({ view: "gallery" });
    }
  });
  window.addEventListener("popstate", (event) => {
    if (panel.hidden || panel.dataset.filesScope !== "artifacts") return;
    const state = artifactHistoryState(event.state);
    if (state?.view === "preview") showPreview(state.entry, false);
    else if (panel.dataset.artifactView === "preview") showGallery();
  });
  panel.dataset.artifactView = "gallery";
  renderBreadcrumb();
  return { refresh, reset };
}
