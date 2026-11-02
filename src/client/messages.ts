// Per-session transcript stores: the persisted transcript from /api/messages,
// plus a live tail built from neutral events while a turn streams. The live
// tail is replaced by the persisted transcript when the turn ends.
import { createStore } from "./store.js";
import { toolPaths } from "./events.js";
import type { ClientEvent, ClientMessage, ClientMessageRole, ClientToolCall, MessagesStore } from "./types.js";

type Record_ = Record<string, unknown>;
const isRecord = (value: unknown): value is Record_ => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown) => (typeof value === "string" ? value : "");

function textOf(value: Record_): string {
  if (typeof value.text === "string") return value.text;
  const content = value.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (isRecord(part) && part.type === "text" ? str(part.text) : "")).filter(Boolean).join("\n");
  return "";
}

/** One /api/messages entry → a ClientMessage, or undefined for entries views do not show. */
export function clientMessageFromDto(value: unknown, index: number, cwd = ""): ClientMessage | undefined {
  if (!isRecord(value)) return undefined;
  const id = str(value.entryId) || `entry-${index}`;
  const timestamp = str(value.timestamp) || undefined;
  const base = { id, ...(timestamp ? { timestamp } : {}) };
  switch (value.role) {
    case "user":
      return { ...base, role: "user", text: textOf(value) };
    case "assistant": {
      const toolCalls: ClientToolCall[] = Array.isArray(value.toolCalls)
        ? value.toolCalls.filter(isRecord).map((call) => ({ ...(str(call.id) ? { id: str(call.id) } : {}), name: str(call.toolName) || "tool", args: call.args ?? {}, paths: toolPaths(str(call.toolName), call.args, cwd) }))
        : [];
      return { ...base, role: "assistant", text: textOf(value), ...(toolCalls.length ? { toolCalls } : {}), ...(value.isError ? { isError: true } : {}) };
    }
    case "toolResult": {
      const name = str(value.toolName) || "tool";
      return { ...base, role: "tool", text: textOf(value), tool: { ...(str(value.toolCallId) ? { id: str(value.toolCallId) } : {}), name, args: value.toolArgs ?? {}, paths: toolPaths(name, value.toolArgs, cwd), isError: Boolean(value.isError) } };
    }
    case "bashExecution": {
      const command = str(value.command);
      return { ...base, role: "tool", text: [command && `$ ${command}`, str(value.output)].filter(Boolean).join("\n"), tool: { name: "bash", args: { command }, paths: toolPaths("bash", { command }, cwd), isError: Number(value.exitCode) > 0 } };
    }
    case "compactionSummary":
    case "branchSummary":
    case "system":
      return { ...base, role: "system" as ClientMessageRole, text: textOf(value) };
    default:
      return undefined;
  }
}

export type MessagesController = {
  get(sessionId: string): MessagesStore;
  applyEvent(event: ClientEvent): void;
  /** A prompt sent from this client shows at once, before the server echoes it. */
  addOptimisticUser(sessionId: string, text: string): void;
  dispose(): void;
};

export function createMessagesController(deps: {
  load: (sessionId: string) => Promise<unknown[]>;
  cwdOf: (sessionId: string) => string;
}): MessagesController {
  type Entry = {
    store: ReturnType<typeof createStore<readonly ClientMessage[]>>;
    persisted: ClientMessage[];
    live: ClientMessage[];
    loading: boolean;
    generation: number;
    pending?: Promise<void>;
    api: MessagesStore;
  };
  const entries = new Map<string, Entry>();
  let disposed = false;

  function isEchoedPrompt(entry: Entry, message: ClientMessage) {
    return (message.id.startsWith("optimistic-") || message.id.startsWith("live-user-")) && entry.persisted.some((item) => item.role === "user" && item.text === message.text);
  }

  function publish(entry: Entry) {
    entry.store.set([...entry.persisted, ...entry.live]);
  }

  /** endOfTurn: the transcript now holds everything the live tail streamed, so the tail goes. */
  function refresh(sessionId: string, entry: Entry, endOfTurn = false): Promise<void> {
    const generation = ++entry.generation;
    const run = deps.load(sessionId).then((raw) => {
      if (disposed || generation !== entry.generation) return;
      const cwd = deps.cwdOf(sessionId);
      entry.persisted = raw.map((item, index) => clientMessageFromDto(item, index, cwd)).filter((item): item is ClientMessage => Boolean(item));
      // The live tail of a running turn survives a mid-turn refresh; only a prompt the transcript now holds is dropped.
      entry.live = entry.live.filter((message) => !isEchoedPrompt(entry, message) && (!endOfTurn || message.id.startsWith("optimistic-")));
    }).catch((error) => {
      if (!disposed) console.warn(`pi-web client: could not load messages for ${sessionId}`, error);
    }).finally(() => {
      if (generation !== entry.generation) return;
      entry.loading = false;
      if (!disposed) publish(entry);
    });
    entry.pending = run;
    return run;
  }

  function get(sessionId: string): MessagesStore {
    let entry = entries.get(sessionId);
    if (entry) return entry.api;
    const store = createStore<readonly ClientMessage[]>([]);
    const created: Entry = {
      store,
      persisted: [],
      live: [],
      loading: true,
      generation: 0,
      api: {
        getSnapshot: store.getSnapshot,
        subscribe: store.subscribe,
        refresh: () => refresh(sessionId, created),
        loading: () => created.loading,
      },
    };
    entries.set(sessionId, created);
    void refresh(sessionId, created);
    entry = created;
    return entry.api;
  }

  function lastLive(entry: Entry) { return entry.live[entry.live.length - 1]; }

  function applyEvent(event: ClientEvent) {
    const entry = entries.get(event.sessionId);
    if (!entry) return;
    switch (event.type) {
      case "turn/start":
        void refresh(event.sessionId, entry);
        return;
      case "user/message":
        // A prompt you sent from here is already shown (optimistic); one from elsewhere appears now.
        if (!entry.live.some((message) => message.role === "user" && message.text === event.text)) {
          entry.live = [...entry.live, { id: `live-user-${entry.live.length}`, role: "user", text: event.text }];
          publish(entry);
        }
        return;
      case "assistant/delta": {
        if (event.channel !== "text" || !event.delta) return;
        const last = lastLive(entry);
        if (last?.role === "assistant" && last.streaming) entry.live = [...entry.live.slice(0, -1), { ...last, text: last.text + event.delta }];
        else entry.live = [...entry.live, { id: `streaming-${entry.live.length}`, role: "assistant", text: event.delta, streaming: true }];
        publish(entry);
        return;
      }
      case "tool/call": {
        // A tool call ends the current assistant text round.
        entry.live = entry.live.map((message) => (message.role === "assistant" && message.streaming ? { ...message, streaming: false, id: `live-${message.id}` } : message));
        entry.live = [...entry.live, { id: `tool-${event.toolCallId}`, role: "tool", text: "", streaming: true, tool: { id: event.toolCallId, name: event.name, args: event.args, paths: event.paths, isError: false } }];
        publish(entry);
        return;
      }
      case "tool/result":
        entry.live = entry.live.map((message) => (message.id === `tool-${event.toolCallId}` && message.tool
          ? { ...message, streaming: false, tool: { ...message.tool, isError: event.isError } }
          : message));
        publish(entry);
        return;
      case "turn/end":
        entry.live = entry.live.map((message) => (message.streaming ? { ...message, streaming: false } : message));
        publish(entry);
        void refresh(event.sessionId, entry, true);
    }
  }

  function addOptimisticUser(sessionId: string, text: string) {
    const entry = entries.get(sessionId);
    if (!entry) return;
    entry.live = [...entry.live, { id: `optimistic-${Date.now()}-${entry.live.length}`, role: "user", text }];
    publish(entry);
  }

  return {
    get,
    applyEvent,
    addOptimisticUser,
    dispose() { disposed = true; entries.clear(); },
  };
}
