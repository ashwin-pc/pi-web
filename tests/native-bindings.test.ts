import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { NativeBindings, type NativeBinding } from "../server/session/nativeBindings.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile), rename: vi.fn(actual.rename) };
});
const roots: string[] = [];
afterEach(async () => {
  vi.mocked(writeFile).mockClear(); vi.mocked(rename).mockClear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-web-atomic-bindings-")); roots.push(root);
  const file = join(root, "bindings.json");
  const store = new NativeBindings(file); await store.ready;
  return { root, file, store };
}
function row(id: string, nativeId = `native-${id}`): NativeBinding {
  return { id, cwd: "/synthetic", created: "2026-01-01", modified: "2026-01-01",
    nativeSession: { harnessId: "codex", sessionId: nativeId, persistence: "persistent", status: "resumable" } };
}

it.each(["write", "rename"] as const)("a failed %s preserves committed memory/disk, removes its temporary file, and permits retry", async (stage) => {
  const { root, file, store } = await fixture();
  await store.put(row("original"));
  const disk = await readFile(file, "utf8");
  const failure = new Error(`synthetic ${stage} failure`);
  if (stage === "write") {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(writeFile).mockImplementationOnce(async (path, _data, options) => { await actual.writeFile(path, "partial", options); throw failure; });
  } else vi.mocked(rename).mockRejectedValueOnce(failure);
  await expect(store.put(row("new"))).rejects.toThrow(failure.message);
  expect(store.list()).toEqual([row("original")]);
  expect(store.get("new")).toBeUndefined();
  expect(await readFile(file, "utf8")).toBe(disk);
  expect(await readdir(root)).toEqual(["bindings.json"]);
  await store.put(row("new"));
  expect(store.get("new")).toEqual(row("new"));
  expect(JSON.parse(await readFile(file, "utf8")).sessions).toEqual([row("original"), row("new")]);
});

it("serializes validation and immutable snapshots, including concurrent native identity collisions", async () => {
  const { file, store } = await fixture();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const atRename = new Promise<void>((resolve) => { entered = resolve; });
  vi.mocked(rename).mockImplementationOnce(async (from, to) => { entered(); await gate; await actual.rename(from, to); });
  const first = store.put(row("first", "shared-native"));
  await atRename;
  const duplicate = store.put(row("duplicate", "shared-native"));
  const rejected = expect(duplicate).rejects.toThrow("Conflicting native session identity");
  expect(store.list()).toEqual([]);
  expect(store.byNative(row("first", "shared-native").nativeSession)).toBeUndefined();
  release();
  await first; await rejected;
  expect(JSON.parse(await readFile(file, "utf8")).sessions).toEqual([row("first", "shared-native")]);
  expect(store.list()).toEqual([row("first", "shared-native")]);
  await store.put(row("later", "another-native"));
  expect(store.list().map((entry) => entry.id)).toEqual(["first", "later"]);
});

it("does not let a queued candidate leak into an earlier write or caller mutations change committed rows", async () => {
  const { file, store } = await fixture();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const atWrite = new Promise<void>((resolve) => { entered = resolve; });
  const snapshots: string[] = [];
  vi.mocked(writeFile).mockImplementationOnce(async (path, data, options) => {
    snapshots.push(String(data)); entered(); await gate; await actual.writeFile(path, data, options);
  }).mockRejectedValueOnce(new Error("second write failed"));
  const input = row("first");
  const first = store.put(input);
  input.name = "mutated after submission";
  await atWrite;
  const second = store.put(row("second"));
  const rejected = expect(second).rejects.toThrow("second write failed");
  release(); await first; await rejected;
  expect(JSON.parse(snapshots[0]).sessions).toEqual([row("first")]);
  expect(JSON.parse(await readFile(file, "utf8")).sessions).toEqual([row("first")]);
  const view = store.get("first")!; view.name = "mutated reader";
  expect(store.get("first")).toEqual(row("first"));
});
