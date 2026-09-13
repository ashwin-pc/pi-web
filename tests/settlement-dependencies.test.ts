import { describe, expect, it } from "vitest";
import { createSettlementDependencyStore } from "../src/sessions/settlementDependencies.js";

describe("settlement dependency snapshots", () => {
  it("does not write a delayed snapshot after switching sessions", async () => {
    const target: Record<string, string[]> = {};
    const store = createSettlementDependencyStore(target);
    let currentSessionId = "parent-a";
    let resolve!: (ids: string[]) => void;
    const delayed = new Promise<string[]>((done) => { resolve = done; });
    const hydration = store.hydrate("parent-a", () => delayed, () => currentSessionId === "parent-a");

    currentSessionId = "parent-b";
    resolve(["worker-a"]);

    await expect(hydration).resolves.toBe(false);
    expect(target).toEqual({});
  });

  it("rejects a delayed HTTP snapshot after a newer realtime report", async () => {
    const target: Record<string, string[]> = {};
    const store = createSettlementDependencyStore(target);
    let resolve!: (ids: string[]) => void;
    const delayed = new Promise<string[]>((done) => { resolve = done; });
    const hydration = store.hydrate("parent", () => delayed, () => true);

    expect(store.applyReport("parent", ["new-worker"])).toBe(true);
    resolve(["stale-worker"]);

    await expect(hydration).resolves.toBe(false);
    expect(target.parent).toEqual(["new-worker"]);
  });

  it("allows independent in-flight snapshots for different sessions", () => {
    const target: Record<string, string[]> = {};
    const store = createSettlementDependencyStore(target);
    const first = store.beginSnapshot("parent-a")!;
    const second = store.beginSnapshot("parent-b")!;

    store.applyReport("parent-b", ["live-b"]);
    expect(store.applySnapshot(first, ["snapshot-a"])).toBe(true);
    expect(store.applySnapshot(second, ["stale-b"])).toBe(false);
    expect(target).toEqual({ "parent-b": ["live-b"], "parent-a": ["snapshot-a"] });
  });

  it("normalizes untrusted IDs through one canonical update path", () => {
    const target: Record<string, string[]> = {};
    const store = createSettlementDependencyStore(target);
    store.applyReport(" parent ", [" child ", "child", "parent", "", 42]);
    expect(target.parent).toEqual(["child"]);
  });
});
