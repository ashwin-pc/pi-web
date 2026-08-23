import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionUiStateStore, defaultSessionUiState } from "../server/sessionUiState.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function tempFile() { const dir = await mkdtemp(join(tmpdir(), "pi-web-session-ui-")); dirs.push(dir); return join(dir, "state.json"); }

describe("session UI state store", () => {
  it("never overwrites an unsupported future-version file", async () => {
    const file = await tempFile();
    const future = { ...defaultSessionUiState, version: 4, futureMetadata: { keep: true } };
    await writeFile(file, JSON.stringify(future));
    const store = createSessionUiStateStore(file);

    expect((await store.read()).lanes).toEqual([]);
    await expect(store.patch({ lanes: [{ sessionId: "a", lane: "pinned", since: new Date().toISOString() }] })).rejects.toThrow(/refusing to overwrite/i);
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

    const patched = await store.patch({ pinnedFolders: ["/tmp/project"] });
    expect(patched.sessionNotes).toEqual(state.sessionNotes);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      version: 3,
      pinnedFolders: ["/tmp/project"],
      sessionNotes: [{ sessionId: "a", note: "Keep this note", updatedAt: expect.any(String) }],
    });
  });

  it("keeps notes when lanes change and removes them only with the session", async () => {
    const store = createSessionUiStateStore(await tempFile());
    await store.patch({
      lanes: [{ sessionId: "a", lane: "pinned", since: "2025-01-01T00:00:00.000Z" }],
      sessionNotes: [{ sessionId: "a", note: "Persistent", updatedAt: "2025-01-01T00:00:00.000Z" }],
    });

    const unpinned = await store.patch({ lanes: [] });
    expect(unpinned.sessionNotes).toEqual([{ sessionId: "a", note: "Persistent", updatedAt: "2025-01-01T00:00:00.000Z" }]);
    expect((await store.removeSession("a")).sessionNotes).toEqual([]);
  });

  it("persists renamed buckets and accepts the three additional bucket colors", async () => {
    const store = createSessionUiStateStore(await tempFile());
    const next = await store.patch({
      bucketLabels: { cyan: "Builds", orange: "  Urgent  ", pink: "", invalid: "Nope" },
      sessionMarkers: [
        { sessionId: "a", color: "cyan" },
        { sessionId: "b", color: "orange" },
        { sessionId: "c", color: "pink" },
      ],
    });

    expect(next.bucketLabels).toEqual({ cyan: "Builds", orange: "Urgent" });
    expect(next.sessionMarkers.map(({ color }) => color)).toEqual(["cyan", "orange", "pink"]);
  });

  it("preserves since for unchanged pins sent through the legacy alias", async () => {
    const file = await tempFile();
    const store = createSessionUiStateStore(file);
    const since = "2025-01-01T00:00:00.000Z";
    await store.write({ ...defaultSessionUiState, lanes: [{ sessionId: "a", lane: "pinned", since }] });

    const next = await store.patch({ pinnedSessions: [{ id: "a", cwd: "/tmp/a" }] });
    expect(next.lanes).toEqual([{ sessionId: "a", lane: "pinned", cwd: "/tmp/a", since }]);
  });
});
