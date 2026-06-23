import type { ApiClient } from "../app/api.js";
import type { AppElements } from "../app/elements.js";
import { iconElement, setIcon, type IconName } from "../app/icons.js";
import { blurActiveEditableOnMobile } from "../app/focus.js";
import type { AppState, SessionInfo, SessionMarkerColorId, SessionUiState } from "../app/types.js";
import { defaultSessionUiState, normalizeSessionUiState, persistCollapsedSessionFolders, sessionFolderPreviewLimit, sessionMarkerColors, writeActiveSessionIdToUrl } from "../app/types.js";

export type SessionsController = {
  init: () => void;
  refreshSessions: () => Promise<void>;
  setSessionDrawerOpen: (open: boolean) => void;
  startNewSession: (cwd?: string) => Promise<void>;
  updateSessionRuntime: (sessionId: string, runtime: SessionInfo["runtime"]) => void;
  updateEmptyCwdChooser: () => void;
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
  return window.matchMedia("(max-width: 700px)").matches;
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
  // Tracks runtime state for pinned sessions independently of cachedSessions so
  // session_runtime_changed events can update the bar even before the first
  // refreshSessions() completes.
  const pinnedRuntimes = new Map<string, SessionInfo["runtime"]>();
  let closeSessionActionsMenu: (() => void) | undefined;
  let currentSessionPinButton: HTMLButtonElement | undefined;
  let sessionSearchInput: HTMLInputElement | undefined;
  let sessionColorFilterButton: HTMLButtonElement | undefined;
  let markerPaletteEl: HTMLDivElement | undefined;
  let closeSessionColorFilterMenu: (() => void) | undefined;
  let closeCurrentSessionBucketMenu: (() => void) | undefined;
  const allowedMarkerColors = new Set<SessionMarkerColorId>();
  type SessionRowTool = "pin" | SessionMarkerColorId;
  let selectedSessionRowTool: SessionRowTool = state.selectedMarkerColor;

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
    elements.emptyCwdPathEl.textContent = state.currentCwd;
    elements.emptyCwdChooserEl.hidden = elements.messagesEl.children.length > 0 || state.isStreaming;
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
    updateMeta(data);
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
    const res = await fetch("/api/sessions/new", {
      method: "POST",
      headers: api.headers(),
      body: JSON.stringify({ ...(cwd ? { cwd } : {}), sessionId: state.currentSessionId }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    if (data.sessionId) writeActiveSessionIdToUrl(data.sessionId);
    rememberSessionCwd(cwd || data.cwd || state.currentCwd);
    clearMessages();
    updateMeta(data);
    await refreshState();
    updateEmptyCwdChooser();
    if (shouldCloseDrawerAfterSessionSwitch()) {
      setSessionDrawerOpen(false);
    } else {
      await setSessionDrawerOpen(true);
      scrollCurrentSessionIntoView();
    }
  }

  function setSessionDrawerOpen(open: boolean) {
    if (open) blurActiveEditableOnMobile();
    persistSessionDrawerOpen(open);
    if (!open) {
      closeOpenSessionActionsMenu();
      closeOpenSessionColorFilterMenu();
    }
    elements.sessionDrawer.hidden = !open;
    elements.sessionBackdrop.hidden = !open;
    document.body.classList.toggle("sessionDrawerOpen", open);
    if (open) return refreshSessions().catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
  }

  function scrollCurrentSessionIntoView() {
    elements.sessionListEl.querySelector<HTMLElement>(".sessionItem.current")
      ?.scrollIntoView({ block: "nearest" });
  }

  async function refreshSessions() {
    rememberSessionCwd(state.currentCwd);
    const params = new URLSearchParams();
    for (const cwd of readKnownSessionCwds()) params.append("cwd", cwd);
    const url = params.toString() ? `/api/sessions?${params}` : "/api/sessions";
    const res = await fetch(url, { headers: api.headers() });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    cachedSessions = (data.sessions || []).map((item: SessionInfo) => ({ ...item, isCurrent: item.id === state.currentSessionId }));
    for (const session of cachedSessions) state.sessionsById[session.id] = { ...state.sessionsById[session.id], ...session };
    let pinnedCwdsChanged = false;
    state.pinnedSessions = state.pinnedSessions.map((pinned) => {
      const live = cachedSessions.find((s) => s.id === pinned.id);
      if (live?.cwd && live.cwd !== pinned.cwd) {
        pinnedCwdsChanged = true;
        return { ...pinned, cwd: live.cwd };
      }
      return pinned;
    });
    if (pinnedCwdsChanged) persistSessionUiState({ pinnedSessions: state.pinnedSessions });
    renderSessionList(cachedSessions);
    renderSessionBar();
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
    return state.sessionUnreadStates.some((item) => item.sessionId !== state.currentSessionId && !isSessionRunning(item.sessionId));
  }

  function updateSessionButtonUnread() {
    const unread = hasVisibleUnreadSessions();
    elements.sessionButton.classList.toggle("unread", unread);
    const title = unread ? "Sessions · unread activity" : "Sessions";
    elements.sessionButton.title = title;
    elements.sessionButton.setAttribute("aria-label", title);
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
    sessionColorFilterButton.classList.toggle("active", colors.length > 0);
    sessionColorFilterButton.title = colors.length === 0
      ? "Filter marker colors: all colors allowed"
      : `Filter marker colors: ${colors.map(markerColorLabel).join(", ")}`;
    sessionColorFilterButton.setAttribute("aria-label", sessionColorFilterButton.title);
    sessionColorFilterButton.setAttribute("aria-expanded", String(Boolean(closeSessionColorFilterMenu)));

    if (colors.length === 0) {
      const label = document.createElement("span");
      label.textContent = "All colors";
      sessionColorFilterButton.append(label);
      return;
    }

    const dots = document.createElement("span");
    dots.className = "sessionColorFilterDots";
    for (const color of colors) {
      const dot = document.createElement("span");
      dot.className = `sessionColorFilterDot marker-${color}`;
      dot.setAttribute("aria-hidden", "true");
      dots.append(dot);
    }
    const label = document.createElement("span");
    label.textContent = colors.length === 1 ? markerColorLabel(colors[0]) : `${colors.length} colors`;
    sessionColorFilterButton.append(dots, label);
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
    title.textContent = "Allowed marker colors";
    menu.append(title);

    const allButton = document.createElement("button");
    allButton.type = "button";
    allButton.className = "sessionColorFilterMenuItem all";
    allButton.setAttribute("role", "menuitemcheckbox");
    const allLabel = document.createElement("span");
    allLabel.textContent = "All colors";
    allButton.append(allLabel);
    menu.append(allButton);

    const colorButtons: Array<{ color: SessionMarkerColorId; button: HTMLButtonElement }> = [];
    const updateMenuState = () => {
      const allSelected = allowedMarkerColors.size === 0;
      allButton.classList.toggle("selected", allSelected);
      allButton.setAttribute("aria-checked", String(allSelected));
      allButton.title = allSelected ? "All marker colors are allowed" : "Allow all marker colors";
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
    state.pinnedSessions = [...state.pinnedSessions, { id: item.id, cwd: item.cwd || state.currentCwd }];
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

  async function openSessionTab(sessionId: string, cwd: string) {
    const previousSessionId = state.currentSessionId;
    const switchingSessions = state.currentSessionId !== sessionId;
    if (switchingSessions) {
      const knownSession = state.sessionsById[sessionId];
      const knownTitle = knownSession ? sessionTitle(knownSession as SessionInfo) : "";
      state.currentSessionId = sessionId;
      state.currentSessionTitle = knownTitle || "Session";
      renderSessionBar();
      renderCurrentSessionBucketButton();
      clearMessages();
    }
    try {
      const openRes = await fetch("/api/sessions/open", {
        method: "POST",
        headers: api.headers(),
        body: JSON.stringify({ sessionId, cwd, clientId: api.clientId }),
      });
      if (!openRes.ok) throw new Error(await openRes.text());
      writeActiveSessionIdToUrl(sessionId);
      rememberSessionCwd(cwd);
      markCachedCurrentSession(sessionId, cwd);
      markSessionReadBestEffort(sessionId);
      await refreshState();
      if (switchingSessions) await refreshMessages();
    } catch (error) {
      state.currentSessionId = previousSessionId;
      renderSessionBar();
      renderCurrentSessionBucketButton();
      addMessage("system", error instanceof Error ? error.message : String(error), "error");
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
      state.pinnedSessions = [...state.pinnedSessions, { id: currentId, cwd: state.currentCwd }];
      persistSessionUiState({ pinnedSessions: state.pinnedSessions });
      renderSessionBar();
      updateCurrentSessionPinButton();
    }
  }

  // ── Session bar ────────────────────────────────────────────────────────────

  function renderSessionBar() {
    const bar = elements.sessionBarEl;
    const pinned = state.pinnedSessions;
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

    updateCurrentSessionPinButton();

    let activeTab: HTMLElement | undefined;
    const appendTab = (sessionId: string, label: string, cwd: string, options: { pinned: boolean; running?: boolean; unread?: boolean }) => {
      const isActive = currentId === sessionId;
      const unread = isSessionUnread(sessionId, Boolean(options.unread), Boolean(options.running));
      const markerColor = colorForMarker(markerForSession(sessionId)?.color);
      const tab = document.createElement("div");
      tab.className = `sessionBarTab${isActive ? " active" : ""}${unread ? " unread" : ""}${options.running ? " running" : ""}${options.pinned ? " pinned" : " temporary"}${markerColor ? ` marked marker-${markerColor.id}` : ""}`;
      if (isActive) activeTab = tab;

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
      body: JSON.stringify({ sessionId: item.id, cwd: item.cwd || cwd, activeSessionId: state.currentSessionId }),
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

  function getSessionActions(item: SessionInfo, cwd: string): SessionAction[] {
    const deleteDisabledReason = item.isCurrent
      ? "Switch to another session before deleting the current session"
      : item.runtime?.isRunning
        ? "Wait for the session to finish before deleting it"
        : undefined;
    const pinned = isPinned(item.id);
    return [
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
      if (allowedMarkerColors.size > 0 && !allowedMarkerColors.has(marker?.color as SessionMarkerColorId)) return false;
      if (!query) return true;
      return [sessionTitle(item), item.cwd || "", item.firstMessage || ""]
        .some((value) => value.toLowerCase().includes(query));
    };
    const filterActive = Boolean(query || allowedMarkerColors.size > 0);

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

    for (const [cwd, items] of orderedEntries) {
      const folderPinned = isFolderPinned(cwd);
      const group = document.createElement("section");
      group.className = `sessionFolderGroup${folderPinned ? " pinned" : ""}`;

      const header = document.createElement("div");
      header.className = "sessionFolderHeader";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "sessionFolderToggle";
      toggle.setAttribute("aria-expanded", String(!state.collapsedSessionFolders.has(cwd)));
      toggle.title = state.collapsedSessionFolders.has(cwd) ? "Expand folder" : "Collapse folder";
      const chevron = document.createElement("span");
      chevron.className = "sessionFolderChevron";
      chevron.textContent = state.collapsedSessionFolders.has(cwd) ? "▸" : "▾";
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

      if (state.collapsedSessionFolders.has(cwd)) {
        elements.sessionListEl.append(group);
        continue;
      }

      const filteredItems = items.filter(matchesFilter);
      const folderExpanded = state.expandedSessionFolders.has(cwd);
      const visibleItems = folderExpanded ? filteredItems : filteredItems.slice(0, sessionFolderPreviewLimit);

      if (filteredItems.length === 0 && filterActive) {
        const empty = document.createElement("p");
        empty.className = "sessionEmpty";
        empty.textContent = query ? "No matching sessions in this folder." : "No sessions in the selected colors.";
        group.append(empty);
      }

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
    meta.textContent = `${formatRelativeTime(item.modified)} · ${item.messageCount}`;

    navBtn.append(titleRow, meta);
    navBtn.addEventListener("click", async () => {
      const previousSessionId = state.currentSessionId;
      const nextCwd = item.cwd || cwd;
      const switchingSessions = state.currentSessionId !== item.id;
      if (switchingSessions) {
        state.currentSessionId = item.id;
        renderSessionBar();
        renderCurrentSessionBucketButton();
        clearMessages();
      }
      try {
        const openRes = await fetch("/api/sessions/open", {
          method: "POST",
          headers: api.headers(),
          body: JSON.stringify({ sessionId: item.id, cwd: nextCwd, clientId: api.clientId }),
        });
        if (!openRes.ok) throw new Error(await openRes.text());
        writeActiveSessionIdToUrl(item.id);
        rememberSessionCwd(nextCwd);
        markCachedCurrentSession(item.id, nextCwd);
        markSessionReadBestEffort(item.id);
        if (shouldCloseDrawerAfterSessionSwitch()) setSessionDrawerOpen(false);
        await refreshState();
        if (switchingSessions) await refreshMessages();
      } catch (error) {
        if (switchingSessions) {
          state.currentSessionId = previousSessionId;
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
      filterWrap.append(sessionSearchInput, sessionColorFilterButton, markerPaletteEl);
      headerTitle.replaceWith(filterWrap);
    }

    const footer = document.createElement("div");
    footer.className = "sessionDrawerFooter";
    elements.settingsButton.classList.add("sessionDrawerFooterButton");
    elements.settingsButton.textContent = "";
    setIcon(elements.settingsButton, "settings");
    elements.settingsButton.append(document.createTextNode("Settings"));
    elements.sessionNewButton.textContent = "+ New session";
    footer.append(elements.settingsButton, elements.sessionNewButton);
    elements.sessionDrawer.append(footer);

    elements.sessionButton.addEventListener("click", () => setSessionDrawerOpen(true));
    elements.currentSessionBucketButton.addEventListener("click", () => openCurrentSessionBucketMenu(elements.currentSessionBucketButton));
    renderCurrentSessionBucketButton();
    elements.newSessionHeaderButton.addEventListener("click", async () => {
      try {
        await startNewSession();
      } catch (error) {
        addMessage("system", error instanceof Error ? error.message : String(error), "error");
      }
    });
    elements.sessionCloseButton.addEventListener("click", () => setSessionDrawerOpen(false));
    elements.sessionBackdrop.addEventListener("click", () => setSessionDrawerOpen(false));
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
    updateSessionRuntime,
    renderSessionBar,
    renderCurrentSessionBucketButton,
    applySessionUiState,
    markSessionRead,
  };
}
