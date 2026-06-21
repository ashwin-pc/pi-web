import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { collectToolImages } from "../src/tools/toolCards.js";

describe("tool card image previews", () => {
  it("extracts image data from read tool style raw content", () => {
    const images = collectToolImages({
      role: "toolResult",
      toolName: "read",
      raw: {
        content: [
          { type: "text", text: "Read image file [image/png]" },
          { type: "image", mimeType: "image/png", data: "abc123", name: "screenshot.png" },
        ],
      },
    });

    expect(images).toEqual([{ src: "data:image/png;base64,abc123", alt: "screenshot.png" }]);
  });

  it("extracts Bedrock-style image source data", () => {
    const images = collectToolImages({
      content: [{ type: "image", source: { media_type: "image/jpeg", data: "jpegdata" } }],
    });

    expect(images).toEqual([{ src: "data:image/jpeg;base64,jpegdata", alt: "tool result image" }]);
  });
});

describe("tool card structured arguments styling", () => {
  const css = readFileSync(new URL("../src/styles/toolCards.css", import.meta.url), "utf8");

  it("defines key/value rows and highlighted code blocks", () => {
    expect(css).toContain(".toolCardArgRow");
    expect(css).toContain(".toolCardArgKey");
    expect(css).toContain(".toolCardArgCode code");
  });

  it("defines image preview styles", () => {
    expect(css).toContain(".toolCardImage");
    expect(css).toContain("max-height: 420px");
  });
});
