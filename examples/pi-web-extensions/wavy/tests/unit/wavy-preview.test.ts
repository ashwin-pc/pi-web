import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { normalizationStableScript, renderWavyPreview, renderWavyView, wavyPreviewTest } from "../../preview.js";
import type { LoadedProject } from "../../types.js";

const ref = (path: string) => ({ path, sha256: "a".repeat(64), bytes: 12 });
function project(overrides: Partial<LoadedProject> = {}): LoadedProject {
  return {
    absolutePath: "/tmp/demo/demo.wavy", artifactPath: "/api/artifacts/demo/demo.wavy", warnings: [],
    head: { lyrics: "[Verse]\nHéllo 世界 🎵 <script>alert(1)</script>", style: "Warm & close", score: "X:1\nT:Safe\nM:4/4\nL:1/4\nQ:1/4=120\nK:C\nC D E F|", settings: { precision: "bf16", planning: "full", maxSemanticTokens: 9000 } },
    index: { format: "wavy", version: 1, title: "Café 世界 </script><img src=x>", createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-02T00:00:00Z", revision: 2,
      revisions: [{ id: 2, createdAt: "2025-01-02T00:00:00Z", summary: "Actual summary", origin: "agent", files: { lyrics: ref("lyrics.md"), style: ref("style.md"), settings: ref("settings.json"), score: ref("score.abc") } }],
      sources: [], takes: [{ id: "take-1", revision: 1, createdAt: "2025-01-01T00:00:00Z", status: "complete", seed: 42, precision: "bf16", request: ref("takes/request.json"), audio: ref("takes/song #1.wav"), truncated: true }] },
    ...overrides,
  };
}

describe("Wavy artifact preview", () => {
  it("escapes trusted ABCjs control sentinels before exact host normalization", async () => {
    const source = await readFile(new URL("../../vendor/abcjs-basic-min.js", import.meta.url), "utf8");
    expect(source).toMatch(/[\u0003\u0012]/);
    const stable = normalizationStableScript(source);
    const hostNormalized = stable.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trimEnd();
    expect(stable).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/);
    expect(hostNormalized).toBe(stable);
    expect(stable).toContain('"\\x12"');
    expect(stable).toContain('"\\x03"');
  });

  it("renders bounded self-contained HTML without interpolating untrusted content", async () => {
    const html = await renderWavyPreview(project());
    expect(html).toMatch(/^<!doctype html>/);
    expect(Buffer.byteLength(html)).toBeLessThan(wavyPreviewTest.MAX_HTML);
    expect(html).not.toContain("</script><img");
    expect(html).not.toContain("Héllo 世界");
    expect(html).toContain("abcjs_basic v6.4.4");
    expect(html).toContain("Optional oscillator audition");
    expect(html).not.toContain("piWebPreview");
    expect(html).not.toContain('id="recording"');
    expect(html).toContain('aria-label="Copy comment draft"');
  });

  it("returns HTML only and keeps recording metadata credential-free", async () => {
    const html = await renderWavyView(project());
    const encoded = html.match(/data-wavy="([A-Za-z0-9+/=]+)"/)![1];
    const data = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    expect(data.takes[0].audio.url).toBe("/api/artifacts/demo/takes/song%20%231.wav");
    expect(data.takes[0].audio).not.toHaveProperty("assetId");
    expect(html).not.toMatch(/authorization|bearer token/i);
  });

  it("enforces the preview response size cap", async () => {
    const huge = project(); huge.head.lyrics = "é".repeat(400_000);
    await expect(renderWavyPreview(huge)).rejects.toThrow("exceeds the 1 MB");
  });

  it("supports incomplete drafts and rejects escaping native paths", async () => {
    const draft = project({ head: { lyrics: "Only words", style: "", settings: { precision: "4bit", planning: "off", maxSemanticTokens: 250 } }, index: { ...project().index, revisions: [], takes: [], sources: [] } });
    await expect(renderWavyPreview(draft)).resolves.toContain("No score exists yet");
    const bad = project(); bad.index.takes[0].audio = ref("../secret.wav");
    await expect(renderWavyPreview(bad)).rejects.toThrow("Unsafe Wavy file path");
  });
});
