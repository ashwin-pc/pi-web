import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionUiStateStore, defaultSessionUiState, SessionUiStateConflictError, SessionUiStatePreconditionError, SessionUiStateUnavailableError } from "../server/sessionUiState.js";

const since = "2025-01-01T00:00:00.000Z";
const lanes = (count: number) => Array.from({ length: count }, (_, index) => ({ sessionId: `session-${index}`, lane: "pinned" as const, since }));
const unreadStates = (count: number) => Array.from({ length: count }, (_, index) => ({ sessionId: `session-${index}`, unreadAt: since, updatedAt: since }));

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function tempFile() { const dir = await mkdtemp(join(tmpdir(), "pi-web-session-ui-")); dirs.push(dir); return join(dir, "state.json"); }

describe("session UI state store", () => {
  it("never overwrites an unsupported future-version file", async () => {
    const file = await tempFile();
    const future = { ...defaultSessionUiState, version: 4, futureMetadata: { keep: true } };
    await writeFile(file, JSON.stringify(future));
    const store = createSessionUiStateStore(file);

    await expect(store.read()).rejects.toBeInstanceOf(SessionUiStateUnavailableError);
    await expect(store.patch({ expectedRevision: 0, lanes: [{ sessionId: "a", lane: "pinned", since }] })).rejects.toBeInstanceOf(SessionUiStateUnavailableError);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(future);
  });

  it("migrates lane-owned v2 notes and durably writes them on the next mutation", async () => {
    const file = await tempFile();
    await writeFile(file, JSON.stringify({
      version: 2,
      revision: 7,
      lanes: [
        { sessionId: "a", lane: "pinned", cwd: "/tmp/a", note: "  Keep this note  ", since: "2025-01-01T00:00:00.000Z" },
        { sessionId: "b", lane: "parked", since: "2025-01-02T00:00:00.000Z" },
      ],
    }));

    const store = createSessionUiStateStore(file);
    const state = await store.read();
    expect(state.version).toBe(3);
    expect(state.lanes).toEqual([
      { sessionId: "a", lane: "pinned", cwd: "/tmp/a", since: "2025-01-01T00:00:00.000Z" },
      { sessionId: "b", lane: "parked", since: "2025-01-02T00:00:00.000Z" },
    ]);
    expect(state.sessionNotes).toEqual([{ sessionId: "a", note: "Keep this note", updatedAt: expect.any(String) }]);

    const patched = await store.patch({ expectedRevision: state.revision, pinnedFolders: ["/tmp/project"] });
    expect(patched.sessionNotes).toEqual(state.sessionNotes);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      version: 3,
      pinnedFolders: ["/tmp/project"],
      sessionNotes: [{ sessionId: "a", note: "Keep this note", updatedAt: expect.any(String) }],
    });
  });

  it("keeps notes when lanes change and removes them only with the session", async () => {
    const store = createSessionUiStateStore(await tempFile());
    await store.patch({ expectedRevision: 0, initialize: true,
      lanes: [{ sessionId: "a", lane: "pinned", since: "2025-01-01T00:00:00.000Z" }],
      sessionNotes: [{ sessionId: "a", note: "Persistent", updatedAt: "2025-01-01T00:00:00.000Z" }],
    });

    const unpinned = await store.patch({ expectedRevision: 1, lanes: [] });
    expect(unpinned.sessionNotes).toEqual([{ sessionId: "a", note: "Persistent", updatedAt: "2025-01-01T00:00:00.000Z" }]);
    expect((await store.removeSession("a")).sessionNotes).toEqual([]);
  });

  it("persists renamed buckets, normalized bucket order, and additional colors", async () => {
    const file = await tempFile();
    const store = createSessionUiStateStore(file);
    const next = await store.patch({ expectedRevision: 0, initialize: true,
      bucketLabels: { cyan: "Builds", orange: "  Urgent  ", pink: "", invalid: "Nope" },
      bucketOrder: ["cyan", "cyan", "invalid", "blue"],
      sessionMarkers: [
        { sessionId: "a", color: "cyan" },
        { sessionId: "b", color: "orange" },
        { sessionId: "c", color: "pink" },
      ],
    });

    expect(next.bucketLabels).toEqual({ cyan: "Builds", orange: "Urgent" });
    expect(next.bucketOrder).toEqual(["cyan", "blue", "purple", "yellow", "red", "green", "orange", "pink"]);
    expect(next.sessionMarkers.map(({ color }) => color)).toEqual(["cyan", "orange", "pink"]);

    expect((await createSessionUiStateStore(file).read()).bucketOrder).toEqual(next.bucketOrder);
  });

  it("keeps picker favorites independent from pinned drawer groups", async () => {
    const store = createSessionUiStateStore(await tempFile());
    const patched = await store.patch({ expectedRevision: 0, initialize: true, pinnedFolders: ["/drawer"], favoriteFolders: [" /picker ", "/picker", ""] });
    expect(patched.pinnedFolders).toEqual(["/drawer"]);
    expect(patched.favoriteFolders).toEqual(["/picker"]);
    expect((await store.patch({ expectedRevision: patched.revision, favoriteFolders: "wrong" })).favoriteFolders).toEqual(["/picker"]);
  });

  it("preserves since for unchanged pins sent through the legacy alias", async () => {
    const file = await tempFile();
    const store = createSessionUiStateStore(file);
    const seeded = await store.patch({ expectedRevision: 0, initialize: true, lanes: [{ sessionId: "a", lane: "pinned", since }] });

    const next = await store.patch({ expectedRevision: seeded.revision, pinnedSessions: [{ id: "a", cwd: "/tmp/a" }] });
    expect(next.lanes).toEqual([{ sessionId: "a", lane: "pinned", cwd: "/tmp/a", since }]);
  });

  it("never commits a state that its restart validator rejects", async () => {
    const file = await tempFile();
    const store = createSessionUiStateStore(file);
    const seeded = await store.patch({ expectedRevision: 0, initialize: true, lanes: lanes(5) });
    const primary = await readFile(file, "utf8");
    const history = await readFile(`${file}.history.json`, "utf8");
    const mirror = await readFile(`${file}.bak-1.json`, "utf8");
    const invalid = [
      { sessionNotes: [{ sessionId: "session-0", note: "keep", updatedAt: "not-a-timestamp" }] },
      { sessionMarkers: [{ sessionId: "session-0", color: "green", updatedAt: "not-a-timestamp" }] },
      { sessionUnreadStates: [{ sessionId: "session-0", unreadAt: "not-a-timestamp", updatedAt: since }] },
      { sessionUnreadStates: [{ sessionId: "session-0", unreadAt: since, updatedAt: "not-a-timestamp" }] },
      { sessionOrigins: [{ sessionId: "session-1", originSessionId: "session-0", kind: "spawn", updatedAt: "not-a-timestamp" }] },
    ];
    for (const fields of invalid) {
      await expect(store.patch({ expectedRevision: seeded.revision, ...fields })).rejects.toMatchObject({ name: SessionUiStatePreconditionError.name, status: 400, message: "Invalid session UI state payload" });
      expect(await readFile(file, "utf8")).toBe(primary);
      expect(await readFile(`${file}.history.json`, "utf8")).toBe(history);
      expect(await readFile(`${file}.bak-1.json`, "utf8")).toBe(mirror);
      expect(await store.read()).toEqual(seeded);
    }
    const valid = await store.patch({ expectedRevision: seeded.revision, sessionNotes: [{ sessionId: "session-0", note: "keep", updatedAt: since }] });
    expect(await createSessionUiStateStore(file).read()).toEqual(valid);
  });

  it("rejects stale five-lane and same-size replacements even with force, but permits explicit clear at current revision", async () => {
    const file = await tempFile();
    const store = createSessionUiStateStore(file);
    const seeded = await store.patch({ expectedRevision: 0, initialize: true, lanes: lanes(5) });
    const before = await readFile(file, "utf8");
    for (const change of [{ lanes: [] }, { lanes: lanes(5).map((entry) => ({ ...entry, sessionId: `other-${entry.sessionId}` })) }, { lanes: [], force: true }]) {
      await expect(store.patch({ expectedRevision: 0, ...change })).rejects.toBeInstanceOf(SessionUiStateConflictError);
      expect(await readFile(file, "utf8")).toBe(before);
    }
    const cleared = await store.patch({ expectedRevision: seeded.revision, lanes: [], bucketOrder: [...seeded.bucketOrder].reverse() });
    expect(cleared.lanes).toEqual([]);
    expect(cleared.bucketOrder).toEqual([...seeded.bucketOrder].reverse());
  });

  it("rejects missing or malformed revisions and late initialization without a write", async () => {
    const store = createSessionUiStateStore(await tempFile());
    await expect(store.patch({ lanes: lanes(5) })).rejects.toMatchObject({ name: SessionUiStatePreconditionError.name, status: 428 });
    for (const revision of [-1, 0.5, "0", Number.MAX_SAFE_INTEGER + 1]) await expect(store.patch({ expectedRevision: revision })).rejects.toMatchObject({ status: 400 });
    const first = await store.patch({ expectedRevision: 0, initialize: true, lanes: lanes(5) });
    await expect(store.patch({ expectedRevision: first.revision, initialize: true, lanes: [] })).rejects.toBeInstanceOf(SessionUiStateConflictError);
  });

  it("serializes two simultaneous clients and targeted server intents without losing unrelated data", async () => {
    const store = createSessionUiStateStore(await tempFile());
    const seed = await store.patch({ expectedRevision: 0, initialize: true, lanes: lanes(5) });
    const results = await Promise.allSettled([
      store.patch({ expectedRevision: seed.revision, sessionNotes: [{ sessionId: "session-0", note: "first", updatedAt: since }] }),
      store.patch({ expectedRevision: seed.revision, sessionMarkers: [{ sessionId: "session-1", color: "green", updatedAt: since }] }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const before = await store.read();
    const [unread, origin] = await Promise.all([store.markUnread("session-2", since), store.setSessionOrigin("session-3", "session-0")]);
    const latest = await store.read();
    expect(latest.revision).toBe(Math.max(unread.revision, origin.revision));
    expect(latest.sessionUnreadStates.map((item) => item.sessionId)).toContain("session-2");
    expect(latest.sessionOrigins.map((item) => item.sessionId)).toContain("session-3");
    await expect(store.patch({ expectedRevision: before.revision, lanes: [] })).rejects.toBeInstanceOf(SessionUiStateConflictError);
    expect((await store.read()).lanes).toHaveLength(5);
  });

  it("allows POST-style single-entry read and unread changes", async () => {
    const store = createSessionUiStateStore(await tempFile());
    await store.patch({ expectedRevision: 0, initialize: true, sessionUnreadStates: unreadStates(20) });

    const read = await store.markRead("session-0");
    expect(read.sessionUnreadStates).toHaveLength(19);
    const unread = await store.markUnread("new-session", since);
    expect(unread.sessionUnreadStates).toHaveLength(20);
    expect(unread.sessionUnreadStates[0]?.sessionId).toBe("new-session");
  });

  it("recovers the newest valid backup, preserves damaged primary, and advances past high-water", async () => {
    const file = await tempFile();
    const store = createSessionUiStateStore(file);
    let state = await store.patch({ expectedRevision: 0, initialize: true, lanes: lanes(5) });
    state = await store.patch({ expectedRevision: state.revision, pinnedFolders: ["/one"] });
    const last = await store.patch({ expectedRevision: state.revision, pinnedFolders: ["/two"] });
    await writeFile(file, "{corrupt");
    const recovered = await createSessionUiStateStore(file).read();
    expect(recovered).toMatchObject({ initialized: true, revision: last.revision + 1, lanes: lanes(5), pinnedFolders: ["/two"] });
    await expect(createSessionUiStateStore(file).patch({ expectedRevision: last.revision, lanes: [] })).rejects.toBeInstanceOf(SessionUiStateConflictError);
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(join(file, ".."));
    expect(names.some((name) => name.startsWith("state.json.corrupt-"))).toBe(true);
  });

  it("treats a persisted empty legacy revision-zero state as initialized, not first run", async () => {
    const file = await tempFile();
    await writeFile(file, JSON.stringify({ version: 3, revision: 0, lanes: [] }));
    const store = createSessionUiStateStore(file);
    expect(await store.read()).toMatchObject({ revision: 0, initialized: true, lanes: [] });
    await expect(store.patch({ expectedRevision: 0, initialize: true, lanes: lanes(5) })).rejects.toBeInstanceOf(SessionUiStateConflictError);
  });

  it("recovers the first persisted import from its committed mirror", async () => {
    const file = await tempFile();
    const first = await createSessionUiStateStore(file).patch({ expectedRevision: 0, initialize: true, lanes: lanes(5) });
    expect(JSON.parse(await readFile(`${file}.bak-1.json`, "utf8"))).toMatchObject({ revision: first.revision, lanes: lanes(5) });
    await writeFile(file, "{corrupt");
    expect(await createSessionUiStateStore(file).read()).toMatchObject({ revision: first.revision + 1, initialized: true, lanes: lanes(5) });
  });

  it("treats recognized empty legacy v1/v2/v3 files as initialized and rejects partial v2/v3", async () => {
    for (const value of [
      { version: 1, revision: 0, pinnedSessions: [] },
      { version: 2, revision: 0, lanes: [] },
      { version: 3, revision: 0, lanes: [] },
    ]) {
      const file = await tempFile();
      await writeFile(file, JSON.stringify(value));
      expect(await createSessionUiStateStore(file).read()).toMatchObject({ initialized: true, revision: 0, lanes: [] });
    }
    for (const version of [2, 3]) {
      const file = await tempFile();
      await writeFile(file, JSON.stringify({ version, revision: 0 }));
      await expect(createSessionUiStateStore(file).read()).rejects.toBeInstanceOf(SessionUiStateUnavailableError);
    }
  });

  it("rejects partial revision-only primary and recovers intact mirrored state", async () => {
    const file = await tempFile();
    const first = await createSessionUiStateStore(file).patch({ expectedRevision: 0, initialize: true, lanes: lanes(5) });
    await writeFile(file, JSON.stringify({ version: 3, revision: first.revision }));
    expect(await createSessionUiStateStore(file).read()).toMatchObject({ revision: first.revision + 1, lanes: lanes(5) });
  });

  it("recovers a recognized legacy preference-only state and rejects unknown-only records", async () => {
    const file = await tempFile();
    await writeFile(file, JSON.stringify({ version: 3, revision: 0, lanes: [], bucketOrder: [...defaultSessionUiState.bucketOrder].reverse() }));
    expect(await createSessionUiStateStore(file).read()).toMatchObject({ initialized: true, revision: 0, bucketOrder: [...defaultSessionUiState.bucketOrder].reverse() });
    await writeFile(`${file}.bak-1.json`, await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ garbage: true }));
    const recovered = await createSessionUiStateStore(file).read();
    expect(recovered).toMatchObject({ initialized: true, revision: 1, bucketOrder: [...defaultSessionUiState.bucketOrder].reverse() });
  });

  it("rejects malformed persisted entries rather than normalizing them into empty collections", async () => {
    const file = await tempFile();
    await writeFile(file, JSON.stringify({ version: 3, revision: 9, lanes: [{ sessionId: "lost", lane: "unknown", since }] }));
    await expect(createSessionUiStateStore(file).read()).rejects.toBeInstanceOf(SessionUiStateUnavailableError);
    expect(JSON.parse(await readFile(file, "utf8")).revision).toBe(9);
  });

  it("fails closed when persisted data is missing or corrupt and no valid history remains", async () => {
    const file = await tempFile();
    const store = createSessionUiStateStore(file);
    expect(await store.read()).toMatchObject({ revision: 0, initialized: false });
    const state = await store.patch({ expectedRevision: 0, initialize: true, lanes: lanes(5) });
    await rm(file);
    await rm(`${file}.bak-1.json`);
    await expect(createSessionUiStateStore(file).read()).rejects.toBeInstanceOf(SessionUiStateUnavailableError);
    await writeFile(file, "{corrupt");
    await expect(createSessionUiStateStore(file).read()).rejects.toBeInstanceOf(SessionUiStateUnavailableError);
    expect(state.initialized).toBe(true);
  });

  it("keeps committed cache and primary unchanged after backup persistence fails", async () => {
    const file = await tempFile();
    const store = createSessionUiStateStore(file);
    const seeded = await store.patch({ expectedRevision: 0, initialize: true, lanes: lanes(5) });
    const { mkdir, readdir } = await import("node:fs/promises");
    const history = await readFile(`${file}.history.json`, "utf8");
    await rm(`${file}.history.json`);
    await mkdir(`${file}.history.json`);
    await writeFile(`${file}.history.json/keep`, "blocking history replacement");
    await expect(store.patch({ expectedRevision: seeded.revision, lanes: [] })).rejects.toThrow();
    await expect(store.read()).rejects.toBeInstanceOf(SessionUiStateUnavailableError);
    await rm(`${file}.history.json`, { recursive: true });
    await writeFile(`${file}.history.json`, history);
    expect((await createSessionUiStateStore(file).read()).lanes).toHaveLength(5);
    expect((await readdir(join(file, ".."))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("rejects revision overflow before modifying primary or history", async () => {
    const file = await tempFile();
    const max = { ...defaultSessionUiState, initialized: true, revision: Number.MAX_SAFE_INTEGER, lanes: lanes(5) };
    await writeFile(file, JSON.stringify(max));
    await writeFile(`${file}.history.json`, JSON.stringify({ highWater: max.revision }));
    const store = createSessionUiStateStore(file);
    await expect(store.patch({ expectedRevision: max.revision, lanes: [] })).rejects.toBeInstanceOf(SessionUiStateUnavailableError);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject(max);
    expect(JSON.parse(await readFile(`${file}.history.json`, "utf8")).highWater).toBe(max.revision);
  });

  it("serializes parallel first loads, recovery, and an interleaved write through one gate", async () => {
    const file = await tempFile();
    const first = await createSessionUiStateStore(file).patch({ expectedRevision: 0, initialize: true, lanes: lanes(5) });
    await writeFile(file, "{corrupt");
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let loads = 0;
    const store = createSessionUiStateStore(file, { beforeLoad: async () => { loads++; entered(); await gate; } });
    const reads = [store.read(), store.read()];
    const write = store.patch({ expectedRevision: first.revision + 1, pinnedFolders: ["/after-recovery"] });
    await started;
    expect(loads).toBe(1);
    expect(JSON.parse(await readFile(`${file}.history.json`, "utf8")).highWater).toBe(first.revision);
    release();
    const [a, b, patched] = await Promise.all([...reads, write]);
    expect(a.revision).toBe(first.revision + 1);
    expect(b.revision).toBe(a.revision);
    expect(patched.revision).toBe(a.revision + 1);
    expect((await createSessionUiStateStore(file).read()).revision).toBe(patched.revision);
    expect(loads).toBe(1);
  });

  it("does not publish a reserved but uncommitted revision when primary rename fails", async () => {
    const file = await tempFile();
    const seeded = await createSessionUiStateStore(file).patch({ expectedRevision: 0, initialize: true, lanes: lanes(5) });
    const store = createSessionUiStateStore(file, { beforePrimaryCommit: async () => { throw new Error("injected pre-rename failure"); } });
    await expect(store.patch({ expectedRevision: seeded.revision, lanes: [] })).rejects.toThrow("injected pre-rename failure");
    expect(await store.read()).toMatchObject({ revision: seeded.revision, lanes: lanes(5) });
    expect(JSON.parse(await readFile(`${file}.history.json`, "utf8")).highWater).toBe(seeded.revision + 1);
    const committed = await createSessionUiStateStore(file).patch({ expectedRevision: seeded.revision, pinnedFolders: ["/after-failure"] });
    expect(committed.revision).toBe(seeded.revision + 2);
    expect(committed.lanes).toEqual(lanes(5));
  });

  it("does not return failure after primary commit if mirror update fails", async () => {
    const file = await tempFile();
    const store = createSessionUiStateStore(file, { beforeMirror: async () => { throw new Error("injected post-commit mirror failure"); } });
    const saved = await store.patch({ expectedRevision: 0, initialize: true, lanes: lanes(5) });
    expect(saved).toMatchObject({ revision: 1, lanes: lanes(5) });
    expect(await createSessionUiStateStore(file).read()).toMatchObject({ revision: 1, lanes: lanes(5) });
  });

  it("keeps five rolling backups including the latest committed state", async () => {
    const file = await tempFile();
    const store = createSessionUiStateStore(file);
    let state = await store.patch({ expectedRevision: 0, initialize: true, pinnedFolders: ["/write-1"] });
    state = await store.patch({ expectedRevision: state.revision, pinnedFolders: ["/write-2"] });
    expect(JSON.parse(await readFile(`${file}.bak-1.json`, "utf8")).pinnedFolders).toEqual(["/write-2"]);

    state = await store.patch({ expectedRevision: state.revision, pinnedFolders: ["/write-3"] });
    expect(JSON.parse(await readFile(`${file}.bak-1.json`, "utf8")).pinnedFolders).toEqual(["/write-3"]);
    expect(JSON.parse(await readFile(`${file}.bak-2.json`, "utf8")).pinnedFolders).toEqual(["/write-2"]);

    for (let index = 4; index <= 7; index += 1) state = await store.patch({ expectedRevision: state.revision, pinnedFolders: [`/write-${index}`] });
    await Promise.all(Array.from({ length: 5 }, (_, index) => readFile(`${file}.bak-${index + 1}.json`, "utf8")));
    await expect(readFile(`${file}.bak-6.json`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
