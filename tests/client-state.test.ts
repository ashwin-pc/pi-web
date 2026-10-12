import { describe, expect, it, vi } from "vitest";
import { createSessionsModel } from "../src/client/sessions.js";
import { createMessagesController } from "../src/client/messages.js";
import { createPiWebClient } from "../src/client/client.js";
import { createStore } from "../src/client/store.js";
import type { RealtimeEnvelope } from "../src/client/types.js";

const since = "2026-10-11T09:00:00.000Z";
const uiState = (fields: Record<string, unknown> = {}) => ({
  version: 3, revision: 1, initialized: true, lanes: [], sessionNotes: [], pinnedFolders: [], favoriteFolders: [], sessionMarkers: [],
  sessionUnreadStates: [], sessionOrigins: [], selectedMarkerColor: "blue", allowedMarkerColors: [], bucketLabels: {}, bucketOrder: ["blue", "purple", "yellow", "red", "green", "orange", "cyan", "pink"],
  ...fields,
});
const list = [
  { id: "a", name: "Alpha", cwd: "/w/a", modified: "2026-10-11T08:00:00.000Z" },
  { id: "b", firstMessage: "Build the bar", cwd: "/w/b", modified: "2026-10-11T10:00:00.000Z", runtime: { isRunning: true, isStreaming: true, startedAt: since } },
  { id: "c", cwd: "/w/c", modified: "2026-10-11T07:00:00.000Z" },
];

describe("store", () => {
  it("keeps snapshot identity until set, and returns one disposer per subscription", () => {
    const store = createStore<number[]>([]);
    const first = store.getSnapshot();
    expect(store.getSnapshot()).toBe(first);
    const listener = vi.fn();
    const one = store.subscribe(listener);
    const two = store.subscribe(listener);
    store.set([1]);
    expect(listener).toHaveBeenCalledTimes(2);
    one();
    one(); // idempotent
    store.set([2]);
    expect(listener).toHaveBeenCalledTimes(3);
    two();
    store.set([3]);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(store.listenerCount()).toBe(0);
  });

  it("isolates a failing listener from the others", () => {
    const store = createStore(0);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const good = vi.fn();
    store.subscribe(() => { throw new Error("boom"); });
    store.subscribe(good);
    store.set(1);
    expect(good).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});

describe("sessions model", () => {
  it("derives pins, order, unread, parent, notes and status from the list and the ui state", () => {
    const model = createSessionsModel();
    model.applyList(list);
    model.applyUiState(uiState({
      lanes: [{ sessionId: "c", lane: "pinned", since }, { sessionId: "a", lane: "pinned", since }, { sessionId: "b", lane: "parked", since }],
      sessionUnreadStates: [{ sessionId: "a", unreadAt: since, updatedAt: since }],
      sessionOrigins: [{ sessionId: "b", originSessionId: "a", kind: "spawn", updatedAt: since }],
      sessionNotes: [{ sessionId: "a", note: "ship it", updatedAt: since }],
    }));
    const snapshot = model.getSnapshot();
    expect(snapshot.map((s) => [s.id, s.pinned, s.pinOrder, s.lane])).toEqual([["c", true, 0, "pinned"], ["a", true, 1, "pinned"], ["b", false, -1, "parked"]]);
    const a = snapshot.find((s) => s.id === "a")!;
    const b = snapshot.find((s) => s.id === "b")!;
    expect(a).toMatchObject({ title: "Alpha", unread: true, unreadCount: 1, status: "waiting", waitingOn: ["b"], note: "ship it", parentId: null });
    expect(b).toMatchObject({ title: "Build the bar", status: "running", runningSince: since, parentId: "a" });
  });

  it("follows realtime runtime, settle, unread and deletion, and counts turns that end while unread", () => {
    const model = createSessionsModel();
    model.applyList(list);
    model.applyUiState(uiState({ sessionUnreadStates: [{ sessionId: "c", unreadAt: since, updatedAt: since }] }));
    const listener = vi.fn();
    const dispose = model.subscribe(listener);
    model.applyEnvelope({ type: "agent_event", sessionId: "c", event: { type: "agent_start", startedAt: since } });
    expect(model.getSnapshot().find((s) => s.id === "c")?.status).toBe("running");
    model.applyEnvelope({ type: "agent_event", sessionId: "c", event: { type: "agent_settled" } });
    model.applyEvent({ type: "turn/end", sessionId: "c", aborted: false, error: "model overloaded" });
    expect(model.getSnapshot().find((s) => s.id === "c")).toMatchObject({ status: "error", unreadCount: 2, error: "model overloaded" });
    model.applyEnvelope({ type: "session_runtime_changed", sessionId: "c", runtime: { isRunning: true, isStreaming: true } });
    expect(model.getSnapshot().find((s) => s.id === "c")?.status).toBe("running");
    model.markReadLocally("c");
    expect(model.getSnapshot().find((s) => s.id === "c")).toMatchObject({ unread: false, unreadCount: 0 });
    model.applyEnvelope({ type: "session_deleted", sessionId: "b" });
    expect(model.getSnapshot().some((s) => s.id === "b")).toBe(false);
    const calls = listener.mock.calls.length;
    dispose();
    model.applyEnvelope({ type: "session_runtime_changed", sessionId: "a", runtime: { isRunning: true } });
    expect(listener).toHaveBeenCalledTimes(calls);
  });

  it("keeps a pinned session the list does not know yet, with the lane's cwd", () => {
    const model = createSessionsModel();
    model.applyUiState(uiState({ lanes: [{ sessionId: "ghost", lane: "pinned", cwd: "/w/ghost", since }] }));
    expect(model.getSnapshot()).toMatchObject([{ id: "ghost", pinned: true, cwd: "/w/ghost", title: "New session" }]);
    expect(model.missingLaneCwds()).toEqual(["/w/ghost"]);
  });

  it("uses the session list's unread flag until the ui state has loaded", () => {
    const model = createSessionsModel();
    model.applyList([{ id: "a", cwd: "/w", unread: true }]);
    expect(model.getSnapshot()[0].unread).toBe(true);
    model.applyUiState(uiState());
    expect(model.getSnapshot()[0].unread).toBe(false);
  });

  it("does not let a replayed agent event change runtime state", () => {
    const model = createSessionsModel();
    model.applyList([{ id: "a", cwd: "/w" }]);
    const before = model.getSnapshot();
    model.applyEnvelope({ type: "agent_event", sessionId: "a", replay: true, event: { type: "agent_start" } });
    expect(model.getSnapshot()).toBe(before);
  });
});

describe("messages", () => {
  it("streams a live tail and replaces it with the persisted transcript at the end of the turn", async () => {
    let persisted: unknown[] = [{ role: "user", text: "hi", entryId: "u1" }];
    const load = vi.fn(async () => persisted);
    const controller = createMessagesController({ load, cwdOf: () => "/repo" });
    const store = controller.get("s");
    expect(store.loading()).toBe(true);
    await store.refresh();
    expect(store.loading()).toBe(false);
    expect(store.getSnapshot().map((m) => m.text)).toEqual(["hi"]);
    controller.applyEvent({ type: "turn/start", sessionId: "s" });
    controller.applyEvent({ type: "tool/call", sessionId: "s", toolCallId: "t1", name: "read", args: { path: "a.ts" }, paths: ["/repo/a.ts"] });
    controller.applyEvent({ type: "tool/result", sessionId: "s", toolCallId: "t1", name: "read", isError: false, paths: ["/repo/a.ts"] });
    controller.applyEvent({ type: "assistant/delta", sessionId: "s", channel: "text", delta: "Hel" });
    controller.applyEvent({ type: "assistant/delta", sessionId: "s", channel: "text", delta: "lo" });
    controller.applyEvent({ type: "assistant/delta", sessionId: "s", channel: "thinking", delta: "ignored" });
    // get() loads once, refresh() once, turn/start once.
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The mid-turn refresh keeps the live tail.
    expect(store.getSnapshot().map((m) => [m.role, m.text, Boolean(m.streaming)])).toEqual([["user", "hi", false], ["tool", "", false], ["assistant", "Hello", true]]);
    persisted = [...persisted, { role: "assistant", text: "Hello", entryId: "a1", toolCalls: [{ id: "t1", toolName: "read", args: { path: "a.ts" } }] }, { role: "toolResult", toolCallId: "t1", toolName: "read", toolArgs: { path: "a.ts" }, text: "ok", isError: false }];
    controller.applyEvent({ type: "turn/end", sessionId: "s", aborted: false });
    await vi.waitFor(() => expect(store.getSnapshot().map((m) => m.id)).toEqual(["u1", "a1", "entry-2"]));
    expect(store.getSnapshot()[1].toolCalls?.[0].paths).toEqual(["/repo/a.ts"]);
    expect(store.getSnapshot()[2].tool).toMatchObject({ name: "read", paths: ["/repo/a.ts"], isError: false });
  });

  it("shows a prompt delivered from another client at once, once", async () => {
    let persisted: unknown[] = [];
    const controller = createMessagesController({ load: async () => persisted, cwdOf: () => "" });
    const store = controller.get("s");
    await store.refresh();
    controller.applyEvent({ type: "user/message", sessionId: "s", text: "from my phone" });
    controller.applyEvent({ type: "user/message", sessionId: "s", text: "from my phone" });
    expect(store.getSnapshot().map((m) => [m.role, m.text])).toEqual([["user", "from my phone"]]);
    persisted = [{ role: "user", text: "from my phone", entryId: "u" }];
    await store.refresh();
    expect(store.getSnapshot().map((m) => m.id)).toEqual(["u"]);
  });

  it("shows an optimistic prompt until the transcript echoes it", async () => {
    let persisted: unknown[] = [];
    const controller = createMessagesController({ load: async () => persisted, cwdOf: () => "" });
    const store = controller.get("s");
    await store.refresh();
    controller.addOptimisticUser("s", "go");
    expect(store.getSnapshot().map((m) => m.text)).toEqual(["go"]);
    persisted = [{ role: "user", text: "go", entryId: "u" }];
    await store.refresh();
    expect(store.getSnapshot().map((m) => m.id)).toEqual(["u"]);
  });
});

describe("createPiWebClient", () => {
  function harness() {
    const listeners = new Set<(envelope: RealtimeEnvelope) => void>();
    const calls: Array<{ url: string; body?: unknown }> = [];
    const responses: Record<string, unknown> = {
      "/api/session-ui-state": { ok: true, sessionUiState: uiState({ lanes: [{ sessionId: "a", lane: "pinned", since }] }) },
      "/api/sessions": { ok: true, sessions: list },
      "/api/session-ui-state/read": { ok: true, sessionUiState: uiState({ lanes: [{ sessionId: "a", lane: "pinned", since }] }) },
      "/api/sessions/open": { ok: true },
      "/api/prompt": { ok: true },
    };
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const key = url.startsWith("/api/messages") ? "messages" : url.split("?")[0];
      const data = key === "messages" ? { ok: true, messages: [] } : key === "/api/files/tree" ? treeResponse(url) : responses[key] || { ok: false, error: "unexpected" };
      return new Response(JSON.stringify(data), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const client = createPiWebClient({ headers: () => ({}), fetch, realtime: { subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } } });
    const emit = (envelope: RealtimeEnvelope) => { for (const fn of [...listeners]) fn(envelope); };
    return { client, calls, emit, listeners };
  }
  function treeResponse(url: string) {
    const path = new URL(url, "http://x").searchParams.get("path") || "";
    if (!path) return { ok: true, path, entries: [{ name: "src", path: "src", kind: "directory" }, { name: "README.md", path: "README.md", kind: "file", size: 340 }] };
    if (path === "src") return { ok: true, path, entries: [{ name: "main.ts", path: "src/main.ts", kind: "file", size: 1200 }] };
    return { ok: true, path, entries: [] };
  }

  it("fetches nothing until a view reads from it, then loads the ui state and the session list", async () => {
    const { client, calls } = harness();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([]);
    const listener = vi.fn();
    client.sessions.subscribe(listener);
    await vi.waitFor(() => expect(client.sessions.getSnapshot().length).toBe(3));
    expect(calls.map((call) => call.url)).toEqual(["/api/session-ui-state", "/api/sessions"]);
    expect(client.sessions.getSnapshot()[0]).toMatchObject({ id: "a", pinned: true });
    expect(listener).toHaveBeenCalled();
  });

  it("emits neutral events, marks a focused session read when its run ends, and stops on dispose", async () => {
    const { client, calls, emit, listeners } = harness();
    const events = vi.fn();
    const unsubscribe = client.events.subscribe(events);
    await vi.waitFor(() => expect(client.sessions.getSnapshot().length).toBe(3));
    await client.actions.openSession("a");
    emit({ type: "agent_event", sessionId: "a", event: { type: "agent_start" } });
    emit({ type: "agent_event", sessionId: "a", event: { type: "agent_settled" } });
    emit({ type: "agent_event", sessionId: "b", event: { type: "agent_settled" } });
    expect(events.mock.calls.map(([event]) => `${event.type}:${event.sessionId}`)).toEqual(["turn/start:a", "turn/end:a", "turn/end:b"]);
    await vi.waitFor(() => expect(calls.filter((call) => call.url === "/api/session-ui-state/read").map((call) => call.body)).toEqual([{ sessionId: "a" }]));
    expect(calls.find((call) => call.url === "/api/sessions/open")?.body).toEqual({ sessionId: "a" });
    unsubscribe();
    emit({ type: "agent_event", sessionId: "a", event: { type: "agent_start" } });
    expect(events).toHaveBeenCalledTimes(3);
    client.dispose();
    expect(listeners.size).toBe(0);
  });

  it("sends prompts as follow-ups and walks the file tree of a session's workspace", async () => {
    const { client, calls } = harness();
    await client.sessions.refresh();
    await client.actions.prompt("a", "  hello  ");
    expect(calls.find((call) => call.url === "/api/prompt")?.body).toMatchObject({ sessionId: "a", message: "hello", mode: "followUp" });
    const tree = await client.files.tree("/w/a");
    expect(tree).toEqual({ name: "a", path: "/w/a", files: [{ name: "README.md", path: "/w/a/README.md", bytes: 340 }], dirs: [{ name: "src", path: "/w/a/src", files: [{ name: "main.ts", path: "/w/a/src/main.ts", bytes: 1200 }], dirs: [] }] });
    expect(await client.files.tree("/elsewhere")).toBeNull();
    const truncated = await client.files.tree("/w/a", { maxDepth: 1 });
    expect(truncated?.dirs[0]).toMatchObject({ name: "src", truncated: true, files: [] });
  });
});
