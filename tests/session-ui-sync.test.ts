import { describe, expect, it, vi } from "vitest";
import { normalizeSessionUiState, sessionUiStateFromResponse, type SessionUiState } from "../src/app/types.js";
import { applyUiIntent, captureUiIntents, SessionUiCoordinator, type UiTransport } from "../src/sessions/sessionUiSync.js";

const state = (value: Record<string, unknown> = {}) => normalizeSessionUiState({ revision: 1, initialized: true, ...value });
const lane = (sessionId: string) => ({ sessionId, lane: "pinned" as const, since: "2025-01-01T00:00:00.000Z" });

function peer(initial = state()) {
  let server = initial;
  const writes: Array<{ expectedRevision: number; initialize?: true; lanes?: SessionUiState["lanes"] }> = [];
  const transport: UiTransport = {
    read: async () => server,
    patch: async (patch) => {
      writes.push(patch);
      if (patch.expectedRevision !== server.revision || patch.initialize && server.initialized) return { status: 409 };
      server = normalizeSessionUiState({ ...server, ...patch, initialized: true, revision: server.revision + 1 });
      return { status: 200, state: server };
    },
    postUnread: async (sessionId, unread) => {
      server = normalizeSessionUiState({ ...server, revision: server.revision + 1,
        sessionUnreadStates: unread ? [...server.sessionUnreadStates.filter((item) => item.sessionId !== sessionId), { sessionId, unreadAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z" }] : server.sessionUnreadStates.filter((item) => item.sessionId !== sessionId),
      });
      return { status: 200, state: server };
    },
  };
  const render = vi.fn<(state: SessionUiState) => void>();
  const report = vi.fn<(error: string) => void>();
  const coordinator = new SessionUiCoordinator(transport, render, report);
  return { coordinator, render, report, writes, get server() { return server; }, set server(value) { server = value; } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("session UI state causal sync", () => {
  it("does not refresh a held initialization conflict after read-only mode, but accepts a committed initialization", async () => {
    for (const responseStatus of [409, 200]) {
      const held = deferred<{ status: number; state?: SessionUiState }>();
      const dispatched = deferred<void>();
      const read = vi.fn(async () => state({ revision: 0, initialized: false }));
      const patch = vi.fn(() => { dispatched.resolve(); return held.promise; });
      const coordinator = new SessionUiCoordinator({ read, patch, postUnread: vi.fn() }, vi.fn(), vi.fn());
      const boot = state({ revision: 0, initialized: false, lanes: [lane("legacy")] });
      const starting = coordinator.start(boot);
      await dispatched.promise;
      coordinator.markUnavailable();
      held.resolve(responseStatus === 409 ? { status: 409 } : { status: 200, state: state({ revision: 1, lanes: [lane("legacy")] }) });
      await starting;
      expect(read).toHaveBeenCalledTimes(1);
      expect(patch).toHaveBeenCalledTimes(1);
      expect(coordinator.ready).toBe(false);
      expect(coordinator.projected?.lanes).toEqual([lane("legacy")]);
    }
  });

  it("stops a held 409 before any conflict GET or retry PATCH after availability loss", async () => {
    const first = deferred<{ status: number }>();
    const dispatched = deferred<void>();
    const read = vi.fn(async () => state({ lanes: [lane("saved")] }));
    const patch = vi.fn(() => { dispatched.resolve(); return first.promise; });
    const coordinator = new SessionUiCoordinator({ read, patch, postUnread: vi.fn() }, vi.fn(), vi.fn());
    await coordinator.start(state());
    const gesture = coordinator.mutate({ lanes: [lane("saved"), lane("new")] });
    await dispatched.promise;
    coordinator.markUnavailable();
    first.resolve({ status: 409 });
    expect(await gesture).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(coordinator.projected?.lanes).toEqual([lane("saved")]);
  });

  it("reports a held 200 PATCH as committed even if read-only mode arrived in flight", async () => {
    const first = deferred<{ status: number; state: SessionUiState }>();
    const dispatched = deferred<void>();
    const canonical = state({ lanes: [lane("saved")] });
    const committed = state({ revision: 2, lanes: [lane("saved"), lane("new")] });
    const patch = vi.fn(() => { dispatched.resolve(); return first.promise; });
    const coordinator = new SessionUiCoordinator({ read: async () => canonical, patch, postUnread: vi.fn() }, vi.fn(), vi.fn());
    await coordinator.start(state());
    const gesture = coordinator.mutate({ lanes: committed.lanes });
    await dispatched.promise;
    coordinator.markUnavailable();
    first.resolve({ status: 200, state: committed });
    expect(await gesture).toBe(true);
    expect(coordinator.ready).toBe(false);
    expect(coordinator.projected).toEqual(committed);
    expect(await coordinator.mutate({ lanes: [lane("other")] })).toBe(false);
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it("does not retry a conflict when a held refresh GET finishes after read-only mode", async () => {
    const refresh = deferred<SessionUiState>();
    const refreshing = deferred<void>();
    const read = vi.fn().mockResolvedValueOnce(state({ lanes: [lane("saved")] })).mockImplementationOnce(() => {
      refreshing.resolve(); return refresh.promise;
    });
    const patch = vi.fn(async () => ({ status: 409 }));
    const coordinator = new SessionUiCoordinator({ read, patch, postUnread: vi.fn() }, vi.fn(), vi.fn());
    await coordinator.start(state());
    const gesture = coordinator.mutate({ lanes: [lane("saved"), lane("new")] });
    await refreshing.promise;
    coordinator.markUnavailable();
    refresh.resolve(state({ revision: 2, lanes: [lane("saved"), lane("remote")] }));
    expect(await gesture).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it("reports a held unread 200 as committed without resurrecting its cleared intent", async () => {
    const ack = deferred<{ status: number; state: SessionUiState }>();
    const dispatched = deferred<void>();
    const postUnread = vi.fn(() => { dispatched.resolve(); return ack.promise; });
    const canonical = state({ lanes: [lane("saved")] });
    const committed = state({ ...canonical, revision: 2, sessionUnreadStates: [{ sessionId: "saved", unreadAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z" }] });
    const coordinator = new SessionUiCoordinator({ read: async () => canonical, patch: vi.fn(), postUnread }, vi.fn(), vi.fn());
    await coordinator.start(state());
    const operation = coordinator.setUnread("saved", true);
    await dispatched.promise;
    coordinator.markUnavailable();
    ack.resolve({ status: 200, state: committed });
    expect(await operation).toBe(true);
    expect(coordinator.ready).toBe(false);
    expect(coordinator.projected?.sessionUnreadStates).toEqual(committed.sessionUnreadStates);
  });
  it("an explicit unavailable chat response retains the cached display and blocks all preferences writes", async () => {
    const cached = state({ lanes: [lane("cached")] });
    const read = vi.fn(async () => cached);
    const patch = vi.fn();
    const postUnread = vi.fn();
    const render = vi.fn<(state: SessionUiState) => void>();
    const report = vi.fn();
    const coordinator = new SessionUiCoordinator({ read, patch, postUnread }, render, report);
    await coordinator.start(state());
    coordinator.markUnavailable();
    expect(coordinator.ready).toBe(false);
    expect(coordinator.projected?.lanes).toEqual([lane("cached")]);
    expect(await coordinator.mutate({ lanes: [lane("cached"), lane("new")] })).toBe(false);
    expect(await coordinator.setUnread("cached", false)).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
    expect(patch).not.toHaveBeenCalled();
    expect(postUnread).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled(); // no repeated chat notices from blocked gestures
    expect(render.mock.lastCall?.[0].lanes).toEqual([lane("cached")]);
  });

  it("explicit unavailability before bootstrap prevents even a legacy migration GET or write", async () => {
    const read = vi.fn();
    const patch = vi.fn();
    const coordinator = new SessionUiCoordinator({ read, patch, postUnread: vi.fn() }, vi.fn(), vi.fn());
    coordinator.markUnavailable();
    await coordinator.start(state({ lanes: [lane("legacy")] }));
    expect(coordinator.ready).toBe(false);
    expect(coordinator.projected?.lanes).toEqual([lane("legacy")]);
    expect(read).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });
  it("waits for the authorized caller before GET; starts once and then permits pin/read", async () => {
    let stored = state({ revision: 0, initialized: false });
    const read = vi.fn(async () => stored);
    const patch = vi.fn(async (value: Partial<SessionUiState> & { expectedRevision: number; initialize?: true }) => {
      stored = state({ ...stored, ...value, initialized: true, revision: stored.revision + 1 });
      return { status: 200, state: stored };
    });
    const postUnread = vi.fn(async (sessionId: string, unread: boolean) => {
      stored = state({ ...stored, revision: stored.revision + 1, sessionUnreadStates: unread
        ? [{ sessionId, unreadAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z" }] : [] });
      return { status: 200, state: stored };
    });
    const coordinator = new SessionUiCoordinator({ read, patch, postUnread }, vi.fn(), vi.fn());
    const bootAppState = { lanes: [lane("legacy")] };
    const capturedSeed = state({ revision: 0, initialized: false, lanes: bootAppState.lanes });
    // A later authorized /api/state projection may change mutable AppState;
    // migration still imports the constructor's original, owned legacy seed.
    bootAppState.lanes[0].sessionId = "mutated-in-place";
    bootAppState.lanes = [lane("state-response")];
    expect(read).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
    await coordinator.start(capturedSeed); // first authorized /api/state response
    await coordinator.start(state({ revision: 0, initialized: false, lanes: [lane("later")] }));
    expect(read).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.lastCall?.[0]).toMatchObject({ initialize: true, expectedRevision: 0, lanes: [lane("legacy")] });
    expect(await coordinator.mutate({ lanes: [lane("legacy"), lane("pin")] })).toBe(true);
    expect(await coordinator.setUnread("pin", false)).toBe(true);
    expect(stored.lanes.map((entry) => entry.sessionId)).toEqual(["legacy", "pin"]);
    expect(postUnread).toHaveBeenCalledWith("pin", false);
  });

  it("keeps concurrent unknown lanes and changes only a gesture's target after 409", async () => {
    const p = peer(state({ lanes: [lane("known"), lane("other")] }));
    await p.coordinator.start(state());
    p.server = state({ revision: 2, lanes: [lane("known"), lane("other"), lane("remote")] });
    p.coordinator.mutate({ lanes: [lane("other"), lane("new")] });
    await vi.waitFor(() => expect(p.server.lanes.map((entry) => entry.sessionId)).toEqual(["other", "remote", "new"]));
    expect(p.writes.map((write) => write.expectedRevision)).toEqual([1, 2]);
    expect(p.writes[1].lanes?.map((entry) => entry.sessionId)).toEqual(["other", "remote", "new"]);
    expect(p.report).not.toHaveBeenCalled();
  });

  it("commits a multi-ID, multi-field gesture in one CAS attempt after rebasing a conflict", async () => {
    const p = peer(state({ lanes: [lane("remove-a"), lane("remove-b"), lane("keep")], favoriteFolders: ["/old"] }));
    await p.coordinator.start(state());
    p.server = state({ revision: 2, lanes: [...p.server.lanes, lane("remote")], favoriteFolders: ["/old", "/remote"],
      sessionNotes: [{ sessionId: "remote", note: "remote note", updatedAt: "2025-01-01T00:00:00.000Z" }] });
    const result = await p.coordinator.mutate({
      lanes: [lane("keep"), lane("new")], favoriteFolders: ["/old", "/mine"],
      sessionNotes: [{ sessionId: "keep", note: "mine", updatedAt: "2025-01-01T00:00:00.000Z" }],
    });
    expect(result).toBe(true);
    expect(p.writes.map((write) => write.expectedRevision)).toEqual([1, 2]);
    expect(Object.keys(p.writes[1]).sort()).toEqual(["expectedRevision", "favoriteFolders", "lanes", "sessionNotes"]);
    expect(p.server.lanes.map((entry) => entry.sessionId)).toEqual(["keep", "remote", "new"]);
    expect(p.server.sessionNotes.map((entry) => entry.sessionId)).toEqual(["remote", "keep"]);
    expect(p.server.favoriteFolders).toEqual(["/old", "/remote", "/mine"]);
  });

  it("a failed multi-field write rolls the entire gesture back without advancing the server", async () => {
    const original = state({ lanes: [lane("a"), lane("b")] });
    const patch = vi.fn(async () => ({ status: 503, error: "storage unavailable" }));
    const render = vi.fn<(value: SessionUiState) => void>();
    const coordinator = new SessionUiCoordinator({ read: async () => original, patch, postUnread: vi.fn() }, render, vi.fn());
    await coordinator.start(state());
    const result = await coordinator.mutate({ lanes: [lane("b")],
      sessionNotes: [{ sessionId: "b", note: "note", updatedAt: "2025-01-01T00:00:00.000Z" }],
    });
    expect(result).toBe(false);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.lastCall?.[0]).toMatchObject({ expectedRevision: 1, lanes: [lane("b")] });
    expect(coordinator.projected).toEqual(original);
    expect(render.mock.lastCall?.[0]).toEqual(original);
  });

  it("moving an existing early parked entry to the end of pinned captures placement independently of its entry", async () => {
    const parked = { ...lane("parked"), lane: "parked" as const };
    const original = state({ lanes: [parked, lane("pinned-a"), lane("pinned-b")] });
    const target = state({ lanes: [lane("pinned-a"), lane("pinned-b"), { ...parked, lane: "pinned" }] });
    const intents = captureUiIntents(original, { lanes: target.lanes });
    expect(intents).toHaveLength(1); // The entry change alone retains the old global index.
    expect(intents.reduce(applyUiIntent, original).lanes.map((entry) => entry.sessionId)).toEqual(["parked", "pinned-a", "pinned-b"]);
    const placement = { kind: "order" as const, field: "lanes" as const, id: "parked", after: "pinned-b" };
    expect([...intents, placement].reduce(applyUiIntent, original).lanes.map((entry) => entry.sessionId)).toEqual(["pinned-a", "pinned-b", "parked"]);
    const p = peer(original);
    await p.coordinator.start(state());
    expect(await p.coordinator.mutate({ lanes: target.lanes }, placement)).toBe(true);
    expect(p.server.lanes.map((entry) => entry.sessionId)).toEqual(["pinned-a", "pinned-b", "parked"]);
    const reloaded = peer(p.server);
    await reloaded.coordinator.start(state());
    expect(reloaded.coordinator.projected?.lanes.map((entry) => entry.sessionId)).toEqual(["pinned-a", "pinned-b", "parked"]);
  });

  it("rebases a move-to-pinned placement around unknown concurrent pins without reposting stale order", async () => {
    const parked = { ...lane("parked"), lane: "parked" as const };
    const original = state({ lanes: [parked, lane("pinned-a"), lane("pinned-b")] });
    const p = peer(original);
    await p.coordinator.start(state());
    p.server = state({ revision: 2, lanes: [parked, lane("pinned-a"), lane("remote"), lane("pinned-b")] });
    const next = [lane("pinned-a"), lane("pinned-b"), { ...parked, lane: "pinned" }];
    expect(await p.coordinator.mutate({ lanes: next }, { kind: "order", field: "lanes", id: "parked", after: "pinned-b" })).toBe(true);
    expect(p.writes.map((write) => write.expectedRevision)).toEqual([1, 2]);
    expect(p.server.lanes.map((entry) => entry.sessionId)).toEqual(["pinned-a", "remote", "pinned-b", "parked"]);
    expect(p.server.lanes.find((entry) => entry.sessionId === "remote")?.lane).toBe("pinned");
  });

  it("ordinary metadata updates never manufacture a lane reorder", async () => {
    const original = state({ lanes: [lane("early"), lane("later")] });
    const p = peer(original);
    await p.coordinator.start(state());
    const updated = { ...lane("early"), cwd: "/new-cwd" };
    expect(await p.coordinator.mutate({ lanes: [lane("later"), updated] })).toBe(true);
    expect(p.server.lanes.map((entry) => entry.sessionId)).toEqual(["early", "later"]);
    expect(p.server.lanes[0].cwd).toBe("/new-cwd");
  });

  it("ordinary addition does not reset concurrent ordering; explicit reorder moves only its target", () => {
    const base = state({ lanes: [lane("a"), lane("b")] });
    const remote = state({ lanes: [lane("b"), lane("a"), lane("unknown")] });
    const intents = captureUiIntents(base, { lanes: [lane("a"), lane("b"), lane("new")] });
    expect(intents).toHaveLength(1);
    // The existing Pin/new-session gesture appends its newly laned ID; keep
    // that placement without overwriting a concurrent ordering of known IDs.
    expect(intents.reduce(applyUiIntent, remote).lanes.map((entry) => entry.sessionId)).toEqual(["b", "a", "unknown", "new"]);
    const moved = applyUiIntent(remote, { kind: "order", field: "lanes", id: "a", before: "b" });
    expect(moved.lanes.map((entry) => entry.sessionId)).toEqual(["a", "b", "unknown"]);
  });

  it("preserves unrelated notes, markers, origins, folders and labels through keyed edits and explicit clears", () => {
    const remote = state({
      sessionNotes: [{ sessionId: "other", note: "remote", updatedAt: "2025-01-01T00:00:00.000Z" }],
      sessionMarkers: [{ sessionId: "other", color: "blue", updatedAt: "2025-01-01T00:00:00.000Z" }],
      sessionOrigins: [{ sessionId: "other", originSessionId: "parent", kind: "worker", updatedAt: "2025-01-01T00:00:00.000Z" }],
      favoriteFolders: ["/remote"], allowedMarkerColors: ["blue", "red"], bucketLabels: { blue: "Remote" },
    });
    const edits = [
      { kind: "entry", field: "sessionNotes", id: "mine", value: { sessionId: "mine", note: "hello", updatedAt: "2025-01-01T00:00:00.000Z" } },
      { kind: "string", field: "favoriteFolders", id: "/mine", present: true },
      { kind: "label", id: "red", value: "Mine" },
      { kind: "clear-strings", field: "allowedMarkerColors" },
    ] as const;
    const merged = edits.reduce<SessionUiState>((value, edit) => applyUiIntent(value, edit), remote);
    expect(merged.sessionNotes.map((item) => item.sessionId)).toEqual(["other", "mine"]);
    expect(merged.sessionMarkers).toEqual(remote.sessionMarkers);
    expect(merged.sessionOrigins).toEqual(remote.sessionOrigins);
    expect(merged.favoriteFolders).toEqual(["/remote", "/mine"]);
    expect(merged.bucketLabels).toEqual({ blue: "Remote", red: "Mine" });
    expect(merged.allowedMarkerColors).toEqual([]);
  });

  it("overlays queued gestures over SSE and ignores late lower-revision acknowledgements", async () => {
    const p = peer(state({ lanes: [lane("a")] }));
    await p.coordinator.start(state());
    p.server = state({ revision: 2, lanes: [lane("a"), lane("remote")] });
    const saved = p.coordinator.mutate({ lanes: [lane("a"), lane("b")] });
    p.coordinator.accept(p.server);
    expect(p.coordinator.projected?.lanes.map((item) => item.sessionId)).toEqual(["a", "remote", "b"]);
    expect(await saved).toBe(true);
    p.coordinator.accept(state({ revision: 1, lanes: [lane("a")] }));
    expect(p.coordinator.projected?.lanes.map((item) => item.sessionId)).toEqual(["a", "remote", "b"]);
    expect(p.render.mock.lastCall?.[0].lanes.map((item) => item.sessionId)).toEqual(["a", "remote", "b"]);
  });

  it("does not migrate from a late fresh GET after SSE supplied initialized history", async () => {
    let finishRead!: (state: SessionUiState | undefined) => void;
    const pendingRead = new Promise<SessionUiState | undefined>((resolve) => { finishRead = resolve; });
    const patch = vi.fn();
    const coordinator = new SessionUiCoordinator({ read: () => pendingRead, patch, postUnread: vi.fn() }, vi.fn(), vi.fn());
    const loading = coordinator.start(state({ revision: 0, initialized: false, lanes: [lane("legacy")] }));
    coordinator.accept(state({ revision: 4, initialized: true, lanes: [lane("winner")] }));
    finishRead(state({ revision: 0, initialized: false }));
    await loading;
    expect(patch).not.toHaveBeenCalled();
    expect(coordinator.projected?.lanes.map((entry) => entry.sessionId)).toEqual(["winner"]);
  });

  it("rejects malformed and future GET snapshots without writing a migration", async () => {
    const patch = vi.fn();
    for (const value of [{ revision: 0, initialized: false },
      { ...state({ revision: 0, initialized: false }), version: 4 },
      { ...state({ revision: 0, initialized: false }), lanes: [{ sessionId: "bad", lane: "bogus" }] }]) {
      const read = async () => sessionUiStateFromResponse({ ok: true, status: 200, sessionUiState: value });
      const coordinator = new SessionUiCoordinator({ read, patch, postUnread: vi.fn() }, vi.fn(), vi.fn());
      await coordinator.start(state({ revision: 0, initialized: false, lanes: [lane("legacy")] }));
    }
    expect(patch).not.toHaveBeenCalled();
  });

  it("captures immutable entry intents and never gives rendered AppState ownership of canonical entries", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let server = state({ lanes: [lane("known")] });
    const render = vi.fn<(value: SessionUiState) => void>();
    const coordinator = new SessionUiCoordinator({
      read: async () => server,
      patch: async (patch) => {
        await gate;
        server = state({ ...server, ...patch, revision: server.revision + 1 });
        return { status: 200, state: server };
      },
      postUnread: vi.fn(),
    }, render, vi.fn());
    await coordinator.start(state());
    const exposed = render.mock.lastCall![0];
    exposed.lanes[0].cwd = "/render-mutated";
    exposed.lanes.push(lane("render-added"));
    expect(coordinator.projected?.lanes).toEqual([lane("known")]);
    const entry = { ...lane("known"), cwd: "/gesture" };
    const saved = coordinator.mutate({ lanes: [entry] });
    entry.cwd = "/changed-after-capture";
    render.mock.lastCall![0].lanes[0].cwd = "/second-render-mutation";
    expect(coordinator.projected?.lanes[0].cwd).toBe("/gesture");
    release();
    expect(await saved).toBe(true);
    expect(server.lanes[0].cwd).toBe("/gesture");
  });

  it("losing legacy initialize drops seed instead of retrying it over the winner", async () => {
    let server = state({ revision: 0, initialized: false });
    const writes: Array<{ expectedRevision: number; initialize?: true }> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const report = vi.fn();
    const coordinator = new SessionUiCoordinator({
      read: async () => server,
      patch: async (patch) => {
        writes.push(patch);
        await gate;
        if (server.initialized) return { status: 409 };
        server = state({ revision: 1, initialized: true, ...patch });
        return { status: 200, state: server };
      },
      postUnread: async () => ({ status: 200, state: server }),
    }, vi.fn(), report);
    const loading = coordinator.start(state({ revision: 0, initialized: false, lanes: [lane("legacy")] }));
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    server = state({ revision: 1, initialized: true, lanes: [lane("winner")] });
    release();
    await loading;
    await vi.waitFor(() => expect(coordinator.projected?.lanes.map((entry) => entry.sessionId)).toEqual(["winner"]));
    expect(report).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ expectedRevision: 0, initialize: true });
  });

  it("merges individual bucket-name and moved-color intents without replacing concurrent settings", async () => {
    const p = peer(state({ bucketLabels: { blue: "Blue one" } }));
    await p.coordinator.start(state());
    p.server = state({ revision: 2, bucketLabels: { blue: "Blue one", green: "Remote green" },
      bucketOrder: ["pink", "blue", "purple", "yellow", "red", "green", "orange", "cyan"] });
    expect(await p.coordinator.mutate({ bucketLabels: { blue: "My blue" } })).toBe(true);
    expect(p.server.bucketLabels).toEqual({ blue: "My blue", green: "Remote green" });
    const next = ["blue", "pink", "purple", "yellow", "red", "green", "orange", "cyan"] as SessionUiState["bucketOrder"];
    expect(await p.coordinator.mutate({ bucketOrder: next }, { kind: "order", field: "bucketOrder", id: "blue", before: "pink" })).toBe(true);
    expect(p.server.bucketOrder.slice(0, 3)).toEqual(["blue", "pink", "purple"]);
  });

  it("serializes targeted unread actions with replacement writes and keeps later optimism during earlier acknowledgements", async () => {
    const p = peer(state({ lanes: [lane("a")] }));
    await p.coordinator.start(state());
    p.coordinator.mutate({ lanes: [lane("a"), lane("new")] });
    p.coordinator.setUnread("a", true);
    expect(p.coordinator.projected?.sessionUnreadStates.map((entry) => entry.sessionId)).toEqual(["a"]);
    await vi.waitFor(() => expect(p.server.sessionUnreadStates.map((entry) => entry.sessionId)).toEqual(["a"]));
    expect(p.server.lanes.map((entry) => entry.sessionId)).toEqual(["a", "new"]);
    p.coordinator.setUnread("a", false);
    await vi.waitFor(() => expect(p.server.sessionUnreadStates).toEqual([]));
  });

  it("restores canonical state after a failed write, with reload guidance instead of unsafe replay", async () => {
    const source = state({ lanes: [lane("a")] });
    const report = vi.fn();
    const render = vi.fn();
    const patch = vi.fn(async () => ({ status: 428, error: "precondition required" }));
    const coordinator = new SessionUiCoordinator({ read: async () => source, patch, postUnread: vi.fn() }, render, report);
    await coordinator.start(state());
    expect(await coordinator.mutate({ lanes: [lane("a"), lane("b")] })).toBe(false);
    expect(coordinator.projected?.lanes.map((entry) => entry.sessionId)).toEqual(["a"]);
    expect(report.mock.lastCall?.[0]).toMatch(/Reload/);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(await coordinator.mutate({ lanes: [lane("a"), lane("c")] })).toBe(false);
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it("queues a gesture made during first load behind one-shot migration", async () => {
    const p = peer(state({ revision: 0, initialized: false }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = vi.fn(async () => { await gate; return p.server; });
    const coordinator = new SessionUiCoordinator({
      read,
      patch: async (patch) => {
        p.writes.push(patch);
        if (patch.expectedRevision !== p.server.revision) return { status: 409 };
        p.server = state({ ...p.server, ...patch, revision: p.server.revision + 1, initialized: true });
        return { status: 200, state: p.server };
      },
      postUnread: async () => ({ status: 200, state: p.server }),
    }, vi.fn(), vi.fn());
    const initial = coordinator.start(state({ revision: 0, initialized: false, lanes: [lane("legacy")] }));
    const saved = coordinator.mutate({ lanes: [lane("legacy"), lane("gesture")] });
    expect(p.writes).toHaveLength(0);
    release();
    await initial;
    expect(await saved).toBe(true);
    expect(p.writes.map((write) => [write.expectedRevision, write.initialize])).toEqual([[0, true], [1, undefined]]);
    expect(p.server.lanes.map((entry) => entry.sessionId)).toEqual(["legacy", "gesture"]);
  });

  it("restores the boot display after a failed initial read without publishing an unsafe patch", async () => {
    let resolveRead!: (value: SessionUiState | undefined) => void;
    const read = new Promise<SessionUiState | undefined>((resolve) => { resolveRead = resolve; });
    const patch = vi.fn();
    const seed = state({ revision: 0, initialized: false, lanes: [lane("legacy")] });
    let displayed = normalizeSessionUiState(seed);
    const coordinator = new SessionUiCoordinator({ read: () => read, patch, postUnread: vi.fn() },
      (value) => { displayed = value; }, vi.fn());
    const loading = coordinator.start(seed);
    displayed.lanes[0].cwd = "/unsaved-edit";
    coordinator.mutate({ lanes: [{ ...lane("legacy"), cwd: "/unsaved-edit" }] });
    expect(displayed.lanes[0].cwd).toBe("/unsaved-edit");
    resolveRead(undefined);
    await loading;
    expect(displayed.lanes).toEqual([lane("legacy")]);
    displayed.lanes.push(lane("unsafe"));
    expect(await coordinator.mutate({ lanes: displayed.lanes })).toBe(false);
    expect(displayed.lanes).toEqual([lane("legacy")]);
    expect(patch).not.toHaveBeenCalled();
  });

  it("never imports after a failed read and never issues an unversioned replacement", async () => {
    const patch = vi.fn();
    const errors = vi.fn();
    const coordinator = new SessionUiCoordinator({ read: async () => undefined, patch, postUnread: vi.fn() }, vi.fn(), errors);
    await coordinator.start(state({ lanes: [lane("legacy")] }));
    coordinator.mutate({ lanes: [lane("new")] });
    expect(patch).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalled();
  });
});
