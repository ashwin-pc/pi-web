// Public types of the client state layer (src/client/). Framework-free: every
// store follows the getSnapshot()/subscribe() contract so React's
// useSyncExternalStore, dsh's renderer stores or a plain render loop can all
// read it. Every subscription returns a disposer.

export type Unsubscribe = () => void;

/** A read model: a stable snapshot that only changes identity when its content changes. */
export type ReadableStore<T> = {
  getSnapshot(): T;
  subscribe(listener: () => void): Unsubscribe;
};

export type ClientSessionStatus = "running" | "waiting" | "idle" | "error";

export type ClientSession = {
  id: string;
  title: string;
  cwd: string;
  /** In the pinned lane of /api/session-ui-state. */
  pinned: boolean;
  /** Position within the pinned lane, or -1 when not pinned. */
  pinOrder: number;
  /** The other lane a session may sit in (parked or bookmarks), when not pinned. */
  lane: "pinned" | "parked" | "bookmarks" | null;
  status: ClientSessionStatus;
  /** pi-web stores a per-session unread flag, not a count; see unreadCount. */
  unread: boolean;
  /**
   * Turns that finished while the session was unread and this client was
   * connected (at least 1 while unread). The server has no per-turn count.
   */
  unreadCount: number;
  /** The session that spawned this one (sessionOrigins), when there is one. */
  parentId: string | null;
  /** ISO time of the last observed activity (runtime or file modification time). */
  lastActivityAt: string;
  /** ISO time the current run started, while running. */
  runningSince: string | null;
  /** Children this session is waiting on (settlement dependencies, or spawned workers that run). */
  waitingOn: string[];
  /** The last assistant error of a run that ended in error, cleared by the next run. */
  error: string | null;
  /** The session's note (sessionNotes in /api/session-ui-state). */
  note: string | null;
  /** The model label, when the runtime reports one. */
  model: string | null;
};

export type ClientMessageRole = "user" | "assistant" | "tool" | "system";

export type ClientToolCall = { id?: string; name: string; args: unknown; paths: string[] };

export type ClientMessage = {
  /** Stable for persisted entries; "streaming" for the in-flight assistant reply. */
  id: string;
  role: ClientMessageRole;
  text: string;
  timestamp?: string;
  /** Assistant messages: the tools it called. */
  toolCalls?: ClientToolCall[];
  /** Tool results: which tool, with what paths, and whether it failed. */
  tool?: ClientToolCall & { isError: boolean };
  /** True for the assistant reply that is still streaming. */
  streaming?: boolean;
  isError?: boolean;
};

export type MessagesStore = ReadableStore<readonly ClientMessage[]> & {
  /** Reload the persisted transcript. */
  refresh(): Promise<void>;
  /** True until the first transcript load has finished. */
  loading(): boolean;
};

/** Neutral event names, close to dsh's turn/*, assistant/* and tool/*. */
export type ClientEvent =
  | { type: "turn/start"; sessionId: string; at?: string }
  /** A prompt delivered to the session (from any client), before the transcript is reloaded. */
  | { type: "user/message"; sessionId: string; text: string }
  | { type: "assistant/delta"; sessionId: string; channel: "text" | "thinking"; delta: string; contentIndex?: number }
  | { type: "tool/call"; sessionId: string; toolCallId: string; name: string; args: unknown; paths: string[]; at?: string }
  | { type: "tool/result"; sessionId: string; toolCallId: string; name: string; isError: boolean; paths: string[] }
  | { type: "turn/end"; sessionId: string; aborted: boolean; error?: string; at?: string };

export type ClientEventType = ClientEvent["type"];

export type ClientArtifactKind = "image" | "markdown" | "html" | "video" | "audio" | "diff" | "model" | "diagram" | "other";

export type ClientArtifact = {
  /** Stable: the path below the artifact root (.pi/web/artifacts). */
  id: string;
  kind: ClientArtifactKind;
  name: string;
  path: string;
  /** Same-origin URL that serves it (/api/session-artifacts/<session>/<path>), with the API's auth. */
  url: string;
  /** The 0-based user turn that produced or first showed it. */
  turn: number;
  /** "written": a tool of this session wrote it; "linked": the transcript links or embeds it. */
  origin: "written" | "linked";
  bytes?: number;
  /** False when the artifact folder listing does not have it (deleted, or not written yet). */
  exists?: boolean;
};

export type ArtifactsStore = ReadableStore<readonly ClientArtifact[]> & {
  /** Re-list the artifact folder (sizes, existence). */
  refresh(): Promise<void>;
};

export type FileTreeFile = { name: string; path: string; bytes?: number };
export type FileTreeDir = {
  name: string;
  /** Absolute path. */
  path: string;
  files: FileTreeFile[];
  dirs: FileTreeDir[];
  /** True when the walk stopped early (depth or entry budget), so children may be missing. */
  truncated?: boolean;
};

export type FileTreeOptions = { maxDepth?: number; maxEntries?: number; signal?: AbortSignal };

export type PiWebClientActions = {
  /**
   * Make this the session you are looking at: it is loaded and kept warm, and
   * a run that ends while you look at it is marked read.
   */
  openSession(sessionId: string): Promise<void>;
  /** Send a prompt. Queued as a follow-up on a running session; starts a turn on an idle one. */
  prompt(sessionId: string, text: string): Promise<void>;
  markRead(sessionId: string): Promise<void>;
  /**
   * Leave the view for the 2D app on this session, optionally opening an
   * artifact in its viewer (for kinds a view cannot draw, such as HTML in WebGL).
   */
  openIn2D(sessionId: string, artifact?: Pick<ClientArtifact, "url">): void;
};

export type PiWebClient = {
  sessions: ReadableStore<readonly ClientSession[]> & { refresh(): Promise<void> };
  messages(sessionId: string): MessagesStore;
  artifacts(sessionId: string): ArtifactsStore;
  events: { subscribe(listener: (event: ClientEvent) => void): Unsubscribe };
  files: {
    tree(root: string, options?: FileTreeOptions): Promise<FileTreeDir | null>;
    /** Fetch an artifact's bytes with the API's auth (same-origin /api/ routes only), for views that draw it themselves. */
    fetch(url: string, init?: { signal?: AbortSignal }): Promise<Response>;
  };
  actions: PiWebClientActions;
  dispose(): void;
};

/** One realtime envelope as the server broadcasts it over /ws. */
export type RealtimeEnvelope = Record<string, unknown> & { type?: unknown };

export type PiWebClientDeps = {
  headers: () => Record<string, string>;
  /** The existing realtime connection; the client never opens its own socket. */
  realtime: { subscribe(listener: (envelope: RealtimeEnvelope) => void): Unsubscribe };
  /** Replaces the default opener (POST /api/sessions/open). */
  openSession?: (sessionId: string) => Promise<void>;
  fetch?: typeof fetch;
  /** Navigation, replaceable in tests. */
  navigate?: (href: string) => void;
  now?: () => number;
};
