import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkStore } from "../server/workspace/workStore.js";
import { WorkspaceRegistry } from "../server/workspace/registry.js";
import { parseWorkItem, workItemKey } from "../shared/work.js";

describe("durable work", () => {
  it("spans roots without needing an agent and rejects lost updates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-work-"));
    try {
      const registry = new WorkspaceRegistry(), a = registry.register(join(dir, "a")), b = registry.register(join(dir, "b"));
      const file = join(dir, "work.json"), store = new WorkStore(file, registry);
      const work = await store.create({ title: "Release both projects", workspaceIds: [a.id, b.id], sessionIds: [] });
      const restarted = new WorkStore(file, new WorkspaceRegistry());
      expect(await restarted.require(work.id)).toEqual(work);
      const results = await Promise.allSettled([store.patch(work.id, { title: "Renamed" }, 0), store.patch(work.id, { title: "Stale" }, 0)]);
      expect(results.map(r => r.status)).toEqual(["fulfilled", "rejected"]);
      expect((await store.require(work.id)).title).toBe("Renamed");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("keeps file, connection and browser identities distinct and rejects unsafe paths", () => {
    const a = parseWorkItem({ kind: "file", workspaceId: "local-0000000000000001", path: "README.md" })!, b = parseWorkItem({ ...a, workspaceId: "local-0000000000000002" })!;
    expect(workItemKey(a)).not.toBe(workItemKey(b));
    expect(parseWorkItem({ kind: "preview", workspaceId: "local-0000000000000001", path: "../../x.html" })).toBeUndefined();
    expect(parseWorkItem({ kind: "browser", id: "browser-one" })).toEqual({ kind: "browser", id: "browser-one" });
    expect(parseWorkItem({ kind: "mcp-app", connectionId: "planner", toolName: "plan" })).toEqual({ kind: "mcp-app", connectionId: "planner", toolName: "plan" });
  });
});
