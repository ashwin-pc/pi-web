import type { ApiClient } from "../app/api.js";
import type { AppElements } from "../app/elements.js";
import { iconElement, setIcon, type IconName } from "../app/icons.js";
import { blurActiveEditableOnMobile } from "../app/focus.js";
import type { RightPanelHandle, RightPanelManager } from "../layout/rightPanel.js";
import type { AppState, SessionInfo, SessionLaneEntry, SessionLaneId, SessionMarkerColorId, SessionUiState } from "../app/types.js";
import { sessionRuntime, type SessionStateController } from "../app/sessionState.js";
import { defaultSessionUiState, normalizeSessionUiState, persistCollapsedSessionFolders, persistExpandedWorkerBranches, sessionFolderPreviewLimit, sessionMarkerColors, writeActiveSessionIdToUrl } from "../app/types.js";
import { runningChildIdsOf, sessionIndicatorKind, waitingInfoFrom, type WaitingInfo } from "./lineage.js";
import { buildSpawnWorkerForest, deriveWorkerBranchView, type WorkerBranchView } from "./workerBranches.js";
import { buildSessionInspector } from "./sessionInspector.js";
import { sessionLaneIcon, sessionLaneMeta } from "./lanes.js";

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
  moveCurrentSessionToLane: (lane: SessionLaneId) => void;
  focusedLaneSessionCount: () => number;
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
  // TTL dedupe (issue #112): a message_end-driven refetch arriving within a short
  // window of the last list fetch is redundant — the just-fetched list already
  // includes it (e.g. the drawer-open refresh right before the prompt). The
  // knowledge "did we just fetch?" lives HERE, not in realtime inspecting drawer
  // timestamps. `force` bypasses for paths where the list actually changed.
  const SESSION_LIST_TTL_MS = 1000;
  let lastListFetchedAt = 0;
  let closeSessionActionsMenu: (() => void) | undefined;
  let closeLaneDrawer: (() => void) | undefined;
  let laneDrawerBucketFilter: SessionMarkerColorId | undefined;
  let sessionPanelHandle: RightPanelHandle | undefined;
  let currentSessionPinButton: HTMLButtonElement | undefined;
  let sessionSearchInput: HTMLInputElement | undefined;
  let sessionWorkerCollapseAllButton: HTMLButtonElement | undefined;
  let sessionColorFilterButton: HTMLButtonElement | undefined;
  let closeSessionColorFilterMenu: (() => void) | undefined;
  let closeCurrentSessionBucketMenu: (() => void) | undefined;
  const allowedMarkerColors = new Set<SessionMarkerColorId>();
  let quickBucketColor: SessionMarkerColorId | undefined;
  let unreadFilterActive = false;
  let transcriptLoading = true;
  let transcriptLoadGeneration = 0;
  let lastReplayedGeneration = -1;
  let sessionBarGestureInFlight = false;
  let sessionBarRenderQueued = false;
  let sessionListRenderFrame: number | undefined;
  let lastSessionBarRenderKey = "";
  let suppressTabClickUntil = 0;
  let laneFilter: SessionLaneId | "all" = "all";
  let focusedLane: SessionLaneId = "pinned";
  function laneEntry(sessionId: string) { return state.lanes.find((entry) => entry.sessionId === sessionId); }
  function laneOf(sessionId: string) { return laneEntry(sessionId)?.lane; }
  function noteForSession(sessionId: string) { return state.sessionNotes.find((entry) => entry.sessionId === sessionId)?.note; }
  function sessionsInLane(lane: SessionLaneId) { return state.lanes.filter((entry) => entry.lane === lane); }
  function syncPinnedProjection() { state.pinnedSessions = sessionsInLane("pinned").map((entry) => ({ id: entry.sessionId, ...(entry.cwd ? { cwd: entry.cwd } : {}) })); }
  function commitLanes() { const drawerScrollTop = document.querySelector<HTMLElement>(".sessionLaneDrawerBody")?.scrollTop; syncPinnedProjection(); persistSessionUiState({ lanes: state.lanes }); renderSessionList(cachedSessions); renderSessionBar(); if (drawerScrollTop !== undefined) openLaneDrawer(drawerScrollTop); }
  function commitSessionNotes() { const drawerScrollTop = document.querySelector<HTMLElement>(".sessionLaneDrawerBody")?.scrollTop; persistSessionUiState({ sessionNotes: state.sessionNotes }); renderSessionList(cachedSessions); renderSessionBar(); if (drawerScrollTop !== undefined) openLaneDrawer(drawerScrollTop); }
  function setSessionNote(sessionId: string, value: string) {
    const note = value.trim();
    if (note === (noteForSession(sessionId) || "")) return;
    state.sessionNotes = note
      ? [{ sessionId, note, updatedAt: new Date().toISOString() }, ...state.sessionNotes.filter((entry) => entry.sessionId !== sessionId)]
      : state.sessionNotes.filter((entry) => entry.sessionId !== sessionId);
    commitSessionNotes();
  }
  function openSessionNoteEditor(title: string, initial: string, onCommit: (note: string) => void) {
    document.querySelector(".sessionNoteEditorBackdrop")?.remove();
    const backdrop = document.createElement("div"); backdrop.className = "sessionNoteEditorBackdrop";
    const prompt = document.createElement("form"); prompt.className = "sessionNoteEditor"; prompt.setAttribute("role", "dialog"); prompt.setAttribute("aria-modal", "true"); prompt.setAttribute("aria-label", title);
    const label = document.createElement("label"); label.textContent = title;
    const input = document.createElement("textarea"); input.className = "sessionNoteEditorInput"; input.value = initial; input.placeholder = "Add a note…"; input.rows = 5; label.append(input);
    const actions = document.createElement("div"); const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "Cancel"; const save = document.createElement("button"); save.type = "submit"; save.textContent = "Save"; actions.append(cancel, save); prompt.append(label, actions); backdrop.append(prompt); document.body.append(backdrop);
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    const close = () => {
      document.removeEventListener("keydown", onEscape, true);
      backdrop.remove();
    };
    document.addEventListener("keydown", onEscape, true);
    cancel.addEventListener("click", close); backdrop.addEventListener("click", (event) => { if (event.target === backdrop) close(); });
    prompt.addEventListener("submit", (event) => { event.preventDefault(); const note = input.value.trim(); close(); onCommit(note); });
    input.addEventListener("keydown", (event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); prompt.requestSubmit(); } });
    requestAnimationFrame(() => { input.focus(); input.scrollIntoView({ block: "center", behavior: "smooth" }); });
  }
  function editSessionNote(sessionId: string) { openSessionNoteEditor("Session note", noteForSession(sessionId) || "", (note) => setSessionNote(sessionId, note)); }
  function moveToLane(sessionId: string, lane: SessionLaneId, opts: { cwd?: string } = {}) {
    const previous = laneEntry(sessionId);
    const entry: SessionLaneEntry = { sessionId, lane, ...(opts.cwd || previous?.cwd ? { cwd: opts.cwd || previous?.cwd } : {}), since: previous?.lane === lane ? previous.since : new Date().toISOString() };
    const promptForNote = lane === "parked" && previous?.lane !== "parked" && !noteForSession(sessionId);
    if (previous?.lane === focusedLane && previous.lane !== lane) focusedLane = lane;
    state.lanes = [...state.lanes.filter((item) => item.sessionId !== sessionId), entry]; commitLanes();
    if (promptForNote) requestAnimationFrame(() => promptForParkedNote(sessionId));
  }
  function promptForParkedNote(sessionId: string) {
    if (laneOf(sessionId) !== "parked" || noteForSession(sessionId)) return;
    openSessionNoteEditor("Optional parking note", "", (note) => {
      if (!note || laneOf(sessionId) !== "parked") return;
      setSessionNote(sessionId, note);
    });
  }
  function removeFromLanes(sessionId: string) { const next = state.lanes.filter((entry) => entry.sessionId !== sessionId); if (next.length === state.lanes.length) return; state.lanes = next; commitLanes(); }
  function isStale(entry: SessionLaneEntry) { return entry.lane === "parked" && Date.now() - new Date(entry.since).getTime() > 14 * 864e5; }
  const sessionInspector = buildSessionInspector({
    item: (sessionId) => { const live = cachedSessions.find((entry) => entry.id === sessionId); return { sessionId, name: live ? sessionTitle(live) : titleForSessionId(sessionId), lane: laneOf(sessionId), bucket: markerForSession(sessionId)?.color, note: noteForSession(sessionId), unread: Boolean(unreadStateForSession(sessionId)) }; },
    moveToLane: (sessionId, lane) => moveToLane(sessionId, lane, { cwd: cachedSessions.find((entry) => entry.id === sessionId)?.cwd || laneEntry(sessionId)?.cwd || state.currentCwd }),
    setBucket: (sessionId, color) => setSessionMarker(sessionId, color),
    editNote: editSessionNote,
    removeFromLanes,
    openSession: (sessionId) => { void openSessionById(sessionId); },
    setUnread: (sessionId, unread) => { (unread ? markSessionUnread(sessionId) : markSessionRead(sessionId)).catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error")); },
  });

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
    // The session index may have been fetched while the drawer was closed. Render
    // that cache immediately even when the TTL correctly suppresses another fetch.
    renderSessionList(cachedSessions);
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

  /** Coalesce bursts of background runtime/UI-state events into one drawer pass. */
  function scheduleSessionListRender() {
    if (elements.sessionDrawer.hidden || sessionListRenderFrame !== undefined) return;
    sessionListRenderFrame = window.requestAnimationFrame(() => {
      sessionListRenderFrame = undefined;
      renderSessionList(cachedSessions);
    });
  }

  function refreshSessions(force = false): Promise<void> {
    if (sessionRefreshPromise) return sessionRefreshPromise; // in-flight reuse
    if (!force && Date.now() - lastListFetchedAt < SESSION_LIST_TTL_MS) return Promise.resolve();
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
      let laneCwdsChanged = false;
      state.lanes = state.lanes.map((entry) => {
        const live = cachedSessions.find((session) => session.id === entry.sessionId);
        if (live?.cwd && live.cwd !== entry.cwd) {
          laneCwdsChanged = true;
          return { ...entry, cwd: live.cwd };
        }
        return entry;
      });
      if (laneCwdsChanged) {
        syncPinnedProjection();
        persistSessionUiState({ lanes: state.lanes });
      }
      scheduleSessionListRender();
      renderSessionBar();
      updateSessionButtonUnread();
      options.onDerivedSessionStateChanged?.();
      lastListFetchedAt = Date.now();
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
    if (changed) scheduleSessionListRender();
    else void refreshSessionsSoon(); // bring the new session into the list
    renderSessionBar();
    options.onDerivedSessionStateChanged?.();
  }

  /** Coalesce list refreshes triggered by newly discovered sessions. */
  let refreshSoonTimer: number | undefined;
  function refreshSessionsSoon() {
    if (refreshSoonTimer !== undefined) return;
    refreshSoonTimer = window.setTimeout(() => {
      refreshSoonTimer = undefined;
      // Newly discovered sessions (just spawned / named) must appear immediately,
      // so bypass the TTL dedupe.
      void refreshSessions(true);
    }, 400);
  }

  function removeSession(sessionId: string) {
    if (!sessionId) return;
    cachedSessions = cachedSessions.filter((session) => session.id !== sessionId);
    sessionState.remove(sessionId);
    state.sessionNotes = state.sessionNotes.filter((entry) => entry.sessionId !== sessionId);
    if (!elements.sessionDrawer.hidden) renderSessionList(cachedSessions);
    renderSessionBar();
    updateSessionButtonUnread();
  }

  function updateSessionRuntime(sessionId: string, runtime: SessionInfo["runtime"]) {
    if (!sessionId || !runtime) return;
    cachedSessions = cachedSessions.map((session) => session.id === sessionId ? { ...session, runtime } : session);
    if (!patchRenderedRuntimeBranch(sessionId)) scheduleSessionListRender();
    renderSessionBar();
  }

  // ── Markers and pinning ────────────────────────────────────────────────────

  let sessionUiWritePending = 0;
  let sessionUiWriteSequence = 0;
  let latestSessionUiRevision = 0;
  let sessionUiStateInitialized = false;
  let sessionUiWriteQueue = Promise.resolve();
  function applySessionUiStateValue(value: unknown) {
    const next = normalizeSessionUiState(value);
    if (sessionUiStateInitialized && next.revision <= latestSessionUiRevision) return;
    sessionUiStateInitialized = true;
    latestSessionUiRevision = next.revision;
    state.lanes = next.lanes;
    state.sessionNotes = next.sessionNotes;
    state.pinnedSessions = next.lanes.filter((entry) => entry.lane === "pinned").map((entry) => ({ id: entry.sessionId, ...(entry.cwd ? { cwd: entry.cwd } : {}) }));
    state.pinnedFolders = next.pinnedFolders;
    state.sessionMarkers = next.sessionMarkers;
    state.sessionUnreadStates = next.sessionUnreadStates;
    state.sessionOrigins = next.sessionOrigins;
    syncCachedUnreadFromState();
    state.selectedMarkerColor = next.selectedMarkerColor;
    state.bucketLabels = next.bucketLabels;
    allowedMarkerColors.clear();
    for (const color of next.allowedMarkerColors) allowedMarkerColors.add(color);
    document.body.classList.toggle("hasPinnedSessions", state.pinnedSessions.length > 0 || Boolean(state.currentSessionId));
    scheduleSessionListRender();
    renderSessionBar();
    updateSessionButtonUnread();
    updateCurrentSessionPinButton();
    renderCurrentSessionBucketButton();
    if (state.pinnedSessions.length > 0 && cachedSessions.length === 0) refreshSessions().catch(() => undefined);
  }

  function hasAnySessionUiState(value: SessionUiState) {
    return value.lanes.length > 0
      || value.sessionNotes.length > 0
      || value.pinnedFolders.length > 0
      || value.sessionMarkers.length > 0
      || value.sessionUnreadStates.length > 0
      // Lineage counts as state: without it, a server holding ONLY origins looks
      // "empty" and a legacy-localStorage push would wipe every recorded origin.
      || (value.sessionOrigins?.length ?? 0) > 0
      || value.allowedMarkerColors.length > 0
      || Object.keys(value.bucketLabels).length > 0
      || value.selectedMarkerColor !== defaultSessionUiState.selectedMarkerColor;
  }

  function applySessionUiState(value: unknown) {
    // Realtime snapshots emitted before our PATCH response can contain the old
    // lane projection. Let the mutation response remain authoritative while a
    // local write is in flight so a newly pinned tab cannot immediately revert.
    if (sessionUiWritePending > 0) return;
    applySessionUiStateValue(value);
  }

  async function patchSessionUiState(patch: Partial<SessionUiState>) {
    const writeSequence = ++sessionUiWriteSequence;
    sessionUiWritePending += 1;
    const write = async () => {
      const res = await fetch("/api/session-ui-state", {
        method: "PATCH",
        headers: api.headers(),
        body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.error || await res.text());
      // Keep newer optimistic mutations rendered until their queued write is
      // confirmed; intermediate full-state responses would otherwise revert UI.
      if (writeSequence === sessionUiWriteSequence) applySessionUiStateValue(data.sessionUiState);
    };
    const result = sessionUiWriteQueue.then(write, write);
    sessionUiWriteQueue = result.then(() => undefined, () => undefined);
    try {
      await result;
    } finally {
      sessionUiWritePending -= 1;
    }
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
      sessionNotes: state.sessionNotes,
      pinnedFolders: state.pinnedFolders,
      sessionMarkers: state.sessionMarkers,
      sessionUnreadStates: state.sessionUnreadStates,
      selectedMarkerColor: state.selectedMarkerColor,
      allowedMarkerColors: Array.from(allowedMarkerColors),
      bucketLabels: state.bucketLabels,
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

  function spawnOrigins() {
    return (state.sessionOrigins || []).filter((item) => item.kind === "spawn");
  }

  function originParentOf(sessionId: string) {
    return spawnOrigins().find((item) => item.sessionId === sessionId)?.originSessionId;
  }

  function runningChildrenOf(sessionId: string) {
    return runningChildIdsOf(sessionId, spawnOrigins(), (childId) => {
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
    return waitingInfoFrom(sessionId, spawnOrigins(), {
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

  async function markSessionUnread(sessionId = state.currentSessionId) {
    const id = sessionId.trim();
    if (!id) return;
    const now = new Date().toISOString();
    state.sessionUnreadStates = [...state.sessionUnreadStates.filter((item) => item.sessionId !== id), { sessionId: id, unreadAt: now, updatedAt: now }];
    syncCachedUnreadFromState();
    if (!elements.sessionDrawer.hidden) renderSessionList(cachedSessions);
    renderSessionBar();
    updateSessionButtonUnread();
    const res = await fetch("/api/session-ui-state/unread", {
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
    return state.bucketLabels[color] || colorForMarker(color)?.label || color;
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
    const active = colors.length > 0 || unreadFilterActive || laneFilter !== "all";
    sessionColorFilterButton.classList.toggle("active", active);
    const parts = [
      laneFilter === "all" ? "all lanes" : `${sessionLaneMeta[laneFilter].label} lane`,
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
        ? `Current session bucket: ${markerColorLabel(color.id)}. Click to change or unset.`
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
      label.textContent = markerColorLabel(color.id);
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

    const laneTitle = document.createElement("div");
    laneTitle.className = "sessionColorFilterTitle";
    laneTitle.textContent = "Lane";
    menu.append(laneTitle);

    const laneButtons: Array<{ lane: SessionLaneId | "all"; button: HTMLButtonElement }> = [];
    for (const lane of ["all", "pinned", "parked", "bookmarks"] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "sessionColorFilterMenuItem lane";
      button.setAttribute("role", "menuitemradio");
      const label = document.createElement("span");
      label.textContent = lane === "all" ? "All lanes" : sessionLaneMeta[lane].label;
      button.append(label);
      button.addEventListener("click", () => {
        laneFilter = lane;
        renderSessionList(cachedSessions);
        closeOpenSessionColorFilterMenu();
      });
      laneButtons.push({ lane, button });
      menu.append(button);
    }

    const stateTitle = document.createElement("div");
    stateTitle.className = "sessionColorFilterTitle";
    stateTitle.textContent = "State";
    menu.append(stateTitle);

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
      for (const item of laneButtons) {
        const selected = laneFilter === item.lane;
        item.button.classList.toggle("selected", selected);
        item.button.setAttribute("aria-checked", String(selected));
      }
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
      label.textContent = markerColorLabel(color.id);
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
    return laneOf(id) === "pinned";
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
    if (!isPinned(sessionId)) return;
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
    const previousFocusedLane = focusedLane;
    const targetLane = laneOf(sessionId);
    const switchingSessions = state.currentSessionId !== sessionId;
    if (targetLane) focusedLane = targetLane;
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
      if (!await applyOpenedSession(openRes)) { focusedLane = previousFocusedLane; renderSessionBar(); return; }
      writeActiveSessionIdToUrl(sessionId);
      rememberSessionCwd(cwd);
      markCachedCurrentSession(sessionId, cwd);
      markSessionReadBestEffort(sessionId);
    } catch (error) {
      if (state.currentSessionId === sessionId) sessionState.activate(previousSessionId);
      focusedLane = previousFocusedLane;
      renderSessionBar();
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
    await openSessionTab(sessionId, cached?.cwd || laneEntry(sessionId)?.cwd || state.currentCwd || "");
  }

  async function openAdjacentPinnedSession(direction: -1 | 1) {
    const pinned = sessionsInLane(focusedLane).map((entry) => ({ id: entry.sessionId, cwd: entry.cwd }));
    if (pinned.length < 2) return;
    const currentIndex = pinned.findIndex((item) => item.id === state.currentSessionId);
    const targetIndex = currentIndex < 0
      ? (direction < 0 ? pinned.length - 1 : 0)
      : (currentIndex + direction + pinned.length) % pinned.length;
    const target = pinned[targetIndex];
    const cached = cachedSessions.find((item) => item.id === target.id);
    await openSessionTab(target.id, cached?.cwd || target.cwd || state.currentCwd || "");
  }

  function moveCurrentSessionToLane(lane: SessionLaneId) {
    const sessionId = state.currentSessionId;
    if (!sessionId) return;
    moveToLane(sessionId, lane, { cwd: cachedSessions.find((item) => item.id === sessionId)?.cwd || laneEntry(sessionId)?.cwd || state.currentCwd });
  }

  function focusedLaneSessionCount() { return sessionsInLane(focusedLane).length; }

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
    else moveToLane(currentId, "pinned", { cwd: state.currentCwd });
  }

  // ── Session bar ────────────────────────────────────────────────────────────

  function flushQueuedSessionBarRender(force = false) {
    sessionBarGestureInFlight = false;
    if (!force && !sessionBarRenderQueued) return;
    sessionBarRenderQueued = false;
    renderSessionBar();
  }

  function attachLaneTabReorder(tab: HTMLElement) {
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
        tab.removeEventListener("session-inspector-open", onInspectorOpen);
      };

      const finishPress = (delay = 0) => {
        if (!pressActive) return;
        pressActive = false;
        tab.classList.remove("reorder-ready");
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
        tabs = Array.from(bar.querySelectorAll<HTMLElement>(".sessionBarTab.laned"));
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
        tab.classList.remove("reorder-ready");
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
        tab.classList.remove("reorder-ready", "dragging");
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
            const entriesById = new Map(sessionsInLane(focusedLane).map((entry) => [entry.sessionId, entry]));
            const reordered = visualIds.flatMap((id) => {
              const entry = entriesById.get(id);
              if (!entry) return [];
              entriesById.delete(id);
              return [entry];
            });
            state.lanes = [...reordered, ...entriesById.values(), ...state.lanes.filter((entry) => entry.lane !== focusedLane)];
            syncPinnedProjection();
            persistSessionUiState({ lanes: state.lanes });
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

      function onInspectorOpen() { finishPress(); }
      tab.addEventListener("session-inspector-open", onInspectorOpen);
      window.addEventListener("pointermove", onPointerMove, { passive: false });
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerCancel);
      if (downEvent.pointerType !== "mouse") {
        holdTimer = window.setTimeout(() => {
          if (!pressActive) return;
          longPressReady = true;
          tab.classList.add("reorder-ready");
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

  function openLaneDrawer(scrollTop = 0) {
    closeLaneDrawer?.();
    if (cachedSessions.length === 0) void refreshSessions().then(() => { if (document.querySelector(".sessionLaneDrawerBackdrop")) openLaneDrawer(); });
    const backdrop = document.createElement("div");
    backdrop.className = "sessionLaneDrawerBackdrop";
    const drawer = document.createElement("section");
    drawer.className = "sessionLaneDrawer";
    drawer.setAttribute("role", "dialog");
    drawer.setAttribute("aria-modal", "true");
    drawer.setAttribute("aria-label", "Session lanes");

    const grab = document.createElement("div"); grab.className = "sessionLaneDrawerGrab"; drawer.append(grab);
    const header = document.createElement("header");
    const heading = document.createElement("h2"); heading.textContent = "Lanes";
    const allEntries = state.lanes;
    const visibleEntries = laneDrawerBucketFilter
      ? allEntries.filter((entry) => markerForSession(entry.sessionId)?.color === laneDrawerBucketFilter)
      : allEntries;
    const bucketCount = new Set(allEntries.map((entry) => markerForSession(entry.sessionId)?.color).filter(Boolean)).size;
    const summary = document.createElement("span"); summary.className = "sessionLaneDrawerSummary"; summary.textContent = laneDrawerBucketFilter
      ? `${visibleEntries.length} of ${allEntries.length} sessions`
      : `${allEntries.length} session${allEntries.length === 1 ? "" : "s"} · ${bucketCount} bucket${bucketCount === 1 ? "" : "s"}`;
    header.append(heading, summary); drawer.append(header);

    const filters = document.createElement("div"); filters.className = "sessionLaneDrawerBucketFilters"; filters.setAttribute("role", "group"); filters.setAttribute("aria-label", "Filter lanes by bucket");
    const allBuckets = document.createElement("button"); allBuckets.type = "button"; allBuckets.className = `sessionLaneDrawerBucketFilterAll${laneDrawerBucketFilter ? "" : " selected"}`; allBuckets.textContent = "All"; allBuckets.setAttribute("aria-pressed", String(!laneDrawerBucketFilter)); allBuckets.addEventListener("click", () => { laneDrawerBucketFilter = undefined; openLaneDrawer(); }); filters.append(allBuckets);
    for (const color of sessionMarkerColors) {
      const selected = laneDrawerBucketFilter === color.id;
      const button = document.createElement("button"); button.type = "button"; button.className = `sessionLaneDrawerBucketFilter marker-${color.id}${selected ? " selected" : ""}`;
      const label = markerColorLabel(color.id); button.title = label; button.setAttribute("aria-label", `Show ${label} bucket`); button.setAttribute("aria-pressed", String(selected));
      const swatch = document.createElement("span"); swatch.setAttribute("aria-hidden", "true"); const text = document.createElement("span"); text.textContent = label; button.append(swatch, text);
      button.addEventListener("click", () => { laneDrawerBucketFilter = selected ? undefined : color.id; openLaneDrawer(); }); filters.append(button);
    }
    drawer.append(filters);

    const body = document.createElement("div"); body.className = "sessionLaneDrawerBody";
    for (const lane of ["pinned", "parked", "bookmarks"] as SessionLaneId[]) {
      const entries = sessionsInLane(lane).filter((entry) => !laneDrawerBucketFilter || markerForSession(entry.sessionId)?.color === laneDrawerBucketFilter);
      const section = document.createElement("section"); section.className = `sessionLaneDrawerSection lane-${lane}`; section.dataset.lane = lane;
      const laneHeading = document.createElement("div"); laneHeading.className = "sessionLaneDrawerHeading"; laneHeading.append(sessionLaneIcon(lane));
      const laneLabel = document.createElement("strong"); laneLabel.textContent = sessionLaneMeta[lane].label;
      const count = document.createElement("span"); count.className = "sessionLaneDrawerCount"; count.textContent = String(entries.length); laneHeading.append(laneLabel, count);
      if (lane === "pinned") { const more = document.createElement("span"); more.className = "sessionLaneDrawerMore"; more.textContent = "in tab bar"; laneHeading.append(more); }
      section.append(laneHeading);
      if (entries.length === 0) { const empty = document.createElement("p"); empty.className = "sessionLaneDrawerEmpty"; empty.textContent = laneDrawerBucketFilter ? `No ${markerColorLabel(laneDrawerBucketFilter)} sessions` : "No sessions"; section.append(empty); }
      for (const entry of entries) {
        const live = cachedSessions.find((item) => item.id === entry.sessionId);
        const card = document.createElement("div"); card.className = `sessionLaneDrawerCard${state.currentSessionId === entry.sessionId ? " current" : ""}`; card.dataset.sessionId = entry.sessionId; card.dataset.lane = lane;
        let suppressOpenUntil = 0;
        const open = document.createElement("button"); open.type = "button"; open.className = "sessionLaneDrawerItem";
        const copy = document.createElement("span"); copy.className = "sessionLaneDrawerItemCopy";
        const title = document.createElement("span"); title.className = "sessionLaneDrawerItemTitle"; title.textContent = live ? sessionTitle(live) : titleForSessionId(entry.sessionId); copy.append(title);
        const sessionNote = noteForSession(entry.sessionId);
        if (sessionNote) { const note = document.createElement("span"); note.className = "sessionLaneDrawerItemNote"; note.textContent = sessionNote; copy.append(note); }
        const meta = document.createElement("span"); meta.className = "sessionLaneDrawerItemMeta";
        const marker = markerForSession(entry.sessionId);
        if (marker) { const bucket = document.createElement("span"); bucket.className = `sessionLaneDrawerBucket marker-${marker.color}`; bucket.title = `${markerColorLabel(marker.color)} bucket`; meta.append(bucket); }
        if (live?.modified) { const age = document.createElement("span"); age.textContent = formatRelativeTime(live.modified); meta.append(age); }
        if (isStale(entry)) { const stale = document.createElement("span"); stale.className = "sessionStaleBadge"; stale.textContent = "stale"; meta.append(stale); }
        copy.append(meta); open.append(copy);
        open.addEventListener("click", () => { if (performance.now() < suppressOpenUntil) return; closeLaneDrawer?.(); void openSessionTab(entry.sessionId, live?.cwd || entry.cwd || state.currentCwd); });
        card.append(open);
        const dragHandle = document.createElement("button"); dragHandle.type = "button"; dragHandle.className = "sessionLaneDragHandle"; dragHandle.disabled = Boolean(laneDrawerBucketFilter); dragHandle.title = laneDrawerBucketFilter ? "Show all buckets to reorder sessions" : "Drag to reorder or move between lanes"; dragHandle.setAttribute("aria-label", dragHandle.title); dragHandle.textContent = "⠿"; card.append(dragHandle);
        let dragPointer: number | undefined; let dragStartY = 0; let dragging = false;
        const finishDrag = () => {
          if (dragPointer === undefined) return;
          if (dragging) {
            suppressOpenUntil = performance.now() + 350; card.classList.remove("dragging");
            const byId = new Map(state.lanes.map((item) => [item.sessionId, item]));
            const orderedIds = (["pinned", "parked", "bookmarks"] as SessionLaneId[]).flatMap((laneId) =>
              Array.from(drawer.querySelectorAll<HTMLElement>(`.sessionLaneDrawerSection[data-lane="${laneId}"] .sessionLaneDrawerCard`)).map((node) => node.dataset.sessionId!).filter(Boolean));
            const nextLanes = orderedIds.map((id) => {
              const item = byId.get(id)!; const nextLane = drawer.querySelector<HTMLElement>(`.sessionLaneDrawerCard[data-session-id="${CSS.escape(id)}"]`)?.dataset.lane as SessionLaneId || item.lane;
              return { ...item, lane: nextLane, since: item.lane === nextLane ? item.since : new Date().toISOString() };
            });
            const moved = nextLanes.find((item) => item.sessionId === entry.sessionId);
            if (entry.lane === focusedLane && moved && moved.lane !== entry.lane) focusedLane = moved.lane;
            state.lanes = nextLanes; commitLanes();
            if (moved?.lane === "parked" && entry.lane !== "parked" && !noteForSession(entry.sessionId)) requestAnimationFrame(() => promptForParkedNote(entry.sessionId));
          }
          dragPointer = undefined; dragging = false;
        };
        const moveDrag = (event: PointerEvent) => {
          if (dragPointer !== event.pointerId) return;
          if (!dragging && Math.abs(event.clientY - dragStartY) < 8) return;
          dragging = true; suppressOpenUntil = performance.now() + 350; card.classList.add("dragging"); event.preventDefault();
          const bodyRect = body.getBoundingClientRect();
          if (event.clientY < bodyRect.top + 48) body.scrollTop -= 18;
          else if (event.clientY > bodyRect.bottom - 48) body.scrollTop += 18;
          const sections = Array.from(drawer.querySelectorAll<HTMLElement>(".sessionLaneDrawerSection"));
          const targetSection = sections.find((candidate) => { const rect = candidate.getBoundingClientRect(); return event.clientY >= rect.top && event.clientY <= rect.bottom; })
            || sections.reduce((closest, candidate) => Math.abs(candidate.getBoundingClientRect().top - event.clientY) < Math.abs(closest.getBoundingClientRect().top - event.clientY) ? candidate : closest);
          const targetLane = targetSection.dataset.lane as SessionLaneId; card.dataset.lane = targetLane;
          const siblings = Array.from(targetSection.querySelectorAll<HTMLElement>(".sessionLaneDrawerCard")).filter((node) => node !== card);
          const before = siblings.find((node) => event.clientY < node.getBoundingClientRect().top + node.offsetHeight / 2);
          targetSection.insertBefore(card, before || null);
        };
        const endDrag = (event: PointerEvent) => { if (dragPointer !== event.pointerId) return; window.removeEventListener("pointermove", moveDrag); window.removeEventListener("pointerup", endDrag); window.removeEventListener("pointercancel", endDrag); finishDrag(); };
        card.addEventListener("session-inspector-open", () => { window.removeEventListener("pointermove", moveDrag); window.removeEventListener("pointerup", endDrag); window.removeEventListener("pointercancel", endDrag); dragPointer = undefined; dragging = false; card.classList.remove("dragging"); });
        dragHandle.addEventListener("pointerdown", (event) => {
          dragPointer = event.pointerId; dragStartY = event.clientY;
          window.addEventListener("pointermove", moveDrag, { passive: false }); window.addEventListener("pointerup", endDrag); window.addEventListener("pointercancel", endDrag);
        });
        sessionInspector.attach(card, entry.sessionId, "lane");
        if (live) { const actions = document.createElement("button"); actions.type = "button"; actions.className = "sessionLaneDrawerActions"; actions.textContent = "⋯"; actions.title = "Session actions"; actions.setAttribute("aria-label", actions.title); actions.addEventListener("click", (event) => { event.stopPropagation(); sessionInspector.openAt(actions, entry.sessionId, "lane"); }); card.append(actions); }
        section.append(card);
      }
      body.append(section);
    }
    drawer.append(body);
    const footer = document.createElement("footer"); footer.textContent = "Other sessions stay in Recents";
    const recents = document.createElement("button"); recents.type = "button"; recents.textContent = "Open Recents"; recents.addEventListener("click", () => { closeLaneDrawer?.(); setSessionDrawerOpen(true); }); footer.append(recents); drawer.append(footer);
    backdrop.append(drawer); document.body.append(backdrop);

    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") closeLaneDrawer?.(); };
    closeLaneDrawer = () => { window.removeEventListener("keydown", onKeyDown); backdrop.remove(); closeLaneDrawer = undefined; };
    backdrop.addEventListener("click", (event) => { if (event.target === backdrop) closeLaneDrawer?.(); });
    window.addEventListener("keydown", onKeyDown);
    requestAnimationFrame(() => { backdrop.classList.add("open"); body.scrollTop = scrollTop; drawer.focus(); });
  }

  function renderSessionBar() {
    if (sessionBarGestureInFlight) {
      sessionBarRenderQueued = true;
      return;
    }
    const bar = elements.sessionBarEl;
    const laneEntries = sessionsInLane(focusedLane).map((entry) => ({ id: entry.sessionId, cwd: entry.cwd }));
    updateSessionButtonUnread();

    const currentId = state.currentSessionId;
    const currentIsInFocusedLane = Boolean(currentId && laneEntries.some((entry) => entry.id === currentId));
    const renderedIds = [...laneEntries.map((entry) => entry.id), ...(currentId && !currentIsInFocusedLane ? [currentId] : [])];
    const barRenderKey = JSON.stringify({
      focusedLane,
      currentId,
      laneEntries,
      tabs: renderedIds.map((sessionId) => {
        const live = cachedSessions.find((session) => session.id === sessionId);
        const running = (state.sessionsById[sessionId]?.runtime ?? live?.runtime)?.isRunning
          ?? (sessionId === currentId ? sessionRuntime(state).isRunning : false);
        const indicator = sessionIndicator(sessionId, { running, unread: live?.unread });
        return {
          sessionId,
          title: live ? sessionTitle(live) : titleForSessionId(sessionId),
          cwd: live?.cwd || laneEntries.find((entry) => entry.id === sessionId)?.cwd || state.currentCwd,
          running,
          indicator: indicator.kind,
          waiting: indicator.kind === "waiting" ? indicator.waiting.names : undefined,
          marker: markerForSession(sessionId)?.color,
          note: noteForSession(sessionId),
          origin: originParentOf(sessionId),
        };
      }),
    });
    if (barRenderKey === lastSessionBarRenderKey) {
      updateCurrentSessionPinButton();
      return;
    }
    lastSessionBarRenderKey = barRenderKey;

    if (laneEntries.length === 0 && !currentId) {
      bar.hidden = true;
      document.body.classList.remove("hasPinnedSessions");
      updateCurrentSessionPinButton();
      return;
    }

    bar.hidden = false;
    document.body.classList.add("hasPinnedSessions");
    bar.textContent = "";
    const layers = document.createElement("button"); layers.type = "button"; layers.className = `sessionLayersButton${focusedLane !== "pinned" ? " away cur" : ""}`; layers.title = "Session lanes"; layers.append(focusedLane === "pinned" ? (() => { const svg = sessionLaneIcon("pinned"); svg.querySelector("path")?.setAttribute("d", "M8 1.6 14.6 5.3 8 9 1.4 5.3zM3.1 7.8 8 10.5l4.9-2.7 1.7 1L8 12.6 1.4 8.8zM3.1 10.4 8 13.1l4.9-2.7 1.7 1L8 15.2 1.4 11.4z"); return svg; })() : sessionLaneIcon(focusedLane)); layers.addEventListener("click", () => openLaneDrawer()); bar.append(layers);

    updateCurrentSessionPinButton();

    let activeTab: HTMLElement | undefined;
    const appendTab = (sessionId: string, label: string, cwd: string, options: { laned: boolean; running?: boolean; unread?: boolean }) => {
      const isActive = currentId === sessionId;
      const indicator = sessionIndicator(sessionId, { running: options.running, unread: options.unread });
      const unread = indicator.kind === "unread";
      const markerColor = colorForMarker(markerForSession(sessionId)?.color);
      const tab = document.createElement("div");
      tab.className = `sessionBarTab${focusedLane !== "pinned" ? " away" : ""}${isActive ? " active" : ""}${unread ? " unread" : ""}${options.running ? " running" : ""}${options.laned ? ` laned${focusedLane === "pinned" ? " pinned" : ""}` : " temporary"}${markerColor ? ` marked marker-${markerColor.id}` : ""}`;
      tab.dataset.sessionId = sessionId;
      // Give the reorder gesture a clear head start; a stationary hold still
      // opens the Inspector, while hold-and-move reliably becomes a drag.
      sessionInspector.attach(tab, sessionId, "tab", 650);
      if (options.laned) attachLaneTabReorder(tab);
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
      const sessionNote = noteForSession(sessionId);
      open.title = [label, sessionNote ? `Note: ${sessionNote}` : "", markerColor ? `${markerColor.label} marker` : "", unread ? "Unread activity" : ""].filter(Boolean).join(" · ");

      const labelEl = document.createElement("span");
      labelEl.className = "sessionBarTabLabel";
      labelEl.textContent = label;
      open.append(labelEl);
      if (sessionNote) {
        const noteIndicator = document.createElement("span");
        noteIndicator.className = "sessionBarNoteIndicator";
        noteIndicator.title = sessionNote;
        noteIndicator.setAttribute("aria-hidden", "true");
        open.append(noteIndicator);
      }
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

      if (options.laned) {
        const close = document.createElement("button");
        close.type = "button";
        close.className = "sessionBarTabAction";
        close.title = focusedLane === "pinned" ? "Unpin tab" : `Remove from ${sessionLaneMeta[focusedLane].label}`;
        close.setAttribute("aria-label", `${close.title}: ${label}`);
        setIcon(close, "x");
        close.addEventListener("click", () => focusedLane === "pinned" ? unpinSession(sessionId) : removeFromLanes(sessionId));
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

    for (const pinnedEntry of laneEntries) {
      const live = cachedSessions.find((s) => s.id === pinnedEntry.id);
      appendTab(
        pinnedEntry.id,
        titleForSessionId(pinnedEntry.id),
        live?.cwd || pinnedEntry.cwd || state.currentCwd,
        { laned: true, running: (state.sessionsById[pinnedEntry.id]?.runtime ?? live?.runtime)?.isRunning ?? false, unread: live?.unread },
      );
    }

    if (currentId && !currentIsInFocusedLane) {
      const live = cachedSessions.find((s) => s.id === currentId);
      if (laneEntries.length > 0) {
        const separator = document.createElement("div");
        separator.className = "sessionBarSeparator";
        separator.setAttribute("aria-hidden", "true");
        bar.append(separator);
      }
      appendTab(currentId, live ? sessionTitle(live) : titleForSessionId(currentId), live?.cwd || state.currentCwd, {
        laned: false,
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
    state.lanes = state.lanes.filter((entry) => entry.sessionId !== item.id);
    state.sessionNotes = state.sessionNotes.filter((entry) => entry.sessionId !== item.id);
    syncPinnedProjection();
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
      {
        id: unreadStateForSession(item.id) ? "mark-read" : "mark-unread",
        label: unreadStateForSession(item.id) ? "Mark as read" : "Mark as unread",
        run: () => unreadStateForSession(item.id) ? markSessionRead(item.id) : markSessionUnread(item.id),
      },
      ...(["pinned", "parked", "bookmarks"] as SessionLaneId[]).map((target) => ({ id: `lane-${target}`, label: `${lane === target ? "✓ " : ""}Move to ${sessionLaneMeta[target].label}`, icon: target === "pinned" ? "pin" as IconName : undefined, run: () => moveToLane(item.id, target, { cwd: item.cwd || cwd }) })),
      { id: "edit-session-note", label: noteForSession(item.id) ? "Edit note" : "Add note", run: () => editSessionNote(item.id) },
      ...(lane ? [
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
      button.title = selected ? `${markerColorLabel(color.id)} marker selected` : `Mark ${markerColorLabel(color.id)}`;
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

  const unattachedWorkersExpansionId = "__unattached-workers__";

  function branchContainsSession(branch: WorkerBranchView<SessionInfo>, sessionId: string) {
    if (!sessionId) return false;
    const stack = [branch];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current.node.id === sessionId) return true;
      stack.push(...current.children);
    }
    return false;
  }

  function appendWorkerBranch(container: HTMLElement, branch: WorkerBranchView<SessionInfo>, cwd: string, depth = 0) {
    container.append(buildSessionItem(branch.node.item, cwd, { branch, workerDepth: depth }));
    if (!branch.expanded) return;
    for (const child of branch.children) appendWorkerBranch(container, child, cwd, depth + 1);
  }

  function hasActiveSessionListFilters() {
    return Boolean(
      sessionSearchInput?.value.trim()
      || laneFilter !== "all"
      || allowedMarkerColors.size > 0
      || unreadFilterActive,
    );
  }

  /** Patch only the affected visible branch rows for frequent runtime changes. */
  function patchRenderedRuntimeBranch(sessionId: string) {
    if (elements.sessionDrawer.hidden || hasActiveSessionListFilters()) return false;
    const forest = buildSpawnWorkerForest(cachedSessions, state.sessionOrigins || [], {
      isRunning: (item) => isSessionRunning(item.id, Boolean(item.runtime?.isRunning)),
    });
    const view = deriveWorkerBranchView(forest, {
      expandedParentIds: state.expandedWorkerBranches,
      forceExpandedSessionIds: originParentOf(state.currentSessionId) ? new Set([state.currentSessionId]) : new Set(),
    });
    const byId = new Map<string, WorkerBranchView<SessionInfo>>();
    const stack = [...view.roots, ...view.unattachedWorkers];
    while (stack.length > 0) {
      const branch = stack.pop()!;
      byId.set(branch.node.id, branch);
      stack.push(...branch.children);
    }

    const affectedIds = new Set<string>();
    let currentId: string | undefined = sessionId;
    while (currentId && !affectedIds.has(currentId)) {
      affectedIds.add(currentId);
      currentId = byId.get(currentId)?.node.parentId;
    }
    for (const affectedId of affectedIds) {
      const branch = byId.get(affectedId);
      if (!branch) continue;
      const rows = elements.sessionListEl.querySelectorAll<HTMLElement>(`.sessionItem[data-session-id="${CSS.escape(affectedId)}"]`);
      for (const row of rows) {
        const depth = Number(row.dataset.workerDepth || "0");
        row.replaceWith(buildSessionItem(branch.node.item, branch.node.item.cwd || state.currentCwd || "", {
          branch,
          workerDepth: Number.isFinite(depth) ? depth : 0,
        }));
      }
    }
    return true;
  }

  function renderSessionList(sessions: SessionInfo[]) {
    if (sessionListRenderFrame !== undefined) {
      window.cancelAnimationFrame(sessionListRenderFrame);
      sessionListRenderFrame = undefined;
    }
    closeOpenSessionActionsMenu();
    elements.sessionListEl.textContent = "";

    if (sessions.length === 0) {
      if (sessionWorkerCollapseAllButton) sessionWorkerCollapseAllButton.hidden = true;
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
    if (sessionColorFilterButton) laneFilters.append(sessionColorFilterButton);
    const bucketFilters = document.createElement("span"); bucketFilters.className = "sessionBucketFilters"; bucketFilters.setAttribute("role", "group"); bucketFilters.setAttribute("aria-label", "Quick bucket selection");
    for (const color of sessionMarkerColors) {
      const selected = quickBucketColor === color.id;
      const dot = document.createElement("button"); dot.type = "button"; dot.className = `sessionBucketFilter marker-${color.id}${selected ? " selected" : ""}`;
      dot.title = selected ? `Stop marking ${markerColorLabel(color.id)}` : `Mark multiple sessions ${markerColorLabel(color.id)}`;
      dot.setAttribute("aria-label", dot.title);
      dot.setAttribute("aria-pressed", String(selected));
      dot.addEventListener("click", () => {
        quickBucketColor = selected ? undefined : color.id;
        if (!selected && state.selectedMarkerColor !== color.id) {
          state.selectedMarkerColor = color.id;
          persistSessionUiState({ selectedMarkerColor: color.id });
        }
        renderSessionList(cachedSessions);
      });
      bucketFilters.append(dot);
    }
    laneFilters.append(bucketFilters); elements.sessionListEl.append(laneFilters);

    const workerForest = buildSpawnWorkerForest(sessions, state.sessionOrigins || [], {
      isRunning: (item) => isSessionRunning(item.id, Boolean(item.runtime?.isRunning)),
    });
    const currentIsWorker = Boolean(
      state.currentSessionId
      && originParentOf(state.currentSessionId)
      && sessions.some((session) => session.id === state.currentSessionId),
    );
    const workerView = deriveWorkerBranchView(workerForest, {
      ...(filterActive ? { matches: matchesFilter } : {}),
      expandedParentIds: state.expandedWorkerBranches,
      forceExpandedSessionIds: currentIsWorker ? new Set([state.currentSessionId]) : new Set(),
    });

    const validExpansionIds = new Set<string>();
    const expansionStack = [...workerForest.roots, ...workerForest.unattachedWorkers];
    while (expansionStack.length > 0) {
      const branch = expansionStack.pop()!;
      if (branch.children.length > 0) validExpansionIds.add(branch.id);
      expansionStack.push(...branch.children);
    }
    if (workerForest.unattachedWorkers.length > 0) validExpansionIds.add(unattachedWorkersExpansionId);
    let prunedExpansion = false;
    for (const sessionId of state.expandedWorkerBranches) {
      if (validExpansionIds.has(sessionId)) continue;
      state.expandedWorkerBranches.delete(sessionId);
      prunedExpansion = true;
    }
    if (prunedExpansion) persistExpandedWorkerBranches(state.expandedWorkerBranches);
    if (sessionWorkerCollapseAllButton) {
      sessionWorkerCollapseAllButton.hidden = state.expandedWorkerBranches.size === 0;
      sessionWorkerCollapseAllButton.title = `Collapse ${state.expandedWorkerBranches.size} open worker ${state.expandedWorkerBranches.size === 1 ? "branch" : "branches"}`;
    }

    const groups = new Map<string, WorkerBranchView<SessionInfo>[]>();
    for (const branch of workerView.roots) {
      const cwd = branch.node.item.cwd || state.currentCwd || "";
      groups.set(cwd, [...(groups.get(cwd) || []), branch]);
    }

    const pinnedEntries: Array<[string, WorkerBranchView<SessionInfo>[]]> = state.pinnedFolders
      .filter((cwd) => groups.has(cwd))
      .map((cwd) => [cwd, groups.get(cwd)!]);
    const pinnedFolders = new Set(state.pinnedFolders);
    const unpinnedEntries = Array.from(groups.entries()).filter(([cwd]) => !pinnedFolders.has(cwd));
    const orderedEntries = [...pinnedEntries, ...unpinnedEntries];
    const folderLabels = folderDisplayNames(orderedEntries.map(([cwd]) => cwd));

    for (const [cwd, branches] of orderedEntries) {
      const folderPinned = isFolderPinned(cwd);
      const folderCollapsed = state.collapsedSessionFolders.has(cwd);
      const containsCurrentWorker = currentIsWorker && branches.some((branch) => branchContainsSession(branch, state.currentSessionId));
      const folderOpen = !folderCollapsed || filterActive || containsCurrentWorker;
      const group = document.createElement("section");
      group.className = `sessionFolderGroup${folderPinned ? " pinned" : ""}`;

      const header = document.createElement("div");
      header.className = "sessionFolderHeader";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "sessionFolderToggle";
      toggle.setAttribute("aria-expanded", String(folderOpen));
      toggle.title = folderOpen ? "Collapse folder" : "Expand folder";
      const chevron = document.createElement("span");
      chevron.className = "sessionFolderChevron";
      chevron.textContent = folderOpen ? "▾" : "▸";
      const labels = document.createElement("span");
      labels.className = "sessionFolderLabels";
      const name = document.createElement("span");
      name.className = "sessionFolderName";
      name.textContent = folderLabels.get(cwd) || folderName(cwd);
      name.title = cwd;
      const count = document.createElement("span");
      count.className = "sessionFolderMatchCount";
      count.textContent = String(branches.length);
      labels.append(name, count);
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

      if (!folderOpen) {
        elements.sessionListEl.append(group);
        continue;
      }

      const folderExpanded = state.expandedSessionFolders.has(cwd);
      let visibleBranches = folderExpanded ? branches : branches.slice(0, sessionFolderPreviewLimit);
      if (!folderExpanded && containsCurrentWorker && !visibleBranches.some((branch) => branchContainsSession(branch, state.currentSessionId))) {
        const activeBranch = branches.find((branch) => branchContainsSession(branch, state.currentSessionId));
        if (activeBranch) visibleBranches = [...visibleBranches.slice(0, Math.max(0, sessionFolderPreviewLimit - 1)), activeBranch];
      }
      for (const branch of visibleBranches) appendWorkerBranch(group, branch, cwd);

      if (branches.length > sessionFolderPreviewLimit) {
        const moreButton = document.createElement("button");
        moreButton.type = "button";
        moreButton.className = "sessionFolderMoreButton";
        moreButton.textContent = folderExpanded ? "Show fewer" : `Show all ${branches.length} sessions`;
        moreButton.addEventListener("click", () => {
          if (folderExpanded) state.expandedSessionFolders.delete(cwd);
          else state.expandedSessionFolders.add(cwd);
          renderSessionList(cachedSessions);
        });
        group.append(moreButton);
      }

      elements.sessionListEl.append(group);
    }

    if (workerView.unattachedWorkers.length > 0) {
      const forcedOpen = filterActive || workerView.unattachedWorkers.some((branch) => branchContainsSession(branch, state.currentSessionId));
      const open = forcedOpen || state.expandedWorkerBranches.has(unattachedWorkersExpansionId);
      const group = document.createElement("section");
      group.className = "sessionFolderGroup sessionUnattachedWorkerGroup";
      const header = document.createElement("div");
      header.className = "sessionFolderHeader";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "sessionFolderToggle";
      toggle.setAttribute("aria-expanded", String(open));
      toggle.disabled = forcedOpen;
      toggle.title = forcedOpen ? "Expanded by the current filter or active worker" : open ? "Collapse unattached workers" : "Expand unattached workers";
      const chevron = document.createElement("span");
      chevron.className = "sessionFolderChevron";
      chevron.textContent = open ? "▾" : "▸";
      const labels = document.createElement("span");
      labels.className = "sessionFolderLabels";
      const name = document.createElement("span");
      name.className = "sessionFolderName";
      name.textContent = "Unattached workers";
      const count = document.createElement("span");
      count.className = "sessionFolderMatchCount";
      count.textContent = String(workerView.unattachedWorkers.reduce((total, branch) => total + 1 + branch.node.descendantWorkerCount, 0));
      labels.append(name, count);
      toggle.append(chevron, labels);
      toggle.addEventListener("click", () => {
        if (state.expandedWorkerBranches.has(unattachedWorkersExpansionId)) state.expandedWorkerBranches.delete(unattachedWorkersExpansionId);
        else state.expandedWorkerBranches.add(unattachedWorkersExpansionId);
        persistExpandedWorkerBranches(state.expandedWorkerBranches);
        renderSessionList(cachedSessions);
      });
      header.append(toggle);
      group.append(header);
      if (open) {
        for (const branch of workerView.unattachedWorkers) appendWorkerBranch(group, branch, branch.node.item.cwd || state.currentCwd || "");
      }
      elements.sessionListEl.append(group);
    }

    if (filterActive && orderedEntries.length === 0 && workerView.unattachedWorkers.length === 0) {
      elements.sessionListEl.replaceChildren(laneFilters);
      const empty = document.createElement("p");
      empty.className = "sessionEmpty";
      empty.textContent = query
        ? "No matching sessions."
        : unreadFilterActive
          ? "No unread sessions."
          : laneFilter !== "all"
            ? "No sessions in the selected lane."
            : "No sessions in the selected colors.";
      elements.sessionListEl.append(empty);
    }
  }

  function buildSessionItem(
    item: SessionInfo,
    cwd: string,
    options: { branch?: WorkerBranchView<SessionInfo>; workerDepth?: number } = {},
  ): HTMLElement {
    // Use a div so we can have sibling buttons (navigate + actions) without nesting buttons.
    const marker = markerForSession(item.id);
    const markerColor = colorForMarker(marker?.color);
    const pinned = isPinned(item.id);
    const indicator = sessionIndicator(item.id, { running: item.runtime?.isRunning, unread: item.unread });
    const unread = indicator.kind === "unread";
    const workerCount = options.branch?.node.descendantWorkerCount || 0;
    const runningWorkerCount = options.branch?.node.runningDescendantWorkerCount || 0;
    const waiting = workerCount === 0 && indicator.kind === "waiting" ? indicator.waiting : undefined;
    const workerDepth = options.workerDepth || 0;
    const row = document.createElement("div");
    row.className = `sessionItem${item.isCurrent ? " current" : ""}${unread ? " unread" : ""}${pinned ? " pinned" : ""}${markerColor ? ` marked marker-${markerColor.id}` : ""}${workerDepth > 0 ? " sessionItemWorker" : ""}${options.branch?.contextOnly ? " sessionItemContext" : ""}`;
    row.dataset.sessionId = item.id;
    row.dataset.workerDepth = String(workerDepth);
    if (workerDepth > 0) row.style.setProperty("--session-worker-indent", `${workerDepth * 16}px`);
    if (item.isCurrent) row.setAttribute("aria-current", "page");

    const markerButton = document.createElement("button");
    markerButton.type = "button";
    const quickBucket = quickBucketColor ? colorForMarker(quickBucketColor) : undefined;
    const quickBucketSelected = Boolean(quickBucket && markerColor?.id === quickBucket.id);
    markerButton.className = quickBucket
      ? `sessionItemMarkerBtn toolMarker marker-${quickBucket.id}${quickBucketSelected ? " selected" : ""}`
      : `sessionItemMarkerBtn toolPin${pinned ? " pinned" : ""}`;
    markerButton.title = quickBucket
      ? quickBucketSelected
        ? `Remove ${quickBucket.label} bucket`
        : `Mark session ${quickBucket.label}`
      : pinned ? "Remove from pinned lane" : "Move to pinned lane";
    markerButton.setAttribute("aria-label", markerButton.title);
    markerButton.setAttribute("aria-pressed", String(quickBucket ? quickBucketSelected : pinned));
    markerButton.append(iconElement(quickBucket ? "flag" : "pin"));
    if (markerColor) {
      const markerDot = document.createElement("span");
      markerDot.className = "sessionItemMarkerDot";
      markerDot.title = `${markerColor.label} bucket`;
      markerDot.setAttribute("aria-hidden", "true");
      markerButton.append(markerDot);
    }
    markerButton.addEventListener("click", () => {
      if (!quickBucket) {
        togglePin(item);
        return;
      }
      if (quickBucketSelected) clearSessionMarker(item.id);
      else setSessionMarker(item.id, quickBucket.id);
    });

    let workerToggle: HTMLButtonElement | undefined;
    if (options.branch && options.branch.children.length > 0) {
      const toggle = document.createElement("button");
      workerToggle = toggle;
      toggle.type = "button";
      toggle.className = `sessionWorkerBranchToggle${options.branch.expanded ? " expanded" : ""}`;
      const workerChevron = iconElement("chevron-right");
      workerChevron.classList.add("sessionWorkerBranchChevron");
      toggle.append(workerChevron);
      toggle.setAttribute("aria-expanded", String(options.branch.expanded));
      toggle.setAttribute("aria-label", `${options.branch.expanded ? "Collapse" : "Expand"} ${workerCount} worker ${workerCount === 1 ? "session" : "sessions"}`);
      toggle.title = options.branch.forcedExpanded ? "Expanded by the current filter or active worker" : toggle.getAttribute("aria-label") || "Worker sessions";
      toggle.disabled = options.branch.forcedExpanded;
      toggle.addEventListener("click", () => {
        if (state.expandedWorkerBranches.has(item.id)) state.expandedWorkerBranches.delete(item.id);
        else state.expandedWorkerBranches.add(item.id);
        persistExpandedWorkerBranches(state.expandedWorkerBranches);
        renderSessionList(cachedSessions);
      });
    }

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

    navBtn.append(titleRow);
    if (workerCount > 0) {
      const summary = document.createElement("span");
      summary.className = `sessionWorkerSummary${runningWorkerCount > 0 ? " running" : ""}`;
      summary.textContent = runningWorkerCount > 0
        ? `${workerCount} worker${workerCount === 1 ? "" : "s"} · ${runningWorkerCount} running`
        : `${workerCount} worker${workerCount === 1 ? "" : "s"}`;
      summary.title = summary.textContent;
      navBtn.append(summary);
    } else {
      navBtn.append(meta);
    }
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
    const sessionNote = noteForSession(item.id);
    if (sessionNote) { const note = document.createElement("span"); note.className = "sessionLaneNote"; note.textContent = sessionNote; note.title = sessionNote; navBtn.append(note); }
    if (laneEntry && isStale(laneEntry)) { const stale = document.createElement("span"); stale.className = "sessionStaleBadge"; stale.textContent = "stale"; titleRow.append(stale); }
    row.append(markerButton);
    if (workerToggle) {
      row.append(workerToggle);
    } else if (workerDepth === 0) {
      const workerToggleSpacer = document.createElement("span");
      workerToggleSpacer.className = "sessionWorkerBranchSpacer";
      workerToggleSpacer.setAttribute("aria-hidden", "true");
      row.append(workerToggleSpacer);
    }
    row.append(navBtn, actionsBtn);
    sessionInspector.attach(row, item.id, "session");
    return row;
  }

  function init() {
    document.addEventListener("pi-web-bucket-labels-changed", () => {
      renderSessionList(cachedSessions);
      renderSessionBar();
      renderCurrentSessionBucketButton();
      renderSessionColorFilterButton();
    });
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
      sessionWorkerCollapseAllButton = document.createElement("button");
      sessionWorkerCollapseAllButton.type = "button";
      sessionWorkerCollapseAllButton.className = "sessionWorkerCollapseAllButton";
      sessionWorkerCollapseAllButton.textContent = "Collapse all";
      sessionWorkerCollapseAllButton.hidden = true;
      sessionWorkerCollapseAllButton.addEventListener("click", () => {
        state.expandedWorkerBranches.clear();
        persistExpandedWorkerBranches(state.expandedWorkerBranches);
        renderSessionList(cachedSessions);
      });
      sessionColorFilterButton = document.createElement("button");
      sessionColorFilterButton.type = "button";
      sessionColorFilterButton.className = "sessionColorFilterButton";
      sessionColorFilterButton.setAttribute("aria-haspopup", "menu");
      sessionColorFilterButton.addEventListener("click", () => openSessionColorFilterMenu(sessionColorFilterButton!));
      renderSessionColorFilterButton();
      filterWrap.append(sessionSearchInput, sessionWorkerCollapseAllButton);
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
    // External reconciliation requests represent a known state transition and
    // must bypass the drawer-open TTL. Internal opportunistic reads still dedupe.
    refreshSessions: () => refreshSessions(true),
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
    moveCurrentSessionToLane,
    focusedLaneSessionCount,
  };
}
