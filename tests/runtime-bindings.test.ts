import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeBindingStore } from "../server/runtime/bindings.js";
import { localRuntime, RuntimeRegistry } from "../server/runtime/registry.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function store() {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-runtime-bindings-"));
  tempDirs.push(dir);
  return new RuntimeBindingStore(join(dir, "runtime-bindings.json"));
}

describe("RuntimeBindingStore", () => {
  it("defaults missing files to an empty binding list", async () => {
    await expect((await store()).read()).resolves.toEqual({ version: 1, bindings: [] });
  });

  it("updates metadata without allowing a session to be rebound to another runtime", async () => {
    const bindings = await store();
    await bindings.set({ sessionId: "s1", runtimeId: "container:abc", cwd: "/workspace/repo", name: "First", messageCount: 3 });
    await bindings.set({ sessionId: "s1", runtimeId: "container:abc", cwd: "/workspace/renamed", messageCount: 4 });
    await expect(bindings.get("s1")).resolves.toMatchObject({ sessionId: "s1", runtimeId: "container:abc", cwd: "/workspace/renamed", name: "First", messageCount: 4 });
    await expect(bindings.set({ sessionId: "s1", runtimeId: "container:other", cwd: "/workspace/repo" })).rejects.toThrow(/refusing to rebind/);
  });

  it("removes every cached locator when a runtime is forgotten", async () => {
    const bindings = await store();
    await bindings.set({ sessionId: "s1", runtimeId: "container:abc", cwd: "/workspace/a" });
    await bindings.set({ sessionId: "s2", runtimeId: "container:abc", cwd: "/workspace/b" });
    await bindings.set({ sessionId: "s3", runtimeId: "ssh:dev", cwd: "/repo" });
    await expect(bindings.removeRuntime("container:abc")).resolves.toBe(2);
    await expect((await bindings.read()).bindings).toEqual([expect.objectContaining({ sessionId: "s3", runtimeId: "ssh:dev" })]);
  });

  it("treats missing bindings as local without persisting unbounded local rows", async () => {
    const bindings = await store();
    await expect(bindings.ensureLocal("s1", "/repo")).resolves.toMatchObject({ runtimeId: "local", cwd: "/repo" });
    await expect(bindings.ensureLocal("s1", "/other")).resolves.toMatchObject({ runtimeId: "local", cwd: "/other" });
    await expect(bindings.read()).resolves.toEqual({ version: 1, bindings: [] });
  });
});

describe("RuntimeRegistry", () => {
  it("lists registered runtimes", () => {
    const registry = new RuntimeRegistry([localRuntime, { id: "ssh:rpi", kind: "ssh", label: "Raspberry Pi" }]);
    expect(registry.get("local")).toEqual(localRuntime);
    expect(registry.list().map((runtime) => runtime.id)).toEqual(["local", "ssh:rpi"]);
  });
});
