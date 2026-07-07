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

  it("persists and replaces session runtime bindings", async () => {
    const bindings = await store();
    await bindings.set({ sessionId: "s1", runtimeId: "local", cwd: "/repo" });
    await expect(bindings.get("s1")).resolves.toMatchObject({ sessionId: "s1", runtimeId: "local", cwd: "/repo" });
    await bindings.set({ sessionId: "s1", runtimeId: "container:abc", cwd: "/workspace/repo" });
    const data = await bindings.read();
    expect(data.bindings).toHaveLength(1);
    expect(data.bindings[0]).toMatchObject({ sessionId: "s1", runtimeId: "container:abc", cwd: "/workspace/repo" });
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
