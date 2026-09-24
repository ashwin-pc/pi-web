import type {
  AppState,
  SessionInfo,
  SessionRuntimeState,
  SessionStats,
  SessionViewState,
} from "./types.js";

export const stoppedSessionRuntime: Readonly<SessionRuntimeState> = Object.freeze({
  loaded: false,
  isRunning: false,
  isStreaming: false,
  isRetrying: false,
  isCompacting: false,
  pendingMessageCount: 0,
});

export type SessionRuntimePatch = Partial<SessionRuntimeState>;

export type RuntimeActivityUpdate =
  | { kind: "sync" }
  | { kind: "start"; label?: string; startedAt?: string; lastActivityAt?: string }
  | { kind: "progress"; label?: string; lastActivityAt?: string }
  | { kind: "end" }
  | { kind: "preserve" };

export type SessionRuntimeTransition = {
  sessionId: string;
  previous: SessionRuntimeState;
  next: SessionRuntimeState;
  isActive: boolean;
};

export type ApplySessionSnapshotOptions = {
  activate?: boolean;
  activity?: RuntimeActivityUpdate;
};

export type SessionStateController = {
  activate: (sessionId: string) => void;
  applySnapshot: (value: unknown, options?: ApplySessionSnapshotOptions) => SessionViewState | undefined;
  mergeSessionInfo: (session: SessionInfo) => SessionViewState;
  patchRuntime: (sessionId: string, patch: SessionRuntimePatch, activity?: RuntimeActivityUpdate) => SessionRuntimeTransition;
  replaceRuntime: (sessionId: string, runtime: SessionRuntimePatch, activity?: RuntimeActivityUpdate) => SessionRuntimeTransition;
  updateStats: (sessionId: string, stats?: SessionStats | null) => void;
  remove: (sessionId: string) => void;
};

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasOwn(value: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function runtimeFromRecord(value: Record<string, unknown>, fallback: SessionRuntimeState): SessionRuntimeState {
  const has = (key: string) => hasOwn(value, key);
  const isStreaming = has("isStreaming") ? Boolean(value.isStreaming) : fallback.isStreaming;
  const isRetrying = has("isRetrying") ? Boolean(value.isRetrying) : fallback.isRetrying;
  const isCompacting = has("isCompacting") ? Boolean(value.isCompacting) : fallback.isCompacting;
  const runtimeFlagChanged = has("isStreaming") || has("isRetrying") || has("isCompacting");
  const explicitlyRunning = has("isRunning") ? Boolean(value.isRunning) : runtimeFlagChanged ? false : fallback.isRunning;
  const next: SessionRuntimeState = {
    loaded: has("loaded") ? Boolean(value.loaded) : fallback.loaded,
    isRunning: explicitlyRunning || isStreaming || isRetrying || isCompacting,
    isStreaming,
    isRetrying,
    isCompacting,
    pendingMessageCount: has("pendingMessageCount") && Number.isFinite(Number(value.pendingMessageCount))
      ? Number(value.pendingMessageCount)
      : fallback.pendingMessageCount,
    ...(has("startedAt") ? { startedAt: optionalString(value.startedAt) } : fallback.startedAt ? { startedAt: fallback.startedAt } : {}),
    ...(has("lastActivityAt") ? { lastActivityAt: optionalString(value.lastActivityAt) } : fallback.lastActivityAt ? { lastActivityAt: fallback.lastActivityAt } : {}),
    ...(has("model") ? { model: recordValue(value.model) as SessionRuntimeState["model"] } : fallback.model ? { model: fallback.model } : {}),
  };
  if (!next.isRunning) {
    delete next.startedAt;
    delete next.lastActivityAt;
  }
  return next;
}

export function normalizeSessionRuntime(value: unknown): SessionRuntimeState {
  return runtimeFromRecord(recordValue(value) || {}, stoppedSessionRuntime as SessionRuntimeState);
}

export function mergeSessionRuntime(previous: SessionRuntimeState | undefined, patch: SessionRuntimePatch): SessionRuntimeState {
  return runtimeFromRecord(patch as Record<string, unknown>, previous || stoppedSessionRuntime as SessionRuntimeState);
}

export function activeSessionState(state: AppState): SessionViewState | undefined {
  return state.currentSessionId ? state.sessionsById[state.currentSessionId] : undefined;
}

export function isNativeSession(view: SessionViewState | undefined): boolean {
  return view?.harnessId === "codex" || view?.harnessId === "claude" || view?.harnessId === "kiro";
}

export function harnessName(view: Pick<SessionViewState, "harnessId"> | undefined): string {
  return view?.harnessId === "codex" ? "Codex" : view?.harnessId === "claude" ? "Claude Code" : view?.harnessId === "kiro" ? "Kiro" : "Pi";
}

function authoritativeRuntime(view: SessionViewState | undefined, runtime: SessionRuntimeState): SessionRuntimeState {
  if (!isNativeSession(view) || !view?.phase) return runtime;
  const running = ["starting", "running", "settling"].includes(view.phase);
  return normalizeSessionRuntime({
    ...runtime,
    isRunning: running,
    isStreaming: running && view.activity === "working",
    isRetrying: running && view.activity === "retrying",
    isCompacting: running && view.activity === "compacting",
  });
}

export function sessionRuntime(state: AppState, sessionId = state.currentSessionId): SessionRuntimeState {
  const view = sessionId ? state.sessionsById[sessionId] : undefined;
  return authoritativeRuntime(view, view?.runtime || stoppedSessionRuntime as SessionRuntimeState);
}

export function activeSessionStats(state: AppState): SessionStats | undefined {
  return activeSessionState(state)?.stats;
}

export function selectSession(state: AppState, sessionId: string) {
  const previousId = state.currentSessionId;
  if (previousId && state.sessionsById[previousId]) {
    state.sessionsById[previousId] = { ...state.sessionsById[previousId], isCurrent: false };
  }
  state.currentSessionId = sessionId;
  if (!sessionId) return undefined;
  const current = { ...(state.sessionsById[sessionId] || { id: sessionId }), isCurrent: true };
  state.sessionsById[sessionId] = current;
  return current;
}

function snapshotRuntime(data: Record<string, unknown>): SessionRuntimeState | undefined {
  const nested = recordValue(data.runtime);
  const hasTopLevelRuntime = ["isStreaming", "isRetrying", "isCompacting", "runtimeStartedAt", "runtimeLastActivityAt"]
    .some((key) => hasOwn(data, key));
  if (!nested && !hasTopLevelRuntime) return undefined;

  const source: Record<string, unknown> = { ...(nested || {}) };
  for (const key of ["isStreaming", "isRetrying", "isCompacting"] as const) {
    if (hasOwn(data, key)) source[key] = data[key];
  }
  if (hasOwn(data, "runtimeStartedAt")) source.startedAt = data.runtimeStartedAt;
  if (hasOwn(data, "runtimeLastActivityAt")) source.lastActivityAt = data.runtimeLastActivityAt;
  if (!hasOwn(source, "loaded")) source.loaded = true;
  return normalizeSessionRuntime(source);
}

export function reduceSessionSnapshot(state: AppState, value: unknown, fallbackSessionId = state.currentSessionId): SessionViewState | undefined {
  const data = recordValue(value);
  if (!data) return undefined;
  const sessionId = optionalString(data.sessionId) || fallbackSessionId;
  if (!sessionId) return undefined;

  const previous = state.sessionsById[sessionId] || { id: sessionId };
  const next: SessionViewState = { ...previous, id: sessionId };
  const runtime = snapshotRuntime(data);
  const completeSnapshot = ["stats", "isStreaming", "isRetrying", "isCompacting"]
    .every((key) => hasOwn(data, key));

  if (hasOwn(data, "sessionFile")) next.sessionFile = optionalString(data.sessionFile);
  if (data.harnessId === "pi" || data.harnessId === "codex" || data.harnessId === "claude" || data.harnessId === "kiro") next.harnessId = data.harnessId;
  if (hasOwn(data, "nativeSession")) next.nativeSession = recordValue(data.nativeSession) as SessionViewState["nativeSession"];
  if (hasOwn(data, "phase")) next.phase = optionalString(data.phase) as SessionViewState["phase"];
  if (hasOwn(data, "activity")) next.activity = optionalString(data.activity) as SessionViewState["activity"];
  for (const key of ["activeExecution", "nativeSettings"] as const) {
    if (hasOwn(data, key)) Object.assign(next, { [key]: recordValue(data[key]) });
    else if (completeSnapshot) delete next[key];
  }
  if (hasOwn(data, "pendingInteractions")) next.pendingInteractions = Array.isArray(data.pendingInteractions) ? data.pendingInteractions as SessionViewState["pendingInteractions"] : [];
  if (hasOwn(data, "error")) next.error = optionalString(data.error);
  else if (completeSnapshot) next.error = undefined;
  if (hasOwn(data, "sessionName")) next.name = optionalString(data.sessionName);
  else if (completeSnapshot && hasOwn(data, "sessionTitle")) next.name = undefined;
  if (hasOwn(data, "sessionTitle")) next.title = optionalString(data.sessionTitle) || "New session";
  if (hasOwn(data, "cwd") && typeof data.cwd === "string") next.cwd = data.cwd;
  if (hasOwn(data, "model")) next.model = recordValue(data.model) as SessionViewState["model"];
  else if (completeSnapshot) next.model = undefined;
  if (hasOwn(data, "thinkingLevel")) next.thinkingLevel = optionalString(data.thinkingLevel) || "off";
  if (hasOwn(data, "thinkingLevels")) next.thinkingLevels = stringArray(data.thinkingLevels);
  if (hasOwn(data, "capabilities")) next.capabilities = recordValue(data.capabilities) as SessionViewState["capabilities"];
  if (hasOwn(data, "stats")) next.stats = recordValue(data.stats) as SessionStats | undefined;
  if (hasOwn(data, "queue")) {
    const queue = recordValue(data.queue);
    next.queue = { steering: stringArray(queue?.steering), followUp: stringArray(queue?.followUp) };
  } else if (completeSnapshot) {
    next.queue = { steering: [], followUp: [] };
  }
  if (runtime || next.phase) next.runtime = authoritativeRuntime(next, runtime || next.runtime || stoppedSessionRuntime as SessionRuntimeState);
  for (const key of ["webContributions"] as const) {
    if (hasOwn(data, key)) next[key] = data[key];
  }
  if (completeSnapshot) next.snapshotLoaded = true;

  state.sessionsById[sessionId] = next;
  return next;
}

export function mergeSessionInfo(state: AppState, session: SessionInfo): SessionViewState {
  const previous = state.sessionsById[session.id] || { id: session.id };
  const next: SessionViewState = {
    ...previous,
    ...session,
    runtime: session.runtime ? normalizeSessionRuntime(session.runtime) : previous.runtime,
  };
  state.sessionsById[session.id] = next;
  return next;
}

export function patchSessionRuntime(state: AppState, sessionId: string, patch: SessionRuntimePatch): SessionRuntimeTransition {
  const previous = sessionRuntime(state, sessionId);
  const session = state.sessionsById[sessionId] || { id: sessionId };
  const next = authoritativeRuntime(session, mergeSessionRuntime(previous, patch));
  state.sessionsById[sessionId] = { ...session, runtime: next };
  return { sessionId, previous, next, isActive: sessionId === state.currentSessionId };
}

export function replaceSessionRuntime(state: AppState, sessionId: string, runtime: SessionRuntimePatch): SessionRuntimeTransition {
  const previous = sessionRuntime(state, sessionId);
  const session = state.sessionsById[sessionId] || { id: sessionId };
  const next = authoritativeRuntime(session, normalizeSessionRuntime(runtime));
  state.sessionsById[sessionId] = { ...session, runtime: next };
  return { sessionId, previous, next, isActive: sessionId === state.currentSessionId };
}

export function setSessionStats(state: AppState, sessionId: string, stats?: SessionStats | null) {
  const session = state.sessionsById[sessionId] || { id: sessionId };
  state.sessionsById[sessionId] = { ...session, stats: stats || undefined };
}

export function removeSessionState(state: AppState, sessionId: string) {
  delete state.sessionsById[sessionId];
}
