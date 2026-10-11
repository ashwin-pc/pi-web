// artifacts(sessionId): the artifacts a session produced or showed, for
// views that lay them out in space. pi-web keeps artifacts as files under
// <cwd>/.pi/web/artifacts/ and serves them at /api/session-artifacts/<id>/<path>
// (and /api/artifacts/<path>). A session's artifacts are the ones its
// transcript links or embeds, plus the ones its tools wrote there.
import { createStore } from "./store.js";
import type { ArtifactsStore, ClientArtifact, ClientArtifactKind, ClientMessage, MessagesStore } from "./types.js";

export const ARTIFACT_ROOT = ".pi/web/artifacts";

const KINDS: Array<[RegExp, ClientArtifactKind]> = [
  [/\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i, "image"],
  [/\.(md|markdown)$/i, "markdown"],
  [/\.html?$/i, "html"],
  [/\.(mp4|webm|mov|ogv|m4v)$/i, "video"],
  [/\.(mp3|wav|flac|opus|ogg|m4a)$/i, "audio"],
  [/\.(diff|patch)$/i, "diff"],
  [/\.(stl|gltf|glb|obj|ply)$/i, "model"],
  [/\.(mmd|mermaid)$/i, "diagram"],
];

export function artifactKind(path: string): ClientArtifactKind {
  for (const [pattern, kind] of KINDS) if (pattern.test(path)) return kind;
  return "other";
}

/** The artifact-relative path of a pi-web artifact URL or a tool's file path, or undefined if it is not an artifact. */
export function artifactPathOf(reference: string, cwd = ""): string | undefined {
  let value = reference.trim();
  if (!value) return undefined;
  try {
    if (/^[a-z]+:\/\//i.test(value)) value = new URL(value).pathname;
  } catch { return undefined; }
  value = value.split(/[?#]/)[0];
  const decode = (path: string) => { try { return decodeURIComponent(path); } catch { return path; } };
  let match = /^\/api\/artifacts\/(.+)$/.exec(value);
  if (match) return decode(match[1]);
  match = /^\/api\/session-artifacts\/[^/]+\/(.+)$/.exec(value);
  if (match) return decode(match[1]);
  // A tool's file path: absolute under the session's cwd, or relative to it.
  const root = cwd ? `${cwd.replace(/\/+$/, "")}/${ARTIFACT_ROOT}/` : "";
  if (root && value.startsWith(root)) return value.slice(root.length);
  const relative = value.replace(/^\.\//, "");
  if (relative.startsWith(`${ARTIFACT_ROOT}/`)) return relative.slice(ARTIFACT_ROOT.length + 1);
  return undefined;
}

export function artifactUrl(sessionId: string, path: string) {
  return `/api/session-artifacts/${encodeURIComponent(sessionId)}/${path.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`;
}

const LINK = /!?\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const BARE = /(?:^|[\s(])((?:https?:\/\/[^\s/]+)?\/api\/(?:session-)?artifacts\/[^\s)"'<>]+)/g;

/** Artifacts in a transcript, in first-seen order, with the turn (0-based user turn) that produced or showed each. Pure; tested. */
export function artifactsInTranscript(sessionId: string, messages: readonly ClientMessage[], cwd = ""): ClientArtifact[] {
  const found = new Map<string, ClientArtifact>();
  let turn = -1;
  const add = (path: string | undefined, name: string, origin: ClientArtifact["origin"], link?: string) => {
    if (!path || path.endsWith("/")) return;
    const existing = found.get(path);
    if (existing) { if (origin === "written") existing.origin = "written"; return; }
    // A link keeps its own route: /api/artifacts/ also finds artifacts of other workspaces.
    const url = link && /^\/api\/(?:session-)?artifacts\//.test(link) ? link : artifactUrl(sessionId, path);
    found.set(path, { id: path, kind: artifactKind(path), name: name.trim() || path.split("/").pop() || path, path, url, turn: Math.max(0, turn), origin });
  };
  const sameOriginPath = (reference: string) => { try { return new URL(reference, "http://x").pathname; } catch { return undefined; } };
  for (const message of messages) {
    if (message.role === "user") turn++;
    if (message.role === "assistant" || message.role === "tool" || message.role === "system") {
      for (const match of message.text.matchAll(LINK)) add(artifactPathOf(match[2], cwd), match[1], "linked", sameOriginPath(match[2]));
      for (const match of message.text.matchAll(BARE)) add(artifactPathOf(match[1], cwd), "", "linked", sameOriginPath(match[1]));
    }
    for (const call of [...(message.toolCalls || []), ...(message.tool ? [message.tool] : [])]) {
      if (!/^(write|edit|bash)$/.test(call.name)) continue;
      for (const path of call.paths) add(artifactPathOf(path, cwd), "", "written");
    }
  }
  return [...found.values()];
}

export type ArtifactsController = {
  get(sessionId: string): ArtifactsStore;
  dispose(): void;
};

/**
 * One store per session, derived from its messages store (live: a link that
 * streams in appears at once), with byte sizes filled from one listing of
 * the session's artifact folder.
 */
export function createArtifactsController(deps: {
  messages: (sessionId: string) => MessagesStore;
  cwdOf: (sessionId: string) => string;
  list: (sessionId: string, path: string) => Promise<{ entries?: Array<{ name?: unknown; path?: unknown; kind?: unknown; size?: unknown }> }>;
}): ArtifactsController {
  const stores = new Map<string, { api: ArtifactsStore; dispose: () => void }>();
  /** One listing per workspace (sessions in the same cwd share an artifact folder): path → bytes. */
  const folders = new Map<string, Promise<Map<string, number | undefined>>>();

  function listWorkspace(sessionId: string, fresh: boolean) {
    const key = deps.cwdOf(sessionId) || `session:${sessionId}`;
    const cached = folders.get(key);
    if (cached && !fresh) return cached;
    const files = new Map<string, number | undefined>();
    const walk = async (path: string, depth: number): Promise<void> => {
      if (depth > 3 || files.size > 400) return;
      const data = await deps.list(sessionId, path ? `${ARTIFACT_ROOT}/${path}` : ARTIFACT_ROOT).catch(() => ({ entries: [] }));
      const dirs: string[] = [];
      for (const entry of data.entries || []) {
        const name = typeof entry.name === "string" ? entry.name : "";
        if (!name || name.startsWith(".")) continue;
        const relative = path ? `${path}/${name}` : name;
        if (entry.kind === "directory") dirs.push(relative);
        else files.set(relative, typeof entry.size === "number" ? entry.size : undefined);
      }
      await Promise.all(dirs.map((dir) => walk(dir, depth + 1)));
    };
    const listing = walk("", 0).then(() => files);
    folders.set(key, listing);
    return listing;
  }

  function get(sessionId: string) {
    const existing = stores.get(sessionId);
    if (existing) return existing.api;
    const store = createStore<readonly ClientArtifact[]>([]);
    let files: Map<string, number | undefined> | undefined;
    const messages = deps.messages(sessionId);

    function derive() {
      const artifacts = artifactsInTranscript(sessionId, messages.getSnapshot(), deps.cwdOf(sessionId))
        .map((artifact) => ({ ...artifact, ...(files?.get(artifact.path) !== undefined ? { bytes: files.get(artifact.path) } : {}), ...(files ? { exists: files.has(artifact.path) } : {}) }));
      const previous = store.getSnapshot();
      const same = previous.length === artifacts.length && previous.every((item, index) => item.id === artifacts[index].id && item.bytes === artifacts[index].bytes && item.origin === artifacts[index].origin && item.exists === artifacts[index].exists);
      if (!same) store.set(artifacts);
    }

    const unsubscribe = messages.subscribe(derive);
    const load = async (fresh: boolean) => { files = await listWorkspace(sessionId, fresh); derive(); };
    const api: ArtifactsStore = {
      getSnapshot: store.getSnapshot,
      subscribe: store.subscribe,
      refresh: () => load(true),
    };
    stores.set(sessionId, { api, dispose: unsubscribe });
    derive();
    void load(false);
    return api;
  }

  return {
    get,
    dispose() { for (const entry of stores.values()) entry.dispose(); stores.clear(); folders.clear(); },
  };
}
