import { afterEach, describe, expect, it, vi } from "vitest";
import { artifactPreviewViewportGeometry, configureArtifactPreviews, renderArtifactPreview, setArtifactPreviews, matchingArtifactPreview, mountArtifactPreview, validArtifactReviewPayload } from "../src/extensions/artifactPreviews.js";

afterEach(() => vi.unstubAllGlobals());

describe("artifact preview browser bridge", () => {
  it("accepts bounded canonical assets while keeping paths out of public metadata", async () => {
    const sha256 = "a".repeat(64);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, html: "<!doctype html><p>viewer</p>", assets: [{ id: "audio", path: "/api/session-artifacts/s1/take.mp3", mediaType: "audio/mpeg", bytes: 12, sha256 }] }), { status: 200, headers: { "content-type": "application/json" } })));
    configureArtifactPreviews({ headers: () => ({ authorization: "Bearer private" }), getSessionId: () => "s1" });
    const result = await renderArtifactPreview({ key: "music.viewer" }, { name: "song.score", path: "/api/artifacts/song.score", kind: "file" });
    expect(result.assets).toEqual([{ id: "audio", path: "/api/session-artifacts/s1/take.mp3", mediaType: "audio/mpeg", bytes: 12, sha256 }]);
    expect(fetch).toHaveBeenCalledWith("/api/web-contributions/invoke", expect.objectContaining({ method: "POST" }));
  });

  it("fails closed on malformed asset metadata without affecting the legacy HTML result", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, html: "<h1>legacy</h1>", assets: [{ id: "x", path: "https://evil.test/a", mediaType: "text/html", bytes: 1 }] }), { status: 200 })));
    configureArtifactPreviews({ headers: () => ({}), getSessionId: () => "s1" });
    const result = await renderArtifactPreview({ key: "legacy.viewer" }, { name: "x.bin", path: "/x", kind: "file" });
    expect(result.html).toBe("<h1>legacy</h1>");
    expect(result.assets).toEqual([]);
  });

  it("does not mount an async render after its renderer was removed", async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((done) => { resolve = done; })));
    configureArtifactPreviews({ headers: () => ({}), getSessionId: () => "s1" });
    setArtifactPreviews([{ key: "slow.viewer", match: { extensions: [".slow"] } }]);
    const host = { replaceChildren: vi.fn() } as unknown as HTMLElement;
    const pending = mountArtifactPreview(host, { name: "x.slow", path: "/x", kind: "file" }, { title: "Slow" });
    setArtifactPreviews([]);
    resolve(new Response(JSON.stringify({ ok: true, html: "<!doctype html><p>stale</p>" }), { status: 200 }));
    await expect(pending).resolves.toBe(true);
    expect(host.replaceChildren).not.toHaveBeenCalled();
  });

  it("bounds review payloads by UTF-8 bytes and structural depth", () => {
    expect(validArtifactReviewPayload({ comment: "界".repeat(10_000) })).toBe(true);
    expect(validArtifactReviewPayload({ comment: "界".repeat(11_000) })).toBe(false);
    let deep: unknown = true;
    for (let index = 0; index < 10; index++) deep = { child: deep };
    expect(validArtifactReviewPayload(deep)).toBe(false);
  });

  it("converts clipped, bordered, and scaled host intersections to iframe-local coordinates", () => {
    expect(artifactPreviewViewportGeometry({
      frameRect: { left: 100, top: 50, width: 204, height: 104 },
      intersectionRect: { left: 102, top: 52, right: 302, bottom: 120 },
      clientWidth: 200, clientHeight: 100, clientLeft: 2, clientTop: 2, offsetWidth: 204, offsetHeight: 104,
    })).toEqual({ width: 200, height: 100, visible: { left: 0, top: 0, right: 200, bottom: 68 } });
    expect(artifactPreviewViewportGeometry({
      frameRect: { left: 100, top: 50, width: 204, height: 104 },
      intersectionRect: { left: 102, top: 52, right: 302, bottom: 152 },
      occlusionRects: [
        { left: 180, top: 120, right: 260, bottom: 155, width: 80, height: 35 },
        { left: 400, top: 80, right: 450, bottom: 140, width: 50, height: 60 },
      ],
      clientWidth: 200, clientHeight: 100, clientLeft: 2, clientTop: 2, offsetWidth: 204, offsetHeight: 104,
    })).toEqual({ width: 200, height: 100, visible: { left: 0, top: 0, right: 200, bottom: 68 } });
    expect(artifactPreviewViewportGeometry({
      frameRect: { left: 100, top: 50, width: 408, height: 208 },
      intersectionRect: { left: 204, top: 74, right: 504, bottom: 200 },
      clientWidth: 200, clientHeight: 100, clientLeft: 2, clientTop: 2, offsetWidth: 204, offsetHeight: 104,
    })).toEqual({ width: 200, height: 100, visible: { left: 50, top: 10, right: 200, bottom: 73 } });
    expect(artifactPreviewViewportGeometry({
      frameRect: { left: 0, top: 0, width: 0, height: 0 }, clientWidth: 0, clientHeight: 0, clientLeft: 0, clientTop: 0, offsetWidth: 0, offsetHeight: 0,
    })).toEqual({ width: 0, height: 0, visible: { left: 0, top: 0, right: 0, bottom: 0 } });
  });

  it("retains deterministic generic matching and replacement identity", () => {
    const descriptor = { key: "gcode.viewer", match: { kinds: ["file"], extensions: [".gcode"] } };
    setArtifactPreviews([descriptor]);
    expect(matchingArtifactPreview("PART.GCODE", "file")).toBe(descriptor);
    expect(matchingArtifactPreview("PART.GCODE", "html")).toBeUndefined();
  });
});
