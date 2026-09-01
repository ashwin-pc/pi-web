import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { vscodeDark } from "@uiw/codemirror-theme-vscode/esm/dark.js";
import type { RightPanelManager } from "../layout/rightPanel.js";
import { iconElement } from "../app/icons.js";
import { initArtifactBrowser } from "./artifactBrowser.js";

type FileEntry = { name: string; path: string; kind: "file" | "directory" | "symlink"; size?: number };
type TextDocumentState = { kind: "text"; path: string; revision: string; saved: string; view: EditorView; language: string; wrap: Compartment; host: HTMLElement };
type ImageDocumentState = { kind: "image"; path: string; host: HTMLElement; objectUrl: string };
type DocumentState = TextDocumentState | ImageDocumentState;
type ExplorerScope = "workspace" | "artifacts";
type DirectoryLoadContext = { generation: number; root: boolean };
type WorkspaceHistoryState = { view: "tree" | "editor" };
const workspaceHistoryStateKey = "piWebWorkspaceView";

async function languageExtension(language: string) {
  switch (language) {
    case "javascript": case "typescript": return (await import("@codemirror/lang-javascript")).javascript({ typescript: language === "typescript", jsx: true });
    case "json": return (await import("@codemirror/lang-json")).json();
    case "html": return (await import("@codemirror/lang-html")).html();
    case "css": return (await import("@codemirror/lang-css")).css();
    case "markdown": return (await import("@codemirror/lang-markdown")).markdown();
    case "python": return (await import("@codemirror/lang-python")).python();
    case "rust": return (await import("@codemirror/lang-rust")).rust();
    case "java": return (await import("@codemirror/lang-java")).java();
    case "sql": return (await import("@codemirror/lang-sql")).sql();
    default: return [];
  }
}

export type FilesPanelController = {
  isOpen(): boolean;
  sessionChanged(): void;
  openFile(path: string): Promise<void>;
  openArtifact(url: string): void;
};

export function initFilesPanel(options: {
  button: HTMLButtonElement; panel: HTMLElement; rightPanels: RightPanelManager;
  apiHeaders: () => HeadersInit; getSessionId: () => string; onError: (error: unknown) => void;
}): FilesPanelController {
  const { button, panel, rightPanels, apiHeaders, getSessionId, onError } = options;
  const tree = panel.querySelector<HTMLElement>("#filesTree")!;
  const artifactsTree = panel.querySelector<HTMLElement>("#artifactsTree")!;
  const editor = panel.querySelector<HTMLElement>("#fileEditor")!;
  const tabs = panel.querySelector<HTMLElement>("#fileTabs")!;
  const saveButton = panel.querySelector<HTMLButtonElement>("#fileSaveButton")!;
  const backButton = panel.querySelector<HTMLButtonElement>("#fileBackButton")!;
  const refreshButton = panel.querySelector<HTMLButtonElement>("#filesRefreshButton")!;
  const closeButton = panel.querySelector<HTMLButtonElement>("#filesCloseButton")!;
  const panelHeading = panel.querySelector<HTMLElement>("#filesPanelHeadingLabel")!;
  const explorer = panel.querySelector<HTMLElement>(".filesExplorer")!;
  const workspaceScopeButton = panel.querySelector<HTMLButtonElement>("#filesWorkspaceScope")!;
  const artifactsScopeButton = panel.querySelector<HTMLButtonElement>("#filesArtifactsScope")!;
  backButton.textContent = "";
  backButton.append(iconElement("arrow-left"));
  const status = panel.querySelector<HTMLElement>("#fileStatus")!;
  const treeResize = panel.querySelector<HTMLElement>("#filesTreeResize")!;
  const treeCollapse = panel.querySelector<HTMLButtonElement>("#filesTreeCollapse")!;
  const fontSlider = panel.querySelector<HTMLInputElement>("#fileFontSlider")!;
  const fontValue = panel.querySelector<HTMLOutputElement>("#fileFontValue")!;
  const wrapToggle = panel.querySelector<HTMLButtonElement>("#fileWrapToggle")!;
  const artifactBrowser = initArtifactBrowser({ panel, tree: artifactsTree, apiHeaders, getSessionId });
  const documents = new Map<string, DocumentState>();
  const editorFontStorageKey = "pi-web.files.editor-font-size";
  const editorWrapStorageKey = "pi-web.files.editor-line-wrap";
  const treeWidthStorageKey = "pi-web.files.tree-width";
  const activeTouchPointers = new Map<number, { x: number; y: number }>();
  let activePath = "";
  let loadedSession = "";
  let treeScope: ExplorerScope = "workspace";
  let treeLoadGeneration = 0;
  let workspaceMobileView: "tree" | "editor" = "tree";
  let scopeLoaded: Record<ExplorerScope, boolean> = { workspace: false, artifacts: false };
  const scopeScrollPositions: Record<ExplorerScope, number> = { workspace: 0, artifacts: 0 };
  let errorHost: HTMLElement | undefined;
  let pinchStartDistance = 0;
  let pinchStartFontSize = 0;
  let editorFontSize = (() => {
    try {
      const stored = Number(localStorage.getItem(editorFontStorageKey));
      if (stored >= 11 && stored <= 22) return stored;
    } catch { /* Ignore unavailable storage. */ }
    return window.matchMedia("(max-width: 640px)").matches ? 14 : 13;
  })();
  let editorLineWrap = (() => {
    try { return localStorage.getItem(editorWrapStorageKey) !== "off"; } catch { return true; }
  })();
  panel.style.setProperty("--file-editor-font-size", `${editorFontSize}px`);
  try {
    const storedTreeWidth = Number(localStorage.getItem(treeWidthStorageKey));
    if (storedTreeWidth >= 150 && storedTreeWidth <= 900) panel.style.setProperty("--files-tree-width", `${storedTreeWidth}px`);
  } catch { /* Ignore unavailable storage. */ }
  fontSlider.value = String(editorFontSize);
  fontValue.value = `${editorFontSize}px`;
  wrapToggle.setAttribute("aria-pressed", String(editorLineWrap));

  function query(path = "") {
    const params = new URLSearchParams({ sessionId: getSessionId() });
    if (path) params.set("path", path);
    return params;
  }
  async function responseJson(res: Response) {
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || res.statusText);
    return data;
  }
  function dirty(doc: DocumentState) { return doc.kind === "text" && doc.view.state.doc.toString() !== doc.saved; }
  function isImagePath(path: string) { return /\.(?:png|jpe?g|gif|webp|svg|bmp)$/i.test(path); }
  function renderTabs() {
    tabs.textContent = "";
    panel.classList.toggle("filesPanel--hasDocuments", documents.size > 0);
    for (const doc of documents.values()) {
      const tab = document.createElement("div"); tab.className = `fileTab${doc.path === activePath ? " active" : ""}`;
      const label = document.createElement("button"); label.type = "button"; label.className = "fileTabLabel";
      label.textContent = `${doc.path.split("/").pop()}${dirty(doc) ? " •" : ""}`; label.title = doc.path;
      label.addEventListener("click", () => activate(doc.path));
      const close = document.createElement("button"); close.type = "button"; close.className = "fileTabClose"; close.textContent = "×"; close.title = `Close ${doc.path}`; close.setAttribute("aria-label", `Close ${doc.path}`);
      close.addEventListener("click", () => closeDocument(doc.path));
      tab.append(label, close); tabs.append(tab);
    }
  }
  function closeDocument(path: string) {
    const doc = documents.get(path); if (!doc) return;
    if (dirty(doc) && !confirm(`Discard unsaved changes to ${path}?`)) return;
    const paths = [...documents.keys()]; const index = paths.indexOf(path);
    if (doc.kind === "text") doc.view.destroy();
    else URL.revokeObjectURL(doc.objectUrl);
    doc.host.remove(); documents.delete(path);
    if (activePath === path) {
      const next = paths[index + 1] || paths[index - 1]; activePath = "";
      if (next && documents.has(next)) activate(next);
      else { editor.textContent = ""; renderEditorEmpty(); panel.classList.remove("filesPanel--imageActive"); saveButton.disabled = true; status.textContent = ""; }
    }
    renderTabs();
  }
  function activate(path: string) {
    const doc = documents.get(path); if (!doc) return;
    errorHost?.remove(); errorHost = undefined;
    for (const item of documents.values()) item.host.hidden = item !== doc;
    activePath = path; showWorkspaceEditor(); panel.classList.toggle("filesPanel--imageActive", doc.kind === "image"); saveButton.disabled = !dirty(doc); status.textContent = "";
    renderTabs();
    // Touch-first tablets (including unfolded foldables) should not summon the
    // software keyboard merely because a file was opened.
    if (doc.kind === "text" && window.matchMedia("(hover: hover) and (pointer: fine)").matches) doc.view.focus();
  }
  function editorExtensions(docRef: { current?: DocumentState }, language: Compartment, wrap: Compartment) {
    return [lineNumbers(), history(), drawSelection(), highlightActiveLine(), bracketMatching(), highlightSelectionMatches(),
      vscodeDark, keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab, { key: "Mod-s", preventDefault: true, run: () => { void save(); return true; } }]),
      language.of([]), wrap.of(editorLineWrap ? EditorView.lineWrapping : []), EditorView.updateListener.of((update) => { if (!update.docChanged || !docRef.current) return; saveButton.disabled = !dirty(docRef.current); renderTabs(); })];
  }
  async function openFile(path: string) {
    if (documents.has(path)) { activate(path); return; }
    status.textContent = "Opening…";
    try {
      const host = document.createElement("div"); host.className = "fileEditorHost"; editor.append(host);
      if (isImagePath(path)) {
        host.classList.add("fileImagePreview");
        const response = await fetch(`/api/files/image?${query(path)}`, { headers: apiHeaders() });
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || response.statusText);
        const objectUrl = URL.createObjectURL(await response.blob());
        const image = document.createElement("img"); image.alt = path.split("/").pop() || path; image.src = objectUrl;
        try { await image.decode(); } catch { URL.revokeObjectURL(objectUrl); throw new Error("Browser could not decode this image"); }
        host.append(image); documents.set(path, { kind: "image", path, host, objectUrl }); activate(path); return;
      }
      const data = await responseJson(await fetch(`/api/files/read?${query(path)}`, { headers: apiHeaders() }));
      const language = new Compartment(); const wrap = new Compartment(); const ref: { current?: DocumentState } = {};
      const view = new EditorView({ state: EditorState.create({ doc: data.content, extensions: editorExtensions(ref, language, wrap) }), parent: host });
      const doc: TextDocumentState = { kind: "text", path, revision: data.revision, saved: data.content, view, language: data.language, wrap, host };
      ref.current = doc; documents.set(path, doc); activate(path);
      const extension = await languageExtension(data.language); view.dispatch({ effects: language.reconfigure(extension) });
    } catch (error) {
      editor.querySelector<HTMLElement>(".fileEditorHost:empty")?.remove();
      for (const doc of documents.values()) doc.host.hidden = true;
      errorHost?.remove();
      errorHost = document.createElement("div"); errorHost.className = "fileEditorError";
      const image = document.createElement("img"); image.src = "/file-editor-error.png"; image.alt = "";
      const message = document.createElement("p"); message.textContent = error instanceof Error ? error.message : String(error);
      errorHost.append(image, message); editor.append(errorHost);
      activePath = ""; showWorkspaceEditor(); panel.classList.remove("filesPanel--imageActive"); status.textContent = ""; saveButton.disabled = true; renderTabs();
    }
  }
  async function save() {
    const doc = documents.get(activePath); if (!doc || doc.kind !== "text" || !dirty(doc)) return;
    saveButton.disabled = true; status.textContent = "Saving…";
    try {
      const content = doc.view.state.doc.toString();
      const data = await responseJson(await fetch("/api/files/write", { method: "PUT", headers: apiHeaders(), body: JSON.stringify({ sessionId: getSessionId(), path: doc.path, content, expectedRevision: doc.revision }) }));
      doc.saved = content; doc.revision = data.revision; status.textContent = "Saved"; renderTabs();
    } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); onError(error); }
    finally { saveButton.disabled = !dirty(doc); }
  }
  function fileTypeClass(path: string) {
    const extension = path.split(".").pop()?.toLowerCase();
    if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(extension || "")) return "code";
    if (["json", "yaml", "yml", "toml"].includes(extension || "")) return "data";
    if (["md", "markdown", "txt"].includes(extension || "")) return "text";
    if (["css", "scss", "less", "html", "htm"].includes(extension || "")) return "web";
    if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(extension || "")) return "image";
    return "file";
  }
  function treeIcon(kind: "folder" | "file", type = "file") {
    const icon = document.createElement("span");
    icon.className = `fileTreeIcon fileTreeIcon--${kind} fileTreeIcon--${type}`;
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = kind === "folder"
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3 6h6l2 2h10v10H3z"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5"/></svg>';
    return icon;
  }
  function renderTreeState(container: HTMLElement, kind: "loading" | "empty" | "error", title: string, description = "") {
    container.textContent = "";
    container.classList.add("fileTreeContainer--state");
    const state = document.createElement("div");
    state.className = `fileTreeState fileTreeState--${kind}${container === tree ? "" : " fileTreeState--nested"}`;
    state.setAttribute("role", kind === "error" ? "alert" : "status");
    const icon = document.createElement("span");
    icon.className = "fileTreeStateIcon";
    icon.setAttribute("aria-hidden", "true");
    if (kind === "loading") {
      icon.classList.add("fileTreeStateSpinner");
    } else {
      icon.innerHTML = kind === "error"
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 9v5m0 3h.01"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3 6h6l2 2h10v10H3z"/></svg>';
    }
    const copy = document.createElement("span"); copy.className = "fileTreeStateCopy";
    const heading = document.createElement("strong"); heading.textContent = title; copy.append(heading);
    if (description) { const detail = document.createElement("span"); detail.textContent = description; copy.append(detail); }
    state.append(icon, copy); container.append(state);
  }
  async function loadDirectory(path: string, container: HTMLElement, context: DirectoryLoadContext) {
    renderTreeState(container, "loading", "Loading files…");
    container.setAttribute("aria-busy", "true");
    try {
      const data = await responseJson(await fetch(`/api/files/tree?${query(path)}`, { headers: apiHeaders() }));
      if (context.generation !== treeLoadGeneration) return;
      container.textContent = "";
      container.classList.remove("fileTreeContainer--state");
      const entries = data.entries as FileEntry[];
      for (const entry of entries) {
        if (entry.kind === "directory") {
          const details = document.createElement("details"); details.className = "fileTreeDirectory";
          const summary = document.createElement("summary");
          summary.append(treeIcon("folder"), document.createTextNode(entry.name)); details.append(summary);
          const children = document.createElement("div"); children.className = "fileTreeChildren"; details.append(children);
          details.addEventListener("toggle", () => {
            if (details.open && !children.dataset.loaded) {
              children.dataset.loaded = "1";
              void loadDirectory(entry.path, children, { ...context, root: false });
            }
          });
          container.append(details);
        } else {
          const item = document.createElement("button"); item.type = "button"; item.className = "fileTreeFile"; item.append(treeIcon("file", fileTypeClass(entry.path)), document.createTextNode(entry.name)); item.title = entry.path;
          item.addEventListener("click", () => void openFile(entry.path)); container.append(item);
        }
      }
      if (!entries.length) renderTreeState(container, "empty", context.root ? "Empty workspace" : "Empty folder");
    } catch (error) {
      if (context.generation !== treeLoadGeneration) return;
      renderTreeState(container, "error", "Couldn’t load files", error instanceof Error ? error.message : String(error));
    } finally {
      if (context.generation === treeLoadGeneration) container.removeAttribute("aria-busy");
    }
  }
  function renderEditorEmpty() {
    errorHost = undefined;
    editor.innerHTML = '<div class="fileEditorEmpty"><img src="/file-editor-waiting-v3.png" alt="" /></div>';
  }
  function historyRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }
  function workspaceHistoryState(value: unknown = window.history.state): WorkspaceHistoryState | undefined {
    const candidate = historyRecord(value)[workspaceHistoryStateKey];
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
    const view = (candidate as Record<string, unknown>).view;
    return view === "tree" || view === "editor" ? { view } : undefined;
  }
  function replaceWorkspaceHistory(view: WorkspaceHistoryState["view"]) {
    window.history.replaceState({ ...historyRecord(window.history.state), [workspaceHistoryStateKey]: { view } satisfies WorkspaceHistoryState }, "");
  }
  function setWorkspaceMobileView(view: WorkspaceHistoryState["view"]) {
    workspaceMobileView = view;
    if (treeScope === "workspace") panel.dataset.mobileView = view;
  }
  function showWorkspaceEditor() {
    if (treeScope === "workspace" && workspaceMobileView !== "editor" && !panel.hidden) {
      replaceWorkspaceHistory("tree");
      window.history.pushState({ ...historyRecord(window.history.state), [workspaceHistoryStateKey]: { view: "editor" } satisfies WorkspaceHistoryState }, "");
    }
    setWorkspaceMobileView("editor");
  }
  function showWorkspaceTree() {
    setWorkspaceMobileView("tree");
    replaceWorkspaceHistory("tree");
  }
  function updateTreeScope() {
    const showingArtifacts = treeScope === "artifacts";
    panel.dataset.filesScope = treeScope;
    panel.setAttribute("aria-label", showingArtifacts ? "Artifacts" : "Workspace files");
    panelHeading.textContent = showingArtifacts ? "Artifacts" : "Explorer";
    explorer.setAttribute("aria-label", showingArtifacts ? "Artifact gallery" : "File tree");
    refreshButton.setAttribute("aria-label", showingArtifacts ? "Refresh artifacts" : "Refresh files");
    refreshButton.title = showingArtifacts ? "Refresh artifacts" : "Refresh files";
    workspaceScopeButton.setAttribute("aria-pressed", String(!showingArtifacts));
    artifactsScopeButton.setAttribute("aria-pressed", String(showingArtifacts));
  }
  function loadActiveScope(force = false) {
    if (!force && scopeLoaded[treeScope]) return;
    scopeLoaded[treeScope] = true;
    if (treeScope === "artifacts") {
      artifactBrowser.refresh();
      return;
    }
    const generation = ++treeLoadGeneration;
    void loadDirectory("", tree, { generation, root: true });
  }
  function refresh() { loadActiveScope(true); }
  function restoreScopeScroll(scope: ExplorerScope) {
    const scrollTop = scopeScrollPositions[scope];
    explorer.scrollTop = scrollTop;
    requestAnimationFrame(() => { if (treeScope === scope) explorer.scrollTop = scrollTop; });
  }
  function setTreeScope(next: ExplorerScope) {
    if (treeScope === next) return;
    scopeScrollPositions[treeScope] = explorer.scrollTop;
    if (treeScope === "workspace") workspaceMobileView = panel.dataset.mobileView === "editor" ? "editor" : "tree";
    treeScope = next;
    panel.dataset.mobileView = next === "workspace" ? workspaceMobileView : "tree";
    updateTreeScope();
    restoreScopeScroll(next);
    loadActiveScope();
  }
  function sessionChanged() {
    const next = getSessionId(); if (next === loadedSession) return "unchanged" as const;
    if ([...documents.values()].some(dirty) && !confirm("Discard unsaved file changes from the previous session?")) return "cancelled" as const;
    loadedSession = next;
    scopeLoaded = { workspace: false, artifacts: false };
    scopeScrollPositions.workspace = 0; scopeScrollPositions.artifacts = 0;
    ++treeLoadGeneration;
    tree.className = "filesTree"; tree.textContent = ""; tree.removeAttribute("aria-busy");
    artifactBrowser.reset();
    for (const doc of documents.values()) { if (doc.kind === "text") doc.view.destroy(); else URL.revokeObjectURL(doc.objectUrl); doc.host.remove(); } documents.clear(); renderEditorEmpty(); activePath = ""; renderTabs(); panel.classList.remove("filesPanel--imageActive"); setWorkspaceMobileView("tree");
    if (!panel.hidden) loadActiveScope();
    return "changed" as const;
  }
  updateTreeScope();
  const handle = rightPanels.register({
    id: "files", side: "right", panel, trigger: button, closeButton, width: "760px", minWidth: 360, maxWidth: 10_000,
    onOpen: () => {
      const sessionResult = sessionChanged();
      if (sessionResult === "cancelled") return;
      loadActiveScope();
    },
  });
  function applyEditorFontSize(value: number, persist = false) {
    editorFontSize = Math.round(Math.min(22, Math.max(11, value)) * 10) / 10;
    panel.style.setProperty("--file-editor-font-size", `${editorFontSize}px`);
    fontSlider.value = String(editorFontSize);
    fontValue.value = `${editorFontSize.toFixed(editorFontSize % 1 ? 1 : 0)}px`;
    for (const doc of documents.values()) if (doc.kind === "text") doc.view.requestMeasure();
    if (persist) {
      try { localStorage.setItem(editorFontStorageKey, String(editorFontSize)); } catch { /* Ignore unavailable storage. */ }
    }
  }
  function pointerDistance() {
    const [first, second] = [...activeTouchPointers.values()];
    return first && second ? Math.hypot(second.x - first.x, second.y - first.y) : 0;
  }
  function finishEditorPinch(event: PointerEvent) {
    if (event.pointerType !== "touch") return;
    activeTouchPointers.delete(event.pointerId);
    if (activeTouchPointers.size < 2) {
      pinchStartDistance = 0;
      applyEditorFontSize(editorFontSize, true);
    }
  }
  editor.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "touch") return;
    activeTouchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (activeTouchPointers.size === 2) {
      pinchStartDistance = pointerDistance();
      pinchStartFontSize = editorFontSize;
    }
  });
  editor.addEventListener("pointermove", (event) => {
    if (event.pointerType !== "touch" || !activeTouchPointers.has(event.pointerId)) return;
    activeTouchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (activeTouchPointers.size < 2 || !pinchStartDistance) return;
    event.preventDefault();
    const next = Math.min(22, Math.max(11, pinchStartFontSize * pointerDistance() / pinchStartDistance));
    applyEditorFontSize(next);
  }, { passive: false });
  editor.addEventListener("pointerup", finishEditorPinch);
  editor.addEventListener("pointercancel", finishEditorPinch);
  function setTreeCollapsed(collapsed: boolean) {
    panel.classList.toggle("filesPanel--treeCollapsed", collapsed);
    treeCollapse.textContent = collapsed ? "›" : "‹";
    treeCollapse.setAttribute("aria-label", collapsed ? "Expand file tree" : "Collapse file tree");
    treeCollapse.title = collapsed ? "Expand file tree" : "Collapse file tree";
  }
  treeCollapse.addEventListener("click", (event) => { event.stopPropagation(); setTreeCollapsed(!panel.classList.contains("filesPanel--treeCollapsed")); });
  treeResize.addEventListener("pointerdown", (event) => {
    if (event.target === treeCollapse || window.matchMedia("(max-width: 640px)").matches) return;
    event.preventDefault(); treeResize.setPointerCapture(event.pointerId); setTreeCollapsed(false);
    const body = treeResize.parentElement!;
    const update = (move: PointerEvent) => {
      const left = body.getBoundingClientRect().left;
      const max = Math.max(150, body.getBoundingClientRect().width - 180);
      const width = Math.max(0, Math.min(max, move.clientX - left));
      if (width < 80) setTreeCollapsed(true);
      else { setTreeCollapsed(false); panel.style.setProperty("--files-tree-width", `${Math.max(150, width)}px`); }
    };
    const finish = (up: PointerEvent) => {
      treeResize.releasePointerCapture(up.pointerId); treeResize.removeEventListener("pointermove", update); treeResize.removeEventListener("pointerup", finish); treeResize.removeEventListener("pointercancel", finish);
      const width = parseFloat(getComputedStyle(panel).getPropertyValue("--files-tree-width"));
      if (!panel.classList.contains("filesPanel--treeCollapsed") && width) try { localStorage.setItem(treeWidthStorageKey, String(width)); } catch { /* Ignore unavailable storage. */ }
    };
    treeResize.addEventListener("pointermove", update); treeResize.addEventListener("pointerup", finish); treeResize.addEventListener("pointercancel", finish);
  });
  fontSlider.addEventListener("input", () => applyEditorFontSize(Number(fontSlider.value)));
  fontSlider.addEventListener("change", () => applyEditorFontSize(Number(fontSlider.value), true));
  wrapToggle.addEventListener("click", () => {
    editorLineWrap = !editorLineWrap;
    wrapToggle.setAttribute("aria-pressed", String(editorLineWrap));
    try { localStorage.setItem(editorWrapStorageKey, editorLineWrap ? "on" : "off"); } catch { /* Ignore unavailable storage. */ }
    for (const doc of documents.values()) if (doc.kind === "text") doc.view.dispatch({ effects: doc.wrap.reconfigure(editorLineWrap ? EditorView.lineWrapping : []) });
  });
  workspaceScopeButton.addEventListener("click", () => setTreeScope("workspace"));
  artifactsScopeButton.addEventListener("click", () => setTreeScope("artifacts"));
  refreshButton.addEventListener("click", refresh); saveButton.addEventListener("click", () => void save()); backButton.addEventListener("click", showWorkspaceTree);
  window.addEventListener("popstate", (event) => {
    if (panel.hidden || treeScope !== "workspace") return;
    const view = workspaceHistoryState(event.state)?.view;
    if (view === "editor" && (activePath || errorHost)) setWorkspaceMobileView("editor");
    else if (workspaceMobileView === "editor") setWorkspaceMobileView("tree");
  });
  window.addEventListener("beforeunload", (event) => { if ([...documents.values()].some(dirty)) event.preventDefault(); });
  function openArtifact(url: string) {
    handle.open();
    setTreeScope("artifacts");
    artifactBrowser.openArtifact(url);
  }
  return { isOpen: handle.isOpen, sessionChanged, openFile, openArtifact };
}
