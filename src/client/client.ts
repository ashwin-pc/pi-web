// createPiWebClient: the framework-free client state layer (issue #181,
// stage 1). It shares the 2D app's API headers and its realtime connection,
// and starts fetching only when a view first reads from it, so the normal
// app pays nothing for it.
import { createEventTranslator } from "./events.js";
import { walkFileTree } from "./files.js";
import { createArtifactsController } from "./artifacts.js";
import { createMessagesController } from "./messages.js";
import { createSessionsModel } from "./sessions.js";
import { createEmitter } from "./store.js";
import type { ClientEvent, PiWebClient, PiWebClientDeps, RealtimeEnvelope, Unsubscribe } from "./types.js";

export type { ClientArtifact, ClientEvent, ClientMessage, ClientSession, FileTreeDir, MessagesStore, PiWebClient, PiWebClientDeps } from "./types.js";

/** The 2D app's URL for a session, optionally opening an artifact in its viewer. */
export function chatHref(sessionId: string, artifactUrl?: string) {
  const params = new URLSearchParams({ sessionId });
  if (artifactUrl) params.set("artifact", artifactUrl);
  return `/?${params}`;
}

async function json(response: Response) {
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || data.ok === false) throw new Error(typeof data.error === "string" ? data.error : `Request failed (${response.status})`);
  return data;
}

export function createPiWebClient(deps: PiWebClientDeps): PiWebClient {
  const fetchFn = deps.fetch || ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const get = (url: string, signal?: AbortSignal) => fetchFn(url, { headers: deps.headers(), signal }).then(json);
  const post = (url: string, body: unknown) => fetchFn(url, { method: "POST", headers: deps.headers(), body: JSON.stringify(body) }).then(json);

  const sessions = createSessionsModel({ now: deps.now });
  const translator = createEventTranslator({ cwdOf: sessions.cwdOf });
  const events = createEmitter<ClientEvent>();
  const messages = createMessagesController({
    load: async (sessionId) => {
      const data = await get(`/api/messages?sessionId=${encodeURIComponent(sessionId)}`);
      return Array.isArray(data.messages) ? data.messages : [];
    },
    cwdOf: sessions.cwdOf,
  });

  const artifacts = createArtifactsController({
    messages: (sessionId) => messages.get(sessionId),
    cwdOf: sessions.cwdOf,
    list: (sessionId, path) => get(`/api/files/tree?${new URLSearchParams({ sessionId, path })}`),
  });

  let started = false;
  let focusedSessionId = "";
  let disposed = false;
  let listTimer: ReturnType<typeof setTimeout> | undefined;
  let listInFlight: Promise<void> | undefined;

  async function loadList() {
    const params = new URLSearchParams();
    for (const cwd of sessions.missingLaneCwds()) params.append("cwd", cwd);
    const data = await get(params.toString() ? `/api/sessions?${params}` : "/api/sessions");
    if (!disposed) sessions.applyList(data.sessions);
  }

  function refreshList(): Promise<void> {
    if (listInFlight) return listInFlight;
    listInFlight = loadList().catch((error) => { console.warn("pi-web client: session list failed", error); })
      .finally(() => { listInFlight = undefined; });
    return listInFlight;
  }

  async function refreshAll() {
    try {
      const data = await get("/api/session-ui-state");
      if (!disposed) sessions.applyUiState(data.sessionUiState);
    } catch (error) {
      // Preferences may be unavailable; the session list still carries unread flags.
      console.warn("pi-web client: session ui state failed", error);
    }
    await refreshList();
  }

  function scheduleList(delay = 600) {
    if (!started || disposed || listTimer) return;
    listTimer = setTimeout(() => { listTimer = undefined; void refreshList(); }, delay);
  }

  async function markRead(sessionId: string) {
    sessions.markReadLocally(sessionId);
    const data = await post("/api/session-ui-state/read", { sessionId });
    if (!disposed && data.sessionUiState) sessions.applyUiState(data.sessionUiState);
  }

  function start() {
    if (started || disposed) return;
    started = true;
    void refreshAll();
  }

  const unsubscribeRealtime = deps.realtime.subscribe((envelope: RealtimeEnvelope) => {
    if (disposed) return;
    sessions.applyEnvelope(envelope);
    for (const event of translator.translate(envelope)) {
      sessions.applyEvent(event);
      messages.applyEvent(event);
      events.emit(event);
      // The server marks every settled run unread; one you are looking at is read.
      if (event.type === "turn/end" && event.sessionId === focusedSessionId) void markRead(event.sessionId).catch(() => undefined);
    }
    // Reconcile titles and new sessions at settle points, not per message.
    const eventType = envelope.type === "agent_event" && envelope.event && typeof envelope.event === "object" ? (envelope.event as { type?: unknown }).type : undefined;
    if (envelope.type === "sync_required") void refreshAll();
    else if (envelope.type === "state_changed" || eventType === "agent_settled" || envelope.type === "session_ui_state_changed" && sessions.missingLaneCwds().length) scheduleList();
  });

  return {
    sessions: {
      getSnapshot() { start(); return sessions.getSnapshot(); },
      subscribe(listener) { start(); return sessions.subscribe(listener); },
      refresh: () => { start(); return refreshAll(); },
    },
    messages(sessionId: string) { start(); return messages.get(sessionId); },
    artifacts(sessionId: string) { start(); return artifacts.get(sessionId); },
    events: {
      subscribe(listener: (event: ClientEvent) => void): Unsubscribe { start(); return events.subscribe(listener); },
    },
    files: {
      async tree(root, options = {}) {
        start();
        if (!sessions.hasUiState() && !sessions.getSnapshot().length) await refreshAll();
        const normalized = root.replace(/\/+$/, "");
        // The session with the longest cwd that contains the root scopes the listing.
        const scope = [...sessions.getSnapshot()]
          .filter((item) => item.cwd && (normalized === item.cwd || normalized.startsWith(`${item.cwd.replace(/\/+$/, "")}/`)))
          .sort((a, b) => b.cwd.length - a.cwd.length)[0];
        if (!scope) return null;
        return walkFileTree({
          root: normalized,
          sessionId: scope.id,
          cwd: scope.cwd,
          list: (sessionId, path, signal) => get(`/api/files/tree?${new URLSearchParams({ sessionId, path })}`, signal),
          ...options,
        });
      },
    },
    actions: {
      async openSession(sessionId) {
        start();
        focusedSessionId = sessionId;
        if (deps.openSession) await deps.openSession(sessionId);
        else await post("/api/sessions/open", { sessionId });
      },
      async prompt(sessionId, text) {
        const message = text.trim();
        if (!message) return;
        start();
        messages.addOptimisticUser(sessionId, message);
        const clientMessageId = globalThis.crypto?.randomUUID?.() || `vr-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        // followUp never interrupts a running turn; on an idle session it simply starts one.
        await post("/api/prompt", { sessionId, clientMessageId, message, mode: "followUp", images: [] });
      },
      markRead: (sessionId) => { start(); return markRead(sessionId); },
      openIn2D(sessionId, artifact) {
        (deps.navigate || ((href: string) => location.assign(href)))(chatHref(sessionId, artifact?.url));
      },
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (listTimer) clearTimeout(listTimer);
      unsubscribeRealtime();
      artifacts.dispose();
      messages.dispose();
      events.clear();
      translator.reset();
    },
  };
}
