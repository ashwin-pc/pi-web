import { describe, expect, it } from "vitest";
import { normalizeErrorPresentation } from "../src/errors/errorPresentation.js";
import { errorRowPresentation } from "../src/tools/toolCards.js";

describe("normalizeErrorPresentation", () => {
  it("prefers structured details errors while preserving the original result", () => {
    const result = { ok: false, details: { error: { type: "QuotaError", code: 429, message: "quota exhausted", suggestion: "Try another account", technical: { requestId: "r1" } } }, content: [{ type: "text", text: "raw" }] };
    const presentation = normalizeErrorPresentation(result);
    expect(presentation).toMatchObject({ message: "quota exhausted", type: "QuotaError", code: "429", suggestion: "Try another account", original: result });
    expect(presentation.technicalDetails).toContain('"requestId"');
    expect(presentation.technicalDetails).toContain('"content"');
  });

  it("maps structured message and suggestion to row title and subtitle", () => {
    expect(errorRowPresentation({ details: { error: { type: "RuntimeError", message: "Could not read file", suggestion: "Check permissions" } } })).toMatchObject({
      title: "Could not read file",
      subtitle: "Check permissions",
    });
    expect(errorRowPresentation("RuntimeError: failed")).toMatchObject({ title: "failed", subtitle: "RuntimeError" });
  });

  it("handles live results and persisted tool-result wrappers", () => {
    expect(normalizeErrorPresentation({ ok: false, error: "permission denied" })).toMatchObject({ message: "permission denied" });
    const history = { role: "toolResult", isError: true, content: [{ type: "text", text: "history failure" }], raw: { id: "entry-1" } };
    expect(normalizeErrorPresentation(history)).toMatchObject({ message: "history failure", original: history });
    expect(normalizeErrorPresentation(history).technicalDetails).toContain('"entry-1"');

    const rawHistory = { role: "toolResult", isError: true, raw: { content: [{ type: "text", text: "raw history failure" }] } };
    expect(normalizeErrorPresentation(rawHistory)).toMatchObject({ message: "raw history failure", original: rawHistory });
  });

  it("separates only conventional exception prefixes", () => {
    expect(normalizeErrorPresentation("TypeError: invalid input")).toMatchObject({ type: "TypeError", message: "invalid input" });
    expect(normalizeErrorPresentation("remote: invalid input")).toMatchObject({ message: "remote: invalid input" });
  });

  it("tolerates thrown errors and unknown values", () => {
    expect(normalizeErrorPresentation(new RangeError("outside range"))).toMatchObject({ type: "RangeError", message: "outside range" });
    expect(normalizeErrorPresentation(17)).toMatchObject({ message: "17", technicalDetails: "17" });
  });
});
