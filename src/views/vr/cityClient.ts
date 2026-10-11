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
import type { ClientMessage, ClientSession, FileTreeDir, PiWebClient } from "../../client/types.js";

export type CityMessage = {
  type: "user" | "assistant" | "tool";
  key: string;
  text?: string;
  html?: string;
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

type CityDir = { name: string; root?: boolean; synthetic?: boolean; files: Array<{ name: string; bytes: number; lines: number }>; dirs: CityDir[] };

export type CityClient = {
  sessions: { getSnapshot(): CitySession[]; subscribe(fn: () => void): () => void };
  messages(sessionId: string): CityMessage[];
  events: { subscribe(fn: (event: { type: string; sessionId: string }) => void): () => void };
  files: { home: string; tree(root?: string): CityDir | null };
  actions: { openSession(id: string): void; prompt(id: string, text: string): boolean; markRead(id: string): void };
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

function markdownHtml(text: string) {
  try { return marked.parse(text, { async: false, gfm: true, breaks: false }) as string; } catch { return `<p>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>`; }
}

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
      if (message.text.trim()) out.push({ type: "assistant", key: message.id, html: markdownHtml(message.text), time: clock(message.timestamp), streaming: Boolean(message.streaming) });
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
    // Follow the transcripts of the sessions on screen (and stop following the rest).
    const ids = new Set(list.map((session) => session.id));
    for (const [id, unsubscribe] of messageSubscriptions) if (!ids.has(id)) { unsubscribe(); messageSubscriptions.delete(id); }
    for (const id of ids) if (!messageSubscriptions.has(id)) {
      const store = client.messages(id);
      messageSubscriptions.set(id, store.subscribe(() => syncMessages(id)));
      syncMessages(id, false);
    }
  }

  /** Rebuild a session's City message array in place, reusing message objects so the scene's caches hold. */
  function syncMessages(sessionId: string, notify = true) {
    if (disposed) return;
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
      return Object.assign(existing, message);
    });
    const keep = new Set(next.map((message) => message.key));
    for (const key of [...byKey.keys()]) if (!keep.has(key)) byKey.delete(key);
    array.splice(0, array.length, ...next);
    if (notify) for (const listener of [...eventListeners]) listener({ type: "transcript", sessionId });
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
    await Promise.all([...layout.avenues.values()].flat().map(async (root) => {
      trees.set(root, await client.files.tree(root, { maxEntries: budget }).catch(() => null));
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
    // Transcripts: the scene lays them out as soon as it is built.
    progress?.("Loading transcripts…");
    await Promise.race([
      Promise.all(included.map((session) => new Promise<void>((resolve) => {
        const store = client.messages(session.id);
        if (!store.loading()) { resolve(); return; }
        const unsubscribe = store.subscribe(() => { if (!store.loading()) { unsubscribe(); resolve(); } });
      }))),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    for (const session of included) syncMessages(session.id, false);
    project();
    unsubscribeSessions = client.sessions.subscribe(() => {
      project();
      for (const listener of [...sessionListeners]) listener();
    });
    unsubscribeEvents = client.events.subscribe((event) => {
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
    events: { subscribe(fn) { eventListeners.add(fn); return () => { eventListeners.delete(fn); }; } },
    files: {
      get home() { return home; },
      tree(root = home) { return root === home ? homeTree : null; },
    },
    actions: {
      openSession(id) { if (id) void client.actions.openSession(id).catch((error) => console.warn("VR view: could not open session", error)); },
      prompt(id, text) {
        if (!id || !text.trim()) return false;
        void client.actions.prompt(id, text).catch((error) => console.warn("VR view: prompt failed", error));
        return true;
      },
      markRead(id) { void client.actions.markRead(id).catch((error) => console.warn("VR view: mark read failed", error)); },
    },
    prepare,
    dispose() {
      disposed = true;
      unsubscribeSessions?.();
      unsubscribeEvents?.();
      for (const unsubscribe of messageSubscriptions.values()) unsubscribe();
      messageSubscriptions.clear();
      sessionListeners.clear();
      eventListeners.clear();
    },
  };
}
