import { describe, expect, it } from "vitest";
import { activitySessionRefs, consecutiveActivity, liveThinkingPreview } from "../src/messages/activitySummary.js";

describe("consecutiveActivity", () => {
  it("returns every eligible run, including singletons, and respects boundaries", () => {
    const items = ["tool-a", "thinking-a", "prose", "tool-b", "notice", "tool-c", "tool-d", "error"];
    expect(consecutiveActivity(items, item => item.startsWith("tool") || item.startsWith("thinking"))).toEqual([
      ["tool-a", "thinking-a"],
      ["tool-b"],
      ["tool-c", "tool-d"],
    ]);
  });

  it("keeps eligible singletons separate around an ineligible boundary", () => {
    expect(consecutiveActivity([1, 0, 2], Boolean)).toEqual([[1], [2]]);
  });
});

describe("activitySessionRefs", () => {
  it("merges structured refs in order, de-duplicates, and caps the result", () => {
    const refs = Array.from({ length: 10 }, (_, index) => ({ sessionId: `worker-${index}`, name: `Worker ${index}` }));
    expect(activitySessionRefs([
      { refs: [refs[0], refs[1]] },
      { refs: [refs[1], ...refs.slice(2)] },
    ])).toEqual(refs.slice(0, 8));
  });

  it("does not infer references from unrelated metadata", () => {
    expect(activitySessionRefs([{ key: "sessionId=incidental" }, {}])).toEqual([]);
  });
});

describe("liveThinkingPreview", () => {
  it("normalizes streamed whitespace into a single line", () => {
    expect(liveThinkingPreview(" First\n\nthought\tthen   next ")).toBe("First thought then next");
  });
  it("bounds the live preview while retaining the newest words", () => {
    const text = `${"Earlier thought. ".repeat(100)}Newest thought.`;
    const preview = liveThinkingPreview(text);
    expect(preview).toHaveLength(320);
    expect(preview.endsWith("Newest thought.")).toBe(true);
    expect(text).toHaveLength(1715); // Previewing never replaces the full body.
  });
});
