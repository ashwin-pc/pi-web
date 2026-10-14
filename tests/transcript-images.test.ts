import { describe, expect, it } from "vitest";
import type { MessageDto } from "../server/session/dto.js";
import { referenceTranscriptImages, resolveTranscriptImage } from "../server/session/transcriptImages.js";

const imageData = Buffer.from("image bytes").toString("base64");
const messages = (data = imageData, mimeType = "image/png"): MessageDto[] => [
  { role: "user", raw: { role: "user", content: [{ type: "text", text: "look" }, { type: "image", mimeType, data }], timestamp: 1 } },
  { role: "toolResult", toolCallId: "read-1", toolName: "read", isError: false, raw: { role: "toolResult", content: [{ type: "image", mimeType, data }], timestamp: 2 } },
];

function content(message: MessageDto): Array<Record<string, unknown>> {
  return (message.raw as Record<string, unknown>).content as Array<Record<string, unknown>>;
}

function imageUrl(projected: MessageDto[], index = 0): URL {
  return new URL(String(content(projected[index])[index === 0 ? 1 : 0].imageUrl), "http://localhost");
}

describe("lazy transcript image transport", () => {
  it("replaces user and tool images without mutating runtime or live events", () => {
    const original = messages();
    const projected = referenceTranscriptImages(original, "session /?&");
    expect(JSON.stringify(projected)).not.toContain(imageData);
    expect(JSON.stringify(original)).toContain(imageData);
    expect(content(projected[0])[0]).toBe(content(original[0])[0]);
    for (const index of [0, 1]) {
      const url = imageUrl(projected, index);
      expect(url.pathname).toBe("/api/messages/image");
      expect(url.searchParams.get("sessionId")).toBe("session /?&");
      expect(resolveTranscriptImage(original, url.searchParams.get("imageId")!)).toEqual({ data: Buffer.from("image bytes"), mimeType: "image/png" });
    }
  });

  it("rejects stale, cross-session, malformed, and non-raster references", () => {
    const id = imageUrl(referenceTranscriptImages(messages(), "one")).searchParams.get("imageId")!;
    expect(resolveTranscriptImage(messages(Buffer.from("different image").toString("base64")), id)).toBeUndefined();
    expect(resolveTranscriptImage([], id)).toBeUndefined();
    for (const invalid of ["", "../../file", "-1.1." + "a".repeat(64), "9999999999.0." + "a".repeat(64)]) {
      expect(resolveTranscriptImage(messages(), invalid)).toBeUndefined();
    }
    const svg = messages(imageData, "image/svg+xml");
    expect(resolveTranscriptImage(svg, imageUrl(referenceTranscriptImages(svg, "one")).searchParams.get("imageId")!)).toBeUndefined();
  });

  it("preserves text, tool calls and non-image blocks", () => {
    const original: MessageDto[] = [{ role: "assistant", isError: false, raw: { role: "assistant", content: [{ type: "text", text: "done" }, { type: "toolCall", id: "read-1", name: "read", arguments: { path: "file" } }], timestamp: 1 } }];
    expect(referenceTranscriptImages(original, "one")).toEqual(original);
    expect(referenceTranscriptImages(original, "one")[0]).toBe(original[0]);
  });

  it("records reproducible payload reduction for large user/tool images", () => {
    const original = messages(Buffer.alloc(1024 * 1024, 42).toString("base64"));
    const inlineBytes = Buffer.byteLength(JSON.stringify({ ok: true, messages: original }));
    const referencedBytes = Buffer.byteLength(JSON.stringify({ ok: true, messages: referenceTranscriptImages(original, "session-1") }));
    expect(referencedBytes).toBeLessThan(1024);
    expect(inlineBytes).toBeGreaterThan(2_700_000);
    console.log(`Transcript image payload: inline=${inlineBytes} bytes; referenced=${referencedBytes} bytes`);
  });
});
