import { describe, expect, it } from "vitest";
import type { ComposerContextAttachment } from "../src/app/types.js";
import { reviewedContextAddition, sameComposerReviewSnapshot } from "../src/composer/composer.js";

const github: ComposerContextAttachment = {
  type: "reference", id: "source:1", label: "Issue",
  reference: { provider: "github", repository: "owner/repo", resource: "issue", number: 1, url: "https://github.com/owner/repo/issues/1" },
};
const artifact: ComposerContextAttachment = {
  type: "reference", id: "artifact:2", label: "Artifact",
  reference: { provider: "artifact", path: "source.txt", sha256: "a".repeat(64) },
};

describe("reviewed composer context staging", () => {
  it("preserves unrelated contexts and permits only identical deduplication", () => {
    expect(reviewedContextAddition([github], artifact)).toEqual([github, artifact]);
    expect(reviewedContextAddition([artifact], { ...artifact })).toBeDefined();
    expect(reviewedContextAddition([github], { ...artifact, id: github.id })).toBeUndefined();
  });

  it("treats context changes during review as stale", () => {
    const snapshot = { sessionId: "s1", revision: 3, selectionStart: 0, selectionEnd: 0, contextRevision: 4 };
    expect(sameComposerReviewSnapshot(snapshot, { ...snapshot })).toBe(true);
    expect(sameComposerReviewSnapshot(snapshot, { ...snapshot, contextRevision: 5 })).toBe(false);
  });
});
