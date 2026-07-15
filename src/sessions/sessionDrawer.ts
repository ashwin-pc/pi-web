import type { ApiClient } from "../app/api.js";
import type { AppElements } from "../app/elements.js";
import { iconElement, setIcon, type IconName } from "../app/icons.js";
import { blurActiveEditableOnMobile } from "../app/focus.js";
import type { RightPanelHandle, RightPanelManager } from "../layout/rightPanel.js";
import type { AppState, RuntimeRef, SessionInfo, SessionMarkerColorId, SessionUiState } from "../app/types.js";
import { defaultSessionUiState, normalizeSessionUiState, persistActiveRuntimeRef, persistCollapsedSessionFolders, sessionFolderPreviewLimit, sessionMarkerColors, writeActiveSessionIdToUrl } from "../app/types.js";
import { listRuntimes, localRuntimeRef, parseApiError, type RuntimeOption } from "../runtimes/api.js";

export type SessionsController = {
  init: () => void;
  refreshSessions: () => Promise<void>;
  setSessionDrawerOpen: (open: boolean) => void;
  startNewSession: (cwd?: string, runtimeId?: string) => Promise<void>;
  updateSessionRuntime: (sessionId: string, runtime: SessionInfo["runtime"]) => void;
  updateEmptyCwdChooser: () => void;
  finishTranscriptLoading: () => void;
  renderSessionBar: () => void;
  renderCurrentSessionBucketButton: () => void;
  applySessionUiState: (value: unknown) => void;
  markSessionRead: (sessionId?: string) => Promise<void>;
};

function formatRelativeTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function sessionTitle(session: SessionInfo) {
  return session.name || session.firstMessage?.trim() || "New session";
}

function optimisticRuntimeRef(session: Partial<SessionInfo> | undefined, cwd: string): RuntimeRef {
  return session?.runtimeRef?.id ? { ...session.runtimeRef, cwd: session.runtimeRef.cwd || cwd } : localRuntimeRef(cwd);
}

function folderPathParts(path: string) {
  return path.split(/[\\/]+/).filter(Boolean);
}

function folderName(path: string) {
  const parts = folderPathParts(path);
  return parts.at(-1) || path || "Folder";
}

function folderPathSuffix(path: string, count: number) {
  const parts = folderPathParts(path);
  return parts.length > 0 ? parts.slice(-count).join("/") : path || "Folder";
}

function folderDisplayNames(cwds: string[]) {
  const labels = new Map<string, string>();
  const uniqueCwds = Array.from(new Set(cwds));
  for (const cwd of uniqueCwds) {
    const maxDepth = Math.min(3, Math.max(1, folderPathParts(cwd).length));
    const minDepth = Math.min(2, maxDepth);
    for (let depth = minDepth; depth <= maxDepth; depth += 1) {
      const label = folderPathSuffix(cwd, depth);
      const unique = uniqueCwds.every((other) => other === cwd || folderPathSuffix(other, depth) !== label);
      if (unique || depth === maxDepth) {
        labels.set(cwd, label);
        break;
      }
    }
  }
  return labels;
}

function shouldCloseDrawerAfterSessionSwitch() {
  return window.matchMedia("(max-width: 640px), (max-height: 520px)").matches;
}

const knownSessionCwdsStorageKey = "pi-web-known-session-cwds";
const sessionDrawerOpenStorageKey = "pi-web-session-drawer-open";
const runtimeLastSessionsStorageKey = "pi-web-runtime-last-sessions";

type RememberedRuntimeSession = { sessionId: string; cwd?: string };

function readRuntimeLastSessions(): Record<string, RememberedRuntimeSession> {
  try {
    const value = JSON.parse(sessionStorage.getItem(runtimeLastSessionsStorageKey) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function rememberRuntimeSession(runtimeId: string, sessionId?: string, cwd?: string) {
  if (!runtimeId || !sessionId) return;
  const sessions = readRuntimeLastSessions();
  sessions[runtimeId] = { sessionId, ...(cwd ? { cwd } : {}) };
  try { sessionStorage.setItem(runtimeLastSessionsStorageKey, JSON.stringify(sessions)); } catch { /* best effort */ }
}

function readPersistedSessionDrawerOpen() {
  try {
    return localStorage.getItem(sessionDrawerOpenStorageKey) === "true";
  } catch {
    return false;
  }
}

function persistSessionDrawerOpen(open: boolean) {
  try {
    localStorage.setItem(sessionDrawerOpenStorageKey, open ? "true" : "false");
  } catch {
    // Ignore storage failures (private browsing, quota, etc.).
  }
}

function readKnownSessionCwdMap(): Record<string, string[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(knownSessionCwdsStorageKey) || "{}");
    if (Array.isArray(raw)) return { local: raw.filter((value): value is string => typeof value === "string" && value.trim().length > 0) };
    if (!raw || typeof raw !== "object") return {};
    return Object.fromEntries(Object.entries(raw).map(([runtimeId, values]) => [
      runtimeId,
      Array.isArray(values) ? values.filter((value): value is string => typeof value === "string" && value.trim().length > 0) : [],
    ]));
  } catch {
    return {};
  }
}

function readKnownSessionCwds(runtimeId = "local") {
  return readKnownSessionCwdMap()[runtimeId] || [];
}

function rememberSessionCwd(cwd?: string, runtimeId = "local") {
  const value = cwd?.trim();
  if (!value) return;
  const map = readKnownSessionCwdMap();
  const cwds = new Set(map[runtimeId] || []);
  cwds.add(value);
  map[runtimeId] = Array.from(cwds);
  localStorage.setItem(knownSessionCwdsStorageKey, JSON.stringify(map));
}

async function responseError(response: Response) {
  return parseApiError(response);
}

function runtimeOptionLabel(runtime: RuntimeOption) {
  return runtime.label || runtime.id;
}

export function createSessions(options: {
  state: AppState;
  elements: AppElements;
  api: ApiClient;
  rightPanels?: RightPanelManager;
  updateMeta: (data: any) => void;
  updateThinkingOptions: (levels?: string[]) => void;
  refreshModels: () => Promise<void>;
  refreshMessages: () => Promise<void>;
  refreshState: () => Promise<void>;
  refreshSessionTitle: () => Promise<void>;
  clearMessages: () => void;
  addMessage: (role: "system", text: string, extraClass?: string) => void;
}): SessionsController {
  const {
    state,
    elements,
    api,
    rightPanels,
    updateMeta,
    updateThinkingOptions,
    refreshModels,
    refreshMessages,
    refreshState,
    refreshSessionTitle,
    clearMessages,
    addMessage,
  } = options;

  let cachedSessions: SessionInfo[] = [];
  let sessionRefreshSerial = 0;
  // Tracks runtime state for pinned sessions independently of cachedSessions so
  // session_runtime_changed events can update the bar even before the first
  // refreshSessions() completes.
  const pinnedRuntimes = new Map<string, SessionInfo["runtime"]>();
  let closeSessionActionsMenu: (() => void) | undefined;
  let sessionPanelHandle: RightPanelHandle | undefined;
  let currentSessionPinButton: HTMLButtonElement | undefined;
  let sessionSearchInput: HTMLInputElement | undefined;
  let sessionColorFilterButton: HTMLButtonElement | undefined;
  let markerPaletteEl: HTMLDivElement | undefined;
  let closeSessionColorFilterMenu: (() => void) | undefined;
  let closeCurrentSessionBucketMenu: (() => void) | undefined;
  const allowedMarkerColors = new Set<SessionMarkerColorId>();
  let unreadFilterActive = false;
  let transcriptLoading = true;
  type SessionRowTool = "pin" | SessionMarkerColorId;
  let selectedSessionRowTool: SessionRowTool = state.selectedMarkerColor;
  function effectiveRuntimeId() {
    return state.activeRuntimeRef.id || "local";
  }

  function effectiveRuntimeLabel() {
    return state.activeRuntimeRef.label || state.activeRuntimeRef.id || "Local machine";
  }

  function effectiveRuntimeCwd() {
    return state.activeRuntimeRef.cwd;
  }

  function renderActiveRuntime() {
    const label = effectiveRuntimeLabel();
    elements.workbenchRuntimeLabel.textContent = effectiveRuntimeId() === "local" ? "Local" : label;
    elements.workbenchRuntimeButton.title = `Workbench runtime: ${label}. Change runtime`;
    elements.workbenchRuntimeButton.setAttribute("aria-label", `Workbench runtime: ${label}`);
    elements.workbenchRuntimeButton.classList.toggle("remote", effectiveRuntimeId() !== "local");
  }

  function setActiveRuntime(runtime: RuntimeOption) {
    state.activeRuntimeRef = { ...runtime };
    persistActiveRuntimeRef(state.activeRuntimeRef);
    renderActiveRuntime();
    updateEmptyCwdChooser();
    window.dispatchEvent(new CustomEvent("pi-web:workbench-runtime-changed", { detail: { runtime: state.activeRuntimeRef } }));
  }

  async function fetchRuntimeOptions() {
    return listRuntimes(api);
  }

  type SessionAction = {
    id: string;
    label: string;
    icon?: IconName;
    danger?: boolean;
    disabled?: boolean;
    disabledReason?: string;
    run: () => Promise<void> | void;
  };

  function updateEmptyCwdChooser() {
    elements.emptyCwdPathEl.textContent = effectiveRuntimeId() !== "local" && effectiveRuntimeCwd() ? effectiveRuntimeCwd()! : state.currentCwd;
    elements.emptyCwdChooserEl.hidden = transcriptLoading || elements.messagesEl.children.length > 0 || state.isStreaming;
  }

  function finishTranscriptLoading() {
    if (elements.messagesEl.children.length === 0 && !state.isStreaming) {
      transcriptLoading = true;
      void restartNewChatAnimation();
      return;
    }
    transcriptLoading = false;
    updateEmptyCwdChooser();
  }

  async function restartNewChatAnimation() {
    const video = elements.emptyCwdChooserEl.querySelector<HTMLVideoElement>(".newChatLoadingAnimation");
    if (!video) {
      transcriptLoading = false;
      updateEmptyCwdChooser();
      return;
    }

    video.classList.add("resetting");
    video.pause();
    video.currentTime = 0;
    if (video.seeking) {
      await new Promise<void>((resolve) => {
        const timeout = window.setTimeout(resolve, 150);
        video.addEventListener("seeked", () => {
          window.clearTimeout(timeout);
          resolve();
        }, { once: true });
      });
    }

    transcriptLoading = false;
    updateEmptyCwdChooser();
    video.addEventListener("playing", () => video.classList.remove("resetting"), { once: true });
    void video.play().catch(() => video.classList.remove("resetting"));
  }

  async function selectSessionCwd(cwd: string) {
    const runtimeId = effectiveRuntimeId();
    if (runtimeId !== "local") {
      await startNewSession(cwd, runtimeId);
      return;
    }
    const res = await fetch("/api/session/cwd", {
      method: "POST",
      headers: api.headers(),
      body: JSON.stringify({ cwd, sessionId: state.currentSessionId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || await res.text());
    rememberSessionCwd(cwd, runtimeId);
    if (data.sessionId) writeActiveSessionIdToUrl(data.sessionId, "push", data.runtimeRef?.id || runtimeId);
    rememberRuntimeSession(data.runtimeRef?.id || runtimeId, data.sessionId, cwd);
    updateMeta(data);
    if (data.thinkingLevels) updateThinkingOptions(data.thinkingLevels);
    await refreshModels();
    await refreshMessages();
    refreshSessionTitle();
  }

  async function switchWorkbenchRuntime(runtime: RuntimeOption, confirmChange = true) {
    const currentWorkbenchId = effectiveRuntimeId();
    if (runtime.id === currentWorkbenchId) {
      setActiveRuntime(runtime);
      return;
    }

    if (confirmChange && state.currentSessionId) {
      const accepted = window.confirm(
        `Switch the entire workbench to ${runtimeOptionLabel(runtime)}?\n\nOpen tabs, sessions, folders, models, git, artifacts, and tools will switch together. Your current sessions remain saved and return when you switch back.`,
      );
      if (!accepted) return;
    }

    if ((state.currentRuntimeRef?.id || "local") === currentWorkbenchId) {
      rememberRuntimeSession(currentWorkbenchId, state.currentSessionId, state.currentCwd);
    }

    setActiveRuntime(runtime);
    cachedSessions = [];
    sessionRefreshSerial += 1;
    state.currentSessionId = "";
    state.currentRuntimeRef = { ...runtime };
    state.currentCwd = runtime.cwd || "";
    writeActiveSessionIdToUrl("", "replace");
    clearMessages();
    renderSessionList([]);
    renderSessionBar();
    updateEmptyCwdChooser();

    const remembered = readRuntimeLastSessions()[runtime.id];
    if (remembered?.sessionId) {
      state.sessionsById[remembered.sessionId] = {
        ...state.sessionsById[remembered.sessionId],
        id: remembered.sessionId,
        cwd: remembered.cwd || runtime.cwd,
        runtimeRef: { ...runtime, cwd: remembered.cwd || runtime.cwd },
      };
      try {
        if (await openSessionTab(remembered.sessionId, remembered.cwd || runtime.cwd || "")) {
          await refreshSessions();
          return;
        }
        // The remembered session may have been deleted on the runtime. Start a
        // clean session in the selected workbench instead.
      } catch {
        // Fall through to a clean session if recovery fails.
      }
    }
    await refreshSessions();
  }

  async function openRuntimePicker() {
    const runtimes = await fetchRuntimeOptions();
    if (!runtimes.some((runtime) => runtime.id === effectiveRuntimeId()) && effectiveRuntimeId() !== "local") {
      runtimes.push({ ...state.activeRuntimeRef, id: effectiveRuntimeId(), label: `${effectiveRuntimeLabel()} · unavailable` });
    }

    const backdrop = document.createElement("div");
    backdrop.className = "folderPickerBackdrop";
    const modal = document.createElement("div");
    modal.className = "folderPicker runtimePicker";
    const title = document.createElement("h2");
    title.textContent = "Switch workbench runtime";
    const description = document.createElement("p");
    description.className = "folderPickerHint runtimePickerHint";
    description.textContent = "Changing runtime replaces all open tabs, sessions, folders, models, git, artifacts, and tools in this browser tab.";
    const list = document.createElement("div");
    list.className = "folderPickerList";
    const actions = document.createElement("div");
    actions.className = "folderPickerActions";
    const manage = document.createElement("button");
    manage.type = "button";
    manage.textContent = "Manage runtimes…";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    const use = document.createElement("button");
    use.type = "button";
    use.className = "primaryAction";
    use.textContent = "Switch runtime";
    actions.append(manage, cancel, use);
    modal.append(title, description, list, actions);
    backdrop.append(modal);
    document.body.append(backdrop);

    let pendingRuntime = runtimes.find((runtime) => runtime.id === effectiveRuntimeId()) || runtimes[0] || localRuntimeRef();
    function render() {
      list.textContent = "";
      for (const runtime of runtimes) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "folderPickerRow";
        row.textContent = `${runtime.id === pendingRuntime.id ? "✓ " : ""}${runtimeOptionLabel(runtime)}${runtime.experimental ? " · experimental" : ""}`;
        row.addEventListener("click", () => {
          pendingRuntime = runtime;
          render();
        });
        list.append(row);
      }
    }
    render();
    manage.addEventListener("click", () => {
      backdrop.remove();
      elements.runtimeButton.click();
    });
    cancel.addEventListener("click", () => backdrop.remove());
    backdrop.addEventListener("click", (event) => { if (event.target === backdrop) backdrop.remove(); });
    use.addEventListener("click", () => {
      backdrop.remove();
      void switchWorkbenchRuntime(pendingRuntime).catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
    });
  }

  async function openFolderPicker(startPath: string) {
    blurActiveEditableOnMobile();
    const currentRuntime = state.currentRuntimeRef;
    let runtimes: RuntimeOption[];
    let initialRuntimeWarning = "";
    try {
      runtimes = await fetchRuntimeOptions();
    } catch (error) {
      initialRuntimeWarning = error instanceof Error ? error.message : String(error);
      runtimes = [localRuntimeRef(state.currentCwd)];
      if (currentRuntime?.id && currentRuntime.id !== "local") runtimes.push({ ...currentRuntime, cwd: currentRuntime.cwd || state.currentCwd });
    }

    let pickerRuntimeId = effectiveRuntimeId();
    let pickerRuntime = runtimes.find((runtime) => runtime.id === pickerRuntimeId)
      || (pickerRuntimeId === state.activeRuntimeRef.id ? { ...state.activeRuntimeRef, cwd: state.activeRuntimeRef.cwd || startPath } : undefined)
      || (pickerRuntimeId === currentRuntime?.id && currentRuntime ? { ...currentRuntime, cwd: currentRuntime.cwd || startPath } : undefined)
      || runtimes[0]
      || localRuntimeRef(state.currentCwd);
    pickerRuntimeId = pickerRuntime.id;
    let pickerRuntimeLabel = runtimeOptionLabel(pickerRuntime);
    let pickerRuntimeCwd = pickerRuntime.cwd;
    const folderRuntimeOptions = [pickerRuntime];
    const showRuntimeSelect = false;

    const backdrop = document.createElement("div");
    backdrop.className = "folderPickerBackdrop";
    const modal = document.createElement("div");
    modal.className = "folderPicker";
    const title = document.createElement("h2");
    title.textContent = "Select working directory";
    const runtimeField = document.createElement("label");
    runtimeField.className = "folderPickerRuntimeField";
    if (!showRuntimeSelect) runtimeField.hidden = true;
    const runtimeLabel = document.createElement("span");
    runtimeLabel.textContent = "Runtime";
    const runtimeSelect = document.createElement("select");
    runtimeSelect.className = "folderPickerRuntimeSelect";
    runtimeSelect.setAttribute("aria-label", "Runtime");
    for (const runtime of folderRuntimeOptions) {
      const option = new Option(`${runtimeOptionLabel(runtime)}${runtime.experimental ? " · experimental" : ""}`, runtime.id);
      runtimeSelect.append(option);
    }
    runtimeSelect.value = pickerRuntimeId;
    runtimeField.append(runtimeLabel, runtimeSelect);
    const runtimeHint = document.createElement("div");
    runtimeHint.className = "folderPickerHint";
    runtimeHint.hidden = !showRuntimeSelect;
    runtimeHint.textContent = `Folders are resolved inside ${pickerRuntimeLabel}. Change the workbench runtime separately to browse elsewhere.`;
    const input = document.createElement("input");
    input.className = "folderPickerInput";
    input.value = startPath;
    const list = document.createElement("div");
    list.className = "folderPickerList";
    const error = document.createElement("div");
    error.className = "folderPickerError";
    error.textContent = initialRuntimeWarning;
    const actions = document.createElement("div");
    actions.className = "folderPickerActions";
    const create = document.createElement("button");
    create.type = "button";
    create.textContent = "New folder";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    const select = document.createElement("button");
    select.type = "button";
    select.className = "primaryAction";
    select.textContent = "Select folder";
    actions.append(create, cancel, select);
    modal.append(title, runtimeField, runtimeHint, input, list, error, actions);
    backdrop.append(modal);
    document.body.append(backdrop);

    function selectedRuntimeDefaultPath(runtime: RuntimeOption) {
      if (runtime.id === "local") return runtime.cwd || (state.currentRuntimeRef?.id === "local" ? state.currentCwd : "") || startPath || "/";
      return runtime.cwd || startPath || "/";
    }

    async function load(path: string) {
      error.textContent = "";
      list.textContent = "Loading…";
      const runtimeQuery = pickerRuntimeId !== "local" ? `&runtimeId=${encodeURIComponent(pickerRuntimeId)}` : "";
      const res = await fetch(`/api/fs/dirs?path=${encodeURIComponent(path)}${runtimeQuery}`, { headers: api.headers() });
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.error || "Could not list directory");
      input.value = data.path;
      list.textContent = "";
      const up = document.createElement("button");
      up.type = "button";
      up.className = "folderPickerRow";
      up.textContent = "..";
      up.addEventListener("click", () => load(data.parent).catch((e) => { error.textContent = e.message; }));
      list.append(up);
      for (const dir of data.dirs || []) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "folderPickerRow";
        row.textContent = dir.name;
        row.addEventListener("click", () => load(dir.path).catch((e) => { error.textContent = e.message; }));
        list.append(row);
      }
    }

    runtimeSelect.addEventListener("change", () => {
      const nextRuntime = folderRuntimeOptions.find((runtime) => runtime.id === runtimeSelect.value) || folderRuntimeOptions[0] || localRuntimeRef(state.currentCwd);
      pickerRuntime = nextRuntime;
      pickerRuntimeId = nextRuntime.id;
      pickerRuntimeLabel = runtimeOptionLabel(nextRuntime);
      pickerRuntimeCwd = nextRuntime.cwd;
      const nextPath = selectedRuntimeDefaultPath(nextRuntime);
      input.value = nextPath;
      load(nextPath).catch((e) => { error.textContent = e.message; list.textContent = ""; });
    });

    create.addEventListener("click", async () => {
      const name = window.prompt("New folder name");
      if (name === null) return;
      try {
        create.disabled = true;
        error.textContent = "";
        const res = await fetch("/api/fs/dirs", {
          method: "POST",
          headers: api.headers(),
          body: JSON.stringify({ parent: input.value, name, ...(pickerRuntimeId !== "local" ? { runtimeId: pickerRuntimeId } : {}) }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false) throw new Error(data.error || "Could not create folder");
        input.value = data.path;
        await load(data.path);
      } catch (e) {
        error.textContent = e instanceof Error ? e.message : String(e);
      } finally {
        create.disabled = false;
      }
    });
    cancel.addEventListener("click", () => backdrop.remove());
    backdrop.addEventListener("click", (event) => { if (event.target === backdrop) backdrop.remove(); });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") load(input.value).catch((e) => { error.textContent = e.message; });
    });
    select.addEventListener("click", async () => {
      try {
        select.disabled = true;
        await selectSessionCwd(input.value);
        backdrop.remove();
      } catch (e) {
        error.textContent = e instanceof Error ? e.message : String(e);
        select.disabled = false;
      }
    });
    load(selectedRuntimeDefaultPath(pickerRuntime)).catch((e) => { error.textContent = e.message; list.textContent = ""; });
    if (!("ontouchstart" in window) && navigator.maxTouchPoints === 0) {
      input.focus();
    }
  }

  async function startNewSession(cwd?: string, runtimeIdOverride?: string) {
    const wasDrawerOpen = !elements.sessionDrawer.hidden;
    const runtimeId = runtimeIdOverride !== undefined ? runtimeIdOverride : effectiveRuntimeId();
    const res = await fetch("/api/sessions/new", {
      method: "POST",
      headers: api.headers(),
      body: JSON.stringify({ ...(cwd ? { cwd } : {}), ...(runtimeId ? { runtimeId } : {}), sessionId: state.currentSessionId }),
    });
    if (!res.ok) throw await responseError(res);
    const data = await res.json();
    if (data.sessionId) writeActiveSessionIdToUrl(data.sessionId, "push", data.runtimeRef?.id || runtimeId);
    rememberRuntimeSession(data.runtimeRef?.id || runtimeId, data.sessionId, cwd || data.cwd);
    rememberSessionCwd(cwd || data.cwd || state.currentCwd, data.runtimeRef?.id || runtimeId);
    transcriptLoading = true;
    clearMessages();
    updateMeta(data);
    await refreshState();
    await restartNewChatAnimation();
    if (shouldCloseDrawerAfterSessionSwitch()) {
      setSessionDrawerOpen(false);
    } else if (wasDrawerOpen) {
      await setSessionDrawerOpen(true);
      scrollCurrentSessionIntoView();
    }
  }

  function applySessionDrawerOpen(open: boolean) {
    persistSessionDrawerOpen(open);
    document.body.classList.toggle("sessionDrawerOpen", open);
    if (!open) {
      closeOpenSessionActionsMenu();
      closeOpenSessionColorFilterMenu();
      return;
    }
    return refreshSessions().catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
  }

  function setSessionDrawerOpen(open: boolean) {
    if (sessionPanelHandle) {
      sessionPanelHandle.setOpen(open);
      return;
    }
    if (open) blurActiveEditableOnMobile();
    elements.sessionDrawer.hidden = !open;
    elements.sessionBackdrop.hidden = !open;
    return applySessionDrawerOpen(open);
  }

  function scrollCurrentSessionIntoView() {
    elements.sessionListEl.querySelector<HTMLElement>(".sessionItem.current")
      ?.scrollIntoView({ block: "nearest" });
  }

  async function refreshSessions() {
    const refreshId = ++sessionRefreshSerial;
    const runtimeId = effectiveRuntimeId();
    rememberSessionCwd(state.currentCwd, state.currentRuntimeRef?.id || "local");
    const params = new URLSearchParams();
    params.set("runtimeId", runtimeId);
    params.set("limit", "200");
    params.set("all", "1");
    for (const cwd of readKnownSessionCwds(runtimeId)) params.append("cwd", cwd);

    async function load(cachedOnly: boolean) {
      const requestParams = new URLSearchParams(params);
      if (cachedOnly) requestParams.set("cached", "1");
      const res = await fetch(`/api/sessions?${requestParams}`, { headers: api.headers() });
      if (!res.ok) throw await responseError(res);
      const data = await res.json();
      if (refreshId !== sessionRefreshSerial || runtimeId !== effectiveRuntimeId()) return;
      cachedSessions = (data.sessions || []).map((item: SessionInfo) => ({
        ...item,
        isCurrent: item.id === state.currentSessionId && (item.runtimeRef?.id || "local") === (state.currentRuntimeRef?.id || "local"),
      }));
      for (const session of cachedSessions) state.sessionsById[session.id] = { ...state.sessionsById[session.id], ...session };
      let pinnedCwdsChanged = false;
      state.pinnedSessions = state.pinnedSessions.map((pinned) => {
        const live = cachedSessions.find((s) => s.id === pinned.id);
        const runtimeId = live?.runtimeRef?.id;
        if (live && (live.cwd && live.cwd !== pinned.cwd || runtimeId && runtimeId !== pinned.runtimeId)) {
          pinnedCwdsChanged = true;
          return { ...pinned, ...(live.cwd ? { cwd: live.cwd } : {}), ...(runtimeId ? { runtimeId } : {}) };
        }
        return pinned;
      });
      if (pinnedCwdsChanged) persistSessionUiState({ pinnedSessions: state.pinnedSessions });
      renderSessionList(cachedSessions);
      renderSessionBar();
      updateSessionButtonUnread();
    }

    if (runtimeId !== "local") await load(true).catch(() => undefined);
    await load(false);
  }

  function markCachedCurrentSession(sessionId: string, cwd: string) {
    cachedSessions = cachedSessions.map((session) => ({
      ...session,
      isCurrent: session.id === sessionId && (session.cwd || cwd) === cwd,
    }));
    renderSessionList(cachedSessions);
    renderSessionBar();
  }

  function updateSessionRuntime(sessionId: string, runtime: SessionInfo["runtime"]) {
    if (!sessionId) return;
    // Always cache runtime for pinned sessions — this lets renderSessionBar show
    // the running state even before cachedSessions is populated.
    const isPinned = state.pinnedSessions.some((p) => p.id === sessionId);
    if (isPinned) pinnedRuntimes.set(sessionId, runtime);
    if (cachedSessions.length === 0) {
      if (isPinned) renderSessionBar();
      return;
    }
    let changed = false;
    cachedSessions = cachedSessions.map((session) => {
      if (session.id !== sessionId) return session;
      changed = true;
      return { ...session, runtime };
    });
    if (!changed) {
      // Session not in cachedSessions yet but is pinned — still re-render bar.
      if (isPinned) renderSessionBar();
      return;
    }
    if (!elements.sessionDrawer.hidden) renderSessionList(cachedSessions);
    renderSessionBar();
  }

  // ── Markers and pinning ────────────────────────────────────────────────────

  function applySessionUiState(value: unknown) {
    const next = normalizeSessionUiState(value);
    state.pinnedSessions = next.pinnedSessions;
    state.pinnedFolders = next.pinnedFolders;
    state.sessionMarkers = next.sessionMarkers;
    state.sessionUnreadStates = next.sessionUnreadStates;
    syncCachedUnreadFromState();
    state.selectedMarkerColor = next.selectedMarkerColor;
    allowedMarkerColors.clear();
    for (const color of next.allowedMarkerColors) allowedMarkerColors.add(color);
    if (selectedSessionRowTool !== "pin") selectedSessionRowTool = next.selectedMarkerColor;
    document.body.classList.toggle("hasPinnedSessions", state.pinnedSessions.length > 0 || Boolean(state.currentSessionId));
    renderMarkerPalette();
    if (!elements.sessionDrawer.hidden) renderSessionList(cachedSessions);
    renderSessionBar();
    updateSessionButtonUnread();
    updateCurrentSessionPinButton();
    renderCurrentSessionBucketButton();
    if (state.pinnedSessions.length > 0 && cachedSessions.length === 0) refreshSessions().catch(() => undefined);
  }

  function hasAnySessionUiState(value: SessionUiState) {
    return value.pinnedSessions.length > 0
      || value.pinnedFolders.length > 0
      || value.sessionMarkers.length > 0
      || value.sessionUnreadStates.length > 0
      || value.allowedMarkerColors.length > 0
      || value.selectedMarkerColor !== defaultSessionUiState.selectedMarkerColor;
  }

  async function patchSessionUiState(patch: Partial<SessionUiState>) {
    const res = await fetch("/api/session-ui-state", {
      method: "PATCH",
      headers: api.headers(),
      body: JSON.stringify(patch),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || await res.text());
    applySessionUiState(data.sessionUiState);
  }

  function persistSessionUiState(patch: Partial<SessionUiState>) {
    patchSessionUiState(patch).catch((error) => {
      addMessage("system", error instanceof Error ? error.message : String(error), "error");
    });
  }

  function persistAllowedMarkerColors() {
    persistSessionUiState({ allowedMarkerColors: Array.from(allowedMarkerColors) });
  }

  async function refreshSessionUiState() {
    const res = await fetch("/api/session-ui-state", { headers: api.headers() });
    if (res.status === 401) return;
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || await res.text());
    const serverState = normalizeSessionUiState(data.sessionUiState);
    const localState = normalizeSessionUiState({
      pinnedSessions: state.pinnedSessions,
      pinnedFolders: state.pinnedFolders,
      sessionMarkers: state.sessionMarkers,
      sessionUnreadStates: state.sessionUnreadStates,
      selectedMarkerColor: state.selectedMarkerColor,
      allowedMarkerColors: Array.from(allowedMarkerColors),
    });
    if (!hasAnySessionUiState(serverState) && hasAnySessionUiState(localState)) {
      await patchSessionUiState(localState);
      return;
    }
    applySessionUiState(serverState);
  }

  function unreadStateForSession(sessionId: string) {
    return state.sessionUnreadStates.find((item) => item.sessionId === sessionId);
  }

  function syncCachedUnreadFromState() {
    cachedSessions = cachedSessions.map((session) => {
      const unread = unreadStateForSession(session.id);
      return { ...session, unread: Boolean(unread), unreadAt: unread?.unreadAt };
    });
  }

  function sessionRuntime(sessionId: string) {
    const pinnedRuntime = pinnedRuntimes.get(sessionId);
    if (pinnedRuntime?.isRunning) return pinnedRuntime;
    return cachedSessions.find((session) => session.id === sessionId)?.runtime ?? pinnedRuntime;
  }

  function isSessionRunning(sessionId: string, fallbackRunning = false) {
    return Boolean(fallbackRunning || sessionRuntime(sessionId)?.isRunning);
  }

  function isSessionUnread(sessionId: string, fallbackUnread = false, fallbackRunning = false) {
    return Boolean(
      sessionId
      && sessionId !== state.currentSessionId
      && !isSessionRunning(sessionId, fallbackRunning)
      && (fallbackUnread || unreadStateForSession(sessionId)),
    );
  }

  function hasVisibleUnreadSessions() {
    if (cachedSessions.length > 0) {
      return cachedSessions.some((item) => isSessionUnread(item.id, Boolean(item.unread), Boolean(item.runtime?.isRunning)));
    }
    return state.sessionUnreadStates.some((item) => item.sessionId !== state.currentSessionId && !isSessionRunning(item.sessionId));
  }

  function updateSessionButtonUnread() {
    const unread = hasVisibleUnreadSessions();
    elements.sessionButton.classList.toggle("unread", unread);
    const title = unread ? "Sessions · unread activity" : "Sessions";
    elements.sessionButton.title = title;
    elements.sessionButton.setAttribute("aria-label", title);
    renderSessionColorFilterButton();
  }

  function clearLocalUnread(sessionId: string) {
    const next = state.sessionUnreadStates.filter((item) => item.sessionId !== sessionId);
    if (next.length === state.sessionUnreadStates.length) return;
    state.sessionUnreadStates = next;
    syncCachedUnreadFromState();
    if (!elements.sessionDrawer.hidden) renderSessionList(cachedSessions);
    renderSessionBar();
    updateSessionButtonUnread();
  }

  async function markSessionRead(sessionId = state.currentSessionId) {
    const id = sessionId.trim();
    if (!id) return;
    clearLocalUnread(id);
    const res = await fetch("/api/session-ui-state/read", {
      method: "POST",
      headers: api.headers(),
      body: JSON.stringify({ sessionId: id }),
    });
    if (res.status === 401) return;
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || await res.text());
    applySessionUiState(data.sessionUiState);
  }

  function markSessionReadBestEffort(sessionId?: string) {
    markSessionRead(sessionId).catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
  }

  function markerForSession(sessionId: string) {
    return state.sessionMarkers.find((marker) => marker.sessionId === sessionId);
  }

  function colorForMarker(colorId?: string) {
    return sessionMarkerColors.find((color) => color.id === colorId);
  }

  function selectedMarkerColor() {
    return colorForMarker(state.selectedMarkerColor) || sessionMarkerColors[0];
  }

  function markerColorLabel(color: SessionMarkerColorId) {
    return colorForMarker(color)?.label || color;
  }

  function sortedAllowedMarkerColors() {
    return sessionMarkerColors
      .map((color) => color.id)
      .filter((color) => allowedMarkerColors.has(color));
  }

  function renderSessionColorFilterButton() {
    if (!sessionColorFilterButton) return;
    const colors = sortedAllowedMarkerColors();
    sessionColorFilterButton.textContent = "";
    const active = colors.length > 0 || unreadFilterActive;
    sessionColorFilterButton.classList.toggle("active", active);
    const parts = [
      colors.length === 0 ? "all colors allowed" : `colors: ${colors.map(markerColorLabel).join(", ")}`,
      unreadFilterActive ? "unread only" : "read and unread",
    ];
    sessionColorFilterButton.title = `Filter sessions: ${parts.join("; ")}`;
    sessionColorFilterButton.setAttribute("aria-label", sessionColorFilterButton.title);
    sessionColorFilterButton.setAttribute("aria-expanded", String(Boolean(closeSessionColorFilterMenu)));

    sessionColorFilterButton.append(iconElement("funnel"));
    if (unreadFilterActive) {
      const unreadDot = document.createElement("span");
      unreadDot.className = "sessionUnreadDot sessionFilterUnreadDot";
      unreadDot.title = "Unread only";
      unreadDot.setAttribute("aria-hidden", "true");
      sessionColorFilterButton.append(unreadDot);
    }
    if (colors.length === 0) return;

    const dots = document.createElement("span");
    dots.className = "sessionColorFilterDots";
    for (const color of colors) {
      const dot = document.createElement("span");
      dot.className = `sessionColorFilterDot marker-${color}`;
      dot.setAttribute("aria-hidden", "true");
      dots.append(dot);
    }
    sessionColorFilterButton.append(dots);
  }

  function setSelectedMarkerColor(color: SessionMarkerColorId) {
    const colorChanged = state.selectedMarkerColor !== color;
    const toolChanged = selectedSessionRowTool !== color;
    if (!colorChanged && !toolChanged) return;
    state.selectedMarkerColor = color;
    selectedSessionRowTool = color;
    renderMarkerPalette();
    if (!elements.sessionDrawer.hidden) renderSessionList(cachedSessions);
    if (colorChanged) persistSessionUiState({ selectedMarkerColor: color });
  }

  function setSelectedPinTool() {
    if (selectedSessionRowTool === "pin") return;
    selectedSessionRowTool = "pin";
    renderMarkerPalette();
    if (!elements.sessionDrawer.hidden) renderSessionList(cachedSessions);
  }

  function setSessionMarker(sessionId: string, color: SessionMarkerColorId) {
    const next = { sessionId, color, updatedAt: new Date().toISOString() };
    state.sessionMarkers = [next, ...state.sessionMarkers.filter((marker) => marker.sessionId !== sessionId)];
    renderSessionList(cachedSessions);
    renderSessionBar();
    renderCurrentSessionBucketButton();
    persistSessionUiState({ sessionMarkers: state.sessionMarkers });
  }

  function clearSessionMarker(sessionId: string) {
    const count = state.sessionMarkers.length;
    state.sessionMarkers = state.sessionMarkers.filter((marker) => marker.sessionId !== sessionId);
    if (state.sessionMarkers.length === count) return;
    renderSessionList(cachedSessions);
    renderSessionBar();
    renderCurrentSessionBucketButton();
    persistSessionUiState({ sessionMarkers: state.sessionMarkers });
  }

  function markerButtonTitle(markerColor: { id?: string; label: string } | undefined) {
    const selected = selectedMarkerColor();
    if (!markerColor) return `Mark session ${selected.label}. Current marker color: ${selected.label}.`;
    return markerColor.id === selected.id
      ? `Marked ${markerColor.label}. Click to clear.`
      : `Marked ${markerColor.label}. Click to change to ${selected.label}.`;
  }

  function sessionStatusButtonTitle(pinned: boolean, markerColor: { id?: string; label: string } | undefined) {
    if (selectedSessionRowTool !== "pin") return markerButtonTitle(markerColor);
    const markerText = markerColor ? ` ${markerColor.label} marker.` : "";
    return pinned
      ? `Pinned to tab bar.${markerText} Click to unpin.`
      : `Pin session to tab bar.${markerText}`;
  }

  function renderMarkerPalette() {
    if (!markerPaletteEl) return;
    markerPaletteEl.textContent = "";
    markerPaletteEl.setAttribute("aria-label", selectedSessionRowTool === "pin"
      ? "Session row action: pin or unpin tabs"
      : `Current marker color: ${selectedMarkerColor().label}`);

    const pinSelected = selectedSessionRowTool === "pin";
    const pinButton = document.createElement("button");
    pinButton.type = "button";
    pinButton.className = `sessionMarkerColorButton sessionMarkerPinTool${pinSelected ? " selected" : ""}`;
    pinButton.title = pinSelected ? "Row action: pin or unpin tabs" : "Use row button to pin or unpin tabs";
    pinButton.setAttribute("aria-label", pinButton.title);
    pinButton.setAttribute("aria-pressed", String(pinSelected));
    setIcon(pinButton, "pin");
    pinButton.addEventListener("click", setSelectedPinTool);
    markerPaletteEl.append(pinButton);

    for (const color of sessionMarkerColors) {
      const selected = color.id === selectedSessionRowTool;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `sessionMarkerColorButton marker-${color.id}${selected ? " selected" : ""}`;
      button.title = selected ? `Current marker color: ${color.label}` : `Use ${color.label} marker`;
      button.setAttribute("aria-label", button.title);
      button.setAttribute("aria-pressed", String(selected));
      const swatch = document.createElement("span");
      swatch.className = "sessionMarkerColorSwatch";
      swatch.setAttribute("aria-hidden", "true");
      button.append(swatch);
      if (selected) {
        const label = document.createElement("span");
        label.className = "sessionMarkerColorLabel";
        label.textContent = color.label;
        button.append(label);
      }
      button.addEventListener("click", () => setSelectedMarkerColor(color.id));
      markerPaletteEl.append(button);
    }
  }

  function closeOpenSessionColorFilterMenu() {
    closeSessionColorFilterMenu?.();
    closeSessionColorFilterMenu = undefined;
    renderSessionColorFilterButton();
  }

  function closeOpenCurrentSessionBucketMenu() {
    closeCurrentSessionBucketMenu?.();
    closeCurrentSessionBucketMenu = undefined;
    renderCurrentSessionBucketButton();
  }

  function renderCurrentSessionBucketButton() {
    const button = elements.currentSessionBucketButton;
    const marker = state.currentSessionId ? markerForSession(state.currentSessionId) : undefined;
    const color = colorForMarker(marker?.color);
    button.textContent = "";
    button.append(iconElement("flag"));
    for (const item of sessionMarkerColors) button.classList.remove(`marker-${item.id}`);
    button.classList.toggle("marked", Boolean(color));
    if (color) button.classList.add(`marker-${color.id}`);
    button.disabled = !state.currentSessionId;
    button.title = !state.currentSessionId
      ? "Open a session to set its bucket"
      : color
        ? `Current session bucket: ${color.label}. Click to change or unset.`
        : "Set current session bucket";
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-expanded", String(Boolean(closeCurrentSessionBucketMenu)));
  }

  function openCurrentSessionBucketMenu(anchor: HTMLButtonElement) {
    if (!state.currentSessionId) return;
    closeOpenSessionActionsMenu();
    closeOpenSessionColorFilterMenu();
    closeOpenCurrentSessionBucketMenu();

    const sessionId = state.currentSessionId;
    const marker = markerForSession(sessionId);
    const menu = document.createElement("div");
    menu.className = "sessionColorFilterMenu sessionBucketMenu";
    menu.setAttribute("role", "menu");

    const title = document.createElement("div");
    title.className = "sessionColorFilterTitle";
    title.textContent = "Session bucket";
    menu.append(title);

    const clearButton = document.createElement("button");
    clearButton.type = "button";
    clearButton.className = `sessionColorFilterMenuItem all${marker ? "" : " selected"}`;
    clearButton.setAttribute("role", "menuitemradio");
    clearButton.setAttribute("aria-checked", String(!marker));
    const clearLabel = document.createElement("span");
    clearLabel.textContent = "No bucket";
    clearButton.append(clearLabel);
    clearButton.addEventListener("click", () => {
      clearSessionMarker(sessionId);
      closeOpenCurrentSessionBucketMenu();
    });
    menu.append(clearButton);

    for (const color of sessionMarkerColors) {
      const selected = marker?.color === color.id;
      const item = document.createElement("button");
      item.type = "button";
      item.className = `sessionColorFilterMenuItem marker-${color.id}${selected ? " selected" : ""}`;
      item.setAttribute("role", "menuitemradio");
      item.setAttribute("aria-checked", String(selected));
      const swatch = document.createElement("span");
      swatch.className = "sessionColorFilterMenuSwatch";
      swatch.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.textContent = color.label;
      item.append(swatch, label);
      item.addEventListener("click", () => {
        setSessionMarker(sessionId, color.id);
        closeOpenCurrentSessionBucketMenu();
      });
      menu.append(item);
    }

    document.body.append(menu);
    positionSessionMenu(menu, anchor);

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (menu.contains(target) || anchor.contains(target))) return;
      closeOpenCurrentSessionBucketMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeOpenCurrentSessionBucketMenu();
    };
    const onResize = () => closeOpenCurrentSessionBucketMenu();
    const installPointerListener = window.setTimeout(() => document.addEventListener("pointerdown", onPointerDown), 0);
    closeCurrentSessionBucketMenu = () => {
      window.clearTimeout(installPointerListener);
      menu.remove();
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    renderCurrentSessionBucketButton();
  }

  function positionSessionMenu(menu: HTMLElement, anchor: HTMLElement) {
    const rect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(Math.max(margin, rect.right - menuRect.width), window.innerWidth - menuRect.width - margin);
    const below = rect.bottom + 4;
    const top = below + menuRect.height <= window.innerHeight - margin
      ? below
      : Math.max(margin, rect.top - menuRect.height - 4);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  function installSessionMenuCloseHandlers(menu: HTMLElement, anchor: HTMLElement) {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (menu.contains(target) || anchor.contains(target))) return;
      closeOpenSessionActionsMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeOpenSessionActionsMenu();
    };
    const onResize = () => closeOpenSessionActionsMenu();
    const installPointerListener = window.setTimeout(() => document.addEventListener("pointerdown", onPointerDown), 0);
    closeSessionActionsMenu = () => {
      window.clearTimeout(installPointerListener);
      menu.remove();
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
  }

  function openSessionColorFilterMenu(anchor: HTMLButtonElement) {
    closeOpenSessionActionsMenu();
    closeOpenSessionColorFilterMenu();

    const menu = document.createElement("div");
    menu.className = "sessionColorFilterMenu";
    menu.setAttribute("role", "menu");

    const title = document.createElement("div");
    title.className = "sessionColorFilterTitle";
    title.textContent = "Filter sessions";
    menu.append(title);

    const allButton = document.createElement("button");
    allButton.type = "button";
    allButton.className = "sessionColorFilterMenuItem all";
    allButton.setAttribute("role", "menuitemcheckbox");
    const allLabel = document.createElement("span");
    allLabel.textContent = "All colors";
    allButton.append(allLabel);
    menu.append(allButton);

    const unreadButton = document.createElement("button");
    unreadButton.type = "button";
    unreadButton.className = "sessionColorFilterMenuItem unread";
    unreadButton.setAttribute("role", "menuitemcheckbox");
    const unreadLabel = document.createElement("span");
    unreadLabel.textContent = "Unread only";
    unreadButton.append(unreadLabel);
    menu.append(unreadButton);

    const colorTitle = document.createElement("div");
    colorTitle.className = "sessionColorFilterTitle";
    colorTitle.textContent = "Marker colors";
    menu.append(colorTitle);

    const colorButtons: Array<{ color: SessionMarkerColorId; button: HTMLButtonElement }> = [];
    const updateMenuState = () => {
      const allSelected = allowedMarkerColors.size === 0;
      allButton.classList.toggle("selected", allSelected);
      allButton.setAttribute("aria-checked", String(allSelected));
      allButton.title = allSelected ? "All marker colors are allowed" : "Allow all marker colors";
      unreadButton.classList.toggle("selected", unreadFilterActive);
      unreadButton.setAttribute("aria-checked", String(unreadFilterActive));
      unreadButton.title = unreadFilterActive ? "Showing unread sessions only" : "Show unread sessions only";
      for (const item of colorButtons) {
        const selected = allowedMarkerColors.has(item.color);
        item.button.classList.toggle("selected", selected);
        item.button.setAttribute("aria-checked", String(selected));
        item.button.title = selected ? `${markerColorLabel(item.color)} allowed` : `Allow ${markerColorLabel(item.color)}`;
      }
    };

    allButton.addEventListener("click", () => {
      allowedMarkerColors.clear();
      renderSessionColorFilterButton();
      renderSessionList(cachedSessions);
      updateMenuState();
      persistAllowedMarkerColors();
    });

    unreadButton.addEventListener("click", () => {
      unreadFilterActive = !unreadFilterActive;
      renderSessionColorFilterButton();
      renderSessionList(cachedSessions);
      updateMenuState();
    });

    for (const color of sessionMarkerColors) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `sessionColorFilterMenuItem marker-${color.id}`;
      button.setAttribute("role", "menuitemcheckbox");
      const swatch = document.createElement("span");
      swatch.className = "sessionColorFilterMenuSwatch";
      swatch.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.textContent = color.label;
      button.append(swatch, label);
      button.addEventListener("click", () => {
        if (allowedMarkerColors.has(color.id)) allowedMarkerColors.delete(color.id);
        else allowedMarkerColors.add(color.id);
        renderSessionColorFilterButton();
        renderSessionList(cachedSessions);
        updateMenuState();
        persistAllowedMarkerColors();
      });
      colorButtons.push({ color: color.id, button });
      menu.append(button);
    }

    updateMenuState();
    document.body.append(menu);
    positionSessionMenu(menu, anchor);

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (menu.contains(target) || anchor.contains(target))) return;
      closeOpenSessionColorFilterMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeOpenSessionColorFilterMenu();
    };
    const onResize = () => closeOpenSessionColorFilterMenu();
    const installPointerListener = window.setTimeout(() => document.addEventListener("pointerdown", onPointerDown), 0);
    closeSessionColorFilterMenu = () => {
      window.clearTimeout(installPointerListener);
      menu.remove();
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    renderSessionColorFilterButton();
  }

  function isPinned(id: string) {
    return state.pinnedSessions.some((p) => p.id === id);
  }

  function pinSession(item: SessionInfo) {
    if (isPinned(item.id)) return;
    state.sessionsById[item.id] = { ...state.sessionsById[item.id], ...item };
    state.pinnedSessions = [...state.pinnedSessions, { id: item.id, cwd: item.cwd || state.currentCwd, runtimeId: item.runtimeRef?.id || "local" }];
    persistSessionUiState({ pinnedSessions: state.pinnedSessions });
    document.body.classList.toggle("hasPinnedSessions", state.pinnedSessions.length > 0 || Boolean(state.currentSessionId));
    renderSessionList(cachedSessions);
    renderSessionBar();
    updateCurrentSessionPinButton();
  }

  function unpinSession(sessionId: string) {
    const pinnedCount = state.pinnedSessions.length;
    state.pinnedSessions = state.pinnedSessions.filter((p) => p.id !== sessionId);
    if (state.pinnedSessions.length === pinnedCount) return;
    pinnedRuntimes.delete(sessionId);
    persistSessionUiState({ pinnedSessions: state.pinnedSessions });
    document.body.classList.toggle("hasPinnedSessions", state.pinnedSessions.length > 0 || Boolean(state.currentSessionId));
    renderSessionList(cachedSessions);
    renderSessionBar();
    updateCurrentSessionPinButton();
  }

  function togglePin(item: SessionInfo) {
    if (isPinned(item.id)) unpinSession(item.id);
    else pinSession(item);
  }

  function isFolderPinned(cwd: string) {
    return state.pinnedFolders.includes(cwd);
  }

  function pinFolder(cwd: string) {
    if (isFolderPinned(cwd)) return;
    state.pinnedFolders = [...state.pinnedFolders, cwd];
    persistSessionUiState({ pinnedFolders: state.pinnedFolders });
    renderSessionList(cachedSessions);
  }

  function unpinFolder(cwd: string) {
    const pinnedCount = state.pinnedFolders.length;
    state.pinnedFolders = state.pinnedFolders.filter((folder) => folder !== cwd);
    if (state.pinnedFolders.length === pinnedCount) return;
    persistSessionUiState({ pinnedFolders: state.pinnedFolders });
    renderSessionList(cachedSessions);
  }

  function toggleFolderPin(cwd: string) {
    if (isFolderPinned(cwd)) unpinFolder(cwd);
    else pinFolder(cwd);
  }

  function titleForSessionId(sessionId: string) {
    if (sessionId === state.currentSessionId) return state.currentSessionTitle || "New session";
    const session = state.sessionsById[sessionId];
    if (session) return sessionTitle(session as SessionInfo);
    return "Session";
  }

  function currentMetaSnapshot() {
    return {
      sessionId: state.currentSessionId,
      sessionTitle: state.currentSessionTitle || "New session",
      cwd: state.currentCwd,
      runtimeRef: state.currentRuntimeRef || localRuntimeRef(state.currentCwd),
      isStreaming: state.isStreaming,
      isCompacting: state.isCompacting,
      stats: state.stats || null,
    };
  }

  function applyOptimisticSessionSwitch(sessionId: string, sessionTitle: string, cwd: string, knownSession?: Partial<SessionInfo>) {
    transcriptLoading = true;
    updateEmptyCwdChooser();
    updateMeta({
      sessionId,
      sessionTitle,
      cwd,
      runtimeRef: optimisticRuntimeRef(knownSession, cwd),
      isStreaming: Boolean(knownSession?.runtime?.isStreaming),
      isCompacting: Boolean(knownSession?.runtime?.isCompacting),
      stats: null,
    });
    renderSessionBar();
    renderCurrentSessionBucketButton();
    clearMessages();
  }

  async function openSessionTab(sessionId: string, cwd: string) {
    const previousMeta = currentMetaSnapshot();
    const knownSession = state.sessionsById[sessionId];
    const runtimeId = knownSession?.runtimeRef?.id || (sessionId === state.currentSessionId ? state.currentRuntimeRef?.id : undefined);
    const switchingSessions = state.currentSessionId !== sessionId;
    if (switchingSessions) {
      const knownTitle = knownSession ? sessionTitle(knownSession as SessionInfo) : "";
      applyOptimisticSessionSwitch(sessionId, knownTitle || "Session", cwd, knownSession);
    }
    try {
      const openRes = await fetch("/api/sessions/open", {
        method: "POST",
        headers: api.headers(),
        body: JSON.stringify({ sessionId, runtimeId: runtimeId || null, cwd, clientId: api.clientId }),
      });
      if (!openRes.ok) throw await responseError(openRes);
      const opened = await openRes.json();
      const openedRuntimeId = opened.runtimeRef?.id || runtimeId || "local";
      updateMeta(opened);
      writeActiveSessionIdToUrl(sessionId, "push", openedRuntimeId);
      rememberRuntimeSession(openedRuntimeId, sessionId, cwd);
      rememberSessionCwd(cwd, openedRuntimeId);
      markCachedCurrentSession(sessionId, cwd);
      markSessionReadBestEffort(sessionId);
      await refreshState();
      if (switchingSessions) await refreshMessages();
      return true;
    } catch (error) {
      updateMeta(previousMeta);
      renderSessionBar();
      renderCurrentSessionBucketButton();
      addMessage("system", error instanceof Error ? error.message : String(error), "error");
      return false;
    }
  }

  function updateCurrentSessionPinButton() {
    if (!currentSessionPinButton) return;
    const currentId = state.currentSessionId;
    const pinned = Boolean(currentId && isPinned(currentId));
    currentSessionPinButton.hidden = !currentId;
    currentSessionPinButton.disabled = false;
    currentSessionPinButton.classList.toggle("pinned", pinned);
    currentSessionPinButton.title = pinned
      ? "Unpin current session from tab bar"
      : "Pin current session to tab bar";
    currentSessionPinButton.setAttribute("aria-label", currentSessionPinButton.title);
    currentSessionPinButton.setAttribute("aria-pressed", String(pinned));
  }

  function toggleCurrentSessionPin() {
    const currentId = state.currentSessionId;
    if (!currentId) return;
    const live = cachedSessions.find((session) => session.id === currentId);
    if (live) {
      togglePin(live);
      return;
    }
    if (isPinned(currentId)) unpinSession(currentId);
    else {
      state.pinnedSessions = [...state.pinnedSessions, { id: currentId, cwd: state.currentCwd, runtimeId: state.currentRuntimeRef?.id || effectiveRuntimeId() }];
      persistSessionUiState({ pinnedSessions: state.pinnedSessions });
      renderSessionBar();
      updateCurrentSessionPinButton();
    }
  }

  // ── Session bar ────────────────────────────────────────────────────────────

  function renderSessionBar() {
    const bar = elements.sessionBarEl;
    const activeRuntimeId = effectiveRuntimeId();
    const pinned = state.pinnedSessions.filter((entry) => (entry.runtimeId || "local") === activeRuntimeId);
    updateSessionButtonUnread();

    const currentMatchesWorkbench = (state.currentRuntimeRef?.id || "local") === activeRuntimeId;
    const currentId = currentMatchesWorkbench ? state.currentSessionId : "";
    const currentIsPinned = Boolean(currentId && pinned.some((entry) => entry.id === currentId));

    if (pinned.length === 0 && !currentId) {
      bar.hidden = true;
      document.body.classList.remove("hasPinnedSessions");
      updateCurrentSessionPinButton();
      return;
    }

    bar.hidden = false;
    document.body.classList.add("hasPinnedSessions");
    bar.textContent = "";

    updateCurrentSessionPinButton();

    let activeTab: HTMLElement | undefined;
    const appendTab = (sessionId: string, label: string, cwd: string, options: { pinned: boolean; running?: boolean; unread?: boolean }) => {
      const isActive = currentId === sessionId;
      const unread = isSessionUnread(sessionId, Boolean(options.unread), Boolean(options.running));
      const markerColor = colorForMarker(markerForSession(sessionId)?.color);
      const tab = document.createElement("div");
      tab.className = `sessionBarTab${isActive ? " active" : ""}${unread ? " unread" : ""}${options.running ? " running" : ""}${options.pinned ? " pinned" : " temporary"}${markerColor ? ` marked marker-${markerColor.id}` : ""}`;
      if (isActive) activeTab = tab;
      if (options.running) {
        for (let i = 1; i <= 12; i += 1) {
          const spark = document.createElement("span");
          spark.className = `sessionBarTabSpark s${i}`;
          spark.setAttribute("aria-hidden", "true");
          tab.append(spark);
        }
      }

      const open = document.createElement("button");
      open.type = "button";
      open.className = "sessionBarTabOpen";
      if (isActive) open.setAttribute("aria-current", "page");
      open.title = [label, markerColor ? `${markerColor.label} marker` : "", unread ? "Unread activity" : ""].filter(Boolean).join(" · ");

      const labelEl = document.createElement("span");
      labelEl.className = "sessionBarTabLabel";
      labelEl.textContent = label;
      open.append(labelEl);
      if (unread) {
        const unreadDot = document.createElement("span");
        unreadDot.className = "sessionUnreadDot sessionBarUnreadDot";
        unreadDot.title = "Unread activity";
        unreadDot.setAttribute("aria-hidden", "true");
        open.append(unreadDot);
      }
      open.addEventListener("click", () => void openSessionTab(sessionId, cwd));
      tab.append(open);

      if (options.pinned) {
        const close = document.createElement("button");
        close.type = "button";
        close.className = "sessionBarTabAction";
        close.title = "Unpin tab";
        close.setAttribute("aria-label", `Unpin ${label}`);
        setIcon(close, "x");
        close.addEventListener("click", () => unpinSession(sessionId));
        tab.append(close);
      } else {
        const pin = document.createElement("button");
        pin.type = "button";
        pin.className = "sessionBarTabAction";
        pin.title = "Pin tab";
        pin.setAttribute("aria-label", `Pin ${label}`);
        setIcon(pin, "pin");
        pin.addEventListener("click", toggleCurrentSessionPin);
        tab.append(pin);
      }

      bar.append(tab);
    };

    for (const pinnedEntry of pinned) {
      const live = cachedSessions.find((s) => s.id === pinnedEntry.id);
      if (!state.sessionsById[pinnedEntry.id]?.runtimeRef && pinnedEntry.runtimeId) {
        state.sessionsById[pinnedEntry.id] = {
          ...state.sessionsById[pinnedEntry.id],
          id: pinnedEntry.id,
          cwd: pinnedEntry.cwd,
          runtimeRef: { id: pinnedEntry.runtimeId, cwd: pinnedEntry.cwd },
        };
      }
      appendTab(
        pinnedEntry.id,
        titleForSessionId(pinnedEntry.id),
        live?.cwd || pinnedEntry.cwd || state.currentCwd,
        { pinned: true, running: (live?.runtime ?? pinnedRuntimes.get(pinnedEntry.id))?.isRunning ?? false, unread: live?.unread },
      );
    }

    if (currentId && !currentIsPinned) {
      const live = cachedSessions.find((s) => s.id === currentId);
      if (pinned.length > 0) {
        const separator = document.createElement("div");
        separator.className = "sessionBarSeparator";
        separator.setAttribute("aria-hidden", "true");
        bar.append(separator);
      }
      appendTab(currentId, live ? sessionTitle(live) : titleForSessionId(currentId), live?.cwd || state.currentCwd, {
        pinned: false,
        running: (live?.runtime ?? pinnedRuntimes.get(currentId))?.isRunning ?? state.isStreaming,
        unread: live?.unread,
      });
    }

    if (activeTab) {
      requestAnimationFrame(() => activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" }));
    }
  }

  // ── Session actions ───────────────────────────────────────────────────────

  function closeOpenSessionActionsMenu() {
    closeSessionActionsMenu?.();
    closeSessionActionsMenu = undefined;
  }

  async function deleteSession(item: SessionInfo, cwd: string) {
    if (item.isCurrent) throw new Error("Switch to another session before deleting the current session.");
    if (item.runtime?.isRunning) throw new Error("Wait for the session to finish before deleting it.");

    const title = sessionTitle(item);
    if (!window.confirm(`Delete session “${title}”?`)) return;

    const res = await fetch("/api/sessions/delete", {
      method: "POST",
      headers: api.headers(),
      body: JSON.stringify({ sessionId: item.id, runtimeId: item.runtimeRef?.id || "local", cwd: item.cwd || cwd, activeSessionId: state.currentSessionId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || await res.text());

    cachedSessions = cachedSessions.filter((session) => session.id !== item.id);
    pinnedRuntimes.delete(item.id);
    state.pinnedSessions = state.pinnedSessions.filter((session) => session.id !== item.id);
    state.sessionMarkers = state.sessionMarkers.filter((marker) => marker.sessionId !== item.id);
    renderSessionList(cachedSessions);
    renderSessionBar();
    addMessage("system", data.disposition === "trashed" ? "Session moved to trash." : "Session deleted.");
  }

  async function removeSessionFromList(item: SessionInfo) {
    if (item.isCurrent) throw new Error("Switch to another session before removing the current session.");
    const title = sessionTitle(item);
    if (!window.confirm(`Remove “${title}” from this list? The session data will remain in its runtime, and the row will return if that runtime reconnects and still reports the session.`)) return;
    const res = await fetch("/api/sessions/remove", {
      method: "POST",
      headers: api.headers(),
      body: JSON.stringify({ sessionId: item.id, runtimeId: item.runtimeRef?.id, activeSessionId: state.currentSessionId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || await res.text());
    cachedSessions = cachedSessions.filter((session) => session.id !== item.id);
    pinnedRuntimes.delete(item.id);
    state.pinnedSessions = state.pinnedSessions.filter((session) => session.id !== item.id);
    state.sessionMarkers = state.sessionMarkers.filter((marker) => marker.sessionId !== item.id);
    renderSessionList(cachedSessions);
    renderSessionBar();
    addMessage("system", "Session removed from the local list; runtime data was not deleted.");
  }

  function getSessionActions(item: SessionInfo, cwd: string): SessionAction[] {
    const deleteDisabledReason = item.isCurrent
      ? "Switch to another session before deleting the current session"
      : item.runtime?.isRunning
        ? "Wait for the session to finish before deleting it"
        : undefined;
    const pinned = isPinned(item.id);
    const runtimeUnavailable = item.runtimeRef?.id && item.runtimeRef.id !== "local" && item.runtime?.loaded === false;
    const actions: SessionAction[] = [
      {
        id: pinned ? "unpin" : "pin",
        label: pinned ? "Unpin from tab bar" : "Pin to tab bar",
        icon: "pin",
        run: () => togglePin(item),
      },
    ];
    if (runtimeUnavailable) {
      actions.push({
        id: "reconnect",
        label: "Reconnect runtime",
        icon: "rotate-ccw",
        run: () => elements.runtimeButton.click(),
      });
      actions.push({
        id: "remove",
        label: "Remove from list",
        icon: "trash-2",
        danger: true,
        disabled: item.isCurrent,
        disabledReason: item.isCurrent ? "Switch to another session before removing it" : undefined,
        run: () => removeSessionFromList(item),
      });
    } else {
      actions.push({
        id: "delete",
        label: "Delete session data",
        icon: "trash-2",
        danger: true,
        disabled: Boolean(deleteDisabledReason),
        disabledReason: deleteDisabledReason,
        run: () => deleteSession(item, cwd),
      });
    }
    return actions;
  }

  function buildSessionMarkerActionRow(item: SessionInfo) {
    const marker = markerForSession(item.id);
    const row = document.createElement("div");
    row.className = "sessionActionsMarkerRow";
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", "Session marker color");

    const label = document.createElement("span");
    label.className = "sessionActionsMarkerLabel";
    label.textContent = "Marker";
    row.append(label);

    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = `sessionActionsMarkerButton clear${marker ? "" : " selected"}`;
    clear.title = marker ? "Clear marker" : "No marker";
    clear.setAttribute("aria-label", clear.title);
    clear.setAttribute("aria-pressed", String(!marker));
    clear.textContent = "○";
    clear.addEventListener("click", () => {
      closeOpenSessionActionsMenu();
      clearSessionMarker(item.id);
    });
    row.append(clear);

    for (const color of sessionMarkerColors) {
      const selected = marker?.color === color.id;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `sessionActionsMarkerButton marker-${color.id}${selected ? " selected" : ""}`;
      button.title = selected ? `${color.label} marker selected` : `Mark ${color.label}`;
      button.setAttribute("aria-label", button.title);
      button.setAttribute("aria-pressed", String(selected));
      const swatch = document.createElement("span");
      swatch.className = "sessionActionsMarkerSwatch";
      swatch.setAttribute("aria-hidden", "true");
      button.append(swatch);
      button.addEventListener("click", () => {
        closeOpenSessionActionsMenu();
        setSessionMarker(item.id, color.id);
      });
      row.append(button);
    }

    return row;
  }

  function openSessionActionsMenu(anchor: HTMLButtonElement, item: SessionInfo, cwd: string) {
    closeOpenSessionActionsMenu();
    closeOpenSessionColorFilterMenu();

    const menu = document.createElement("div");
    menu.className = "sessionActionsMenu";
    menu.setAttribute("role", "menu");
    menu.append(buildSessionMarkerActionRow(item));

    for (const action of getSessionActions(item, cwd)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `sessionActionsMenuItem${action.danger ? " danger" : ""}`;
      button.setAttribute("role", "menuitem");
      button.disabled = Boolean(action.disabled);
      button.title = action.disabledReason || action.label;
      if (action.icon) setIcon(button, action.icon);
      const label = document.createElement("span");
      label.textContent = action.label;
      button.append(label);
      button.addEventListener("click", async () => {
        closeOpenSessionActionsMenu();
        try {
          await action.run();
        } catch (error) {
          addMessage("system", error instanceof Error ? error.message : String(error), "error");
          if (!elements.sessionDrawer.hidden) refreshSessions().catch(() => undefined);
        }
      });
      menu.append(button);
    }

    document.body.append(menu);
    positionSessionMenu(menu, anchor);
    installSessionMenuCloseHandlers(menu, anchor);
  }

  // ── Session list ───────────────────────────────────────────────────────────

  function renderSessionList(sessions: SessionInfo[]) {
    closeOpenSessionActionsMenu();
    elements.sessionListEl.textContent = "";

    if (sessions.length === 0) {
      const empty = document.createElement("p");
      empty.className = "sessionEmpty";
      empty.textContent = "No saved sessions yet.";
      elements.sessionListEl.append(empty);
      return;
    }

    const query = sessionSearchInput?.value.trim().toLowerCase() || "";
    const matchesFilter = (item: SessionInfo) => {
      const marker = markerForSession(item.id);
      if (allowedMarkerColors.size > 0 && !allowedMarkerColors.has(marker?.color as SessionMarkerColorId)) return false;
      if (unreadFilterActive && !isSessionUnread(item.id, Boolean(item.unread), Boolean(item.runtime?.isRunning))) return false;
      if (!query) return true;
      return [sessionTitle(item), item.cwd || "", item.runtimeRef?.label || "", item.firstMessage || ""]
        .some((value) => value.toLowerCase().includes(query));
    };
    const filterActive = Boolean(query || allowedMarkerColors.size > 0 || unreadFilterActive);
    renderSessionColorFilterButton();

    const groups = new Map<string, SessionInfo[]>();
    const groupMeta = new Map<string, { cwd: string; runtimeId: string; runtimeLabel: string }>();
    for (const item of sessions) {
      const cwd = item.cwd || state.currentCwd || "";
      const runtimeId = item.runtimeRef?.id || "local";
      const runtimeLabel = item.runtimeRef?.label || "Local machine";
      const key = `${runtimeId}\n${cwd}`;
      groupMeta.set(key, { cwd, runtimeId, runtimeLabel });
      groups.set(key, [...(groups.get(key) || []), item]);
    }

    const pinnedEntries: Array<[string, SessionInfo[]]> = Array.from(groups.entries())
      .filter(([key]) => isFolderPinned(groupMeta.get(key)?.cwd || ""))
      .sort(([left], [right]) => {
        const leftIndex = state.pinnedFolders.indexOf(groupMeta.get(left)?.cwd || "");
        const rightIndex = state.pinnedFolders.indexOf(groupMeta.get(right)?.cwd || "");
        return leftIndex - rightIndex;
      });
    const pinnedKeys = new Set(pinnedEntries.map(([key]) => key));
    const unpinnedEntries = Array.from(groups.entries()).filter(([key]) => !pinnedKeys.has(key));
    const orderedEntries = [...pinnedEntries, ...unpinnedEntries];
    const folderLabels = folderDisplayNames(orderedEntries.map(([key]) => groupMeta.get(key)?.cwd || key));
    let renderedItemCount = 0;

    for (const [groupKey, items] of orderedEntries) {
      const meta = groupMeta.get(groupKey) || { cwd: groupKey, runtimeId: "local", runtimeLabel: "Local machine" };
      const cwd = meta.cwd;
      const folderPinned = isFolderPinned(cwd);
      const folderCollapsed = state.collapsedSessionFolders.has(cwd);
      const group = document.createElement("section");
      group.className = `sessionFolderGroup${folderPinned ? " pinned" : ""}`;

      const header = document.createElement("div");
      header.className = "sessionFolderHeader";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "sessionFolderToggle";
      toggle.setAttribute("aria-expanded", String(!folderCollapsed || filterActive));
      toggle.title = folderCollapsed ? "Expand folder" : "Collapse folder";
      const chevron = document.createElement("span");
      chevron.className = "sessionFolderChevron";
      chevron.textContent = folderCollapsed && !filterActive ? "▸" : "▾";
      const labels = document.createElement("span");
      labels.className = "sessionFolderLabels";
      const name = document.createElement("span");
      name.className = "sessionFolderName";
      const folderLabel = folderLabels.get(cwd) || folderName(cwd);
      name.textContent = meta.runtimeId === "local" ? folderLabel : `${meta.runtimeLabel} · ${folderLabel}`;
      name.title = meta.runtimeId === "local" ? cwd : `${meta.runtimeLabel}\n${cwd}`;
      labels.append(name);
      toggle.append(chevron, labels);
      toggle.addEventListener("click", () => {
        if (state.collapsedSessionFolders.has(cwd)) state.collapsedSessionFolders.delete(cwd);
        else state.collapsedSessionFolders.add(cwd);
        persistCollapsedSessionFolders(state.collapsedSessionFolders);
        renderSessionList(cachedSessions);
      });

      const pinButton = document.createElement("button");
      pinButton.type = "button";
      pinButton.className = `iconButton sessionFolderPinButton${folderPinned ? " pinned" : ""}`;
      pinButton.title = folderPinned ? `Unpin ${folderName(cwd)} folder` : `Pin ${folderName(cwd)} folder`;
      pinButton.setAttribute("aria-label", pinButton.title);
      pinButton.setAttribute("aria-pressed", String(folderPinned));
      setIcon(pinButton, "pin");
      pinButton.addEventListener("click", () => toggleFolderPin(cwd));

      const newButton = document.createElement("button");
      newButton.type = "button";
      newButton.className = "iconButton sessionFolderNewButton";
      newButton.title = `New session in ${folderName(cwd)}`;
      newButton.setAttribute("aria-label", newButton.title);
      setIcon(newButton, "square-pen");
      newButton.addEventListener("click", async () => {
        try {
          await startNewSession(cwd, meta.runtimeId);
        } catch (error) {
          addMessage("system", error instanceof Error ? error.message : String(error), "error");
        }
      });
      header.append(toggle, pinButton, newButton);
      group.append(header);

      const filteredItems = items.filter(matchesFilter);
      if (folderCollapsed && !filterActive) {
        elements.sessionListEl.append(group);
        continue;
      }
      if (folderCollapsed && filterActive && filteredItems.length === 0) {
        elements.sessionListEl.append(group);
        continue;
      }

      const folderExpanded = state.expandedSessionFolders.has(cwd);
      const visibleItems = folderExpanded ? filteredItems : filteredItems.slice(0, sessionFolderPreviewLimit);

      if (filteredItems.length === 0 && filterActive) {
        const empty = document.createElement("p");
        empty.className = "sessionEmpty";
        empty.textContent = query
          ? "No matching sessions in this folder."
          : unreadFilterActive
            ? "No unread sessions in this folder."
            : "No sessions in the selected colors.";
        group.append(empty);
      }

      renderedItemCount += filteredItems.length;
      for (const item of visibleItems) {
        group.append(buildSessionItem(item, cwd));
      }

      if (filteredItems.length > sessionFolderPreviewLimit) {
        const moreButton = document.createElement("button");
        moreButton.type = "button";
        moreButton.className = "sessionFolderMoreButton";
        moreButton.textContent = folderExpanded
          ? "Show fewer"
          : `Show all ${filteredItems.length} sessions`;
        moreButton.addEventListener("click", () => {
          if (folderExpanded) state.expandedSessionFolders.delete(cwd);
          else state.expandedSessionFolders.add(cwd);
          renderSessionList(cachedSessions);
        });
        group.append(moreButton);
      }

      elements.sessionListEl.append(group);
    }

    if (filterActive && renderedItemCount === 0) {
      elements.sessionListEl.textContent = "";
      const empty = document.createElement("p");
      empty.className = "sessionEmpty";
      empty.textContent = query
        ? "No matching sessions."
        : unreadFilterActive
          ? "No unread sessions."
          : "No sessions in the selected colors.";
      elements.sessionListEl.append(empty);
    }
  }

  function buildSessionItem(item: SessionInfo, cwd: string): HTMLElement {
    // Use a div so we can have sibling buttons (navigate + actions) without nesting buttons
    const marker = markerForSession(item.id);
    const markerColor = colorForMarker(marker?.color);
    const pinned = isPinned(item.id);
    const unread = isSessionUnread(item.id, Boolean(item.unread), Boolean(item.runtime?.isRunning));
    const pinToolSelected = selectedSessionRowTool === "pin";
    const row = document.createElement("div");
    row.className = `sessionItem${item.isCurrent ? " current" : ""}${unread ? " unread" : ""}${pinned ? " pinned" : ""}${markerColor ? ` marked marker-${markerColor.id}` : ""}`;
    if (item.isCurrent) row.setAttribute("aria-current", "page");

    const markerButton = document.createElement("button");
    markerButton.type = "button";
    markerButton.className = `sessionItemMarkerBtn ${pinToolSelected ? "toolPin" : "toolMarker"}${pinned ? " pinned" : ""}`;
    markerButton.title = sessionStatusButtonTitle(pinned, markerColor);
    markerButton.setAttribute("aria-label", markerButton.title);
    markerButton.setAttribute("aria-pressed", String(pinToolSelected ? pinned : Boolean(markerColor)));
    markerButton.append(iconElement(pinToolSelected ? "pin" : "flag"));
    if (pinToolSelected && markerColor) {
      const markerDot = document.createElement("span");
      markerDot.className = "sessionItemMarkerDot";
      markerDot.title = `${markerColor.label} marker`;
      markerDot.setAttribute("aria-hidden", "true");
      markerButton.append(markerDot);
    }
    if (!pinToolSelected && pinned) {
      const pinBadge = document.createElement("span");
      pinBadge.className = "sessionItemPinBadge";
      pinBadge.title = "Pinned to tab bar";
      pinBadge.setAttribute("aria-hidden", "true");
      pinBadge.append(iconElement("pin"));
      markerButton.append(pinBadge);
    }
    markerButton.addEventListener("click", () => {
      if (pinToolSelected) togglePin(item);
      else if (markerColor?.id === state.selectedMarkerColor) clearSessionMarker(item.id);
      else setSessionMarker(item.id, state.selectedMarkerColor);
    });

    // ── Navigate button ────────────────────────────────────────────────────
    const navBtn = document.createElement("button");
    navBtn.type = "button";
    navBtn.className = "sessionItemNavBtn";
    if (unread) navBtn.title = "Unread activity";

    const titleRow = document.createElement("span");
    titleRow.className = "sessionItemTitleRow";
    const title = document.createElement("span");
    title.className = "sessionItemTitle";
    title.textContent = sessionTitle(item);
    titleRow.append(title);

    if (unread) {
      const unreadDot = document.createElement("span");
      unreadDot.className = "sessionUnreadDot sessionItemUnreadDot";
      unreadDot.title = "Unread activity";
      unreadDot.setAttribute("aria-hidden", "true");
      titleRow.append(unreadDot);
    }

    if (item.runtime?.isRunning) {
      const spinner = document.createElement("span");
      spinner.className = "sessionSpinner";
      spinner.title = item.runtime.isCompacting ? "Compacting" : "Running";
      spinner.setAttribute("aria-label", spinner.title);
      spinner.style.animationDelay = `-${Date.now() % 800}ms`;
      titleRow.append(spinner);
    }

    const meta = document.createElement("span");
    meta.className = "sessionItemMeta";
    const runtimeUnavailable = item.runtimeRef?.id && item.runtimeRef.id !== "local" && item.runtime?.loaded === false;
    meta.textContent = `${runtimeUnavailable ? "runtime unavailable · " : ""}${formatRelativeTime(item.modified)} · ${item.messageCount}`;

    navBtn.append(titleRow, meta);
    navBtn.addEventListener("click", async () => {
      const previousMeta = currentMetaSnapshot();
      const nextCwd = item.cwd || cwd;
      const switchingSessions = state.currentSessionId !== item.id;
      if (switchingSessions) {
        applyOptimisticSessionSwitch(item.id, sessionTitle(item), nextCwd, item);
        if (shouldCloseDrawerAfterSessionSwitch()) setSessionDrawerOpen(false);
      }
      try {
        const openRes = await fetch("/api/sessions/open", {
          method: "POST",
          headers: api.headers(),
          body: JSON.stringify({ sessionId: item.id, runtimeId: item.runtimeRef?.id || "local", cwd: nextCwd, clientId: api.clientId }),
        });
        if (!openRes.ok) throw await responseError(openRes);
        writeActiveSessionIdToUrl(item.id, "push", item.runtimeRef?.id || "local");
        rememberSessionCwd(nextCwd, item.runtimeRef?.id || "local");
        markCachedCurrentSession(item.id, nextCwd);
        markSessionReadBestEffort(item.id);
        if (shouldCloseDrawerAfterSessionSwitch()) setSessionDrawerOpen(false);
        await refreshState();
        if (switchingSessions) await refreshMessages();
      } catch (error) {
        if (switchingSessions) {
          updateMeta(previousMeta);
          renderSessionBar();
          renderCurrentSessionBucketButton();
        }
        addMessage("system", error instanceof Error ? error.message : String(error), "error");
        if (!elements.sessionDrawer.hidden) refreshSessions().catch(() => undefined);
      }
    });

    const actionsBtn = document.createElement("button");
    actionsBtn.type = "button";
    actionsBtn.className = "sessionItemActionsBtn";
    actionsBtn.title = "Session actions";
    actionsBtn.setAttribute("aria-label", actionsBtn.title);
    actionsBtn.setAttribute("aria-haspopup", "menu");
    setIcon(actionsBtn, "more-vertical");
    actionsBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      openSessionActionsMenu(actionsBtn, item, cwd);
    });

    row.append(markerButton, navBtn, actionsBtn);
    return row;
  }

  function init() {
    renderActiveRuntime();
    const refreshRuntimeContext = () => listRuntimes(api).then((runtimes) => {
      const active = runtimes.find((runtime) => runtime.id === effectiveRuntimeId());
      if (active) setActiveRuntime(active);
      else if (effectiveRuntimeId() !== "local") {
        const local = runtimes.find((runtime) => runtime.id === "local") || localRuntimeRef(state.currentCwd);
        void switchWorkbenchRuntime(local, false).catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
      }
      elements.workbenchRuntimeButton.hidden = false;
    }).catch(() => {
      elements.workbenchRuntimeButton.hidden = false;
    });
    void refreshRuntimeContext();
    window.addEventListener("pi-web:runtimes-changed", (event) => {
      const detail = (event as CustomEvent<{ runtime?: RuntimeOption; select?: boolean }>).detail;
      if (detail?.select && detail.runtime) {
        void switchWorkbenchRuntime(detail.runtime).catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
      }
      void refreshRuntimeContext();
    });
    new MutationObserver(updateEmptyCwdChooser).observe(elements.messagesEl, { childList: true });
    elements.workbenchRuntimeButton.addEventListener("click", () => openRuntimePicker().catch((error) => window.alert(error instanceof Error ? error.message : String(error))));
    elements.emptyCwdButton.addEventListener("click", () => openFolderPicker(effectiveRuntimeId() !== "local" && effectiveRuntimeCwd() ? effectiveRuntimeCwd()! : state.currentCwd).catch((error) => window.alert(error instanceof Error ? error.message : String(error))));
    const headerTitle = elements.sessionDrawer.querySelector(".sessionDrawerHeader h2");
    if (headerTitle) {
      const filterWrap = document.createElement("div");
      filterWrap.className = "sessionDrawerFilters";
      sessionSearchInput = document.createElement("input");
      sessionSearchInput.type = "search";
      sessionSearchInput.className = "sessionDrawerSearch";
      sessionSearchInput.placeholder = "Search sessions…";
      sessionSearchInput.setAttribute("aria-label", "Search sessions");
      sessionSearchInput.addEventListener("input", () => renderSessionList(cachedSessions));
      sessionColorFilterButton = document.createElement("button");
      sessionColorFilterButton.type = "button";
      sessionColorFilterButton.className = "sessionColorFilterButton";
      sessionColorFilterButton.setAttribute("aria-haspopup", "menu");
      sessionColorFilterButton.addEventListener("click", () => openSessionColorFilterMenu(sessionColorFilterButton!));
      renderSessionColorFilterButton();
      markerPaletteEl = document.createElement("div");
      markerPaletteEl.className = "sessionMarkerPalette";
      markerPaletteEl.setAttribute("role", "toolbar");
      renderMarkerPalette();
      filterWrap.append(sessionSearchInput, sessionColorFilterButton, markerPaletteEl);
      headerTitle.replaceWith(filterWrap);
    }

    const footer = document.createElement("div");
    footer.className = "sessionDrawerFooter";
    elements.settingsButton.classList.add("sessionDrawerFooterButton", "sessionDrawerSettingsButton");
    elements.settingsButton.textContent = "";
    setIcon(elements.settingsButton, "settings");
    elements.settingsButton.setAttribute("aria-label", "Settings");
    elements.settingsButton.title = "Settings";
    elements.runtimeButton.hidden = true;
    elements.workbenchRuntimeButton.hidden = false;
    elements.workbenchRuntimeButton.classList.add("sessionDrawerRuntimeButton");
    elements.sessionNewButton.textContent = "+ New session";
    elements.sessionDrawer.querySelector(".sessionDrawerHeader")?.after(elements.sessionNewButton);
    footer.append(elements.settingsButton, elements.workbenchRuntimeButton);
    elements.sessionDrawer.append(footer);

    sessionPanelHandle = rightPanels?.register({
      id: "sessions",
      side: "left",
      panel: elements.sessionDrawer,
      trigger: elements.sessionButton,
      backdrop: elements.sessionBackdrop,
      closeButton: elements.sessionCloseButton,
      width: "360px",
      minWidth: 280,
      maxWidth: 560,
      onOpen: () => { applySessionDrawerOpen(true); },
      onClose: () => { applySessionDrawerOpen(false); },
      focusOnClose: elements.sessionButton,
    });
    if (!sessionPanelHandle) elements.sessionButton.addEventListener("click", () => setSessionDrawerOpen(true));
    elements.currentSessionBucketButton.addEventListener("click", () => openCurrentSessionBucketMenu(elements.currentSessionBucketButton));
    renderCurrentSessionBucketButton();
    elements.newSessionHeaderButton.addEventListener("click", async () => {
      try {
        await startNewSession();
      } catch (error) {
        addMessage("system", error instanceof Error ? error.message : String(error), "error");
      }
    });
    if (!sessionPanelHandle) {
      elements.sessionCloseButton.addEventListener("click", () => setSessionDrawerOpen(false));
      elements.sessionBackdrop.addEventListener("click", () => setSessionDrawerOpen(false));
    }
    elements.sessionNewButton.addEventListener("click", async () => {
      try {
        await startNewSession();
      } catch (error) {
        addMessage("system", error instanceof Error ? error.message : String(error), "error");
      }
    });

    // Render immediately from any legacy local pins, then replace with server state.
    renderSessionBar();
    renderCurrentSessionBucketButton();
    refreshSessionUiState().catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
    // Restore the drawer state after wiring handlers and footer content.
    if (readPersistedSessionDrawerOpen()) {
      setSessionDrawerOpen(true);
    }

    // Background-fetch session list so tab click handlers are always wired up,
    // even if the drawer has never been opened.
    if (state.pinnedSessions.length > 0 && !readPersistedSessionDrawerOpen()) {
      refreshSessions().catch(() => undefined);
    }
  }

  return {
    init,
    refreshSessions,
    setSessionDrawerOpen,
    startNewSession,
    updateEmptyCwdChooser,
    finishTranscriptLoading,
    updateSessionRuntime,
    renderSessionBar,
    renderCurrentSessionBucketButton,
    applySessionUiState,
    markSessionRead,
  };
}
