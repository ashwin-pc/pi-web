import { describe, expect, it } from "vitest";
import { assistantErrorBody, assistantErrorStatusCode, cleanThinkingText, formatThinkingText, isRetryableAssistantError, messageText, normalizeAssistantError, shouldCollapseMessage, textFromRawContent, thinkingFromRawContent, thinkingTextSegments } from "../src/messages/content.js";

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

  it("strips provider empty HTML comments from thinking display text", () => {
    const text = "**Testing UI clipping and overflow**\n\n<!-- -->\n\n**Running UI density and spacing tests**\n\n<!---->";
    expect(cleanThinkingText(text)).toBe("**Testing UI clipping and overflow**\n\n**Running UI density and spacing tests**");
    expect(formatThinkingText(text)).toBe("Testing UI clipping and overflow\n\nRunning UI density and spacing tests");
    expect(cleanThinkingText("Keep <!-- note --> inline")).toBe("Keep <!-- note --> inline");
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

describe("shouldCollapseMessage", () => {
  it("collapses long prose", () => {
    expect(shouldCollapseMessage("x".repeat(1900))).toBe(true);
    expect(shouldCollapseMessage(Array(40).fill("line").join("\n"))).toBe(true);
  });

  it("keeps short prose expanded", () => {
    expect(shouldCollapseMessage("short answer")).toBe(false);
  });

  it("ignores fenced code content, so inline previews are not clipped", () => {
    const preview = "Lead sentence.\n\n```html-preview\n" + "<div>box</div>\n".repeat(200) + "```\n\nOne closing line.";
    expect(preview.length).toBeGreaterThan(1800);
    expect(shouldCollapseMessage(preview)).toBe(false);
  });

  it("ignores tilde fences (attachment blocks) too", () => {
    const text = "See attachment.\n~~~json\n" + "{\"k\": 1}\n".repeat(120) + "~~~";
    expect(shouldCollapseMessage(text)).toBe(false);
  });

  it("still collapses when the prose around a fence is itself a wall", () => {
    const text = "p".repeat(1900) + "\n```js\ncode\n```";
    expect(shouldCollapseMessage(text)).toBe(true);
  });

  it("treats an unclosed fence as consuming the rest of the message", () => {
    const text = "intro\n```\n" + "inside\n".repeat(500);
    expect(shouldCollapseMessage(text)).toBe(false);
  });
});
