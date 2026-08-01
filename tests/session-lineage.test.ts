import { describe, expect, it } from "vitest";
import { orderItemsWithChildren, runningChildIdsOf, sessionIndicatorKind } from "../src/sessions/lineage.js";

type Item = { id: string };
const items = (...ids: string[]): Item[] => ids.map((id) => ({ id }));
const ids = (list: Item[]) => list.map((item) => item.id);

/** Build a parent lookup from "child->parent" pairs. */
function parentLookup(pairs: Array<[string, string]>) {
  const map = new Map(pairs);
  return (id: string) => map.get(id);
}

describe("orderItemsWithChildren", () => {
  it("leaves the list untouched when nothing has a parent", () => {
    const list = items("a", "b", "c");
    expect(orderItemsWithChildren(list, () => undefined)).toBe(list);
  });

  it("moves a child directly after its parent", () => {
    const list = items("a", "b", "child-of-a");
    const ordered = orderItemsWithChildren(list, parentLookup([["child-of-a", "a"]]));
    expect(ids(ordered)).toEqual(["a", "child-of-a", "b"]);
  });

  it("keeps multiple children after their parent in their original order", () => {
    const list = items("a", "c1", "b", "c2");
    const ordered = orderItemsWithChildren(list, parentLookup([["c1", "a"], ["c2", "a"]]));
    expect(ids(ordered)).toEqual(["a", "c1", "c2", "b"]);
  });

  it("keeps a grandchild in the list and under its own parent", () => {
    // Regression: one level of nesting used to be emitted, so a child of a
    // child silently VANISHED from the drawer.
    const list = items("a", "b", "c");
    const ordered = orderItemsWithChildren(list, parentLookup([["b", "a"], ["c", "b"]]));
    expect(ids(ordered)).toEqual(["a", "b", "c"]);
    expect(ordered).toHaveLength(3);
  });

  it("keeps a deep lineage chain intact", () => {
    const list = items("d", "c", "b", "a");
    const ordered = orderItemsWithChildren(list, parentLookup([["b", "a"], ["c", "b"], ["d", "c"]]));
    expect(ids(ordered)).toEqual(["a", "b", "c", "d"]);
  });

  it("never drops sessions when origins form a cycle", () => {
    // Regression: a 2-cycle left no root, so BOTH sessions vanished. Origins are
    // client-asserted, so this must degrade to imperfect order, never data loss.
    const list = items("a", "b");
    const ordered = orderItemsWithChildren(list, parentLookup([["a", "b"], ["b", "a"]]));
    expect(ids(ordered).sort()).toEqual(["a", "b"]);
  });

  it("never drops sessions when a cycle sits below a real root", () => {
    const list = items("root", "x", "y");
    const ordered = orderItemsWithChildren(list, parentLookup([["x", "root"], ["y", "x"], ["x", "y"]]));
    expect(ids(ordered).sort()).toEqual(["root", "x", "y"]);
  });

  it("ignores a session that claims itself as its parent", () => {
    const list = items("a", "b");
    const ordered = orderItemsWithChildren(list, parentLookup([["a", "a"]]));
    expect(ids(ordered)).toEqual(["a", "b"]);
  });

  it("leaves a child in place when its parent is not in the list", () => {
    const list = items("a", "orphan");
    const ordered = orderItemsWithChildren(list, parentLookup([["orphan", "missing-parent"]]));
    expect(ids(ordered)).toEqual(["a", "orphan"]);
  });

  it("emits every input exactly once for a mixed tree", () => {
    const list = items("p1", "p2", "c1a", "c1b", "g1", "loner");
    const ordered = orderItemsWithChildren(list, parentLookup([
      ["c1a", "p1"], ["c1b", "p1"], ["g1", "c1a"],
    ]));
    expect(ids(ordered)).toEqual(["p1", "c1a", "g1", "c1b", "p2", "loner"]);
    expect(new Set(ids(ordered)).size).toBe(list.length);
  });
});

describe("sessionIndicatorKind", () => {
  it("applies the precedence running > waiting > unread", () => {
    expect(sessionIndicatorKind({ running: true, waiting: true, unread: true })).toBe("running");
    expect(sessionIndicatorKind({ waiting: true, unread: true })).toBe("waiting");
    expect(sessionIndicatorKind({ unread: true })).toBe("unread");
    expect(sessionIndicatorKind({})).toBe("none");
  });
});

describe("runningChildIdsOf", () => {
  const origins = [
    { sessionId: "child-running", originSessionId: "parent" },
    { sessionId: "child-idle", originSessionId: "parent" },
    { sessionId: "other-child", originSessionId: "someone-else" },
  ];

  it("returns only this session's still-running children", () => {
    expect(runningChildIdsOf("parent", origins, (id) => id === "child-running")).toEqual(["child-running"]);
  });

  it("returns nothing when no child is running", () => {
    expect(runningChildIdsOf("parent", origins, () => false)).toEqual([]);
  });

  it("ignores other parents' children", () => {
    expect(runningChildIdsOf("parent", origins, () => true)).toEqual(["child-running", "child-idle"]);
  });

  it("de-duplicates repeated origin records and ignores self-parenting", () => {
    const messy = [
      { sessionId: "c", originSessionId: "parent" },
      { sessionId: "c", originSessionId: "parent" },
      { sessionId: "parent", originSessionId: "parent" },
    ];
    expect(runningChildIdsOf("parent", messy, () => true)).toEqual(["c"]);
  });

  it("returns nothing for an empty session id", () => {
    expect(runningChildIdsOf("", origins, () => true)).toEqual([]);
  });
});
