import { renderStandaloneMarkdown } from "../markdown/render.js";
import { mountArtifactPreview } from "../extensions/artifactPreviews.js";
import { mountImagePreview } from "./imagePreview.js";

type ArtifactEntry = { name: string; path: string; kind: "file" | "directory" | "symlink"; size?: number; url?: string };
// Transient view state only: src is the original DOM URL, never a virtual file.
type StandaloneImage = { kind: "standalone"; src: string; name: string };
type ArtifactKind = "image" | "html" | "markdown" | "video" | "audio" | "pdf" | "file";

export const artifactRootPath = ".pi/web/artifacts";
const artifactHistoryStateKey = "piWebArtifactView";

type ArtifactHistoryState =
  // The files panel was open in another scope before this artifact preview.
  | { view: "inactive" }
  | { view: "gallery"; directory: string }
  | { view: "preview"; entry: ArtifactEntry }
  | { view: "image"; id: string };

type ArtifactPreviewNavigation = {
  history: "push" | "replace";
  origin: "current" | "inactive";
};

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
  if (/\.(?:mp3|m4a|wav|ogg|opus|flac)$/.test(lower)) return "audio";
  if (lower.endsWith(".pdf")) return "pdf";
  return "file";
}

function artifactKindLabel(kind: ArtifactKind) {
  return ({ image: "Image", html: "Interactive HTML", markdown: "Markdown", video: "Video", audio: "Audio", pdf: "PDF", file: "File" } as const)[kind];
}

function mediaMimeType(path: string) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".ogv")) return "video/ogg";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".ogg") || lower.endsWith(".opus")) return "audio/ogg";
  if (lower.endsWith(".flac")) return "audio/flac";
  return "application/octet-stream";
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

function isArtifactPath(path: string, allowRoot = false) {
  if (path === artifactRootPath) return allowRoot;
  if (!path.startsWith(`${artifactRootPath}/`)) return false;
  const segments = path.slice(artifactRootPath.length + 1).split("/");
  return segments.every((segment) => segment && segment !== "." && segment !== ".." && !segment.includes("\\") && !segment.includes("\0"));
}

export type ArtifactBrowserController = {
  refresh(): void;
  reset(): void;
  panelOpened(replacingPreview?: boolean): void;
  panelClosed(): void;
  leavePreview(): boolean;
  historyView(state: unknown): ArtifactHistoryState["view"] | undefined;
  restoreHistory(state: unknown): void;
  openArtifact(url: string, navigation?: ArtifactPreviewNavigation): boolean;
  openImage(source: string, name: string, navigation?: ArtifactPreviewNavigation): void;
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
  let renderedGalleryDirectory: string | undefined;
  let activeEntry: ArtifactEntry | undefined;
  let activeImage: StandaloneImage | undefined;
  // Only ephemeral pasted/blob images live here; filesystem artifacts retain their canonical URLs.
  const imageHistory = new Map<string, StandaloneImage>();
  const imageIds = new WeakMap<StandaloneImage, string>();
  // A page-local namespace prevents an old history entry from matching a new
  // image after reload. These are lookup keys, not security tokens.
  const imageIdPrefix = `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  let imageSequence = 0;
  function imageId(image: StandaloneImage) {
    let id = imageIds.get(image);
    if (!id) {
      id = `${imageIdPrefix}-${(++imageSequence).toString(36)}`; imageIds.set(image, id);
    }
    if (!imageHistory.has(id)) {
      imageHistory.set(id, image);
      if (imageHistory.size > 32) imageHistory.delete(imageHistory.keys().next().value!);
    }
    return id;
  }
  let disposeImage: (() => void) | undefined;
  function stopPreviewMedia() {
    disposeImage?.(); disposeImage = undefined;
    previewBody.querySelectorAll("video, audio").forEach((media) => { if (media instanceof HTMLMediaElement) media.pause(); });
  }
  let loadGeneration = 0;
  let previewGeneration = 0;
  // A retained preview can outlive the panel history entry that opened it.
  let previewOwnsHistoryEntry = false;

  function historyRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }

  function artifactHistoryState(value: unknown = history.state): ArtifactHistoryState | undefined {
    const candidate = historyRecord(value)[artifactHistoryStateKey];
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
    const record = candidate as Record<string, unknown>;
    if (record.view === "inactive") return { view: "inactive" };
    if (record.view === "image") {
      return typeof record.id === "string" && /^img-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/.test(record.id) ? { view: "image", id: record.id } : undefined;
    }
    if (record.view === "gallery") {
      const directory = typeof record.directory === "string" && isArtifactPath(record.directory, true) ? record.directory : artifactRootPath;
      return { view: "gallery", directory };
    }
    const entry = record.entry as Partial<ArtifactEntry> | undefined;
    if (record.view !== "preview" || !entry || typeof entry.name !== "string" || typeof entry.path !== "string" || !isArtifactPath(entry.path) || !["file", "symlink"].includes(entry.kind || "")) return undefined;
    const url = typeof entry.url === "string" && /^\/api\/(?:artifacts|session-artifacts)\//.test(entry.url) ? entry.url : undefined;
    return { view: "preview", entry: { name: entry.name, path: entry.path, kind: entry.kind as ArtifactEntry["kind"], size: typeof entry.size === "number" ? entry.size : undefined, url } };
  }

  function replaceArtifactHistory(state: ArtifactHistoryState) {
    history.replaceState({ ...historyRecord(history.state), [artifactHistoryStateKey]: state }, "");
  }

  function currentArtifactHistory(): ArtifactHistoryState {
    if (panel.dataset.artifactView === "preview") {
      if (activeImage) return { view: "image", id: imageId(activeImage) };
      if (activeEntry) return { view: "preview", entry: activeEntry };
    }
    return { view: "gallery", directory: currentDirectory };
  }

  function updateArtifactPreviewHistory(previewState: ArtifactHistoryState, navigation: ArtifactPreviewNavigation) {
    if (navigation.history === "replace") {
      // The shared panel manager already pushed an entry when it opened a closed
      // panel. Reuse that entry so its predecessor remains the closed layout.
      replaceArtifactHistory(previewState);
      return;
    }
    // An already-open panel needs a distinct preview entry and an exact return
    // location (including the artifact directory or prior preview).
    replaceArtifactHistory(navigation.origin === "inactive" ? { view: "inactive" } : currentArtifactHistory());
    history.pushState({ ...historyRecord(history.state), [artifactHistoryStateKey]: previewState }, "");
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

  function artifactUrl(path: string, sourceUrl?: string) {
    if (sourceUrl) return sourceUrl;
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
    renderedGalleryDirectory = path;
    activeEntry = undefined;
    activeImage = undefined;
    stopPreviewMedia();
    previewOwnsHistoryEntry = false;
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
      // A session artifact URL is the provenance of the file; do not silently
      // substitute a same-named file in the currently selected workspace.
      let text: string;
      if (entry.url) {
        const response = await fetch(entry.url, { headers: apiHeaders() });
        if (!response.ok) throw new Error(`Preview failed (${response.status})`);
        text = await response.text();
      } else {
        const data = await responseJson(await fetch(`/api/files/read?${query(entry.path)}`, { headers: apiHeaders() }));
        text = String(data.content || "");
      }
      if (generation !== previewGeneration || activeEntry?.path !== entry.path) return;
      previewBody.className = `artifactBrowserPreviewBody artifactBrowserPreviewBody--${kind}`;
      previewBody.textContent = "";
      if (kind === "markdown") renderStandaloneMarkdown(previewBody, text);
      else { const pre = document.createElement("pre"); pre.textContent = text; previewBody.append(pre); }
    } catch (error) {
      if (generation !== previewGeneration) return;
      renderPreviewError(error instanceof Error ? error.message : String(error));
    }
  }

  function renderPreview(entry: ArtifactEntry) {
    stopPreviewMedia();
    const generation = ++previewGeneration;
    const kind = artifactKind(entry.path);
    const url = artifactUrl(entry.path, entry.url);
    preview.dataset.artifactKind = kind;
    previewTitle.textContent = entry.name;
    previewOpen.href = url;
    previewDownload.href = url;
    previewDownload.download = entry.name;
    renderPreviewLoading();
    if (kind === "image") {
      previewBody.className = "artifactBrowserPreviewBody artifactBrowserPreviewBody--image"; previewBody.textContent = "";
      disposeImage = mountImagePreview(previewBody, url, entry.name, step, () => { if (generation === previewGeneration) renderPreviewError("The image could not be loaded."); });
      return;
    }
    if (kind === "html") {
      previewBody.className = "artifactBrowserPreviewBody artifactBrowserPreviewBody--html"; previewBody.textContent = "";
      const frame = document.createElement("iframe"); frame.src = url; frame.title = `Interactive preview of ${entry.name}`; frame.setAttribute("sandbox", "allow-scripts"); previewBody.append(frame); return;
    }
    if (kind === "video" || kind === "audio") {
      previewBody.className = `artifactBrowserPreviewBody artifactBrowserPreviewBody--${kind}`; previewBody.textContent = "";
      const media = document.createElement(kind); media.controls = true; media.preload = "metadata";
      if (media instanceof HTMLVideoElement) media.playsInline = true;
      const source = document.createElement("source"); source.src = url; source.type = mediaMimeType(entry.path);
      media.append(source); previewBody.append(media); return;
    }
    if (kind === "pdf") {
      previewBody.className = "artifactBrowserPreviewBody artifactBrowserPreviewBody--pdf"; previewBody.textContent = "";
      const frame = document.createElement("iframe"); frame.src = url; frame.title = `Preview of ${entry.name}`; previewBody.append(frame); return;
    }
    if (kind === "file") {
      const isCurrent = () => generation === previewGeneration && activeEntry?.path === entry.path;
      void mountArtifactPreview(previewBody, { name: entry.name, path: url, kind }, {
        title: `Interactive preview of ${entry.name}`,
        isCurrent,
      }).then((mounted) => {
        if (!mounted) return renderTextPreview(entry, kind, generation);
        if (isCurrent()) previewBody.className = "artifactBrowserPreviewBody artifactBrowserPreviewBody--html";
      }).catch((error) => {
        if (isCurrent()) renderPreviewError(error instanceof Error ? error.message : String(error));
      });
      return;
    }
    void renderTextPreview(entry, kind, generation);
  }

  function showImage(image: StandaloneImage, navigation: ArtifactPreviewNavigation | false = { history: "push", origin: "current" }) {
    if (navigation && !panel.hidden) updateArtifactPreviewHistory({ view: "image", id: imageId(image) }, navigation);
    activeEntry = undefined;
    activeImage = image;
    previewOwnsHistoryEntry = Boolean(navigation);
    panel.dataset.artifactView = "preview";
    updateSteps();
    const generation = ++previewGeneration;
    stopPreviewMedia();
    preview.dataset.artifactKind = "image";
    previewTitle.textContent = image.name;
    previewOpen.href = image.src;
    previewDownload.href = image.src;
    previewDownload.download = image.name;
    disposeImage = mountImagePreview(previewBody, image.src, image.name, step, () => { if (generation === previewGeneration) renderPreviewError("The image could not be loaded."); });
    requestAnimationFrame(() => { if (!panel.hidden && panel.dataset.artifactView === "preview") previewBack.focus(); });
  }

  function openImage(source: string, name: string, navigation: ArtifactPreviewNavigation = { history: "push", origin: "current" }) {
    showImage({ kind: "standalone", src: source, name }, navigation);
  }

  function showPreview(entry: ArtifactEntry, navigation: ArtifactPreviewNavigation | false = { history: "push", origin: "current" }) {
    if (navigation && !panel.hidden) updateArtifactPreviewHistory({ view: "preview", entry }, navigation);
    activeImage = undefined;
    activeEntry = entry;
    previewOwnsHistoryEntry = Boolean(navigation);
    panel.dataset.artifactView = "preview";
    updateSteps();
    renderPreview(entry);
    requestAnimationFrame(() => { if (!panel.hidden && panel.dataset.artifactView === "preview") previewBack.focus(); });
  }

  function showGallery() {
    const previousPath = activeEntry?.path;
    activeEntry = undefined;
    activeImage = undefined;
    stopPreviewMedia();
    previewOwnsHistoryEntry = false;
    ++previewGeneration;
    panel.dataset.artifactView = "gallery";
    previewBody.className = "artifactBrowserPreviewBody";
    previewBody.textContent = "";
    if (previousPath) requestAnimationFrame(() => {
      if (panel.hidden || panel.dataset.artifactView !== "gallery") return;
      for (const card of tree.querySelectorAll<HTMLElement>(".artifactGalleryCard")) {
        if (card.dataset.artifactPath === previousPath) { card.querySelector<HTMLButtonElement>(".artifactGalleryCardOpen")?.focus(); break; }
      }
    });
  }

  function openArtifact(value: string, navigation: ArtifactPreviewNavigation = { history: "push", origin: "current" }) {
    let pathname: string;
    try { const url = new URL(value, window.location.href); if (url.origin !== window.location.origin) return false; pathname = url.pathname; } catch { return false; }
    let encoded = "";
    if (pathname.startsWith("/api/artifacts/")) encoded = pathname.slice(15);
    else if (pathname.startsWith("/api/session-artifacts/")) {
      const rest = pathname.slice(23);
      const slash = rest.indexOf("/");
      if (slash >= 0) encoded = rest.slice(slash + 1);
    }
    if (!encoded) return false;
    let segments: string[];
    try { segments = encoded.split("/").filter(Boolean).map(decodeURIComponent); } catch { return false; }
    if (!segments.length || segments.some(segment => segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\") || segment.includes("\0"))) return false;
    const entry: ArtifactEntry = {
      name: segments[segments.length - 1],
      path: `${artifactRootPath}/${segments.join("/")}`,
      kind: "file",
      url: pathname,
    };
    showPreview(entry, navigation);
    currentDirectory = parentArtifactPath(entry.path);
    return true;
  }

  function refresh() {
    if (panel.dataset.artifactView === "preview" && activeEntry) renderPreview(activeEntry);
    else void loadDirectory(currentDirectory);
  }

  function reset() {
    ++loadGeneration; ++previewGeneration; clearDeferredPreviews();
    stopPreviewMedia(); activeImage = undefined;
    directoryScrollPositions.clear();
    currentDirectory = artifactRootPath; renderedGalleryDirectory = undefined; activeEntry = undefined; previewOwnsHistoryEntry = false; panel.dataset.artifactView = "gallery";
    tree.className = "filesTree artifactGallery"; tree.textContent = ""; tree.removeAttribute("aria-busy");
    previewBody.className = "artifactBrowserPreviewBody"; previewBody.textContent = ""; renderBreadcrumb();
  }

  function showGalleryDirectory(path: string) {
    if (path !== currentDirectory || renderedGalleryDirectory !== path || !tree.childElementCount) void loadDirectory(path);
    else showGallery();
  }

  function leavePreview(): boolean {
    if (panel.hidden || panel.dataset.filesScope !== "artifacts" || panel.dataset.artifactView !== "preview") return false;
    const state = artifactHistoryState();
    // Use the same traversal as browser Back. Only a preview retained across a
    // manual panel close/reopen lacks a live navigation entry and needs fallback.
    if (previewOwnsHistoryEntry && ((state?.view === "preview" && state.entry.path === activeEntry?.path) || (state?.view === "image" && imageHistory.get(state.id) === activeImage))) {
      previewOwnsHistoryEntry = false;
      history.back();
      return true;
    }
    showGalleryDirectory(currentDirectory);
    replaceArtifactHistory({ view: "gallery", directory: currentDirectory });
    return true;
  }

  function panelOpened(replacingPreview = false) {
    if (replacingPreview) return;
    if (panel.dataset.artifactView !== "preview") return;
    previewOwnsHistoryEntry = false;
    if (activeEntry) renderPreview(activeEntry);
    else if (activeImage) showImage(activeImage, false);
  }

  function panelClosed() {
    stopPreviewMedia();
    ++previewGeneration;
    previewBody.textContent = ""; // unload sandboxed frames and media while hidden
  }

  function historyView(state: unknown) {
    return artifactHistoryState(state)?.view;
  }

  function restoreHistory(value: unknown) {
    const state = artifactHistoryState(value);
    if (!state || state.view === "inactive") return;
    if (state.view === "image") {
      const image = imageHistory.get(state.id);
      if (image) showImage(image, false);
      else {
        panel.dataset.artifactView = "preview"; activeImage = undefined; activeEntry = undefined;
        previewTitle.textContent = "Image"; previewOpen.removeAttribute("href"); previewDownload.removeAttribute("href");
        stopPreviewMedia(); updateSteps(); renderPreviewError("The image could not be loaded after reloading this page.");
      }
      previewOwnsHistoryEntry = true;
      return;
    }
    if (state.view === "preview") {
      currentDirectory = parentArtifactPath(state.entry.path);
      showPreview(state.entry, false);
      previewOwnsHistoryEntry = true;
      return;
    }
    showGalleryDirectory(state.directory);
  }

  galleryBack.addEventListener("click", () => { if (currentDirectory !== artifactRootPath) void loadDirectory(parentArtifactPath(currentDirectory)); });
  previewBack.addEventListener("click", leavePreview);
  // Markdown links keep their ordinary renderer and DOM; file links simply
  // navigate this panel. Do not recursively embed artifact preview cards here.
  previewBody.addEventListener("click", (event) => {
    if (panel.hidden || !previewBody.classList.contains("artifactBrowserPreviewBody--markdown") || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
    if (!link || link.hasAttribute("download")) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin || !/^\/api\/(?:session-)?artifacts\//.test(url.pathname)) return;
    if (openArtifact(url.href)) event.preventDefault();
  });
  // Navigation is based on the live session DOM, not a second preview renderer.
  // Every destination passes through openArtifact and its existing history/render pipeline.
  const previous = document.createElement("button");
  const next = document.createElement("button");
  for (const [button, label] of [[previous, "Previous preview"], [next, "Next preview"]] as const) {
    button.type = "button";
    button.className = "artifactBrowserPreviewBack";
    button.setAttribute("aria-label", label);
    button.title = label;

  }
  previewTitle.parentElement?.after(previous, next);
  previous.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 18-6-6 6-6"/></svg>';
  next.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>';
  function sessionPreviews() {
    const messages = document.querySelector("#messages");
    if (!messages) return [];
    const items = Array.from(messages.querySelectorAll<HTMLElement>(".artifactPreview[data-artifact-path], .imageFrame > img, a[href^='/api/artifacts/'], a[href^='/api/session-artifacts/']"))
      .map((element) => ({
        url: element instanceof HTMLImageElement ? element.currentSrc || element.src : element instanceof HTMLAnchorElement ? element.getAttribute("href") || "" : element.dataset.artifactPath || "",
        name: element instanceof HTMLImageElement ? element.alt || "Image" : element instanceof HTMLAnchorElement ? element.textContent?.trim() || "Artifact" : element.dataset.artifactName || "Artifact",
      })).filter((item) => Boolean(item.url));
    const key = (url: string) => {
      const parsed = new URL(url, location.href);
      return /^\/api\/(?:session-)?artifacts\//.test(parsed.pathname) ? parsed.pathname + parsed.search : url;
    };
    return [...new Map(items.map((item) => [key(item.url), item])).values()];
  }
  function samePreviewUrl(left: string, right: string) {
    if (left === right) return true;
    const a = new URL(left, location.href), b = new URL(right, location.href);
    return a.origin === location.origin && b.origin === location.origin && /^\/api\//.test(a.pathname) && a.pathname === b.pathname;
  }
  function updateSteps() {
    const items = sessionPreviews();
    const current = activeImage?.src || (activeEntry ? artifactUrl(activeEntry.path, activeEntry.url) : "");
    const index = items.findIndex((item) => current && samePreviewUrl(item.url, current));
    previous.disabled = next.disabled = items.length < 2 || index < 0;
  }
  function step(direction: number) {
    const items = sessionPreviews();
    if (items.length < 2) return;
    const current = activeImage?.src || (activeEntry ? artifactUrl(activeEntry.path, activeEntry.url) : "");
    const index = items.findIndex((item) => current && samePreviewUrl(item.url, current));
    if (index < 0) return;
    const item = items[(index + direction + items.length) % items.length];
    if (!openArtifact(item.url)) openImage(item.url, item.name);
  }
  previous.addEventListener("click", () => step(-1));
  next.addEventListener("click", () => step(1));
  // Only navigation focus owns the arrow shortcuts. Other controls, links,
  // documents, and the composer retain their native keyboard behavior.
  preview.addEventListener("keydown", (event) => {
    if (panel.hidden || panel.dataset.artifactView !== "preview" || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    if (event.target !== preview && event.target !== previewBack && event.target !== previous && event.target !== next) return;
    event.preventDefault(); step(event.key === "ArrowLeft" ? -1 : 1);
  });
  panel.dataset.artifactView = "gallery";
  renderBreadcrumb();
  return { refresh, reset, panelOpened, panelClosed, leavePreview, historyView, restoreHistory, openArtifact, openImage };
}
