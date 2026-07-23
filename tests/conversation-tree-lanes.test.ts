import { describe, expect, it } from "vitest";
import {
  flattenGraphRows,
  type ConversationTreeNode,
} from "../src/tree/conversationTree.js";

function node(
  id: string,
  children: ConversationTreeNode[] = [],
  options: Partial<ConversationTreeNode> = {},
): ConversationTreeNode {
  return {
    id,
    parentId: null,
    type: "message",
    role: "assistant",
    preview: id,
    timestamp: "",
    childCount: children.length,
    isOnActivePath: false,
    isCurrentLeaf: false,
    children,
    ...options,
  };
}

function current(id: string) {
  return node(id, [], { isOnActivePath: true, isCurrentLeaf: true });
}

function rowSummary(roots: ConversationTreeNode[]) {
  return flattenGraphRows(roots).map((row) => ({
    id: row.node.id,
    lane: row.lane,
    branchIndex: row.branchIndex,
    branchCount: row.branchCount,
  }));
}

describe("conversation tree graph lanes", () => {
  it("keeps a linear chain in one lane", () => {
    const tree = node("a", [node("b", [current("c")], { isOnActivePath: true })], { isOnActivePath: true });

    expect(rowSummary([tree])).toEqual([
      { id: "a", lane: 0, branchIndex: undefined, branchCount: undefined },
      { id: "b", lane: 0, branchIndex: undefined, branchCount: undefined },
      { id: "c", lane: 0, branchIndex: undefined, branchCount: undefined },
    ]);
  });

  it("keeps the active fork child in the parent lane", () => {
    const active = current("active");
    const tree = node("fork", [active, node("alternate")], { isOnActivePath: true });

    expect(rowSummary([tree])).toEqual([
      { id: "fork", lane: 0, branchIndex: undefined, branchCount: undefined },
      { id: "alternate", lane: 1, branchIndex: 2, branchCount: 2 },
      { id: "active", lane: 0, branchIndex: 1, branchCount: 2 },
    ]);
  });

  it("reuses a lane after an earlier alternate chain ends", () => {
    const activeFork = node("active-fork", [current("current"), node("alternate-2")], { isOnActivePath: true });
    const tree = node("root-fork", [activeFork, node("alternate-1")], { isOnActivePath: true });
    const rows = rowSummary([tree]);

    expect(rows.map(({ id }) => id)).toEqual(["root-fork", "alternate-1", "active-fork", "alternate-2", "current"]);
    expect(rows.find(({ id }) => id === "alternate-1")?.lane).toBe(1);
    expect(rows.find(({ id }) => id === "alternate-2")?.lane).toBe(1);
  });

  it("reserves lanes across nested branch fans", () => {
    const nestedChildren = Array.from({ length: 6 }, (_, index) => node(`nested-${index + 1}`));
    const outerChildren = [
      node("outer-1", [node("nested-fork", nestedChildren)]),
      ...Array.from({ length: 4 }, (_, index) => node(`outer-${index + 2}`)),
      current("outer-6"),
    ];
    const rows = flattenGraphRows([node("outer-fork", outerChildren, { isOnActivePath: true })]);
    const outerAlternateLanes = new Set(rows.filter((row) => /^outer-[1-5]$/.test(row.node.id)).map((row) => row.lane));
    const nestedLanes = new Set(rows.filter((row) => row.node.id.startsWith("nested-") && row.node.id !== "nested-fork").map((row) => row.lane));

    expect(outerAlternateLanes.size).toBe(5);
    expect(nestedLanes.size).toBe(6);
    expect([...nestedLanes].some((lane) => outerAlternateLanes.has(lane))).toBe(false);
    expect(rows.at(-1)?.node.id).toBe("outer-6");
  });

  it("emits an earlier active child after its alternate siblings", () => {
    const active = node("active", [current("current")], { isOnActivePath: true });
    const rows = rowSummary([node("fork", [active, node("abandoned")], { isOnActivePath: true })]);

    expect(rows.map(({ id }) => id)).toEqual(["fork", "abandoned", "active", "current"]);
    expect(rows.at(-1)?.id).toBe("current");
  });

  it("keeps natural sibling order when a fork has no active descendant", () => {
    const rows = rowSummary([node("fork", [node("first"), node("second"), node("third")])]);

    expect(rows.map(({ id }) => id)).toEqual(["fork", "first", "second", "third"]);
  });

  it("preserves branch badge indexes after reordering", () => {
    const active = current("active-first");
    const rows = rowSummary([node("fork", [active, node("alternate-second")], { isOnActivePath: true })]);

    expect(rows.slice(1)).toEqual([
      { id: "alternate-second", lane: 1, branchIndex: 2, branchCount: 2 },
      { id: "active-first", lane: 0, branchIndex: 1, branchCount: 2 },
    ]);
  });
});
