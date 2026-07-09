import { describe, expect, it } from "vitest";
import { assistantErrorBody, assistantErrorStatusCode, formatThinkingText, isRetryableAssistantError, messageText, normalizeAssistantError, textFromRawContent, thinkingFromRawContent, thinkingTextSegments } from "../src/messages/content.js";

describe("message content helpers", () => {
  it("keeps thinking out of text bubbles and extracts it for thinking cards", () => {
    const content = [
      { type: "thinking", thinking: "  consider the options  " },
      { type: "text", text: "Final answer" },
      { type: "thinking", text: "alternative thinking" },
      { type: "toolCall", toolName: "read" },
    ];

    expect(textFromRawContent(content)).toBe("Final answer");
    expect(thinkingFromRawContent(content)).toEqual(["consider the options", "alternative thinking"]);
  });

  it("formats model-specific standalone bold thinking headings without touching other asterisks", () => {
    const text = "**Planning next step**\n\nKeep *literal* inline emphasis and 2 * 3.";
    expect(formatThinkingText(text)).toBe("Planning next step\n\nKeep *literal* inline emphasis and 2 * 3.");
    expect(thinkingTextSegments(text)[0]).toEqual({ type: "heading", text: "Planning next step" });
    expect(formatThinkingText("- **bullet stays markdown-ish**\nnot **a heading** inline"))
      .toBe("- **bullet stays markdown-ish**\nnot **a heading** inline");
  });

  it("shows friendly stop-reason text for truncated assistant messages", () => {
    expect(messageText({ role: "assistant", raw: { content: "Partial", stopReason: "length" } })).toBe(
      "Partial\n\nResponse stopped because the model hit its output length limit.",
    );
  });

  it("prefers assistant errors over stop-reason text", () => {
    expect(messageText({ role: "assistant", raw: { content: "Partial", stopReason: "length", errorMessage: "Provider exploded" } })).toBe(
      "Provider exploded",
    );
  });

  it("normalizes retryable provider errors without serialized transport dumps", () => {
    const raw = "Throttling error: 429: {\"_events\":{\"close\":[null,null]},\"_readableState\":{\"highWaterMark\":65536}}";
    expect(normalizeAssistantError(raw)).toBe("Throttling error (429)");
    expect(assistantErrorBody(raw)).toBe("Throttling error (429)");
    expect(messageText({ role: "assistant", raw: { stopReason: "error", errorMessage: raw } })).toBe("Throttling error (429)");
  });

  it("normalizes overloaded and unavailable retry errors", () => {
    expect(normalizeAssistantError("Service unavailable: 503: {\"socket\":true}")).toBe("Service unavailable (503)");
    expect(normalizeAssistantError("529 overloaded_error: Overloaded")).toBe("Overloaded (529)");
  });

  it("detects retryable assistant HTTP errors", () => {
    expect(assistantErrorStatusCode("Service unavailable: 503: {\"socket\":true}")).toBe("503");
    expect(isRetryableAssistantError("Throttling error: 429: {}")).toBe(true);
    expect(isRetryableAssistantError("usage_limit_reached")).toBe(false);
  });
});
