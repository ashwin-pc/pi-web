import type { ToastCenter } from "../components/toasts.js";
import type { ApiClient } from "../app/api.js";
import type { AppElements } from "../app/elements.js";
import type { AppState } from "../app/types.js";
import { sessionRuntime, type SessionStateController } from "../app/sessionState.js";
import { connectionLostDelayMs, reconnectDelayMs, reconnectNoticeDelayMs } from "../app/types.js";

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
  toasts: ToastCenter;
  api: ApiClient;
  sessionState: SessionStateController;
  addMessage: (role: "system", text: string, extraClass?: string) => void;
  refreshSessions: () => Promise<void>;
  refreshState: () => Promise<void>;
  copySessionLink?: () => Promise<boolean>;
}): StatusBar {
  const { state, elements, toasts, api, sessionState, addMessage, refreshSessions, refreshState, copySessionLink } = options;
  const activityBySession = new Map<string, ActivityEntry>();
  let activityTimer: number | undefined;
  let connectionKind: "reconnecting" | "offline" | "reconnected" | "syncRequired" | undefined;
  let syncRequired = false;
  let syncRevision = 0;
  let syncPending: Promise<void> | undefined;

  function syncOnly(): Promise<void> {
    if (syncPending) return syncPending;
    const revision = syncRevision;
    const sessionId = state.currentSessionId;
    syncPending = (async () => {
      // Wait for both requests even on failure: a retry must not overlap an
      // earlier state/history refresh that is still applying its response.
      const results = await Promise.allSettled([refreshSessions(), refreshState()]);
      if (revision !== syncRevision || sessionId !== state.currentSessionId) return;
      const failed = results.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      if (!state.initialSyncComplete) throw new Error("Session sync incomplete");
      syncRequired = false;
      if (!state.wsDisconnected) hideConnectionStatus();
      else setConnectionStatus("offline", "Live updates unavailable", "Messages may still send, but live updates are unavailable.");
    })().finally(() => { syncPending = undefined; });
    return syncPending;
  }

  function setStatusTitle(title: string) {
    const value = title.trim() || "New session";
    state.currentSessionTitle = value;
    elements.statusTitleEl.title = "Rename session";
    elements.statusTitleEl.setAttribute("aria-label", `Session: ${value}. Click to rename.`);
    elements.copySessionLinkButton.hidden = !state.currentSessionId || !copySessionLink;
    elements.copySessionLinkButton.disabled = !state.currentSessionId || !copySessionLink;
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

  function setConnectionStatus(kind: "reconnecting" | "offline" | "reconnected" | "syncRequired", text: string, title = text) {
    connectionKind = kind;
    const actions = [
      { label: "Live updates", run: () => window.location.reload() },
      { label: "Sync only", run: syncOnly },
    ];
    const message = kind === "offline"
      ? `${text}. ${title} Live updates reloads the page; Sync only refreshes this session without reloading.`
      : kind === "syncRequired" ? "Some live updates were missed. Sync only refreshes this session; Live updates reloads the page."
      : text;
    if (kind === "reconnected") toasts.show({ id: "connection", message, tone: "success", durationMs: reconnectDelayMs });
    else toasts.show({ id: "connection", message, tone: "warning", persistent: true, actions });
  }

  function hideConnectionStatus() {
    connectionKind = undefined;
    toasts.dismiss("connection");
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
  }

  function scheduleConnectionStatus() {
    if (state.reconnectNoticeTimer === undefined) {
      state.reconnectNoticeTimer = window.setTimeout(() => {
        state.reconnectNoticeTimer = undefined;
        if (state.wsDisconnected && connectionKind !== "offline" && !syncRequired) {
          setConnectionStatus("reconnecting", "Live updates reconnecting…");
        }
      }, reconnectNoticeDelayMs);
    }
    if (state.connectionLostTimer === undefined) {
      state.connectionLostTimer = window.setTimeout(() => {
        state.connectionLostTimer = undefined;
        if (state.wsDisconnected && !syncRequired) {
          setConnectionStatus("offline", "Live updates unavailable", "Connection lost. Messages may still send, but live updates are unavailable.");
        }
      }, connectionLostDelayMs);
    }
  }

  function markWebSocketOpen() {
    const isReconnect = state.wsHasOpened && state.wsDisconnected;
    const hadVisibleStatus = toasts.has("connection");
    state.wsHasOpened = true;
    state.wsDisconnected = false;
    clearConnectionTimers();

    if (syncRequired) {
      setConnectionStatus("syncRequired", "Sync needed");
      return;
    }

    if (!isReconnect) {
      hideConnectionStatus();
      return;
    }

    if (!hadVisibleStatus) {
      hideConnectionStatus();
      return;
    }

    setConnectionStatus("reconnected", "Reconnected");
  }

  function markWebSocketClosed() {
    syncRevision += 1;
    state.wsDisconnected = true;
    if (connectionKind === "reconnected") hideConnectionStatus();
    scheduleConnectionStatus();
  }

  function markSyncRequired() {
    clearConnectionTimers();
    syncRequired = true;
    syncRevision += 1;
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
    elements.copySessionLinkButton.addEventListener("click", () => {
      if (!copySessionLink) return;
      void copySessionLink().then((copied) => {
        const label = copied ? "Session link copied" : "Copy session link failed";
        elements.copySessionLinkButton.title = label;
        elements.copySessionLinkButton.setAttribute("aria-label", label);
        window.setTimeout(() => {
          if (!elements.copySessionLinkButton.isConnected) return;
          elements.copySessionLinkButton.title = "Copy session link";
          elements.copySessionLinkButton.setAttribute("aria-label", elements.copySessionLinkButton.title);
        }, 1_200);
      });
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
  };
}
