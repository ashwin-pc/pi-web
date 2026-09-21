import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderWavyPreview, renderWavyView, wavyPreviewTest } from "../examples/pi-web-extensions/wavy/preview.js";
import { stagePianoAssets } from "../examples/pi-web-extensions/wavy/preview-assets.js";
import type { LoadedProject } from "../examples/pi-web-extensions/wavy/types.js";

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
  it("loads bundled piano through a globally symlinked extension with the SDK loader", async () => {
    const root = await mkdtemp(join(tmpdir(), "wavy-symlink-install-"));
    try {
      const target = fileURLToPath(new URL("../examples/pi-web-extensions/wavy", import.meta.url));
      const installed = join(root, "wavy");
      await symlink(target, installed, process.platform === "win32" ? "junction" : "dir");
      const sdkRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
      const { createJiti } = sdkRequire("jiti");
      const loaded = await createJiti(import.meta.url, { moduleCache: false }).import(join(installed, "preview-assets.ts"));
      expect(await loaded.stagePianoAssets(root)).toHaveLength(15);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("renders a complete bounded sandbox document without interpolating untrusted content", async () => {
    const html = await renderWavyPreview(project());
    expect(html).toMatch(/^<!doctype html>/);
    expect(Buffer.byteLength(html)).toBeLessThan(wavyPreviewTest.MAX_HTML);
    expect(html).not.toContain("</script><img");
    expect(html).not.toContain("Héllo 世界");
    expect(html).toContain("abcjs_basic v6.4.4");
    expect(html).toContain("Written-note piano only");
    expect(html).toContain("--pi-web-bg");
    expect(html).not.toContain("class=\"card\"");
    expect(html).not.toContain(".card{");
    expect(html.indexOf('id="takeSelect"')).toBeLessThan(html.indexOf('id="recording"'));
    expect(html).toContain('id="loadRecording"');
    expect(html).toContain('<details class="section take-history"><summary>Take history</summary>');
  });

  it("declares recordings as bridge assets while retaining credential-free host fallbacks", async () => {
    const view = await renderWavyView(project());
    const html = view.html;
    const encoded = html.match(/data-wavy="([A-Za-z0-9+/=]+)"/)![1];
    const data = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    expect(data.title).toBe("Café 世界 </script><img src=x>");
    expect(data.artifactPath).toBe("/api/artifacts/demo/demo.wavy");
    expect(data.scoreSha256).toBe("a".repeat(64));
    expect(data.lyrics).toContain("Héllo 世界 🎵");
    expect(data.takes[0].audio.url).toBe("/api/artifacts/demo/takes/song%20%231.wav");
    expect(data.takes[0].audio.url).not.toMatch(/token|authorization|cookie/i);
    expect(data.takes[0].audio.assetId).toBe("recording-0");
    expect(view.assets).toEqual([expect.objectContaining({ id: "recording-0", path: "/api/artifacts/demo/takes/song%20%231.wav", mediaType: "audio/wav", bytes: 12, sha256: "a".repeat(64) })]);
    expect(data.takes[0]).toMatchObject({ seed: 42, status: "complete", truncated: true, revision: 1 });
  });

  it("stages content-addressed piano assets only for an explicit project cwd", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wavy-preview-"));
    try {
      const view = await renderWavyView(project(), { cwd });
      const piano = view.assets.filter(asset => asset.id.startsWith("piano-"));
      expect(piano).toHaveLength(15);
      expect(piano.every(asset => /^[A-Za-z0-9._-]+$/.test(asset.id))).toBe(true);
      expect(piano.every(asset => asset.path.startsWith("wavy-preview-cache/"))).toBe(true);
      expect(piano.every(asset => asset.mediaType === "audio/mpeg" && asset.sha256?.length === 64)).toBe(true);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("repairs same-size cache corruption and tolerates concurrent staging", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wavy-cache-repair-"));
    try {
      const [first, concurrent] = await Promise.all([stagePianoAssets(cwd), stagePianoAssets(cwd)]);
      expect(concurrent).toEqual(first);
      const asset = first[0];
      const path = join(cwd, ".pi", "web", "artifacts", asset.path);
      await writeFile(path, Buffer.alloc(asset.bytes!, 0x5a));
      const repaired = await stagePianoAssets(cwd);
      expect(repaired).toEqual(first);
      expect(createHash("sha256").update(await readFile(path)).digest("hex")).toBe(asset.sha256);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it.runIf(process.platform !== "win32")("rejects symlinked artifact ancestors without writing outside", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wavy-cache-ancestor-"));
    const outside = await mkdtemp(join(tmpdir(), "wavy-cache-outside-"));
    try {
      await symlink(outside, join(cwd, ".pi"));
      await expect(stagePianoAssets(cwd)).rejects.toThrow(/real directory/);
      await expect(readFile(join(outside, "web", "artifacts", "sentinel"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await Promise.all([rm(cwd, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]); }
  });

  it.runIf(process.platform !== "win32")("rejects symlinked cache directories and cache leaves", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wavy-cache-links-"));
    const outside = await mkdtemp(join(tmpdir(), "wavy-cache-outside-"));
    try {
      const artifacts = join(cwd, ".pi", "web", "artifacts");
      await mkdir(artifacts, { recursive: true });
      await symlink(outside, join(artifacts, "wavy-preview-cache"));
      await expect(stagePianoAssets(cwd)).rejects.toThrow(/real directory/);
      expect(await readFile(join(outside, "untouched.txt")).catch(() => null)).toBeNull();
      await rm(join(artifacts, "wavy-preview-cache"));
      const staged = await stagePianoAssets(cwd);
      const leaf = join(artifacts, staged[0].path);
      await rm(leaf);
      const sentinel = join(outside, "sentinel.mp3");
      await writeFile(sentinel, Buffer.alloc(staged[0].bytes!, 0x31));
      await symlink(sentinel, leaf);
      await expect(stagePianoAssets(cwd)).rejects.toThrow(/regular files, not links/);
      expect((await readFile(sentinel)).every(byte => byte === 0x31)).toBe(true);
    } finally { await Promise.all([rm(cwd, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]); }
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
