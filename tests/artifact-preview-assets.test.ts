import { appendFile, mkdtemp, mkdir, writeFile, symlink, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { MAX_ARTIFACT_PREVIEW_ASSET_BYTES, normalizeArtifactPreviewAssets } from "../server/extensions/artifactAssets.js";

const roots: string[] = [];
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-assets-")); roots.push(cwd);
  const root = join(cwd, ".pi/web/artifacts"); await mkdir(join(root, "audio"), { recursive: true });
  await writeFile(join(root, "audio/tone.mp3"), "test audio");
  return { cwd, root, options: { cwd, sessionId: "session one" } };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("artifact preview assets", () => {
  it("canonicalizes local audio and returns verified metadata", async () => {
    const { options } = await fixture();
    const assets = await normalizeArtifactPreviewAssets([{ id: "main", path: "/api/artifacts/audio/tone.mp3", bytes: 10, mediaType: "audio/mpeg" }], options);
    expect(assets).toEqual([{ id: "main", path: "/api/session-artifacts/session%20one/audio/tone.mp3", mediaType: "audio/mpeg", bytes: 10, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    expect(await normalizeArtifactPreviewAssets(undefined, options)).toBeUndefined();
    expect(await normalizeArtifactPreviewAssets([], options)).toEqual([]);
    expect(await normalizeArtifactPreviewAssets([], { cwd: join(options.cwd, "missing"), sessionId: "session" })).toEqual([]);
  });

  it.each([
    [{ id: "x", path: "https://example.com/a.mp3" }],
    [{ id: "x", path: "../a.mp3" }],
    [{ id: "x", path: "%2e%2e/a.mp3" }],
    [{ id: "x", path: "audio%2ftone.mp3" }],
    [{ id: "x", path: "audio/tone.mp3?x=1" }],
    [{ id: "x", path: "/api/session-artifacts/other/audio/tone.mp3" }],
    [{ id: "bad id\n", path: "audio/tone.mp3" }],
    [{ id: "<script>", path: "audio/tone.mp3" }],
    [{ id: "_leading", path: "audio/tone.mp3" }],
    [{ id: "x", path: "audio/tone.txt" }],
  ])("rejects malformed or unsupported descriptor %#", async (asset) => {
    const { options } = await fixture();
    await expect(normalizeArtifactPreviewAssets([asset], options)).rejects.toThrow();
  });

  it("rejects duplicate ids and forged metadata", async () => {
    const { options } = await fixture();
    await expect(normalizeArtifactPreviewAssets([{ id: "x", path: "audio/tone.mp3" }, { id: "x", path: "audio/tone.mp3" }], options)).rejects.toThrow(/Duplicate/);
    await expect(normalizeArtifactPreviewAssets([{ id: "x", path: "audio/tone.mp3", bytes: 11 }], options)).rejects.toThrow(/bytes/);
    await expect(normalizeArtifactPreviewAssets([{ id: "x", path: "audio/tone.mp3", mediaType: "audio/wav" }], options)).rejects.toThrow(/mediaType/);
    await expect(normalizeArtifactPreviewAssets([{ id: "x", path: "audio/tone.mp3", sha256: "0".repeat(64) }], options)).rejects.toThrow(/sha256 does not match/);
  });

  it("rejects symlink escapes and oversized regular files", async () => {
    const { cwd, root, options } = await fixture();
    const outside = join(cwd, "outside.mp3"); await writeFile(outside, "outside");
    await symlink(outside, join(root, "audio/link.mp3"));
    await expect(normalizeArtifactPreviewAssets([{ id: "x", path: "audio/link.mp3" }], options)).rejects.toThrow(/escapes/);
    const large = join(root, "audio/large.wav"); await writeFile(large, ""); await truncate(large, MAX_ARTIFACT_PREVIEW_ASSET_BYTES + 1);
    await expect(normalizeArtifactPreviewAssets([{ id: "large", path: "audio/large.wav" }], options)).rejects.toThrow(/128 MiB/);
  });

  it("stops and rejects when a file grows during hashing", async () => {
    const { root, options } = await fixture();
    const growing = join(root, "audio/growing.wav");
    await writeFile(growing, Buffer.alloc(32 * 1024 * 1024));
    const timer = setInterval(() => { void appendFile(growing, Buffer.alloc(64 * 1024)); }, 1);
    try {
      await expect(normalizeArtifactPreviewAssets([{ id: "growing", path: "audio/growing.wav" }], options)).rejects.toThrow(/changed|exceeded/);
    } finally {
      clearInterval(timer);
    }
  });

  it("bounds count before filesystem work", async () => {
    const { options } = await fixture();
    await expect(normalizeArtifactPreviewAssets(Array.from({ length: 129 }, (_, i) => ({ id: String(i), path: "audio/tone.mp3" })), options)).rejects.toThrow(/at most 128/);
  });
});
