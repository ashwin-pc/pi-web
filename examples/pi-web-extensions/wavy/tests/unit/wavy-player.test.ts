import { describe, expect, it } from "vitest";
import { beginSelectionBoundaryMove, buildTimeline, chooseOccurrence, moveSelectionBoundary, normalizeRanges, selectTimelineRange, validateReviewRequest } from "../../player-model.js";

describe("Wavy canonical player model", () => {
  const notes = buildTimeline([
    { track: 0, voiceId: "voice-1", start: 0, duration: .25, pitch: 60, startChar: 20, endChar: 22 },
    { track: 1, voiceId: "voice-2", start: 0, duration: .5, pitch: 48, startChar: 80, endChar: 82 },
    { track: 0, voiceId: "voice-1", start: .25, duration: .25, pitch: 62, startChar: 23, endChar: 25 },
    { track: 0, voiceId: "voice-1", start: .5, duration: .25, pitch: 60, startChar: 20, endChar: 22 },
  ], { tempo: 120, measureFor: (_track, _char, ms) => ms < 1000 ? 0 : 1 });

  it("groups chord pitches into one occurrence and counts repeats per occurrence", () => {
    const chord = buildTimeline([
      { track: 0, voiceId: "voice-1", start: 0, duration: .25, pitch: 60, startChar: 10, endChar: 15, volume: 40 },
      { track: 0, voiceId: "voice-1", start: 0, duration: .25, pitch: 64, startChar: 10, endChar: 15, volume: 90 },
      { track: 0, voiceId: "voice-1", start: 1, duration: .25, pitch: 60, startChar: 10, endChar: 15, volume: 40 },
      { track: 0, voiceId: "voice-1", start: 1, duration: .25, pitch: 64, startChar: 10, endChar: 15, volume: 90 },
    ], { tempo: 120 });
    expect(chord).toHaveLength(2);
    expect(chord.map(note => note.pitches)).toEqual([[60, 64], [60, 64]]);
    expect(chord.map(note => note.repeatPass)).toEqual([1, 2]);
    expect(chord[0].velocity).toBeCloseTo(90 / 127);
  });

  it("retains generated accompaniment without fabricating editable source ranges", () => {
    const accompaniment = buildTimeline([
      { track: 2, start: 0, duration: .25, pitch: 48 },
      { track: 2, start: 0, duration: .25, pitch: 55 },
    ], { tempo: 120 });
    expect(accompaniment).toHaveLength(1);
    expect(accompaniment[0]).toMatchObject({ pitches: [48, 55], sourceRanges: [], start: -1, end: -1 });
  });

  it("retains voices and unfolded repeat occurrences", () => {
    expect(notes.map(note => [note.voiceId, note.startMs, note.repeatPass])).toEqual([
      ["voice-1", 0, 1], ["voice-2", 0, 1], ["voice-1", 500, 1], ["voice-1", 1000, 2],
    ]);
    expect(chooseOccurrence(notes, 20, 22, 600)?.repeatPass).toBe(2);
    expect(chooseOccurrence(notes, 20, 22, 2000)?.repeatPass).toBe(1);
  });

  it("creates disjoint per-voice ranges instead of a broad min/max span", () => {
    const selection = selectTimelineRange(notes, notes[0].id, notes[2].id)!;
    expect(selection.ranges).toEqual([
      { start: 20, end: 22, voiceId: "voice-1" },
      { start: 23, end: 25, voiceId: "voice-1" },
    ]);
    expect(selection.playback.occurrenceIds).toHaveLength(3);
    expect(selection.label).toContain("Voice 1");
  });

  it("derives passage labels and edit ranges from the anchor voice while auditioning accompaniment", () => {
    const chorus = buildTimeline([
      { track: 0, voiceId: "voice-1", voiceLabel: "Vocal", start: 0, duration: .5, pitch: 60, startChar: 10, endChar: 12 },
      { track: 0, voiceId: "voice-1", voiceLabel: "Vocal", start: .5, duration: .5, pitch: 62, startChar: 13, endChar: 15 },
      { track: 1, voiceId: "voice-2", voiceLabel: "Ins", start: 0, duration: 1, pitch: 48, startChar: 80, endChar: 82 },
    ], { tempo: 120, measureFor: (_track, start) => start >= 80 ? 19 : 4, voiceLabelFor: track => track === 0 ? "Vocal" : "Ins" });
    const selection = selectTimelineRange(chorus, chorus[0].id, chorus.find(note => note.voiceId === "voice-1" && note.startMs > 0)!.id)!;
    expect(selection.label).toBe("Bar 5 · Vocal");
    expect(selection.ranges.every(range => range.voiceId === "voice-1")).toBe(true);
    expect(selection.playback.occurrenceIds).toHaveLength(3);
  });

  it("keeps explicit editable-voice endpoints when accompaniment is last in playback order", () => {
    const passage = buildTimeline([
      { track: 0, voiceId: "voice-1", voiceLabel: "Lead", start: 0, duration: .25, pitch: 60, startChar: 10, endChar: 11 },
      { track: 1, voiceId: "voice-2", voiceLabel: "Bass", start: 0, duration: 1, pitch: 48, startChar: 70, endChar: 72 },
      { track: 0, voiceId: "voice-1", voiceLabel: "Lead", start: .25, duration: .25, pitch: 62, startChar: 12, endChar: 13 },
      { track: 0, voiceId: "voice-1", voiceLabel: "Lead", start: .5, duration: .25, pitch: 64, startChar: 14, endChar: 15 },
    ], { tempo: 120 });
    const original = selectTimelineRange(passage, passage[0].id, passage[3].id)!;
    expect(original.playback.occurrenceIds.at(-1)).toBe(passage[3].id);
    expect(original.playback.occurrenceIds).toContain(passage[1].id);
    const gesture = beginSelectionBoundaryMove(original, "start");
    const adjusted = moveSelectionBoundary(passage, gesture, passage[2].id)!;
    expect(adjusted.sourceVoiceId).toBe("voice-1");
    expect(adjusted.label).toContain("Lead");
    expect(adjusted.endpoints).toEqual({ startOccurrenceId: passage[2].id, endOccurrenceId: passage[3].id });
    expect(adjusted.ranges.every(range => range.voiceId === "voice-1")).toBe(true);
    expect(moveSelectionBoundary(passage, gesture, passage[1].id)).toBeUndefined();
  });

  it("keeps the original opposite endpoint through sequential crossing and reversal moves", () => {
    const line = buildTimeline([0, 1, 2, 3, 4].map(index => ({
      track: 0, voiceId: "voice-1", voiceLabel: "Lead", start: index * .25, duration: .25,
      pitch: 60 + index, startChar: 10 + index * 2, endChar: 11 + index * 2,
    })), { tempo: 120 });
    const original = selectTimelineRange(line, line[0].id, line[2].id)!;
    const startGesture = beginSelectionBoundaryMove(original, "start");
    const crossed = moveSelectionBoundary(line, startGesture, line[3].id)!;
    expect(crossed.endpoints).toEqual({ startOccurrenceId: line[2].id, endOccurrenceId: line[3].id });
    const farther = moveSelectionBoundary(line, startGesture, line[4].id)!;
    expect(farther.endpoints).toEqual({ startOccurrenceId: line[2].id, endOccurrenceId: line[4].id });
    const reversed = moveSelectionBoundary(line, startGesture, line[1].id)!;
    expect(reversed.endpoints).toEqual({ startOccurrenceId: line[1].id, endOccurrenceId: line[2].id });
    expect(reversed.sourceVoiceId).toBe("voice-1");

    const endGesture = beginSelectionBoundaryMove(original, "end");
    const crossedBack = moveSelectionBoundary(line, endGesture, line[0].id)!;
    expect(crossedBack.endpoints).toEqual({ startOccurrenceId: line[0].id, endOccurrenceId: line[0].id });
    const reversedForward = moveSelectionBoundary(line, endGesture, line[3].id)!;
    expect(reversedForward.endpoints).toEqual({ startOccurrenceId: line[0].id, endOccurrenceId: line[3].id });
  });

  it("keeps repeat-pass endpoint and occurrence membership distinct from shared source ranges", () => {
    const repeated = buildTimeline([
      { track: 0, voiceId: "voice-1", start: 0, duration: .25, pitch: 60, startChar: 10, endChar: 11 },
      { track: 0, voiceId: "voice-1", start: 1, duration: .25, pitch: 60, startChar: 10, endChar: 11 },
    ], { tempo: 120 });
    const first = selectTimelineRange(repeated, repeated[0].id, repeated[0].id)!;
    expect(first.endpoints).toEqual({ startOccurrenceId: repeated[0].id, endOccurrenceId: repeated[0].id });
    expect(first.playback.occurrenceIds).toEqual([repeated[0].id]);
    expect(first.playback.repeatPasses).toEqual([1]);
    const second = selectTimelineRange(repeated, repeated[1].id, repeated[1].id)!;
    expect(second.playback.occurrenceIds).toEqual([repeated[1].id]);
    expect(second.playback.repeatPasses).toEqual([2]);
  });

  it("merges only overlapping or adjacent ranges in the same voice", () => {
    expect(normalizeRanges([
      { start: 3, end: 5, voiceId: "a" }, { start: 5, end: 7, voiceId: "a" },
      { start: 4, end: 8, voiceId: "b" }, { start: 10, end: 11, voiceId: "a" },
    ])).toEqual([
      { start: 3, end: 7, voiceId: "a" }, { start: 10, end: 11, voiceId: "a" }, { start: 4, end: 8, voiceId: "b" },
    ]);
  });

  it("validates UTF-16 bounds, hash, comment and the 32-range bridge limit", () => {
    const selection = selectTimelineRange(notes, notes[0].id, notes[0].id)!;
    expect(() => validateReviewRequest({ score: "x".repeat(100), compositionRevision: 2, scoreSha256: "a".repeat(64), selection, comment: "Make it softer" })).not.toThrow();
    expect(() => validateReviewRequest({ score: "short", compositionRevision: 2, scoreSha256: "a".repeat(64), selection, comment: "x" })).toThrow(/outside/);
    expect(() => validateReviewRequest({ score: "x".repeat(100), compositionRevision: 2, scoreSha256: "bad", selection, comment: "x" })).toThrow(/hash/);
    expect(() => validateReviewRequest({ score: "x".repeat(100), compositionRevision: 2, scoreSha256: "a".repeat(64), selection: { ...selection, ranges: Array.from({ length: 33 }, (_, i) => ({ start: i, end: i + 1, voiceId: "v" })) }, comment: "x" })).toThrow(/1–128|1–32/);
  });
});
