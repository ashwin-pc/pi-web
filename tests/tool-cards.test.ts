import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { collectToolImages, textFromToolResult } from "../src/tools/toolCards.js";

describe("tool card result text", () => {
  it("renders simplified API tool result text instead of JSON stringifying the whole message", () => {
    expect(textFromToolResult({
      entryId: "entry-1",
      role: "toolResult",
      toolName: "read",
      text: "line 1\nline 2",
      raw: { content: [{ type: "text", text: "raw line" }] },
    })).toBe("line 1\nline 2");
  });

  it("falls back to raw content text for tool results without precomputed text", () => {
    expect(textFromToolResult({
      role: "toolResult",
      toolName: "bash",
      raw: { content: [{ type: "text", text: "command output" }] },
    })).toBe("command output");
  });

  it("keeps bash execution output readable with status metadata", () => {
    expect(textFromToolResult({ output: "failed\n", exitCode: 2 })).toBe("failed\n\nCommand exited with code 2");
  });
});

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

  it("preserves nested artifact paths in image results", () => {
    expect(collectToolImages({ content: [{ type: "image", path: "/project/.pi/web/artifacts/image-edits/run-1/output.png" }] }))
      .toEqual([{ src: "/api/artifacts/image-edits/run-1/output.png", alt: "tool result image", needsAuth: true }]);
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

  it("styles formatted thinking headings without using markdown markers", () => {
    expect(css).toContain(".toolCardThinkingHeading {");
    expect(css).toContain("font-weight: 800;");
  });

  it("keeps tool result monospace output from wrapping on narrow screens", () => {
    expect(css).toContain(".toolCard:not(.toolCard--thinking) .toolCardBody {");
    expect(css).toContain("overflow-x: auto;");
    expect(css).toContain("-webkit-overflow-scrolling: touch;");
    expect(css).toContain("white-space: pre;");
    expect(css).toContain(".toolCard:not(.toolCard--thinking) .toolCardBody code.hljs {");
  });

  it("defines image preview styles", () => {
    expect(css).toContain(".toolCardImage");
    expect(css).toContain("max-height: 420px");
  });
});
