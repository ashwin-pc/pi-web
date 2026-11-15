import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { invokeArtifactBridge } from "../server/extensions/artifactBridgeInvoke.js";

describe("preview invoke dispatch", () => {
  it("falls through for ordinary contributions without touching the registry", () => {
    const bridges = { invoke: vi.fn() };
    const signal = new AbortController().signal;
    expect(invokeArtifactBridge(bridges, "owner", undefined, { slot: "panel" }, signal)).toBeUndefined();
    expect(invokeArtifactBridge(bridges, "owner", "session", { slot: "artifact-preview", key: "notes" }, signal)).toBeUndefined();
    expect(bridges.invoke).not.toHaveBeenCalled();
  });

  it("passes authenticated owner, resolved session and the HTTP signal unchanged", async () => {
    const result = { preview: "id" };
    const bridges = { invoke: vi.fn(async () => result) };
    const signal = new AbortController().signal;
    const preview = { operation: "open", selection: "selection", socket: "socket" };
    await expect(invokeArtifactBridge(bridges, "owner", "session", { slot: "artifact-preview", key: "notes", preview }, signal)).resolves.toBe(result);
    expect(bridges.invoke).toHaveBeenCalledWith("owner", "session", "notes", preview, signal);
  });

  it("rejects missing routing authority before invoking", () => {
    const bridges = { invoke: vi.fn() };
    const body = { slot: "artifact-preview", preview: { operation: "close" } };
    for (const [session, key] of [[undefined, "notes"], ["session", undefined]] as const) {
      expect(() => invokeArtifactBridge(bridges, "owner", session, { ...body, key }, new AbortController().signal)).toThrow("Invalid preview connection");
    }
    expect(bridges.invoke).not.toHaveBeenCalled();
  });

  it("constructs one registry at startup after the realtime hub, outside invoke dispatch", async () => {
    const source = await readFile(new URL("../server.ts", import.meta.url), "utf8");
    expect(source.match(/new ArtifactBridges\(/g)).toHaveLength(1);
    const startup = source.indexOf("const artifactBridges = new ArtifactBridges(");
    expect(startup).toBeGreaterThan(source.indexOf("realtimeHub = new RealtimeHub("));
    expect(startup).toBeLessThan(source.indexOf('url.pathname === "/api/web-contributions/invoke"'));
    expect(source).not.toContain("artifact_preview_invalidated");
    expect(source).toContain("invalidateArtifactPreview: (sessionId, key) => artifactBridges.releaseSession(sessionId, key)");
  });
});
