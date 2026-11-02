// The live backing for the City scene. The City (ported from the vr-city
// mock) reads data through one module, ./city/client.js, shaped like the
// mock's client interface. This adapter maps the real client state layer
// (src/client/) onto that shape, so the scene code is unchanged:
//
//   real PiWebClient                     City client (mock-shaped)
//   sessions (ClientSession)        →    sessions ({id, title, running: {since}, updatedAt (ms), …})
//   messages(id) (ClientMessage)    →    messages(id): a live array of {type: user | assistant | tool, …}
//   events (neutral)                →    events: "this session's transcript changed"
//   files.tree(root) (async)        →    files.tree(home) (sync, prefetched by prepare())
import { marked } from "marked";
import type { ClientArtifact, ClientMessage, ClientSession, FileTreeDir, PiWebClient } from "../../client/types.js";
import { ARTIFACT_ROOT } from "../../client/artifacts.js";

export type CityMessage = {
  type: "user" | "assistant" | "tool";
  key: string;
  text?: string;
  /** The City's HTML (assistant messages): parsed from `src` on first read, so a transcript parses only what is drawn. */
  html?: string;
  /** The assistant message's markdown. */
  src?: string;
  time?: string;
  streaming?: boolean;
  name?: string;
  sub?: string;
  args?: Record<string, unknown>;
  body?: string;
  status?: "running" | "success" | "error";
  sum?: string;
};

export type CitySession = {
  id: string; title: string; short: string | null; cwd: string; parent: string | null;
  lane: ClientSession["lane"]; pinned: boolean; pinOrder: number; status: "running" | "error" | "idle";
  running: { since: number } | null; error: string | null; unread: boolean; note: string | null;
  model: string | null; context: number; updatedAt: number; seenTurns: number | null; synthetic: false;
};

/** The City's artifact record (round 3): `id` is "<sessionId>:<path>", `path` is absolute (a file in the city), `turn` is 1-based. */
export type CityArtifact = {
  id: string; sessionId: string; kind: ClientArtifact["kind"]; name: string; path: string; turn: number; bytes: number;
  url: string; exists?: boolean; artifactPath: string;
};

export function cityArtifactOf(sessionId: string, cwd: string, artifact: ClientArtifact): CityArtifact {
  return {
    id: `${sessionId}:${artifact.path}`,
    sessionId,
    kind: artifact.kind,
    name: artifact.name,
    path: `${cwd.replace(/\/+$/, "")}/${ARTIFACT_ROOT}/${artifact.path}`,
    turn: artifact.turn + 1,
    bytes: artifact.bytes ?? 0,
    url: artifact.url,
    artifactPath: artifact.path,
    ...(artifact.exists === undefined ? {} : { exists: artifact.exists }),
  };
}

type CityDir = { name: string; root?: boolean; synthetic?: boolean; files: Array<{ name: string; bytes: number; lines: number }>; dirs: CityDir[] };

export type CityClient = {
  sessions: { getSnapshot(): CitySession[]; subscribe(fn: () => void): () => void };
  messages(sessionId: string): CityMessage[];
  /** What a session produced (round 3): a live array, updated in place. */
  artifacts(sessionId: string): CityArtifact[];
  /** Bumps when any session's artifacts change (the city's markers re-sync). */
  artifactsVersion(): number;
  /** Load and follow these sessions' transcripts now (they load lazily otherwise). */
  warm(ids: string[]): void;
  /** Whether a session's transcript has loaded (the scene waits for it before marking what is "new"). */
  messagesLoaded(id: string): boolean;
  events: { subscribe(fn: (event: { type: string; sessionId: string }) => void): () => void };
  files: { home: string; tree(root?: string): CityDir | null };
  actions: { openSession(id: string): void; prompt(id: string, text: string): boolean; markRead(id: string): void; openIn2D(id: string, artifact?: { url: string }): void };
  /** The real client, for loading artifact content. */
  live: PiWebClient;
  /** The session the 2D app had open, to start on. */
  initialSessionId: string | null;
  /** Load the session list, transcripts and file trees the scene needs before it is built. */
  prepare(progress?: (text: string) => void): Promise<void>;
  dispose(): void;
};

/** How many sessions the scene follows, and how many recent turns of each it lays out. */
const MAX_SESSIONS = 40;
const FALLBACK_PINS = 8;
const MAX_TURNS = 40;
const BYTES_PER_LINE = 34;

const basename = (path: string) => path.split("/").filter(Boolean).pop() || path;
const dirname = (path: string) => path.replace(/\/+[^/]*\/*$/, "") || "/";

function clock(timestamp?: string) {
  const time = timestamp ? Date.parse(timestamp) : NaN;
  return Number.isFinite(time) ? new Date(time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : undefined;
}

const htmlCache = new Map<string, string>();
/** Markdown → the City's HTML subset. Cached by text: a streaming reply re-parses only the message that grew. */
function markdownHtml(text: string) {
  const cached = htmlCache.get(text);
  if (cached !== undefined) return cached;
  let html: string;
  try { html = marked.parse(text, { async: false, gfm: true, breaks: false }) as string; } catch { html = `<p>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>`; }
  if (htmlCache.size > 2000) htmlCache.clear();
  htmlCache.set(text, html);
  return html;
}

/** Give an assistant message an `html` that is parsed from its markdown on first read (and re-parsed when it changes). */
function lazyHtml(message: CityMessage): CityMessage {
  let parsedFrom: string | undefined, html = "";
  Object.defineProperty(message, "html", {
    configurable: true, enumerable: false,
    get() { if (parsedFrom !== this.src) { parsedFrom = this.src; html = markdownHtml(this.src || ""); } return html; },
  });
  return message;
}

/** Streaming deltas arrive at token rate; the scene re-lays a transcript at most this often (ms). */
export const STREAM_SYNC_MS = 200;
/** How long the file walk may take before the city is built (first frame). */
export const TREE_MS = 2500;

function toolArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
}

function toolEntry(key: string, name: string, args: unknown, paths: string[], status: CityMessage["status"], body = ""): CityMessage {
  const a = toolArgs(args);
  const command = typeof a.command === "string" ? a.command : "";
  const sub = command || paths[0] || "";
  const fileTool = name === "read" || name === "write" || name === "edit";
  return {
    type: "tool", key, name, sub,
    // The City's activity model reads args.path (file tools) and args.command (bash).
    args: { ...a, ...(fileTool && paths[0] && typeof a.path !== "string" ? { path: paths[0] } : {}) },
    body: body.length > 4000 ? `${body.slice(0, 4000)}…` : body,
    status,
    ...(fileTool && paths[0] ? { sum: basename(paths[0]) } : {}),
  };
}

/** ClientMessages (persisted transcript plus live tail) → the City's message list. Pure; tested. */
export function cityMessagesOf(messages: readonly ClientMessage[], running: boolean): CityMessage[] {
  const out: CityMessage[] = [];
  const toolByCallId = new Map<string, CityMessage>();
  for (const message of messages) {
    if (message.role === "user") {
      out.push({ type: "user", key: message.id, text: message.text, time: clock(message.timestamp) });
    } else if (message.role === "assistant") {
      if (message.text.trim()) out.push(lazyHtml({ type: "assistant", key: message.id, src: message.text, time: clock(message.timestamp), streaming: Boolean(message.streaming) }));
      for (const [index, call] of (message.toolCalls || []).entries()) {
        const entry = toolEntry(`${message.id}:call:${call.id || index}`, call.name, call.args, call.paths, running ? "running" : "success");
        if (call.id) toolByCallId.set(call.id, entry);
        out.push(entry);
      }
    } else if (message.role === "tool" && message.tool) {
      const status = message.streaming ? "running" : message.tool.isError ? "error" : "success";
      const known = message.tool.id ? toolByCallId.get(message.tool.id) : undefined;
      if (known) Object.assign(known, { status, body: message.text.slice(0, 4000) });
      else {
        const entry = toolEntry(message.id, message.tool.name, message.tool.args, message.tool.paths, status, message.text);
        if (message.tool.id) toolByCallId.set(message.tool.id, entry);
        out.push(entry);
      }
    }
  }
  // A finished run has no running tools, whatever the transcript says.
  if (!running) for (const entry of out) if (entry.status === "running") entry.status = "success";
  // Only the most recent turns: a turn starts at each user message.
  let turns = 0;
  for (let index = out.length - 1; index >= 0; index--) {
    if (out[index].type === "user" && ++turns >= MAX_TURNS) return out.slice(index);
  }
  return out;
}

/** The deepest directory containing every path. */
function commonAncestor(paths: string[]) {
  if (!paths.length) return "/";
  const split = paths.map((path) => path.split("/").filter(Boolean));
  const common: string[] = [];
  for (let index = 0; split.every((parts) => index < parts.length && parts[index] === split[0][index]); index++) common.push(split[0][index]);
  return `/${common.join("/")}`;
}

/**
 * Lay workspace roots out as the City expects: home → avenues (the folders
 * that lead to roots) → districts (the roots). Avenues are flattened, so an
 * avenue's direct children are always its roots.
 */
export function cityHomeOf(roots: string[]) {
  const unique = [...new Set(roots.map((root) => root.replace(/\/+$/, "") || "/"))]
    .filter((root, _index, all) => !all.some((other) => other !== root && root.startsWith(`${other}/`)))
    .sort();
  const parents = unique.map(dirname);
  let home = commonAncestor(parents);
  if (parents.includes(home)) home = dirname(home);
  if (home === "/") home = "";
  const avenues = new Map<string, string[]>();
  for (const root of unique) {
    const parent = dirname(root);
    const name = parent.slice(home.length + 1) || basename(parent);
    avenues.set(name, [...(avenues.get(name) || []), root]);
  }
  return { home, avenues };
}

function cityDirOf(tree: FileTreeDir, root = false): CityDir {
  return {
    name: tree.name,
    ...(root ? { root: true } : {}),
    files: tree.files.map((file) => ({ name: file.name, bytes: file.bytes ?? 1200, lines: Math.max(1, Math.round((file.bytes ?? 1200) / BYTES_PER_LINE)) })),
    dirs: tree.dirs.map((dir) => cityDirOf(dir)),
  };
}

export function createCityClient(client: PiWebClient, options: { initialSessionId?: string | null } = {}): CityClient {
  const arrays = new Map<string, CityMessage[]>();
  const objects = new Map<string, Map<string, CityMessage>>();
  const messageSubscriptions = new Map<string, () => void>();
  const artifactArrays = new Map<string, CityArtifact[]>();
  const artifactSubscriptions = new Map<string, () => void>();
  let artifactsVersion = 0;
  const hot = new Set<string>();
  const loadedOnce = new Set<string>();
  const sessionListeners = new Set<() => void>();
  const eventListeners = new Set<(event: { type: string; sessionId: string }) => void>();
  let included: ClientSession[] = [];
  let snapshot: CitySession[] = [];
  let homeTree: CityDir | null = null;
  let home = "";
  let disposed = false;
  const initialSessionId = options.initialSessionId || null;

  /** The sessions the scene follows: pins (or the most recent few), running ones, the 2D app's current one, and their workers. */
  function choose(all: readonly ClientSession[]) {
    const pinned = all.filter((session) => session.pinned);
    const byRecent = [...all].sort((a, b) => (Date.parse(b.lastActivityAt) || 0) - (Date.parse(a.lastActivityAt) || 0));
    const pins = pinned.length ? pinned : byRecent.slice(0, FALLBACK_PINS);
    const pick = new Map(pins.map((session) => [session.id, session]));
    for (const session of all) if (session.status === "running" || session.id === initialSessionId || session.lane) pick.set(session.id, session);
    for (const session of all) if (session.parentId && pick.has(session.parentId)) pick.set(session.id, session);
    const pinIds = new Set(pins.map((session) => session.id));
    return { list: [...pick.values()].slice(0, MAX_SESSIONS), pinIds, fallback: !pinned.length };
  }

  function turnCount(sessionId: string) { return (arrays.get(sessionId) || []).filter((m) => m.type === "user").length; }

  function project() {
    const { list, pinIds, fallback } = choose(client.sessions.getSnapshot());
    included = list;
    const order = [...pinIds];
    snapshot = list.map((session): CitySession => {
      const pinned = pinIds.has(session.id);
      const turns = turnCount(session.id);
      return {
        id: session.id,
        title: session.title,
        short: null,
        cwd: session.cwd,
        parent: session.parentId,
        lane: fallback && pinned ? "pinned" : session.lane,
        pinned,
        pinOrder: pinned ? (fallback ? order.indexOf(session.id) : session.pinOrder) : -1,
        // "Waiting on workers" is derived by the City from parent links.
        status: session.status === "running" ? "running" : session.status === "error" ? "error" : "idle",
        running: session.status === "running" ? { since: Date.parse(session.runningSince || session.lastActivityAt) || Date.now() } : null,
        error: session.error,
        unread: session.unread,
        note: session.note,
        model: session.model,
        context: 0,
        updatedAt: Date.parse(session.lastActivityAt) || 0,
        seenTurns: session.unread && turns ? Math.max(0, turns - session.unreadCount) : null,
        synthetic: false,
      };
    });
    // Stop following sessions that left the scene. Transcripts load lazily (warm): the current session and its
    // neighbours, running sessions (their beams need the tool), and whatever you open or point at.
    const ids = new Set(list.map((session) => session.id));
    for (const [id, unsubscribe] of messageSubscriptions) if (!ids.has(id)) { unsubscribe(); messageSubscriptions.delete(id); hot.delete(id); }
    for (const [id, unsubscribe] of artifactSubscriptions) if (!ids.has(id)) { unsubscribe(); artifactSubscriptions.delete(id); }
    warm(list.filter((session) => session.status === "running").map((session) => session.id));
  }

  /** Load and follow these sessions' transcripts and artifacts (idempotent). */
  function warm(ids: Array<string | null | undefined>) {
    for (const id of ids) {
      if (!id || hot.has(id) || !included.some((session) => session.id === id)) continue;
      hot.add(id);
      const store = client.messages(id);
      messageSubscriptions.set(id, store.subscribe(() => scheduleSync(id)));
      artifactSubscriptions.set(id, client.artifacts(id).subscribe(() => syncArtifacts(id)));
      syncMessages(id, false);
      syncArtifacts(id, false);
    }
  }
  /** A session and its neighbours in the pinned order (the ones a flick reaches next). */
  function neighbours(id: string) {
    const pins = snapshot.filter((session) => session.pinned).sort((a, b) => a.pinOrder - b.pinOrder).map((session) => session.id);
    const i = pins.indexOf(id);
    return i < 0 ? [id] : [id, pins[(i + 1) % pins.length], pins[(i - 1 + pins.length) % pins.length]];
  }

  const syncTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Coalesce a burst of transcript changes (streaming) into one rebuild per STREAM_SYNC_MS per session. */
  function scheduleSync(sessionId: string) {
    if (syncTimers.has(sessionId)) return;
    syncTimers.set(sessionId, setTimeout(() => { syncTimers.delete(sessionId); syncMessages(sessionId); }, STREAM_SYNC_MS));
  }

  /** Rebuild a session's City message array in place, reusing message objects so the scene's caches hold. */
  function syncMessages(sessionId: string, notify = true) {
    if (disposed || !hot.has(sessionId)) return;
    const session = client.sessions.getSnapshot().find((item) => item.id === sessionId);
    const fresh = cityMessagesOf(client.messages(sessionId).getSnapshot(), session?.status === "running");
    let array = arrays.get(sessionId);
    if (!array) { array = []; arrays.set(sessionId, array); }
    let byKey = objects.get(sessionId);
    if (!byKey) { byKey = new Map(); objects.set(sessionId, byKey); }
    const next = fresh.map((message) => {
      const existing = byKey!.get(message.key);
      if (!existing || existing.type !== message.type) { byKey!.set(message.key, message); return message; }
      for (const key of Object.keys(existing) as Array<keyof CityMessage>) if (!(key in message)) delete existing[key];
      // Object.assign copies own enumerable fields only: the lazy html getter of `existing` stays, and re-parses
      // when the new `src` differs.
      return Object.assign(existing, message);
    });
    const keep = new Set(next.map((message) => message.key));
    for (const key of [...byKey.keys()]) if (!keep.has(key)) byKey.delete(key);
    array.splice(0, array.length, ...next);
    if (notify) for (const listener of [...eventListeners]) listener({ type: "transcript", sessionId });
    // The first time a transcript arrives, the scene re-reads the session (its "seen" position starts there).
    if (!loadedOnce.has(sessionId) && !client.messages(sessionId).loading()) {
      loadedOnce.add(sessionId);
      if (notify) for (const listener of [...sessionListeners]) listener();
    }
  }

  function syncArtifacts(sessionId: string, notify = true) {
    if (disposed || !hot.has(sessionId)) return;
    const cwd = client.sessions.getSnapshot().find((item) => item.id === sessionId)?.cwd || "";
    const fresh = client.artifacts(sessionId).getSnapshot().map((artifact) => cityArtifactOf(sessionId, cwd, artifact));
    let array = artifactArrays.get(sessionId);
    if (!array) { array = []; artifactArrays.set(sessionId, array); }
    const byId = new Map(array.map((item) => [item.id, item]));
    array.splice(0, array.length, ...fresh.map((item) => { const existing = byId.get(item.id); return existing ? Object.assign(existing, item) : item; }));
    artifactsVersion++;
    if (notify) for (const listener of [...eventListeners]) listener({ type: "transcript", sessionId });
  }

  /** Artifact files are files in the city, even when the tree walk did not reach them. */
  function addArtifactFiles(tree: CityDir, homePath: string) {
    for (const array of artifactArrays.values()) for (const artifact of array) {
      if (!artifact.path.startsWith(`${homePath}/`)) continue;
      const relative = artifact.path.slice(homePath.length + 1);
      // Avenues are flattened ("oss/x"), so match the avenue by prefix, then walk the rest.
      const avenue = tree.dirs.find((dir) => relative.startsWith(`${dir.name}/`));
      if (!avenue) continue;
      const parts = relative.slice(avenue.name.length + 1).split("/");
      let node: CityDir = avenue;
      for (const part of parts.slice(0, -1)) {
        let next = node.dirs.find((dir) => dir.name === part);
        if (!next) { next = { name: part, files: [], dirs: [] }; node.dirs.push(next); }
        node = next;
      }
      const name = parts[parts.length - 1];
      if (!node.files.some((file) => file.name === name)) node.files.push({ name, bytes: artifact.bytes || 1200, lines: Math.max(1, Math.round((artifact.bytes || 1200) / BYTES_PER_LINE)) });
    }
  }

  let unsubscribeSessions: (() => void) | undefined;
  let unsubscribeEvents: (() => void) | undefined;

  function waitForSessions(timeoutMs: number) {
    return new Promise<void>((resolve) => {
      if (client.sessions.getSnapshot().length) { resolve(); return; }
      const timer = setTimeout(() => { unsubscribe(); resolve(); }, timeoutMs);
      const unsubscribe = client.sessions.subscribe(() => {
        if (!client.sessions.getSnapshot().length) return;
        clearTimeout(timer); unsubscribe(); resolve();
      });
    });
  }

  async function prepare(progress?: (text: string) => void) {
    progress?.("Loading sessions…");
    await client.sessions.refresh();
    await waitForSessions(4000);
    project();
    const roots = [...new Set(included.map((session) => session.cwd).filter(Boolean))];
    const layout = cityHomeOf(roots);
    home = layout.home;
    progress?.(`Mapping ${roots.length} workspace${roots.length === 1 ? "" : "s"}…`);
    const trees = new Map<string, FileTreeDir | null>();
    const budget = Math.max(800, Math.floor(6000 / Math.max(1, roots.length)));
    // The city is built from whatever the walk has after this long (deep folders show as blocks without buildings).
    const treeDeadline = Date.now() + TREE_MS;
    await Promise.all([...layout.avenues.values()].flat().map(async (root) => {
      trees.set(root, await client.files.tree(root, { maxEntries: budget, deadline: treeDeadline }).catch(() => null));
    }));
    homeTree = {
      name: basename(home) || "/",
      files: [],
      dirs: [...layout.avenues.entries()].map(([name, avenueRoots]) => ({
        name,
        files: [],
        dirs: avenueRoots.map((root) => {
          const tree = trees.get(root);
          return tree ? cityDirOf(tree, true) : { name: basename(root), root: true, files: [], dirs: [] };
        }),
      })),
    };
    // Transcripts: only the session you start on (and its neighbours) load now; the rest load when you go to them.
    progress?.("Loading the current session…");
    const start = included.find((session) => session.id === initialSessionId)?.id
      || snapshot.filter((session) => session.pinned).sort((a, b) => a.pinOrder - b.pinOrder)[0]?.id || included[0]?.id;
    if (start) {
      warm(neighbours(start));
      const store = client.messages(start);
      await Promise.race([
        new Promise<void>((resolve) => {
          if (!store.loading()) { resolve(); return; }
          const unsubscribe = store.subscribe(() => { if (!store.loading()) { unsubscribe(); resolve(); } });
        }),
        new Promise((resolve) => setTimeout(resolve, 4000)),
      ]);
      for (const id of hot) syncMessages(id, false);
    }
    project();
    if (homeTree) addArtifactFiles(homeTree, home);
    unsubscribeSessions = client.sessions.subscribe(() => {
      project();
      for (const listener of [...sessionListeners]) listener();
    });
    unsubscribeEvents = client.events.subscribe((event) => {
      if (event.type === "turn/start") warm([event.sessionId]);
      if (event.type === "turn/start" || event.type === "turn/end") syncMessages(event.sessionId);
    });
  }

  return {
    initialSessionId,
    sessions: {
      getSnapshot: () => snapshot,
      subscribe(fn) { sessionListeners.add(fn); return () => { sessionListeners.delete(fn); }; },
    },
    messages(sessionId) {
      let array = arrays.get(sessionId);
      if (!array) { array = []; arrays.set(sessionId, array); }
      return array;
    },
    artifacts(sessionId) {
      let array = artifactArrays.get(sessionId);
      if (!array) { array = []; artifactArrays.set(sessionId, array); }
      return array;
    },
    artifactsVersion: () => artifactsVersion,
    warm: (ids) => warm(ids),
    messagesLoaded: (id) => hot.has(id) && !client.messages(id).loading(),
    live: client,
    events: { subscribe(fn) { eventListeners.add(fn); return () => { eventListeners.delete(fn); }; } },
    files: {
      get home() { return home; },
      tree(root = home) { return root === home ? homeTree : null; },
    },
    actions: {
      openSession(id) {
        if (!id) return;
        warm(neighbours(id));
        void client.actions.openSession(id).catch((error) => console.warn("VR view: could not open session", error));
      },
      prompt(id, text) {
        if (!id || !text.trim()) return false;
        void client.actions.prompt(id, text).catch((error) => console.warn("VR view: prompt failed", error));
        return true;
      },
      markRead(id) { void client.actions.markRead(id).catch((error) => console.warn("VR view: mark read failed", error)); },
      openIn2D(id, artifact) { client.actions.openIn2D(id, artifact); },
    },
    prepare,
    dispose() {
      disposed = true;
      unsubscribeSessions?.();
      unsubscribeEvents?.();
      for (const unsubscribe of messageSubscriptions.values()) unsubscribe();
      messageSubscriptions.clear();
      for (const timer of syncTimers.values()) clearTimeout(timer);
      syncTimers.clear();
      for (const unsubscribe of artifactSubscriptions.values()) unsubscribe();
      artifactSubscriptions.clear();
      sessionListeners.clear();
      eventListeners.clear();
    },
  };
}
