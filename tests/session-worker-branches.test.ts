import { describe, expect, it } from "vitest";
import {
  buildSpawnWorkerForest,
  deriveWorkerBranchView,
  type SpawnWorkerForest,
  type WorkerBranch,
  type WorkerBranchOrigin,
  type WorkerBranchSession,
  type WorkerBranchView,
} from "../src/sessions/workerBranches.js";

type Session = WorkerBranchSession & { cwd?: string; running?: boolean };

const session = (id: string, extra: Omit<Session, "id"> = {}): Session => ({ id, ...extra });
const spawn = (sessionId: string, originSessionId: string): WorkerBranchOrigin => ({ sessionId, originSessionId, kind: "spawn" });
const origin = (sessionId: string, originSessionId: string, kind: string): WorkerBranchOrigin => ({ sessionId, originSessionId, kind });
const ids = <T extends WorkerBranchSession>(branches: readonly WorkerBranch<T>[]) => branches.map((branch) => branch.id);
const viewIds = <T extends WorkerBranchSession>(branches: readonly WorkerBranchView<T>[]) => branches.map((branch) => branch.node.id);

function allForestIds<T extends WorkerBranchSession>(forest: SpawnWorkerForest<T>): string[] {
  const result: string[] = [];
  const stack = [...forest.roots, ...forest.unattachedWorkers].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    result.push(node.id);
    for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push(node.children[index]);
  }
  return result;
}

describe("buildSpawnWorkerForest", () => {
  it("builds stable deep spawn branches and computes descendant total/running counts", () => {
    const forest = buildSpawnWorkerForest(
      [
        session("parent"),
        session("worker-a", { running: true }),
        session("ordinary-continuation"),
        session("worker-b"),
        session("grandchild", { running: true }),
      ],
      [
        spawn("worker-a", "parent"),
        origin("ordinary-continuation", "parent", "continuation"),
        spawn("worker-b", "parent"),
        spawn("grandchild", "worker-a"),
      ],
      { isRunning: (item) => Boolean(item.running) },
    );

    expect(ids(forest.roots)).toEqual(["parent", "ordinary-continuation"]);
    expect(forest.unattachedWorkers).toEqual([]);
    expect(forest.primarySessionCount).toBe(2);
    expect(forest.workerSessionCount).toBe(3);

    const parent = forest.roots[0];
    expect(parent.role).toBe("primary");
    expect(ids(parent.children)).toEqual(["worker-a", "worker-b"]);
    expect(parent.descendantWorkerCount).toBe(3);
    expect(parent.runningDescendantWorkerCount).toBe(2);

    const worker = parent.children[0];
    expect(worker).toMatchObject({
      id: "worker-a",
      role: "worker",
      parentId: "parent",
      originParentId: "parent",
      isRunning: true,
      descendantWorkerCount: 1,
      runningDescendantWorkerCount: 1,
    });
    expect(ids(worker.children)).toEqual(["grandchild"]);
  });

  it("uses only exact spawn origins and resolves duplicate spawn rows by first occurrence", () => {
    const forest = buildSpawnWorkerForest(
      [session("parent-a"), session("parent-b"), session("worker"), session("future")],
      [
        origin("worker", "parent-b", "SPAWN"),
        spawn("worker", "parent-a"),
        spawn("worker", "parent-b"),
        origin("future", "parent-a", "continuation"),
        spawn("not-in-list", "parent-a"),
      ],
    );

    expect(ids(forest.roots)).toEqual(["parent-a", "parent-b", "future"]);
    expect(ids(forest.roots[0].children)).toEqual(["worker"]);
    expect(forest.roots[0].children[0].originParentId).toBe("parent-a");
    expect(forest.roots[1].children).toEqual([]);
    expect(forest.workerSessionCount).toBe(1);
  });

  it("exposes self-parented and missing-parent workers as unattached trees without dropping descendants", () => {
    const sessions = [session("ordinary"), session("self"), session("orphan"), session("orphan-child")];
    const forest = buildSpawnWorkerForest(sessions, [
      spawn("self", "self"),
      spawn("orphan", "missing"),
      spawn("orphan-child", "orphan"),
    ]);

    expect(ids(forest.roots)).toEqual(["ordinary"]);
    expect(ids(forest.unattachedWorkers)).toEqual(["self", "orphan"]);
    expect(forest.unattachedWorkers[0]).toMatchObject({
      role: "worker",
      originParentId: "self",
      unattachedReason: "self-parent",
    });
    expect(forest.unattachedWorkers[1]).toMatchObject({
      role: "worker",
      originParentId: "missing",
      unattachedReason: "missing-parent",
      descendantWorkerCount: 1,
    });
    expect(ids(forest.unattachedWorkers[1].children)).toEqual(["orphan-child"]);
    expect(allForestIds(forest).sort()).toEqual(sessions.map((item) => item.id).sort());
  });

  it("breaks a cycle at its earliest listed member and emits every session exactly once", () => {
    const sessions = [session("ordinary"), session("cycle-a"), session("cycle-b"), session("cycle-c"), session("leaf")];
    const forest = buildSpawnWorkerForest(sessions, [
      spawn("cycle-a", "cycle-b"),
      spawn("cycle-b", "cycle-c"),
      spawn("cycle-c", "cycle-a"),
      spawn("leaf", "cycle-b"),
    ]);

    expect(ids(forest.roots)).toEqual(["ordinary"]);
    expect(ids(forest.unattachedWorkers)).toEqual(["cycle-a"]);
    expect(forest.unattachedWorkers[0]).toMatchObject({
      role: "worker",
      originParentId: "cycle-b",
      unattachedReason: "cycle",
      descendantWorkerCount: 3,
    });
    expect(ids(forest.unattachedWorkers[0].children)).toEqual(["cycle-c"]);
    expect(ids(forest.unattachedWorkers[0].children[0].children)).toEqual(["cycle-b"]);
    expect(ids(forest.unattachedWorkers[0].children[0].children[0].children)).toEqual(["leaf"]);

    const emitted = allForestIds(forest);
    expect(emitted).toHaveLength(sessions.length);
    expect(new Set(emitted).size).toBe(sessions.length);
    expect(emitted.sort()).toEqual(sessions.map((item) => item.id).sort());
  });

  it("attaches a cross-cwd worker globally while preserving the worker item cwd", () => {
    const forest = buildSpawnWorkerForest(
      [session("parent", { cwd: "/repo/a" }), session("worker", { cwd: "/repo/b" })],
      [spawn("worker", "parent")],
    );

    expect(ids(forest.roots)).toEqual(["parent"]);
    expect(forest.roots[0].children[0].item.cwd).toBe("/repo/b");
    expect(forest.roots[0].children[0].parentId).toBe("parent");
  });

  it("keeps workers out of the primary root collection used for an eight-item preview", () => {
    const primaries = Array.from({ length: 10 }, (_, index) => session(`parent-${index}`));
    const workers = Array.from({ length: 12 }, (_, index) => session(`worker-${index}`));
    const forest = buildSpawnWorkerForest(
      [...primaries, ...workers],
      workers.map((item, index) => spawn(item.id, `parent-${index % 2}`)),
    );

    expect(forest.primarySessionCount).toBe(10);
    expect(forest.workerSessionCount).toBe(12);
    expect(forest.roots.every((node) => node.role === "primary")).toBe(true);
    expect(ids(forest.roots.slice(0, 8))).toEqual(Array.from({ length: 8 }, (_, index) => `parent-${index}`));
    expect(forest.roots[0].descendantWorkerCount).toBe(6);
    expect(forest.roots[1].descendantWorkerCount).toBe(6);
  });

  it("handles a very deep lineage iteratively", () => {
    const depth = 2_000;
    const sessions = [session("root"), ...Array.from({ length: depth }, (_, index) => session(`worker-${index}`))];
    const origins = Array.from({ length: depth }, (_, index) => spawn(`worker-${index}`, index === 0 ? "root" : `worker-${index - 1}`));
    const forest = buildSpawnWorkerForest(sessions, origins);

    expect(forest.roots[0].descendantWorkerCount).toBe(depth);
    expect(forest.workerSessionCount).toBe(depth);
    expect(allForestIds(forest)).toHaveLength(depth + 1);

    const view = deriveWorkerBranchView(forest, { forceExpandedSessionIds: new Set([`worker-${depth - 1}`]) });
    let current = view.roots[0];
    for (let index = 0; index < depth; index += 1) {
      expect(current.expanded).toBe(true);
      current = current.children[0];
    }
    expect(current.node.id).toBe(`worker-${depth - 1}`);
    expect(current.expanded).toBe(false);
  });

  it("rejects invalid session identities instead of silently losing ambiguous items", () => {
    expect(() => buildSpawnWorkerForest([session("")], [])).toThrow(/non-empty/);
    expect(() => buildSpawnWorkerForest([session("same"), session("same")], [])).toThrow(/duplicate session id/i);
  });
});

describe("deriveWorkerBranchView", () => {
  const makeForest = () => buildSpawnWorkerForest(
    [session("parent"), session("worker-a"), session("worker-b"), session("deep-match"), session("other")],
    [spawn("worker-a", "parent"), spawn("worker-b", "parent"), spawn("deep-match", "worker-a")],
  );

  it("retains filtered-out ancestors as context and forces matching descendant paths open", () => {
    const view = deriveWorkerBranchView(makeForest(), { matches: (item) => item.id === "deep-match" });

    expect(viewIds(view.roots)).toEqual(["parent"]);
    expect(view.unattachedWorkers).toEqual([]);
    expect(view.matchedSessionCount).toBe(1);
    expect(view.visibleSessionCount).toBe(3);
    expect(view.primarySessionCount).toBe(1);
    expect(view.workerSessionCount).toBe(2);

    const parent = view.roots[0];
    expect(parent).toMatchObject({ selfMatches: false, contextOnly: true, forcedExpanded: true, expanded: true });
    expect(viewIds(parent.children)).toEqual(["worker-a"]);

    const worker = parent.children[0];
    expect(worker).toMatchObject({ selfMatches: false, contextOnly: true, forcedExpanded: true, expanded: true });
    expect(viewIds(worker.children)).toEqual(["deep-match"]);
    expect(worker.children[0]).toMatchObject({ selfMatches: true, contextOnly: false, forcedExpanded: false, expanded: false });
  });

  it("does not retain unrelated descendants merely because their parent matches", () => {
    const view = deriveWorkerBranchView(makeForest(), {
      matches: (item) => item.id === "parent",
      expandedParentIds: new Set(["parent"]),
    });

    expect(viewIds(view.roots)).toEqual(["parent"]);
    expect(view.roots[0]).toMatchObject({ selfMatches: true, contextOnly: false, manuallyExpanded: true, expanded: false });
    expect(view.roots[0].children).toEqual([]);
    expect(view.visibleSessionCount).toBe(1);
  });

  it("supports default collapse, manual expansion, and explicit active-worker expansion without mutating the forest", () => {
    const forest = makeForest();
    const collapsed = deriveWorkerBranchView(forest);
    expect(collapsed.roots[0]).toMatchObject({ manuallyExpanded: false, forcedExpanded: false, expanded: false });
    expect(viewIds(collapsed.roots[0].children)).toEqual(["worker-a", "worker-b"]);

    const manual = deriveWorkerBranchView(forest, { expandedParentIds: new Set(["parent"]) });
    expect(manual.roots[0]).toMatchObject({ manuallyExpanded: true, forcedExpanded: false, expanded: true });

    const active = deriveWorkerBranchView(forest, { forceExpandedSessionIds: new Set(["deep-match"]) });
    expect(active.roots[0]).toMatchObject({ manuallyExpanded: false, forcedExpanded: true, expanded: true });
    expect(active.roots[0].children[0]).toMatchObject({ forcedExpanded: true, expanded: true });
    expect(active.roots[0].children[0].children[0]).toMatchObject({ forcedExpanded: false, expanded: false });

    expect(forest.roots[0].children).toHaveLength(2);
    expect(forest.roots[0].descendantWorkerCount).toBe(3);
  });

  it("retains matching unattached worker trees and their context ancestors", () => {
    const forest = buildSpawnWorkerForest(
      [session("orphan"), session("orphan-child"), session("ordinary")],
      [spawn("orphan", "missing"), spawn("orphan-child", "orphan")],
    );
    const view = deriveWorkerBranchView(forest, { matches: (item) => item.id === "orphan-child" });

    expect(view.roots).toEqual([]);
    expect(viewIds(view.unattachedWorkers)).toEqual(["orphan"]);
    expect(view.unattachedWorkers[0]).toMatchObject({ contextOnly: true, forcedExpanded: true, expanded: true });
    expect(viewIds(view.unattachedWorkers[0].children)).toEqual(["orphan-child"]);
  });

  it("lets filtering win when an explicitly forced session does not match", () => {
    const view = deriveWorkerBranchView(makeForest(), {
      matches: (item) => item.id === "other",
      forceExpandedSessionIds: new Set(["deep-match"]),
    });

    expect(viewIds(view.roots)).toEqual(["other"]);
    expect(view.roots[0].expanded).toBe(false);
    expect(view.visibleSessionCount).toBe(1);
  });
});
