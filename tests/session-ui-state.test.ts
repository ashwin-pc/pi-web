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
    const future = { ...defaultSessionUiState, version: 3, futureMetadata: { keep: true } };
    await writeFile(file, JSON.stringify(future));
    const store = createSessionUiStateStore(file);

    expect((await store.read()).lanes).toEqual([]);
    await expect(store.patch({ lanes: [{ sessionId: "a", lane: "pinned", since: new Date().toISOString() }] })).rejects.toThrow(/refusing to overwrite/i);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(future);
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
