import type { ApiClient } from "../app/api.js";
import type { AppElements } from "../app/elements.js";
import { iconElement, setIcon, type IconName } from "../app/icons.js";
import { blurActiveEditableOnMobile } from "../app/focus.js";
import type { RightPanelHandle, RightPanelManager } from "../layout/rightPanel.js";
import type { AppState, SessionInfo, SessionLaneEntry, SessionLaneId, SessionMarkerColorId, SessionUiState } from "../app/types.js";
import { sessionRuntime, type SessionStateController } from "../app/sessionState.js";
import { defaultSessionUiState, normalizeSessionUiState, persistCollapsedSessionFolders, sessionFolderPreviewLimit, sessionMarkerColors, writeActiveSessionIdToUrl } from "../app/types.js";
import { orderItemsWithChildren as orderLineage, runningChildIdsOf, sessionIndicatorKind, waitingInfoFrom, type WaitingInfo } from "./lineage.js";

export async function fetchSessionList(url: string, headers: HeadersInit, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { headers, signal: controller.signal }); }
  finally { window.clearTimeout(timeout); }
}

export type SessionsController = {
  init: () => void;
  refreshSessions: () => Promise<void>;
  setSessionDrawerOpen: (open: boolean) => void;
  startNewSession: (cwd?: string) => Promise<void>;
  toggleCurrentSessionPin: () => void;
  openAdjacentPinnedSession: (direction: -1 | 1) => Promise<void>;
  updateSessionRuntime: (sessionId: string, runtime: SessionInfo["runtime"]) => void;
  updateSessionName: (sessionId: string, name: string) => void;
  removeSession: (sessionId: string) => void;
  beginTranscriptLoading: () => void;
  updateEmptyCwdChooser: () => void;
  finishTranscriptLoading: () => void;
  renderSessionBar: () => void;
  renderCurrentSessionBucketButton: () => void;
  applySessionUiState: (value: unknown) => void;
  markSessionRead: (sessionId?: string) => Promise<void>;
  waitingInfoFor: (sessionId: string) => WaitingInfo | undefined;
  openSessionTab: (sessionId: string, cwd: string) => Promise<void>;
  openSessionById: (sessionId: string) => Promise<void>;
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

function readKnownSessionCwds() {
  try {
    const raw = JSON.parse(localStorage.getItem(knownSessionCwdsStorageKey) || "[]");
    return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string" && value.trim().length > 0) : [];
  } catch {
    return [];
  }
}

function rememberSessionCwd(cwd?: string) {
  const value = cwd?.trim();
  if (!value) return;
  const cwds = new Set(readKnownSessionCwds());
  cwds.add(value);
  localStorage.setItem(knownSessionCwdsStorageKey, JSON.stringify(Array.from(cwds)));
}

export function createSessions(options: {
  state: AppState;
  elements: AppElements;
  api: ApiClient;
  rightPanels?: RightPanelManager;
  sessionState: SessionStateController;
  updateThinkingOptions: (levels?: string[]) => void;
  refreshModels: () => Promise<void>;
  refreshMessages: () => Promise<void>;
  refreshState: () => Promise<void>;
  refreshSessionTitle: () => Promise<void>;
  clearMessages: () => void;
  addMessage: (role: "system", text: string, extraClass?: string) => void;
  /** Called whenever derived per-session state (e.g. waiting-on-spawned) may have changed. */
  onDerivedSessionStateChanged?: () => void;
}): SessionsController {
  const {
    state,
    elements,
    api,
    rightPanels,
    sessionState,
    updateThinkingOptions,
    refreshModels,
    refreshMessages,
    refreshState,
    refreshSessionTitle,
    clearMessages,
    addMessage,
  } = options;

  let cachedSessions: SessionInfo[] = [];
  const knownSessionNames = new Map<string, string>();
  let sessionRefreshPromise: Promise<void> | undefined;
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
  let transcriptLoadGeneration = 0;
  let lastReplayedGeneration = -1;
  let sessionBarGestureInFlight = false;
  let sessionBarRenderQueued = false;
  let suppressTabClickUntil = 0;
  type SessionRowTool = "pin" | SessionMarkerColorId;
  let selectedSessionRowTool: SessionRowTool = state.selectedMarkerColor;
  let laneFilter: SessionLaneId | "all" = "all";
  let focusedLane: SessionLaneId = "pinned";
  let laneMapOpen = false;
  const laneMeta: Record<SessionLaneId, { label: string; path: string }> = {
    pinned: { label: "Pinned", path: "M8 1a5 5 0 0 0-5 5c0 3.6 5 9 5 9s5-5.4 5-9a5 5 0 0 0-5-5zm0 6.8A1.8 1.8 0 1 1 8 4.2a1.8 1.8 0 0 1 0 3.6z" },
    parked: { label: "Parked", path: "M5 3h2.2v10H5zM8.8 3H11v10H8.8z" },
    bookmarks: { label: "Bookmarks", path: "M4 2h8v12l-4-3-4 3z" },
  };
  function laneIcon(lane: SessionLaneId) { const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("viewBox", "0 0 16 16"); svg.setAttribute("aria-hidden", "true"); const path = document.createElementNS(svg.namespaceURI, "path"); path.setAttribute("d", laneMeta[lane].path); path.setAttribute("fill", "currentColor"); svg.append(path); return svg; }
  function laneOf(sessionId: string) { return state.lanes.find((entry) => entry.sessionId === sessionId)?.lane; }
  function sessionsInLane(lane: SessionLaneId) { return state.lanes.filter((entry) => entry.lane === lane); }
  function syncPinnedProjection() { state.pinnedSessions = sessionsInLane("pinned").map((entry) => ({ id: entry.sessionId, ...(entry.cwd ? { cwd: entry.cwd } : {}) })); }
  function commitLanes() { syncPinnedProjection(); persistSessionUiState({ lanes: state.lanes }); renderSessionList(cachedSessions); renderSessionBar(); }
  function moveToLane(sessionId: string, lane: SessionLaneId, opts: { note?: string; cwd?: string } = {}) {
    const previous = state.lanes.find((entry) => entry.sessionId === sessionId);
    const note = lane === "parked" && previous?.lane !== "parked" && opts.note === undefined
      ? window.prompt("Add a session note", previous?.note || "") ?? undefined
      : opts.note ?? previous?.note;
    if (lane === "parked" && note === undefined && previous?.lane !== "parked") return;
    const entry: SessionLaneEntry = { sessionId, lane, ...(opts.cwd || previous?.cwd ? { cwd: opts.cwd || previous?.cwd } : {}), ...(note?.trim() ? { note: note.trim() } : {}), since: previous?.lane === lane ? previous.since : new Date().toISOString() };
    state.lanes = [...state.lanes.filter((item) => item.sessionId !== sessionId), entry]; commitLanes();
  }
  function setLaneNote(sessionId: string) {
    const entry = state.lanes.find((item) => item.sessionId === sessionId);
    if (!entry) return;
    const note = window.prompt("Session note", entry.note || "");
    if (note === null) return;
    state.lanes = state.lanes.map((item) => item.sessionId === sessionId
      ? { ...item, ...(note.trim() ? { note: note.trim() } : {}), ...(!note.trim() ? { note: undefined } : {}) }
      : item);
    commitLanes();
  }
  function removeFromLanes(sessionId: string) { const next = state.lanes.filter((entry) => entry.sessionId !== sessionId); if (next.length === state.lanes.length) return; state.lanes = next; commitLanes(); }
  function isStale(entry: SessionLaneEntry) { return entry.lane === "parked" && Date.now() - new Date(entry.since).getTime() > 14 * 864e5; }

  type SessionAction = {
    id: string;
    label: string;
    icon?: IconName;
    danger?: boolean;
    disabled?: boolean;
    disabledReason?: string;
    run: () => Promise<void> | void;
  };

  function beginTranscriptLoading() {
    transcriptLoading = true;
    transcriptLoadGeneration += 1;
    updateEmptyCwdChooser();
  }

  function updateEmptyCwdChooser() {
    elements.emptyCwdPathEl.textContent = state.currentCwd;
    elements.emptyCwdChooserEl.hidden = transcriptLoading || elements.messagesEl.children.length > 0 || sessionRuntime(state).isStreaming;
  }

  function finishTranscriptLoading() {
    if (!transcriptLoading) {
      updateEmptyCwdChooser();
      return;
    }
    if (elements.messagesEl.children.length === 0 && !sessionRuntime(state).isStreaming) {
      const generation = transcriptLoadGeneration;
      if (lastReplayedGeneration !== generation) {
        lastReplayedGeneration = generation;
        void restartNewChatAnimation(generation);
      }
      return;
    }
    transcriptLoading = false;
    updateEmptyCwdChooser();
  }

  async function restartNewChatAnimation(generation: number) {
    const video = elements.emptyCwdChooserEl.querySelector<HTMLVideoElement>(".newChatLoadingAnimation");
    if (!video) {
      if (generation !== transcriptLoadGeneration) return;
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
    if (generation !== transcriptLoadGeneration) return;

    transcriptLoading = false;
    updateEmptyCwdChooser();
    // Visibility must not depend on codec support: nested source failures can
    // leave play() pending forever in Chromium builds without H.264.
    video.classList.remove("resetting");
    void video.play().catch(() => undefined);
  }

  async function selectSessionCwd(cwd: string) {
    const res = await fetch("/api/session/cwd", {
      method: "POST",
      headers: api.headers(),
      body: JSON.stringify({ cwd, sessionId: state.currentSessionId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || await res.text());
    rememberSessionCwd(cwd);
    if (data.sessionId) writeActiveSessionIdToUrl(data.sessionId);
    sessionState.applySnapshot(data, { activate: true });
    if (data.thinkingLevels) updateThinkingOptions(data.thinkingLevels);
    await refreshModels();
    await refreshMessages();
    refreshSessionTitle();
  }

  async function openFolderPicker(startPath: string) {
    blurActiveEditableOnMobile();
    const backdrop = document.createElement("div");
    backdrop.className = "folderPickerBackdrop";
    const modal = document.createElement("div");
    modal.className = "folderPicker";
    const title = document.createElement("h2");
    title.textContent = "Select working directory";
    const input = document.createElement("input");
    input.className = "folderPickerInput";
    input.value = startPath;
    const list = document.createElement("div");
    list.className = "folderPickerList";
    const error = document.createElement("div");
    error.className = "folderPickerError";
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
    modal.append(title, input, list, error, actions);
    backdrop.append(modal);
    document.body.append(backdrop);

    async function load(path: string) {
      error.textContent = "";
      list.textContent = "Loading…";
      const res = await fetch(`/api/fs/dirs?path=${encodeURIComponent(path)}`, { headers: api.headers() });
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

    create.addEventListener("click", async () => {
      const name = window.prompt("New folder name");
      if (name === null) return;
      try {
        create.disabled = true;
        error.textContent = "";
        const res = await fetch("/api/fs/dirs", {
          method: "POST",
          headers: api.headers(),
          body: JSON.stringify({ parent: input.value, name }),
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
    load(startPath).catch((e) => { error.textContent = e.message; list.textContent = ""; });
    if (!("ontouchstart" in window) && navigator.maxTouchPoints === 0) {
      input.focus();
    }
  }

  async function startNewSession(cwd?: string) {
    const wasDrawerOpen = !elements.sessionDrawer.hidden;
    const res = await fetch("/api/sessions/new", {
      method: "POST",
      headers: api.headers(),
      body: JSON.stringify({ ...(cwd ? { cwd } : {}), sessionId: state.currentSessionId }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    if (data.sessionId) writeActiveSessionIdToUrl(data.sessionId);
    rememberSessionCwd(cwd || data.cwd || state.currentCwd);
    beginTranscriptLoading();
    clearMessages();
    sessionState.applySnapshot(data, { activate: true });
    await refreshState();
    updateEmptyCwdChooser();
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

  function refreshSessions() {
    if (sessionRefreshPromise) return sessionRefreshPromise;
    sessionRefreshPromise = (async () => {
      rememberSessionCwd(state.currentCwd);
      const params = new URLSearchParams();
      for (const cwd of readKnownSessionCwds()) params.append("cwd", cwd);
      const url = params.toString() ? `/api/sessions?${params}` : "/api/sessions";
      const res = await fetchSessionList(url, api.headers());
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      cachedSessions = (data.sessions || []).map((item: SessionInfo) => ({ ...item, isCurrent: item.id === state.currentSessionId }));
      for (const session of cachedSessions) sessionState.mergeSessionInfo(session);
      let pinnedCwdsChanged = false;
      state.pinnedSessions = state.pinnedSessions.map((pinned) => {
        const live = cachedSessions.find((s) => s.id === pinned.id);
        if (live?.cwd && live.cwd !== pinned.cwd) {
          pinnedCwdsChanged = true;
          return { ...pinned, cwd: live.cwd };
        }
        return pinned;
      });
      if (pinnedCwdsChanged) persistSessionUiState({ lanes: [...state.pinnedSessions.map((item) => ({ sessionId: item.id, lane: "pinned" as const, ...(item.cwd ? { cwd: item.cwd } : {}), since: state.lanes.find((entry) => entry.sessionId === item.id)?.since || new Date().toISOString() })), ...state.lanes.filter((entry) => entry.lane !== "pinned")] });
      renderSessionList(cachedSessions);
      renderSessionBar();
      updateSessionButtonUnread();
      options.onDerivedSessionStateChanged?.();
    })().finally(() => { sessionRefreshPromise = undefined; });
    return sessionRefreshPromise;
  }

  async function applyOpenedSession(openRes: Response) {
    const data = await openRes.json();
    const responseSessionId = typeof data.sessionId === "string" ? data.sessionId : "";
    sessionState.applySnapshot(data, { activate: Boolean(responseSessionId && responseSessionId === state.currentSessionId) });
    if (responseSessionId && responseSessionId !== state.currentSessionId) return false;
    if (data.thinkingLevels) updateThinkingOptions(data.thinkingLevels);
    await Promise.all([refreshModels(), refreshMessages()]);
    return !responseSessionId || responseSessionId === state.currentSessionId;
  }

  function markCachedCurrentSession(sessionId: string, cwd: string) {
    cachedSessions = cachedSessions.map((session) => ({
      ...session,
      isCurrent: session.id === sessionId && (session.cwd || cwd) === cwd,
    }));
    renderSessionList(cachedSessions);
    renderSessionBar();
  }

  function updateSessionName(sessionId: string, name: string) {
    if (!sessionId) return;
    // Remember the name even when the session is not in the cached list yet: a
    // just-spawned session is named before it appears in a list refresh, and
    // without this its links would fall back to showing a raw id fragment.
    if (name) knownSessionNames.set(sessionId, name);
    let changed = false;
    cachedSessions = cachedSessions.map((session) => {
      if (session.id !== sessionId) return session;
      changed = true;
      return { ...session, name: name || undefined };
    });
    sessionState.applySnapshot({ sessionId, sessionName: name });
    if (changed && !elements.sessionDrawer.hidden) renderSessionList(cachedSessions);
    else if (!changed) void refreshSessionsSoon(); // bring the new session into the list
    renderSessionBar();
    options.onDerivedSessionStateChanged?.();
  }

  /** Coalesce list refreshes triggered by newly discovered sessions. */
  let refreshSoonTimer: number | undefined;
  function refreshSessionsSoon() {
    if (refreshSoonTimer !== undefined) return;
    refreshSoonTimer = window.setTimeout(() => {
      refreshSoonTimer = undefined;
      void refreshSessions();
    }, 400);
  }

  function removeSession(sessionId: string) {
    if (!sessionId) return;
    cachedSessions = cachedSessions.filter((session) => session.id !== sessionId);
    sessionState.remove(sessionId);
    if (!elements.sessionDrawer.hidden) renderSessionList(cachedSessions);
    renderSessionBar();
    updateSessionButtonUnread();
  }

  function updateSessionRuntime(sessionId: string, runtime: SessionInfo["runtime"]) {
    if (!sessionId || !runtime) return;
    cachedSessions = cachedSessions.map((session) => session.id === sessionId ? { ...session, runtime } : session);
    if (!elements.sessionDrawer.hidden) renderSessionList(cachedSessions);
    renderSessionBar();
  }

  // ── Markers and pinning ────────────────────────────────────────────────────

  function applySessionUiState(value: unknown) {
    const next = normalizeSessionUiState(value);
    state.lanes = next.lanes;
    state.pinnedSessions = next.lanes.filter((entry) => entry.lane === "pinned").map((entry) => ({ id: entry.sessionId, ...(entry.cwd ? { cwd: entry.cwd } : {}) }));
    state.pinnedFolders = next.pinnedFolders;
    state.sessionMarkers = next.sessionMarkers;
    state.sessionUnreadStates = next.sessionUnreadStates;
    state.sessionOrigins = next.sessionOrigins;
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
    return value.lanes.length > 0
      || value.pinnedFolders.length > 0
      || value.sessionMarkers.length > 0
      || value.sessionUnreadStates.length > 0
      // Lineage counts as state: without it, a server holding ONLY origins looks
      // "empty" and a legacy-localStorage push would wipe every recorded origin.
      || (value.sessionOrigins?.length ?? 0) > 0
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
      lanes: state.lanes,
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

  function runtimeForSession(sessionId: string) {
    return state.sessionsById[sessionId]?.runtime ?? cachedSessions.find((session) => session.id === sessionId)?.runtime;
  }

  function isSessionRunning(sessionId: string, fallbackRunning = false) {
    return Boolean(fallbackRunning || runtimeForSession(sessionId)?.isRunning);
  }

  // ── Session origin (creation provenance) helpers ────────────────────────

  function originParentOf(sessionId: string) {
    return (state.sessionOrigins || []).find((item) => item.sessionId === sessionId)?.originSessionId;
  }

  function childSessionIdsOf(sessionId: string) {
    return (state.sessionOrigins || []).filter((item) => item.originSessionId === sessionId).map((item) => item.sessionId);
  }

  function runningChildrenOf(sessionId: string) {
    return runningChildIdsOf(sessionId, state.sessionOrigins || [], (childId) => {
      const cached = cachedSessions.find((item) => item.id === childId);
      return isSessionRunning(childId, Boolean(cached?.runtime?.isRunning));
    });
  }

  /**
   * Derived "waiting" state: session is idle but sessions it spawned are still
   * running. Computed purely from origins + live runtimes — nothing to reset.
   */
  function waitingInfoFor(sessionId: string): WaitingInfo | undefined {
    const self = cachedSessions.find((item) => item.id === sessionId);
    return waitingInfoFrom(sessionId, state.sessionOrigins || [], {
      selfRunning: isSessionRunning(sessionId, Boolean(self?.runtime?.isRunning)),
      isRunning: (childId) => {
        const cached = cachedSessions.find((item) => item.id === childId);
        return isSessionRunning(childId, Boolean(cached?.runtime?.isRunning));
      },
      describe: (childId) => {
        const cached = cachedSessions.find((item) => item.id === childId);
        const cachedName = (cached ? sessionTitle(cached) : "").replace(/^[⑂⤑]\s*/, "");
        return {
          name: cachedName || knownSessionNames.get(childId) || "",
          cwd: cached?.cwd,
        };
      },
    });
  }

  /**
   * Single precedence rule for per-session indicators: running > waiting >
   * unread. Exactly one indicator is shown per session, everywhere (tab bar
   * and drawer rows).
   */
  function sessionIndicator(sessionId: string, fallbacks: { running?: boolean; unread?: boolean }):
    | { kind: "running" }
    | { kind: "waiting"; waiting: { count: number; names: string[] } }
    | { kind: "unread" }
    | { kind: "none" } {
    const waiting = waitingInfoFor(sessionId);
    const kind = sessionIndicatorKind({
      running: isSessionRunning(sessionId, Boolean(fallbacks.running)),
      waiting: Boolean(waiting),
      unread: isSessionUnread(sessionId, Boolean(fallbacks.unread), Boolean(fallbacks.running)),
    });
    if (kind === "waiting" && waiting) return { kind: "waiting", waiting };
    if (kind === "running") return { kind: "running" };
    if (kind === "unread") return { kind: "unread" };
    return { kind: "none" };
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

  function openSessionTabMenu(sessionId: string, anchor: HTMLElement) {
    closeOpenSessionActionsMenu();
    closeOpenSessionColorFilterMenu();
    closeOpenCurrentSessionBucketMenu();

    const marker = markerForSession(sessionId);
    const menu = document.createElement("div");
    menu.className = "sessionColorFilterMenu sessionBucketMenu";
    menu.setAttribute("role", "menu");

    const title = document.createElement("div");
    title.className = "sessionColorFilterTitle";
    title.textContent = "Session color";
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
    sessionState.mergeSessionInfo(item);
    moveToLane(item.id, "pinned", { cwd: item.cwd || state.currentCwd });
    document.body.classList.toggle("hasPinnedSessions", state.pinnedSessions.length > 0 || Boolean(state.currentSessionId));
    renderSessionList(cachedSessions);
    renderSessionBar();
    updateCurrentSessionPinButton();
  }

  function unpinSession(sessionId: string) {
    const pinnedCount = state.pinnedSessions.length;
    state.pinnedSessions = state.pinnedSessions.filter((p) => p.id !== sessionId);
    if (state.pinnedSessions.length === pinnedCount) return;
    removeFromLanes(sessionId);
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

  async function openSessionTab(sessionId: string, cwd: string) {
    const previousSessionId = state.currentSessionId;
    const switchingSessions = state.currentSessionId !== sessionId;
    if (switchingSessions) {
      sessionState.activate(sessionId);
      beginTranscriptLoading();
      clearMessages();
    }
    try {
      const openRes = await fetch("/api/sessions/open", {
        method: "POST",
        headers: api.headers(),
        body: JSON.stringify({ sessionId, cwd, clientId: api.clientId }),
      });
      if (!openRes.ok) throw new Error(await openRes.text());
      if (!await applyOpenedSession(openRes)) return;
      writeActiveSessionIdToUrl(sessionId);
      rememberSessionCwd(cwd);
      markCachedCurrentSession(sessionId, cwd);
      markSessionReadBestEffort(sessionId);
    } catch (error) {
      if (state.currentSessionId === sessionId) sessionState.activate(previousSessionId);
      addMessage("system", error instanceof Error ? error.message : String(error), "error");
    }
  }

  /**
   * Open a session knowing only its id: resolve its cwd from the cached list
   * (falling back to the current one) and switch in place. This is what session
   * links elsewhere in the UI use, so they never need a full page reload.
   */
  async function openSessionById(sessionId: string) {
    if (!sessionId) return;
    const cached = cachedSessions.find((item) => item.id === sessionId);
    await openSessionTab(sessionId, cached?.cwd || state.currentCwd || "");
  }

  async function openAdjacentPinnedSession(direction: -1 | 1) {
    const pinned = state.pinnedSessions;
    if (pinned.length < 2) return;
    const currentIndex = pinned.findIndex((item) => item.id === state.currentSessionId);
    const targetIndex = currentIndex < 0
      ? (direction < 0 ? pinned.length - 1 : 0)
      : (currentIndex + direction + pinned.length) % pinned.length;
    const target = pinned[targetIndex];
    const cached = cachedSessions.find((item) => item.id === target.id);
    await openSessionTab(target.id, cached?.cwd || target.cwd || state.currentCwd || "");
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
      state.pinnedSessions = [...state.pinnedSessions, { id: currentId, cwd: state.currentCwd }];
      persistSessionUiState({ lanes: [...state.pinnedSessions.map((item) => ({ sessionId: item.id, lane: "pinned" as const, ...(item.cwd ? { cwd: item.cwd } : {}), since: state.lanes.find((entry) => entry.sessionId === item.id)?.since || new Date().toISOString() })), ...state.lanes.filter((entry) => entry.lane !== "pinned")] });
      renderSessionBar();
      updateCurrentSessionPinButton();
    }
  }

  // ── Session bar ────────────────────────────────────────────────────────────

  function flushQueuedSessionBarRender(force = false) {
    sessionBarGestureInFlight = false;
    if (!force && !sessionBarRenderQueued) return;
    sessionBarRenderQueued = false;
    renderSessionBar();
  }

  function attachPinnedTabReorder(tab: HTMLElement) {
    const bar = elements.sessionBarEl;
    const holdDelayMs = 300;
    const touchMoveTolerancePx = 10;
    const mouseLiftDistancePx = 6;
    const edgeZonePx = 48;
    const maxScrollPerFrame = 14;
    const settleDurationMs = 220;

    tab.addEventListener("pointerdown", (downEvent) => {
      if (sessionBarGestureInFlight || !downEvent.isPrimary) return;
      if (downEvent.pointerType === "mouse" && downEvent.button !== 0) return;
      if ((downEvent.target as Element | null)?.closest(".sessionBarTabAction")) return;

      const pointerId = downEvent.pointerId;
      const startX = downEvent.clientX;
      const startY = downEvent.clientY;
      let lastClientX = startX;
      let lifted = false;
      let scrolling = false;
      let longPressReady = false;
      let pressActive = true;
      let holdTimer: number | undefined;
      let autoScrollFrame: number | undefined;
      let tabs: HTMLElement[] = [];
      let rects: DOMRect[] = [];
      let others: Array<{ tab: HTMLElement; domIndex: number }> = [];
      let originalIndex = -1;
      let newIndex = -1;
      let draggedWidth = 0;
      let minDx = 0;
      let maxDx = 0;
      let scrollLeft0 = 0;
      let maxScrollLeft = 0;
      let barRect: DOMRect | undefined;

      sessionBarGestureInFlight = true;

      const clearListeners = () => {
        if (holdTimer !== undefined) window.clearTimeout(holdTimer);
        if (autoScrollFrame !== undefined) cancelAnimationFrame(autoScrollFrame);
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerCancel);
      };

      const finishPress = (delay = 0) => {
        if (!pressActive) return;
        pressActive = false;
        clearListeners();
        if (delay > 0) window.setTimeout(() => flushQueuedSessionBarRender(), delay);
        else flushQueuedSessionBarRender();
      };

      const updateDrag = () => {
        if (!lifted) return;
        const previousIndex = newIndex;
        const rawDx = (lastClientX - startX) + (bar.scrollLeft - scrollLeft0);
        const dx = Math.min(maxDx, Math.max(minDx, rawDx));
        const center = rects[originalIndex].left + draggedWidth / 2 + dx;
        if (dx <= minDx + 0.5) newIndex = 0;
        else if (dx >= maxDx - 0.5) newIndex = tabs.length - 1;
        else newIndex = others.filter((item) => rects[item.domIndex].left + rects[item.domIndex].width / 2 < center).length;
        if (newIndex !== previousIndex) navigator.vibrate?.(5);

        tab.style.transform = `translateX(${dx}px) scale(1.06)`;
        for (let position = 0; position < others.length; position += 1) {
          const item = others[position];
          let shift = 0;
          if (item.domIndex > originalIndex && position < newIndex) shift = -draggedWidth;
          else if (item.domIndex < originalIndex && position >= newIndex) shift = draggedWidth;
          item.tab.style.transform = shift ? `translateX(${shift}px)` : "";
        }
      };

      const runAutoScroll = () => {
        if (!lifted || !barRect) return;
        let velocity = 0;
        if (lastClientX < barRect.left + edgeZonePx) {
          velocity = -maxScrollPerFrame * Math.min(1, (barRect.left + edgeZonePx - lastClientX) / edgeZonePx);
        } else if (lastClientX > barRect.right - edgeZonePx) {
          velocity = maxScrollPerFrame * Math.min(1, (lastClientX - (barRect.right - edgeZonePx)) / edgeZonePx);
        }
        if (velocity !== 0) {
          const nextScrollLeft = Math.min(maxScrollLeft, Math.max(0, bar.scrollLeft + velocity));
          if (nextScrollLeft !== bar.scrollLeft) {
            bar.scrollLeft = nextScrollLeft;
            updateDrag();
          }
        }
        autoScrollFrame = requestAnimationFrame(runAutoScroll);
      };

      const lift = () => {
        if (!pressActive || lifted) return;
        tabs = Array.from(bar.querySelectorAll<HTMLElement>(".sessionBarTab.pinned"));
        originalIndex = tabs.indexOf(tab);
        if (originalIndex < 0 || tabs.length < 2) {
          finishPress();
          return;
        }

        rects = tabs.map((item) => item.getBoundingClientRect());
        others = tabs.flatMap((item, domIndex) => item === tab ? [] : [{ tab: item, domIndex }]);
        newIndex = originalIndex;
        draggedWidth = rects[originalIndex].width;
        minDx = rects[0].left - rects[originalIndex].left;
        maxDx = rects.at(-1)!.right - draggedWidth - rects[originalIndex].left;
        scrollLeft0 = bar.scrollLeft;
        maxScrollLeft = Math.max(0, bar.scrollWidth - bar.clientWidth);
        barRect = bar.getBoundingClientRect();
        lifted = true;
        if (holdTimer !== undefined) window.clearTimeout(holdTimer);
        try {
          tab.setPointerCapture(pointerId);
        } catch {
          // The pointer may already have been released by the browser.
        }
        bar.classList.add("reordering");
        tab.classList.add("dragging");
        navigator.vibrate?.(10);
        updateDrag();
        if (maxScrollLeft > 0) autoScrollFrame = requestAnimationFrame(runAutoScroll);
      };

      const settle = (commit: boolean) => {
        if (!pressActive) return;
        pressActive = false;
        clearListeners();
        suppressTabClickUntil = performance.now() + 400;
        bar.classList.remove("reordering");
        tab.classList.remove("dragging");
        tab.classList.add("settling");

        let targetOffset = 0;
        if (commit && newIndex > originalIndex) {
          for (let index = originalIndex + 1; index <= newIndex; index += 1) targetOffset += rects[index].width;
        } else if (commit && newIndex < originalIndex) {
          for (let index = newIndex; index < originalIndex; index += 1) targetOffset -= rects[index].width;
        }
        tab.style.transform = `translateX(${targetOffset}px) scale(1)`;
        if (!commit) {
          for (const item of others) item.tab.style.transform = "";
        }

        window.setTimeout(() => {
          if (commit && newIndex !== originalIndex) {
            const visualIds = tabs.map((item) => item.dataset.sessionId).filter((id): id is string => Boolean(id));
            const [draggedId] = visualIds.splice(originalIndex, 1);
            if (draggedId) visualIds.splice(newIndex, 0, draggedId);
            const entriesById = new Map(state.pinnedSessions.map((entry) => [entry.id, entry]));
            const reordered = visualIds.flatMap((id) => {
              const entry = entriesById.get(id);
              if (!entry) return [];
              entriesById.delete(id);
              return [entry];
            });
            state.pinnedSessions = [...reordered, ...entriesById.values()];
            persistSessionUiState({ lanes: [...state.pinnedSessions.map((item) => ({ sessionId: item.id, lane: "pinned" as const, ...(item.cwd ? { cwd: item.cwd } : {}), since: state.lanes.find((entry) => entry.sessionId === item.id)?.since || new Date().toISOString() })), ...state.lanes.filter((entry) => entry.lane !== "pinned")] });
          }
          flushQueuedSessionBarRender(true);
        }, settleDurationMs);
      };

      function onPointerMove(event: PointerEvent) {
        if (!pressActive || event.pointerId !== pointerId) return;
        lastClientX = event.clientX;
        const distance = Math.hypot(event.clientX - startX, event.clientY - startY);
        if (!lifted) {
          if (downEvent.pointerType === "mouse" && distance > mouseLiftDistancePx) {
            lift();
          } else if (downEvent.pointerType !== "mouse") {
            const dx = event.clientX - startX;
            const dy = event.clientY - startY;
            if (longPressReady && distance > mouseLiftDistancePx) {
              lift();
            } else if (scrolling) {
              event.preventDefault();
              bar.scrollLeft = scrollLeft0 - dx;
            } else if (distance >= touchMoveTolerancePx) {
              if (Math.abs(dx) > Math.abs(dy)) {
                scrolling = true;
                scrollLeft0 = bar.scrollLeft;
                if (holdTimer !== undefined) window.clearTimeout(holdTimer);
                suppressTabClickUntil = performance.now() + 400;
                event.preventDefault();
              } else {
                finishPress();
              }
            }
          }
        }
        if (lifted) {
          event.preventDefault();
          updateDrag();
        }
      }

      function onPointerUp(event: PointerEvent) {
        if (!pressActive || event.pointerId !== pointerId) return;
        lastClientX = event.clientX;
        if (lifted) {
          updateDrag();
          settle(true);
        } else if (longPressReady) {
          suppressTabClickUntil = performance.now() + 400;
          finishPress();
          openSessionTabMenu(tab.dataset.sessionId!, tab);
        } else if (scrolling) {
          finishPress();
        } else {
          // Keep the old tab alive until the synthetic click following pointerup.
          finishPress(250);
        }
      }

      function onPointerCancel(event: PointerEvent) {
        if (!pressActive || event.pointerId !== pointerId) return;
        if (lifted) settle(false);
        else finishPress();
      }

      window.addEventListener("pointermove", onPointerMove, { passive: false });
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerCancel);
      if (downEvent.pointerType !== "mouse") {
        holdTimer = window.setTimeout(() => {
          if (!pressActive) return;
          longPressReady = true;
          suppressTabClickUntil = performance.now() + 400;
          navigator.vibrate?.(10);
        }, holdDelayMs);
      }
    });

    tab.addEventListener("touchmove", (event) => {
      if (tab.classList.contains("dragging")) event.preventDefault();
    }, { passive: false });
    tab.addEventListener("contextmenu", (event) => {
      if (sessionBarGestureInFlight || tab.classList.contains("dragging")) event.preventDefault();
    });
  }

  function renderSessionBar() {
    if (sessionBarGestureInFlight) {
      sessionBarRenderQueued = true;
      return;
    }
    const bar = elements.sessionBarEl;
    const pinned = sessionsInLane(focusedLane).map((entry) => ({ id: entry.sessionId, cwd: entry.cwd }));
    updateSessionButtonUnread();

    const currentId = state.currentSessionId;
    const currentIsPinned = Boolean(currentId && isPinned(currentId));

    if (pinned.length === 0 && !currentId) {
      bar.hidden = true;
      document.body.classList.remove("hasPinnedSessions");
      updateCurrentSessionPinButton();
      return;
    }

    bar.hidden = false;
    document.body.classList.add("hasPinnedSessions");
    bar.textContent = "";
    const layers = document.createElement("button"); layers.type = "button"; layers.className = `sessionLayersButton${focusedLane !== "pinned" ? " away cur" : ""}`; layers.title = laneMapOpen ? "Return to sessions" : "Session lanes"; layers.append(focusedLane === "pinned" ? (() => { const svg = laneIcon("pinned"); svg.querySelector("path")?.setAttribute("d", "M8 1.6 14.6 5.3 8 9 1.4 5.3zM3.1 7.8 8 10.5l4.9-2.7 1.7 1L8 12.6 1.4 8.8zM3.1 10.4 8 13.1l4.9-2.7 1.7 1L8 15.2 1.4 11.4z"); return svg; })() : laneIcon(focusedLane)); layers.addEventListener("click", () => { laneMapOpen = !laneMapOpen; renderSessionBar(); }); bar.append(layers);
    if (laneMapOpen) {
      const total = Math.max(1, state.lanes.length);
      for (const lane of ["pinned", "parked", "bookmarks"] as SessionLaneId[]) { const territory = document.createElement("button"); territory.type = "button"; territory.className = `sessionLaneTerritory${focusedLane === lane ? " cur" : ""}`; territory.style.flexGrow = String(Math.max(1, sessionsInLane(lane).length / total * 10)); territory.append(laneIcon(lane)); const text = document.createElement("span"); text.textContent = `${laneMeta[lane].label} · ${sessionsInLane(lane).length}`; territory.append(text); territory.addEventListener("click", () => { focusedLane = lane; laneMapOpen = false; renderSessionBar(); }); bar.append(territory); }
      updateCurrentSessionPinButton(); return;
    }

    updateCurrentSessionPinButton();

    let activeTab: HTMLElement | undefined;
    const appendTab = (sessionId: string, label: string, cwd: string, options: { pinned: boolean; running?: boolean; unread?: boolean }) => {
      const isActive = currentId === sessionId;
      const indicator = sessionIndicator(sessionId, { running: options.running, unread: options.unread });
      const unread = indicator.kind === "unread";
      const markerColor = colorForMarker(markerForSession(sessionId)?.color);
      const tab = document.createElement("div");
      tab.className = `sessionBarTab${focusedLane !== "pinned" ? " away" : ""}${isActive ? " active" : ""}${unread ? " unread" : ""}${options.running ? " running" : ""}${options.pinned ? " pinned" : " temporary"}${markerColor ? ` marked marker-${markerColor.id}` : ""}`;
      tab.dataset.sessionId = sessionId;
      if (options.pinned) attachPinnedTabReorder(tab);
      if (options.pinned) {
        tab.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          if (tab.classList.contains("dragging")) return;
          openSessionTabMenu(sessionId, tab);
        });
      }
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
      if (indicator.kind === "waiting") {
        const waiting = indicator.waiting;
        const ribbon = document.createElement("span");
        ribbon.className = "auroraRibbon";
        ribbon.title = `Waiting on ${waiting.count} spawned session${waiting.count === 1 ? "" : "s"}: ${waiting.names.join(", ")}`;
        ribbon.setAttribute("aria-label", ribbon.title);
        tab.append(ribbon);
      }
      if (originParentOf(sessionId)) {
        const lineage = document.createElement("span");
        lineage.className = "sessionBarLineageGlyph";
        lineage.textContent = "⑂";
        lineage.title = "Spawned by another session";
        lineage.setAttribute("aria-hidden", "true");
        open.prepend(lineage);
      }
      if (unread) {
        const unreadDot = document.createElement("span");
        unreadDot.className = "sessionUnreadDot sessionBarUnreadDot";
        unreadDot.title = "Unread activity";
        unreadDot.setAttribute("aria-hidden", "true");
        open.append(unreadDot);
      }
      open.addEventListener("click", (event) => {
        if (performance.now() < suppressTabClickUntil) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        void openSessionTab(sessionId, cwd);
      });
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
      appendTab(
        pinnedEntry.id,
        titleForSessionId(pinnedEntry.id),
        live?.cwd || pinnedEntry.cwd || state.currentCwd,
        { pinned: true, running: (state.sessionsById[pinnedEntry.id]?.runtime ?? live?.runtime)?.isRunning ?? false, unread: live?.unread },
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
        running: (state.sessionsById[currentId]?.runtime ?? live?.runtime)?.isRunning ?? sessionRuntime(state).isRunning,
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
      body: JSON.stringify({ sessionId: item.id, cwd: item.cwd || cwd, activeSessionId: state.currentSessionId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || await res.text());

    cachedSessions = cachedSessions.filter((session) => session.id !== item.id);
    sessionState.remove(item.id);
    state.pinnedSessions = state.pinnedSessions.filter((session) => session.id !== item.id);
    state.lanes = state.lanes.filter((entry) => entry.sessionId !== item.id);
    state.sessionMarkers = state.sessionMarkers.filter((marker) => marker.sessionId !== item.id);
    renderSessionList(cachedSessions);
    renderSessionBar();
    addMessage("system", data.disposition === "trashed" ? "Session moved to trash." : "Session deleted.");
  }

  function getSessionActions(item: SessionInfo, cwd: string): SessionAction[] {
    const deleteDisabledReason = item.isCurrent
      ? "Switch to another session before deleting the current session"
      : item.runtime?.isRunning
        ? "Wait for the session to finish before deleting it"
        : undefined;
    const pinned = isPinned(item.id);
    const lane = laneOf(item.id);
    return [
      ...(["pinned", "parked", "bookmarks"] as SessionLaneId[]).map((target) => ({ id: `lane-${target}`, label: `${lane === target ? "✓ " : ""}Move to ${laneMeta[target].label}`, icon: target === "pinned" ? "pin" as IconName : undefined, run: () => moveToLane(item.id, target, { cwd: item.cwd || cwd }) })),
      ...(lane ? [
        { id: "edit-lane-note", label: state.lanes.find((entry) => entry.sessionId === item.id)?.note ? "Edit note" : "Add note", run: () => setLaneNote(item.id) },
        { id: "drop-lane", label: "Remove from lanes", run: () => removeFromLanes(item.id) },
      ] : []),
      {
        id: pinned ? "unpin" : "pin",
        label: pinned ? "Unpin from tab bar" : "Pin to tab bar",
        icon: "pin",
        run: () => togglePin(item),
      },
      {
        id: "delete",
        label: "Delete",
        icon: "trash-2",
        danger: true,
        disabled: Boolean(deleteDisabledReason),
        disabledReason: deleteDisabledReason,
        run: () => deleteSession(item, cwd),
      },
    ];
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
      if (laneFilter !== "all" && laneOf(item.id) !== laneFilter) return false;
      if (allowedMarkerColors.size > 0 && !allowedMarkerColors.has(marker?.color as SessionMarkerColorId)) return false;
      if (unreadFilterActive && !isSessionUnread(item.id, Boolean(item.unread), Boolean(item.runtime?.isRunning))) return false;
      if (!query) return true;
      return [sessionTitle(item), item.cwd || "", item.firstMessage || ""]
        .some((value) => value.toLowerCase().includes(query));
    };
    const filterActive = Boolean(query || laneFilter !== "all" || allowedMarkerColors.size > 0 || unreadFilterActive);
    renderSessionColorFilterButton();
    const laneFilters = document.createElement("div");
    laneFilters.className = "sessionLaneFilters";
    laneFilters.setAttribute("aria-label", "Filter sessions");
    const unreadChip = document.createElement("button");
    unreadChip.type = "button"; unreadChip.className = `sessionLaneFilter sessionUnreadFilter${unreadFilterActive ? " selected" : ""}`;
    const unreadDot = document.createElement("span"); unreadDot.className = "sessionUnreadFilterDot"; unreadDot.setAttribute("aria-hidden", "true");
    const unreadLabel = document.createElement("span"); unreadLabel.textContent = "Unread"; unreadChip.append(unreadDot, unreadLabel);
    unreadChip.title = "Show unread sessions"; unreadChip.setAttribute("aria-pressed", String(unreadFilterActive));
    unreadChip.addEventListener("click", () => { unreadFilterActive = !unreadFilterActive; renderSessionList(cachedSessions); });
    laneFilters.append(unreadChip);
    const laneDivider = document.createElement("span"); laneDivider.className = "sessionFilterDivider"; laneFilters.append(laneDivider);
    for (const lane of ["all", "pinned", "parked", "bookmarks"] as const) {
      const chip = document.createElement("button"); chip.type = "button"; chip.className = `sessionLaneFilter${laneFilter === lane ? " selected" : ""}`;
      if (lane !== "all") chip.append(laneIcon(lane));
      if (lane === "all") { const label = document.createElement("span"); label.textContent = "All"; chip.append(label); }
      chip.title = lane === "all" ? "All lanes" : `${laneMeta[lane].label} (${sessionsInLane(lane).length})`;
      chip.setAttribute("aria-label", chip.title);
      chip.addEventListener("click", () => { laneFilter = lane; renderSessionList(cachedSessions); }); laneFilters.append(chip);
    }
    const bucketFilters = document.createElement("span"); bucketFilters.className = "sessionBucketFilters"; bucketFilters.setAttribute("role", "group"); bucketFilters.setAttribute("aria-label", "Bucket filters");
    for (const color of sessionMarkerColors) {
      const dot = document.createElement("button"); dot.type = "button"; dot.className = `sessionBucketFilter marker-${color.id}${allowedMarkerColors.has(color.id) ? " selected" : ""}`; dot.title = `Filter by ${color.label} bucket`; dot.setAttribute("aria-label", dot.title);
      dot.addEventListener("click", () => { if (allowedMarkerColors.has(color.id)) allowedMarkerColors.delete(color.id); else allowedMarkerColors.add(color.id); persistAllowedMarkerColors(); renderSessionList(cachedSessions); }); bucketFilters.append(dot);
    }
    laneFilters.append(bucketFilters); elements.sessionListEl.append(laneFilters);

    const groups = new Map<string, SessionInfo[]>();
    for (const item of sessions) {
      const cwd = item.cwd || state.currentCwd || "";
      groups.set(cwd, [...(groups.get(cwd) || []), item]);
    }

    const pinnedEntries: Array<[string, SessionInfo[]]> = state.pinnedFolders
      .filter((cwd) => groups.has(cwd))
      .map((cwd) => [cwd, groups.get(cwd)!]);
    const pinnedFolders = new Set(state.pinnedFolders);
    const unpinnedEntries = Array.from(groups.entries()).filter(([cwd]) => !pinnedFolders.has(cwd));
    const orderedEntries = [...pinnedEntries, ...unpinnedEntries];
    const folderLabels = folderDisplayNames(orderedEntries.map(([cwd]) => cwd));
    let renderedItemCount = 0;

    for (const [cwd, items] of orderedEntries) {
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
      name.textContent = folderLabels.get(cwd) || folderName(cwd);
      name.title = cwd;
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
          await startNewSession(cwd);
        } catch (error) {
          addMessage("system", error instanceof Error ? error.message : String(error), "error");
        }
      });
      header.append(toggle, pinButton, newButton);
      group.append(header);

      const filteredItems = items.filter(matchesFilter);
      if (filterActive && filteredItems.length === 0) continue;
      const count = document.createElement("span"); count.className = "sessionFolderMatchCount"; count.textContent = String(filteredItems.length); labels.append(count);
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
      const orderedItems = orderItemsWithChildren(visibleItems);
      for (const item of orderedItems) {
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

  /** Keep spawned children adjacent to (and after) their parent in the list. */
  function orderItemsWithChildren(items: SessionInfo[]): SessionInfo[] {
    if (!(state.sessionOrigins || []).length) return items;
    return orderLineage(items, (id) => originParentOf(id));
  }

  function buildSessionItem(item: SessionInfo, cwd: string): HTMLElement {
    // Use a div so we can have sibling buttons (navigate + actions) without nesting buttons
    const marker = markerForSession(item.id);
    const markerColor = colorForMarker(marker?.color);
    const pinned = isPinned(item.id);
    const indicator = sessionIndicator(item.id, { running: item.runtime?.isRunning, unread: item.unread });
    const unread = indicator.kind === "unread";
    const waiting = indicator.kind === "waiting" ? indicator.waiting : undefined;
    const isChild = Boolean(originParentOf(item.id));
    const row = document.createElement("div");
    row.className = `sessionItem${item.isCurrent ? " current" : ""}${unread ? " unread" : ""}${pinned ? " pinned" : ""}${markerColor ? ` marked marker-${markerColor.id}` : ""}${isChild ? " sessionItemChild" : ""}`;
    if (item.isCurrent) row.setAttribute("aria-current", "page");

    const markerButton = document.createElement("button");
    markerButton.type = "button";
    markerButton.className = `sessionItemMarkerBtn toolPin${pinned ? " pinned" : ""}`;
    markerButton.title = pinned ? "Remove from pinned lane" : "Move to pinned lane";
    markerButton.setAttribute("aria-label", markerButton.title);
    markerButton.setAttribute("aria-pressed", String(pinned));
    markerButton.append(iconElement("pin"));
    if (markerColor) {
      const markerDot = document.createElement("span");
      markerDot.className = "sessionItemMarkerDot";
      markerDot.title = `${markerColor.label} bucket`;
      markerDot.setAttribute("aria-hidden", "true");
      markerButton.append(markerDot);
    }
    markerButton.addEventListener("click", () => togglePin(item));

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
    } else if (waiting) {
      const pill = document.createElement("span");
      pill.className = "sessionWaitingPill";
      pill.title = `Waiting on ${waiting.count} spawned session${waiting.count === 1 ? "" : "s"}: ${waiting.names.join(", ")}`;
      pill.setAttribute("aria-label", pill.title);
      pill.append(iconElement("hourglass"));
      const count = document.createElement("span");
      count.className = "sessionWaitingCount";
      count.textContent = String(waiting.count);
      pill.append(count);
      titleRow.append(pill);
    }

    const meta = document.createElement("span");
    meta.className = "sessionItemMeta";
    meta.textContent = item.messageCount === undefined
      ? formatRelativeTime(item.modified)
      : `${formatRelativeTime(item.modified)} · ${item.messageCount}`;

    navBtn.append(titleRow, meta);
    navBtn.addEventListener("click", async () => {
      const previousSessionId = state.currentSessionId;
      const nextCwd = item.cwd || cwd;
      const switchingSessions = state.currentSessionId !== item.id;
      if (switchingSessions) {
        sessionState.activate(item.id);
        beginTranscriptLoading();
        clearMessages();
      }
      try {
        const openRes = await fetch("/api/sessions/open", {
          method: "POST",
          headers: api.headers(),
          body: JSON.stringify({ sessionId: item.id, cwd: nextCwd, clientId: api.clientId }),
        });
        if (!openRes.ok) throw new Error(await openRes.text());
        if (!await applyOpenedSession(openRes)) return;
        writeActiveSessionIdToUrl(item.id);
        rememberSessionCwd(nextCwd);
        markCachedCurrentSession(item.id, nextCwd);
        markSessionReadBestEffort(item.id);
        if (shouldCloseDrawerAfterSessionSwitch()) setSessionDrawerOpen(false);
      } catch (error) {
        if (switchingSessions && state.currentSessionId === item.id) sessionState.activate(previousSessionId);
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

    const laneEntry = state.lanes.find((entry) => entry.sessionId === item.id);
    if (laneEntry?.note) { const note = document.createElement("span"); note.className = "sessionLaneNote"; note.textContent = laneEntry.note; navBtn.append(note); }
    if (laneEntry && isStale(laneEntry)) { const stale = document.createElement("span"); stale.className = "sessionStaleBadge"; stale.textContent = "stale"; titleRow.append(stale); }
    row.append(markerButton, navBtn, actionsBtn);
    return row;
  }

  function init() {
    new MutationObserver(updateEmptyCwdChooser).observe(elements.messagesEl, { childList: true });
    elements.emptyCwdButton.addEventListener("click", () => openFolderPicker(state.currentCwd));
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
      filterWrap.append(sessionSearchInput);
      headerTitle.replaceWith(filterWrap);
    }

    setIcon(elements.sessionDrawerSettingsButton, "settings");
    elements.sessionDrawerSettingsButton.append(document.createTextNode("Settings"));
    setIcon(elements.sessionDrawerInfoButton, "info");
    elements.sessionDrawerInfoButton.append(document.createTextNode("Info"));
    elements.sessionNewButton.textContent = "+ New session";
    elements.sessionDrawerSettingsButton.addEventListener("click", () => {
      setSessionDrawerOpen(false);
      elements.settingsButton.click();
    });
    // The system-info panel owns this button's open handler. Closing the drawer
    // first keeps the transition consistent on both split-pane and mobile layouts.
    elements.sessionDrawerInfoButton.addEventListener("click", () => setSessionDrawerOpen(false));

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
    elements.currentSessionBucketButton.addEventListener("click", () => {
      if (state.currentSessionId) openSessionTabMenu(state.currentSessionId, elements.currentSessionBucketButton);
    });
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
    toggleCurrentSessionPin,
    beginTranscriptLoading,
    updateEmptyCwdChooser,
    finishTranscriptLoading,
    updateSessionRuntime,
    updateSessionName,
    removeSession,
    renderSessionBar,
    renderCurrentSessionBucketButton,
    applySessionUiState,
    markSessionRead,
    waitingInfoFor,
    openSessionTab,
    openSessionById,
    openAdjacentPinnedSession,
  };
}
