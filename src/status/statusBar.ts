import type { ApiClient } from "../app/api.js";
import type { AppElements } from "../app/elements.js";
import type { AppState } from "../app/types.js";
import { sessionRuntime, type SessionStateController } from "../app/sessionState.js";
import { connectionLostDelayMs, reconnectDelayMs, reconnectNoticeDelayMs } from "../app/types.js";
import { iconElement } from "../app/icons.js";
import type { WaitingInfo } from "../sessions/lineage.js";
import { createSessionRefChip } from "../app/sessionRefs.js";


export type StatusBar = {
  init: () => void;
  setStatusTitle: (title: string) => void;
  refreshSessionTitle: (sessionId?: string) => Promise<void>;
  markWebSocketOpen: () => void;
  markWebSocketClosed: () => void;
  markSyncRequired: () => void;
  markActivityStart: (label?: string, startedAt?: string | number | Date, lastActivityAt?: string | number | Date) => void;
  markActivityProgress: (label?: string, lastActivityAt?: string | number | Date) => void;
  markActivityEnd: () => void;
  updateWaitingStatus: (info: WaitingInfo | undefined) => void;
};

const activityQuietNoticeMs = 30_000;
const activityQuietWarnMs = 120_000;

function formatActivityDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

type ActivityEntry = { startedAt?: number; lastUpdateAt: number; label: string };

function parseActivityTimestamp(value: string | number | Date | undefined) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function createStatusBar(options: {
  state: AppState;
  elements: AppElements;
  api: ApiClient;
  sessionState: SessionStateController;
  addMessage: (role: "system", text: string, extraClass?: string) => void;
  refreshSessions: () => Promise<void>;
  refreshState: () => Promise<void>;
  /** Switch to a spawned session in place (late-bound: sessions is created after). */
  openSession?: (sessionId: string, cwd: string) => Promise<void> | void;
}): StatusBar {
  const { state, elements, api, sessionState, addMessage, refreshSessions, refreshState, openSession } = options;
  const activityBySession = new Map<string, ActivityEntry>();
  let activityTimer: number | undefined;

  function setStatusTitle(title: string) {
    const value = title.trim() || "New session";
    state.currentSessionTitle = value;
    elements.statusTitleEl.title = "Rename session";
    elements.statusTitleEl.setAttribute("aria-label", `Session: ${value}. Click to rename.`);
    if (!state.statusTitleEditing) elements.statusTitleEl.textContent = value;
  }

  async function renameCurrentSession(name: string) {
    const previous = state.currentSessionTitle;
    setStatusTitle(name || "New session");
    try {
      const res = await fetch("/api/session/name", {
        method: "POST",
        headers: api.headers(),
        body: JSON.stringify({ sessionId: state.currentSessionId, name }),
      });
      const text = await res.text();
      const data = text ? JSON.parse(text) : {};
      if (!res.ok || data.ok === false) throw new Error(data.error || text);
      sessionState.applySnapshot(data);
    } catch (error) {
      setStatusTitle(previous);
      addMessage("system", error instanceof Error ? error.message : String(error), "error");
    }
  }

  function beginRenameSessionTitle() {
    if (state.statusTitleEditing || !state.currentSessionId) return;
    state.statusTitleEditing = true;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "statusTitleInput";
    input.value = state.currentSessionTitle === "New session" ? "" : state.currentSessionTitle;
    input.placeholder = "New session";
    input.maxLength = 200;
    input.setAttribute("aria-label", "Session name");
    const originalValue = input.value.trim();

    let finished = false;
    const finish = (save: boolean) => {
      if (finished) return;
      finished = true;
      state.statusTitleEditing = false;
      const next = input.value.trim();
      if (save && next !== originalValue) void renameCurrentSession(next);
      else setStatusTitle(state.currentSessionTitle);
    };

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));

    elements.statusTitleEl.textContent = "";
    elements.statusTitleEl.append(input);
    input.focus();
    input.select();
  }

  function clearConnectionTimers() {
    if (state.reconnectNoticeTimer !== undefined) window.clearTimeout(state.reconnectNoticeTimer);
    if (state.connectionLostTimer !== undefined) window.clearTimeout(state.connectionLostTimer);
    state.reconnectNoticeTimer = undefined;
    state.connectionLostTimer = undefined;
  }

  function clearReconnectedTimer() {
    if (state.reconnectedClearTimer !== undefined) window.clearTimeout(state.reconnectedClearTimer);
    state.reconnectedClearTimer = undefined;
  }

  function setConnectionStatus(kind: "reconnecting" | "offline" | "reconnected" | "syncRequired", text: string, title = text) {
    clearReconnectedTimer();
    elements.connectionStatusEl.className = `connectionStatus ${kind}`;
    elements.connectionStatusEl.textContent = text;
    elements.connectionStatusEl.title = title;
    const reloadable = kind === "offline" || kind === "syncRequired";
    elements.connectionStatusEl.toggleAttribute("role", reloadable);
    elements.connectionStatusEl.tabIndex = reloadable ? 0 : -1;
    elements.connectionStatusEl.setAttribute("aria-label", reloadable ? `${text}. Refresh page.` : text);
    elements.connectionStatusEl.hidden = false;
  }

  function hideConnectionStatus() {
    clearReconnectedTimer();
    elements.connectionStatusEl.hidden = true;
    elements.connectionStatusEl.textContent = "";
    elements.connectionStatusEl.title = "";
    elements.connectionStatusEl.className = "connectionStatus";
    elements.connectionStatusEl.removeAttribute("role");
    elements.connectionStatusEl.removeAttribute("aria-label");
    elements.connectionStatusEl.tabIndex = -1;
  }

  function activityKey() {
    return state.currentSessionId || "__current";
  }

  function currentActivity() {
    return activityBySession.get(activityKey());
  }

  function updateActivityStatus(forceVisible = false) {
    const activity = currentActivity();
    if (!activity) return;
    const now = Date.now();
    const quietFor = now - activity.lastUpdateAt;
    const quiet = quietFor >= activityQuietNoticeMs;
    const warn = quietFor >= activityQuietWarnMs;
    const elapsedText = activity.startedAt ? ` ${formatActivityDuration(now - activity.startedAt)}` : "";
    const className = warn ? "stale" : quiet ? "quiet" : "running";
    const text = `Running${elapsedText}${activity.label ? ` · ${activity.label}` : ""}${quiet ? ` · no updates ${formatActivityDuration(quietFor)}` : ""}`;
    const runtime = sessionRuntime(state);
    const title = activity.startedAt
      ? `Session is still active. Last update ${formatActivityDuration(quietFor)} ago.${runtime.isStreaming || runtime.isRetrying ? " Use Stop to cancel if needed." : ""}`
      : `Session is still active, but its original start time is unavailable.${runtime.isStreaming || runtime.isRetrying ? " Use Stop to cancel if needed." : ""}`;
    elements.activityStatusEl.className = `activityStatus ${className}`;
    elements.activityStatusEl.textContent = text;
    elements.activityStatusEl.title = title;
    elements.activityStatusEl.hidden = true;
    elements.runtimeStatusEl.className = `runtimeStatus ${className}`;
    elements.runtimeStatusEl.textContent = text;
    elements.runtimeStatusEl.title = title;
    elements.runtimeStatusEl.hidden = false;
  }

  function clearActivityTimers() {
    if (activityTimer !== undefined) window.clearInterval(activityTimer);
    activityTimer = undefined;
  }

  function ensureActivityTimers() {
    if (activityTimer === undefined) activityTimer = window.setInterval(() => updateActivityStatus(), 1000);
  }

  function markActivityStart(label = "starting", startedAt?: string | number | Date, lastActivityAt?: string | number | Date) {
    const now = Date.now();
    const key = activityKey();
    const parsedStartedAt = parseActivityTimestamp(startedAt);
    const parsedLastActivityAt = parseActivityTimestamp(lastActivityAt);
    let activity = activityBySession.get(key);
    if (!activity) {
      activity = { startedAt: parsedStartedAt, lastUpdateAt: parsedLastActivityAt ?? now, label };
      activityBySession.set(key, activity);
      elements.activityStatusEl.hidden = true;
    } else {
      const startedAtChanged = Boolean(parsedStartedAt && (!activity.startedAt || Math.abs(activity.startedAt - parsedStartedAt) > 1000));
      if (startedAtChanged) activity.startedAt = parsedStartedAt;
      if (parsedLastActivityAt) activity.lastUpdateAt = parsedLastActivityAt;
      else if (startedAtChanged) activity.lastUpdateAt = now;
    }
    activity.label = label;
    updateActivityStatus(!elements.activityStatusEl.hidden);
    ensureActivityTimers();
  }

  function markActivityProgress(label?: string, lastActivityAt?: string | number | Date) {
    let activity = currentActivity();
    if (!activity) {
      markActivityStart(label || "working", undefined, lastActivityAt);
      return;
    }
    activity.lastUpdateAt = parseActivityTimestamp(lastActivityAt) ?? Date.now();
    if (label) activity.label = label;
    updateActivityStatus(!elements.activityStatusEl.hidden);
  }

  function markActivityEnd() {
    clearActivityTimers();
    activityBySession.delete(activityKey());
    elements.activityStatusEl.hidden = true;
    elements.activityStatusEl.textContent = "";
    elements.activityStatusEl.title = "";
    elements.activityStatusEl.className = "activityStatus";
    elements.runtimeStatusEl.hidden = true;
    elements.runtimeStatusEl.textContent = "";
    elements.runtimeStatusEl.title = "";
    elements.runtimeStatusEl.className = "runtimeStatus";
    renderWaitingStatus();
  }

  // Derived "waiting on spawned sessions" indicator, shown in the runtime
  // slot above the composer — but only while the session is otherwise idle:
  // precedence is running > waiting. Static pulsing hourglass (accent, same
  // color family as unread) + white text naming what it waits for.
  // Derived "waiting on spawned sessions" state, shown as a strip directly above
  // the composer. Each spawned session is a link, so the user can jump straight
  // into a worker while it runs. Only shown while this session is itself idle:
  // precedence is running > waiting.
  let waitingInfo: WaitingInfo | undefined;

  function clearWaitingRender() {
    elements.waitingSessionsEl.hidden = true;
    elements.waitingSessionsEl.replaceChildren();
  }

  function renderWaitingStatus() {
    if (!waitingInfo || currentActivity()) return;
    const container = elements.waitingSessionsEl;
    container.replaceChildren();

    const label = document.createElement("span");
    label.className = "waitingSessionsLabel";
    label.append(iconElement("hourglass"));
    const count = waitingInfo.count;
    label.append(document.createTextNode(`Waiting on ${count} spawned session${count === 1 ? "" : "s"}`));
    label.title = "This session stays usable while spawned sessions run — it will be woken automatically when they finish.";
    container.append(label);

    for (const session of waitingInfo.sessions) {
      const chip = createSessionRefChip({ sessionId: session.sessionId, name: session.name }, {
        className: "waitingSessionChip",
        openSession: (sessionId) => { void openSession?.(sessionId, session.cwd || ""); },
      });
      chip.textContent = "";
      const spinner = document.createElement("span");
      spinner.className = "waitingSessionSpinner";
      spinner.setAttribute("aria-hidden", "true");
      chip.append(spinner, document.createTextNode(session.name));
      chip.title = `Open ${session.name}`;
      container.append(chip);
    }
    container.hidden = false;
  }

  function updateWaitingStatus(info: WaitingInfo | undefined) {
    waitingInfo = info;
    if (currentActivity()) {
      clearWaitingRender(); // the running indicator owns this slot
      return;
    }
    if (info) renderWaitingStatus();
    else clearWaitingRender();
  }

  function scheduleConnectionStatus() {
    if (state.reconnectNoticeTimer === undefined) {
      state.reconnectNoticeTimer = window.setTimeout(() => {
        state.reconnectNoticeTimer = undefined;
        if (state.wsDisconnected && elements.tokenOverlay.hidden && !elements.connectionStatusEl.classList.contains("offline")) {
          setConnectionStatus("reconnecting", "Live updates reconnecting…");
        }
      }, reconnectNoticeDelayMs);
    }
    if (state.connectionLostTimer === undefined) {
      state.connectionLostTimer = window.setTimeout(() => {
        state.connectionLostTimer = undefined;
        if (state.wsDisconnected && elements.tokenOverlay.hidden) {
          setConnectionStatus("offline", "Live updates unavailable", "Connection lost. Messages may still send, but live updates are unavailable.");
        }
      }, connectionLostDelayMs);
    }
  }

  function markWebSocketOpen() {
    const isReconnect = state.wsHasOpened && state.wsDisconnected;
    const hadVisibleStatus = !elements.connectionStatusEl.hidden;
    state.wsHasOpened = true;
    state.wsDisconnected = false;
    clearConnectionTimers();

    if (!isReconnect) {
      hideConnectionStatus();
      return;
    }

    if (!hadVisibleStatus) {
      hideConnectionStatus();
      return;
    }

    setConnectionStatus("reconnected", "Reconnected");
    state.reconnectedClearTimer = window.setTimeout(() => {
      state.reconnectedClearTimer = undefined;
      if (!state.wsDisconnected) hideConnectionStatus();
    }, reconnectDelayMs);
  }

  function markWebSocketClosed() {
    state.wsDisconnected = true;
    clearReconnectedTimer();
    scheduleConnectionStatus();
  }

  function markSyncRequired() {
    setConnectionStatus("syncRequired", "Sync needed", "Some live updates were missed. Click to refresh the page.");
  }

  async function refreshSessionTitle(sessionId = state.currentSessionId) {
    try {
      const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
      const res = await fetch(`/api/state${query}`, { headers: api.headers() });
      if (!res.ok || sessionId !== state.currentSessionId) return;
      const data = await res.json();
      if (sessionId !== state.currentSessionId || data.sessionId !== sessionId) return;
      sessionState.applySnapshot(data);
    } catch (_e) { /* best-effort */ }
  }

  function init() {
    elements.statusTitleEl.setAttribute("role", "button");
    elements.statusTitleEl.tabIndex = 0;
    setStatusTitle(state.currentSessionTitle);
    elements.statusTitleEl.addEventListener("click", beginRenameSessionTitle);
    elements.statusTitleEl.addEventListener("keydown", (event) => {
      if (event.target !== elements.statusTitleEl || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      beginRenameSessionTitle();
    });
    const reloadForConnectionStatus = () => {
      if (!elements.connectionStatusEl.classList.contains("syncRequired") && !elements.connectionStatusEl.classList.contains("offline")) return;
      window.location.reload();
    };
    elements.connectionStatusEl.addEventListener("click", reloadForConnectionStatus);
    elements.connectionStatusEl.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      reloadForConnectionStatus();
    });
  }

  return {
    init,
    setStatusTitle,
    refreshSessionTitle,
    markWebSocketOpen,
    markWebSocketClosed,
    markSyncRequired,
    markActivityStart,
    markActivityProgress,
    markActivityEnd,
    updateWaitingStatus,
  };
}
