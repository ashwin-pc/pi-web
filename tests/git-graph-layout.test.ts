import { describe, expect, it } from "vitest";
import { layoutGitGraph } from "../src/git/graphView.js";
import type { GitCommit } from "../src/git/types.js";

function commit(hash: string, parents: string[] = []): GitCommit {
  return { hash, shortHash: hash, parents, author: "Test", date: "", refs: [], subject: hash };
}

describe("git graph layout", () => {
  it("keeps a linear history in one lane", () => {
    const graph = layoutGitGraph([commit("c", ["b"]), commit("b", ["a"]), commit("a")]);
    expect(graph.laneCount).toBe(1);
    expect(graph.rows.map((row) => row.lane)).toEqual([0, 0, 0]);
    expect(graph.rows[0].edges).toEqual([
      { from: 0, to: 0, fromY: 20, toY: 40, colourLane: 0 },
    ]);
    expect(graph.rows[1].edges).toEqual([
      { from: 0, to: 0, fromY: 0, toY: 20, colourLane: 0 },
      { from: 0, to: 0, fromY: 20, toY: 40, colourLane: 0 },
    ]);
    expect(graph.rows[2].edges).toEqual([
      { from: 0, to: 0, fromY: 0, toY: 20, colourLane: 0 },
    ]);
  });

  it("fans merge parents into separate lanes and rejoins them", () => {
    const graph = layoutGitGraph([
      commit("merge", ["main", "branch"]),
      commit("main", ["base"]),
      commit("branch", ["base"]),
      commit("base"),
    ]);
    expect(graph.laneCount).toBe(2);
    expect(graph.rows.map((row) => row.lane)).toEqual([0, 0, 1, 0]);
    expect(graph.rows[0].edges.map((edge) => edge.to)).toEqual([0, 1]);
    expect(graph.rows[2].edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 1, to: 0, fromY: 20, toY: 40, colourLane: 1 }),
    ]));
  });

  it("keeps independent branch tips in distinct lanes", () => {
    const graph = layoutGitGraph([commit("tip-a", ["base"]), commit("tip-b", ["base"]), commit("base")]);
    expect(graph.laneCount).toBe(2);
    expect(graph.rows.map((row) => row.lane)).toEqual([0, 1, 0]);
    expect(graph.rows[1].colour).toBe(1);
    expect(graph.rows[1].edges.at(-1)?.colourLane).toBe(1);
  });

  it("packs nested branches and merges while preserving chain colours", () => {
    const commits = [
      commit("merge-release", ["main-five", "hotfix-two"]),
      commit("main-five", ["merge-feature"]),
      commit("merge-feature", ["main-four", "feature-three"]),
      commit("main-four", ["main-three"]),
      commit("main-three", ["base-three"]),
      commit("feature-three", ["feature-two"]),
      commit("feature-two", ["feature-one", "nested-two"]),
      commit("feature-one", ["base-two"]),
      commit("nested-two", ["nested-one"]),
      commit("nested-one", ["base-two"]),
      commit("hotfix-two", ["hotfix-one"]),
      commit("hotfix-one", ["base-three"]),
      commit("base-three", ["base-two"]),
      commit("base-two", ["base-one"]),
      commit("base-one"),
    ];
    const graph = layoutGitGraph(commits);

    expect(graph.laneCount).toBe(4);
    expect(graph.rows.map((row) => row.colour)).toEqual([0, 0, 0, 0, 0, 2, 2, 2, 3, 3, 1, 1, 0, 2, 2]);
    for (let index = 1; index < graph.rows.length; index += 1) {
      const row = graph.rows[index];
      expect(row.edges).toContainEqual({
        from: row.lane,
        to: row.lane,
        fromY: 0,
        toY: 20,
        colourLane: row.colour,
      });
    }
    const hotfixJoin = graph.rows[11].edges.find((edge) => edge.fromY === 20);
    expect(hotfixJoin).toMatchObject({ from: 2, to: 0, colourLane: 1 });
  });
});
