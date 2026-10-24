// Sessions read model: per-session title, cwd, pins, status, unread and
// lineage, derived from the existing endpoints and realtime envelopes only:
//
//   GET /api/sessions             title, cwd, modified, runtime, unread flag
//   GET /api/session-ui-state     lanes (pins and order), unread states, origins (parent)
//   realtime                      session_runtime_changed, agent_event, state_changed,
//                                 session_ui_state_changed, settlement_dependencies_changed,
//                                 session_deleted
//
// The model is pure (no fetch), so its semantics are unit-tested directly.
import { normalizeSessionRuntime } from "../app/sessionState.js";
import { normalizeSessionUiState, type SessionRuntimeState, type SessionUiState } from "../app/types.js";
import { createStore } from "./store.js";
import type { ClientEvent, ClientSession, ReadableStore, RealtimeEnvelope } from "./types.js";

type Record_ = Record<string, unknown>;
const isRecord = (value: unknown): value is Record_ => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown) => (typeof value === "string" ? value : "");

type SessionFacts = {
  id: string;
  name?: string;
  title?: string;
  firstMessage?: string;
  cwd: string;
  modified?: string;
  runtime: SessionRuntimeState;
  /** Unread flag from /api/sessions; the ui state's sessionUnreadStates wins once loaded. */
  listedUnread?: boolean;
  error: string | null;
  turnsWhileUnread: number;
  lastActivityAt?: string;
  /** The last model label seen; the runtime drops it when a run stops. */
  model?: string;
};

export type SessionsModel = ReadableStore<readonly ClientSession[]> & {
  applyList(sessions: unknown): void;
  applyUiState(value: unknown): void;
  applyEnvelope(envelope: RealtimeEnvelope): void;
  applyEvent(event: ClientEvent): void;
  /** Optimistic local read, before the server's session_ui_state_changed arrives. */
  markReadLocally(sessionId: string): void;
  cwdOf(sessionId: string): string;
  /** Pinned or laned sessions the list has not returned yet (their cwd may be unknown to the server's index). */
  missingLaneCwds(): string[];
  hasUiState(): boolean;
};

function modelLabel(model: unknown) {
  if (!isRecord(model)) return "";
  return str(model.name) || str(model.id) || str(model.modelId);
}

function sessionTitle(facts: SessionFacts) {
  return facts.name?.trim() || facts.title?.trim() || facts.firstMessage?.trim() || "New session";
}

export function createSessionsModel(options: { now?: () => number } = {}): SessionsModel {
  const now = options.now || Date.now;
  const facts = new Map<string, SessionFacts>();
  const dependencies = new Map<string, string[]>();
  let uiState: SessionUiState | undefined;
  const store = createStore<readonly ClientSession[]>([]);
  let scheduled = false;
  let batching = 0;

  function ensure(id: string): SessionFacts {
    let entry = facts.get(id);
    if (!entry) {
      entry = { id, cwd: "", runtime: normalizeSessionRuntime(undefined), error: null, turnsWhileUnread: 0 };
      facts.set(id, entry);
    }
    return entry;
  }

  function unreadFlag(entry: SessionFacts) {
    if (uiState) return uiState.sessionUnreadStates.some((item) => item.sessionId === entry.id);
    return Boolean(entry.listedUnread);
  }

  function project(): readonly ClientSession[] {
    const lanes = uiState?.lanes || [];
    const pinnedIds = lanes.filter((entry) => entry.lane === "pinned").map((entry) => entry.sessionId);
    const laneOf = new Map(lanes.map((entry) => [entry.sessionId, entry]));
    // Sessions that are only known from lanes still appear, so a pin never vanishes.
    for (const entry of lanes) if (!facts.has(entry.sessionId)) { const created = ensure(entry.sessionId); created.cwd = entry.cwd || ""; }
    const parentOf = new Map((uiState?.sessionOrigins || []).map((origin) => [origin.sessionId, origin.originSessionId]));
    const childrenOf = new Map<string, string[]>();
    for (const [child, parent] of parentOf) childrenOf.set(parent, [...(childrenOf.get(parent) || []), child]);
    const isRunning = (id: string) => Boolean(facts.get(id)?.runtime.isRunning);
    const notes = new Map((uiState?.sessionNotes || []).map((item) => [item.sessionId, item.note]));

    const views = [...facts.values()].map((entry): ClientSession => {
      const lane = laneOf.get(entry.id)?.lane || null;
      const pinOrder = lane === "pinned" ? pinnedIds.indexOf(entry.id) : -1;
      const tracked = dependencies.get(entry.id) || [];
      const waitingOn = [...new Set([...tracked, ...(childrenOf.get(entry.id) || [])])].filter(isRunning);
      const unread = unreadFlag(entry);
      const status = entry.runtime.isRunning ? "running" : waitingOn.length ? "waiting" : entry.error ? "error" : "idle";
      return {
        id: entry.id,
        title: sessionTitle(entry),
        cwd: entry.cwd || laneOf.get(entry.id)?.cwd || "",
        pinned: lane === "pinned",
        pinOrder,
        lane,
        status,
        unread,
        unreadCount: unread ? Math.max(1, entry.turnsWhileUnread) : 0,
        parentId: parentOf.get(entry.id) || null,
        lastActivityAt: entry.runtime.lastActivityAt || entry.lastActivityAt || entry.modified || "",
        runningSince: entry.runtime.isRunning ? entry.runtime.startedAt || null : null,
        waitingOn,
        error: entry.error,
        note: notes.get(entry.id) || null,
        model: modelLabel(entry.runtime.model) || entry.model || null,
      };
    });
    // Pinned lane order first, then everything else by most recent activity.
    return views.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (a.pinned) return a.pinOrder - b.pinOrder;
      return (Date.parse(b.lastActivityAt) || 0) - (Date.parse(a.lastActivityAt) || 0) || a.id.localeCompare(b.id);
    });
  }

  function changed() {
    if (batching) { scheduled = true; return; }
    store.set(project());
  }

  function batch(run: () => void) {
    batching++;
    try { run(); } finally {
      batching--;
      if (!batching && scheduled) { scheduled = false; store.set(project()); }
    }
  }

  function applyList(value: unknown) {
    if (!Array.isArray(value)) return;
    batch(() => {
      for (const raw of value) {
        if (!isRecord(raw) || !str(raw.id)) continue;
        const entry = ensure(str(raw.id));
        entry.name = str(raw.name) || undefined;
        entry.firstMessage = str(raw.firstMessage) || entry.firstMessage;
        entry.cwd = str(raw.cwd) || entry.cwd;
        entry.modified = str(raw.modified) || entry.modified;
        if ("runtime" in raw) applyRuntime(entry.id, raw.runtime);
        if (typeof raw.unread === "boolean") entry.listedUnread = raw.unread;
      }
      changed();
    });
  }

  function applyUiState(value: unknown) {
    if (!isRecord(value)) return;
    const next = normalizeSessionUiState(value);
    const previouslyUnread = new Set(uiState?.sessionUnreadStates.map((item) => item.sessionId) || []);
    uiState = next;
    for (const entry of facts.values()) {
      const unread = next.sessionUnreadStates.some((item) => item.sessionId === entry.id);
      if (!unread || !previouslyUnread.has(entry.id)) entry.turnsWhileUnread = unread ? 1 : 0;
    }
    changed();
  }

  function applyRuntime(sessionId: string, runtime: unknown) {
    const entry = ensure(sessionId);
    entry.runtime = normalizeSessionRuntime(runtime);
    entry.model = modelLabel(entry.runtime.model) || entry.model;
    if (entry.runtime.lastActivityAt) entry.lastActivityAt = entry.runtime.lastActivityAt;
  }

  function applyEnvelope(envelope: RealtimeEnvelope) {
    if (!isRecord(envelope)) return;
    const sessionId = str(envelope.sessionId);
    switch (envelope.type) {
      case "session_ui_state_changed":
        applyUiState(envelope.sessionUiState);
        return;
      case "session_runtime_changed":
        if (!sessionId) return;
        applyRuntime(sessionId, envelope.runtime);
        changed();
        return;
      case "state_changed":
      case "hello": {
        if (!sessionId) return;
        const entry = ensure(sessionId);
        if ("sessionName" in envelope) entry.name = str(envelope.sessionName) || undefined;
        if ("sessionTitle" in envelope) entry.title = str(envelope.sessionTitle) || undefined;
        if (str(envelope.cwd)) entry.cwd = str(envelope.cwd);
        entry.model = modelLabel(envelope.model) || entry.model;
        if (isRecord(envelope.runtime)) applyRuntime(sessionId, envelope.runtime);
        if (isRecord(envelope.sessionUiState)) applyUiState(envelope.sessionUiState);
        changed();
        return;
      }
      case "settlement_dependencies_changed":
        if (!sessionId) return;
        dependencies.set(sessionId, Array.isArray(envelope.childIds) ? envelope.childIds.filter((id): id is string => typeof id === "string" && id !== sessionId) : []);
        changed();
        return;
      case "session_deleted":
        if (!sessionId) return;
        facts.delete(sessionId);
        dependencies.delete(sessionId);
        changed();
        return;
      case "agent_event": {
        if (!sessionId || !isRecord(envelope.event) || envelope.replay === true) return;
        const event = envelope.event;
        const entry = ensure(sessionId);
        const at = str(event.lastActivityAt);
        if (at) entry.lastActivityAt = at;
        if (event.type === "session_info_changed" && "name" in event) { entry.name = str(event.name) || undefined; changed(); return; }
        if (event.type === "agent_start") {
          entry.error = null;
          entry.runtime = normalizeSessionRuntime({ ...entry.runtime, isRunning: true, isStreaming: true, startedAt: str(event.startedAt) || entry.runtime.startedAt || new Date(now()).toISOString(), lastActivityAt: at || undefined });
          changed();
        } else if (event.type === "agent_settled") {
          entry.runtime = normalizeSessionRuntime({ ...entry.runtime, isRunning: false, isStreaming: false, isRetrying: false, isCompacting: false });
          entry.lastActivityAt = at || new Date(now()).toISOString();
          changed();
        }
        return;
      }
      default:
    }
  }

  function applyEvent(event: ClientEvent) {
    if (event.type !== "turn/end") return;
    const entry = ensure(event.sessionId);
    entry.error = event.error && !event.aborted ? event.error : null;
    if (unreadFlag(entry)) entry.turnsWhileUnread += 1;
    changed();
  }

  function markReadLocally(sessionId: string) {
    const entry = facts.get(sessionId);
    if (entry) { entry.listedUnread = false; entry.turnsWhileUnread = 0; }
    if (uiState) uiState = { ...uiState, sessionUnreadStates: uiState.sessionUnreadStates.filter((item) => item.sessionId !== sessionId) };
    changed();
  }

  return {
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    applyList,
    applyUiState,
    applyEnvelope,
    applyEvent,
    markReadLocally,
    cwdOf: (sessionId) => facts.get(sessionId)?.cwd || uiState?.lanes.find((entry) => entry.sessionId === sessionId)?.cwd || "",
    missingLaneCwds: () => [...new Set((uiState?.lanes || []).filter((entry) => !facts.get(entry.sessionId)?.modified && entry.cwd).map((entry) => entry.cwd as string))],
    hasUiState: () => Boolean(uiState),
  };
}
