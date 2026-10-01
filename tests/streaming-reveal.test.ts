import { describe, expect, it } from "vitest";
import { streamingRevealDurationMs, updateStreamingReveal } from "../src/markdown/streamingReveal.js";

describe("streaming text reveal ranges", () => {
  it("reveals the first prefix and preserves fade start times as more words arrive", () => {
    const first = updateStreamingReveal({ text: "", ranges: [] }, "Hello", 0);
    expect(first.ranges).toEqual([{ start: 0, end: 5, startedAt: 0 }]);
    const next = updateStreamingReveal(first, "Hello world", 75);
    expect(next.ranges).toEqual([
      { start: 0, end: 5, startedAt: 0 },
      { start: 5, end: 11, startedAt: 75 },
    ]);
    expect(updateStreamingReveal(next, next.text, 150).ranges).toEqual(next.ranges);
  });

  it("drops expired fades rather than replaying old words", () => {
    const first = updateStreamingReveal({ text: "", ranges: [] }, "Hello", 0);
    expect(updateStreamingReveal(first, "Hello world", streamingRevealDurationMs + 1).ranges).toEqual([
      { start: 5, end: 11, startedAt: streamingRevealDurationMs + 1 },
    ]);
    expect(updateStreamingReveal(first, "Hello", streamingRevealDurationMs)).toEqual({ text: "Hello", ranges: [] });
  });

  it("does not replay settled bold text when delimiters close alongside a new word", () => {
    const previous = { text: "Hello **bold", ranges: [] };
    const next = updateStreamingReveal(previous, "Hello bold world", 500);
    expect(next.ranges).toEqual([{ start: 10, end: 16, startedAt: 500 }]);
  });

  it("moves in-progress fades with displayed text when Markdown removes delimiters", () => {
    const first = updateStreamingReveal({ text: "", ranges: [] }, "Hello **bold", 0);
    expect(updateStreamingReveal(first, "Hello bold world", 75).ranges).toEqual([
      { start: 0, end: 10, startedAt: 0 },
      { start: 10, end: 16, startedAt: 75 },
    ]);
  });

  it("does not animate a formatting-only reparse or a late reference definition", () => {
    expect(updateStreamingReveal({ text: "**bold", ranges: [] }, "bold", 0).ranges).toEqual([]);
    expect(updateStreamingReveal({ text: "Read [guide][ref] for help.", ranges: [] }, "Read guide for help.", 0).ranges).toEqual([]);
  });

  it("keeps old table cell contents settled when markup changes whitespace", () => {
    const next = updateStreamingReveal({ text: "| Mode | Value |\n| Plain | correct |", ranges: [] }, "\nMode\nValue\nPlain\ncorrect\n", 100);
    const revealed = next.ranges.map(range => next.text.slice(range.start, range.end)).join("");
    expect(revealed.trim()).toBe("");
  });

  it("bounds large reparses without replaying ambiguous old text", () => {
    const old = "a".repeat(1000);
    const next = updateStreamingReveal({ text: old, ranges: [] }, "b".repeat(1000), 100);
    expect(next.ranges).toEqual([]);
    // Large ordinary append-only streams still reveal normally.
    expect(updateStreamingReveal({ text: old, ranges: [] }, `${old}${"b".repeat(1000)}`, 100).ranges).toEqual([
      { start: 1000, end: 2000, startedAt: 100 },
    ]);
  });

  it("returns no ranges when content is removed", () => {
    const first = updateStreamingReveal({ text: "", ranges: [] }, "Hello world", 0);
    expect(updateStreamingReveal(first, "", 75)).toEqual({ text: "", ranges: [] });
  });
});
