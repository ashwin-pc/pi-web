import { describe, expect, it, vi } from "vitest";
import { classifyMarkdownImageSource } from "../src/markdown/imageTrust.js";
import { parsePanelDeepLink, setPanelDeepLinkDescriptors, validatedPanelDeepLink } from "../src/messages/panelDeepLinks.js";
import { previewContentSecurityPolicy } from "../src/markdown/htmlPreviewGate.js";
import { applyContentPolicySettings, decideContent, normalizedContentHost, registerContentPolicy } from "../src/security/contentPolicy.js";

describe("markdown image trust policy", () => {
  const origin = "https://pi.example.test";

  it("automatically permits same-origin, blob, and inline raster images", () => {
    expect(classifyMarkdownImageSource("/api/artifacts/chart.png", origin)).toEqual({
      kind: "automatic",
      src: "/api/artifacts/chart.png",
    });
    expect(classifyMarkdownImageSource("https://pi.example.test/api/attachments/id/name.png?download=0", origin)).toEqual({
      kind: "automatic",
      src: "/api/attachments/id/name.png?download=0",
    });
    expect(classifyMarkdownImageSource("/api/session-artifacts/session/chart.png", origin).kind).toBe("automatic");
    expect(classifyMarkdownImageSource("/api/messages/image?imageId=1.2.digest", origin).kind).toBe("automatic");
    expect(classifyMarkdownImageSource("data:image/png;base64,iVBORw0KGgo=", origin).kind).toBe("automatic");
    expect(classifyMarkdownImageSource("blob:https://pi.example.test/id", origin).kind).toBe("automatic");
    expect(classifyMarkdownImageSource("/ordinary/path.png", origin)).toEqual({
      kind: "automatic",
      src: "/ordinary/path.png",
    });
  });

  it("gates normalized remote URLs and rejects ambiguous URL syntax", () => {
    expect(classifyMarkdownImageSource("https://images.example.test/a.png", origin)).toEqual({
      kind: "remote",
      src: "https://images.example.test/a.png",
      host: "images.example.test",
    });
    for (const source of [
      "//images.example.test/a.png",
      "https:\\images.example.test\\a.png",
      "/\\images.example.test/a.png",
      "javascript:alert(1)",
      "data:image/svg+xml;base64,PHN2Zz4=",
      "https://user:secret@images.example.test/a.png",
    ]) {
      expect(classifyMarkdownImageSource(source, origin), source).toEqual({ kind: "rejected" });
    }
  });
});

describe("panel deep-link parsing", () => {
  it("keeps duplicate-parameter behavior while returning an explicit target", () => {
    expect(parsePanelDeepLink("#panel:notes:note=oncall%2Fw34&task=old&task=t-3f2a")).toEqual({
      key: "notes",
      payload: { note: "oncall/w34", task: "t-3f2a" },
    });
  });

  it("preserves supported punctuation while rejecting unreadable targets", () => {
    expect(parsePanelDeepLink("#panel::note=ignored")).toBeUndefined();
    expect(parsePanelDeepLink("#panel:notes!\nTarget=value")).toBeUndefined();
    expect(parsePanelDeepLink(`#panel:${"x".repeat(81)}:value=1`)).toBeUndefined();
    expect(parsePanelDeepLink("#panel:team/notes!@$%^&*():value=1")).toEqual({
      key: "team/notes!@$%^&*()",
      payload: { value: "1" },
    });
  });

  it("drops undeclared keys, enforces required keys, and keeps no-schema compatibility", () => {
    setPanelDeepLinkDescriptors([
      { key: "notes", title: "Notepad", deepLinks: { allowedKeys: ["id"], requiredKeys: ["id"] } },
      { key: "legacy", title: "Legacy" },
    ]);
    expect(validatedPanelDeepLink(parsePanelDeepLink("#panel:notes:id=n-1&mutate=yes")!)).toMatchObject({
      payload: { id: "n-1" },
    });
    expect(validatedPanelDeepLink(parsePanelDeepLink("#panel:notes:mutate=yes")!)).toBeUndefined();
    expect(validatedPanelDeepLink(parsePanelDeepLink("#panel:legacy:any=value")!)).toMatchObject({
      payload: { any: "value" },
    });
  });
});

describe("internal content policy", () => {
  it("normalizes host entries without accepting URLs or credentials", () => {
    expect(normalizedContentHost(" Images.Example.COM. ")).toBe("images.example.com");
    expect(normalizedContentHost("localhost:8787")).toBe("localhost:8787");
    expect(normalizedContentHost("https://example.com/path")).toBeUndefined();
    expect(normalizedContentHost("user@example.com")).toBeUndefined();
    expect(normalizedContentHost("bad_host.example")).toBeUndefined();
    expect(normalizedContentHost("empty..label.example")).toBeUndefined();
    expect(normalizedContentHost("-leading.example")).toBeUndefined();
  });

  it("uses the strictest internal verdict while allowing intrinsic resources", async () => {
    const previousWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { origin: "https://pi.example.test" }, setTimeout, clearTimeout },
    });
    const seen: unknown[] = [];
    const removeAllow = registerContentPolicy((resource) => {
      seen.push(resource);
      return { action: "allow", by: "allow-test" };
    });
    const removeBlock = registerContentPolicy(() => ({ action: "block", reason: "blocked", by: "block-test" }));
    try {
      await expect(decideContent({
        kind: "image",
        url: "https://remote.example/image.png",
        from: { sessionId: "s1", role: "assistant" },
      })).resolves.toMatchObject({ action: "block", by: "block-test" });
      await expect(decideContent({
        kind: "image",
        url: "https://remote.example/image.png",
        from: { sessionId: "s1", role: "assistant" },
      })).resolves.toMatchObject({ action: "block", by: "block-test" });
      await expect(decideContent({
        kind: "image",
        url: "data:image/png;base64,AA==",
        from: { sessionId: "s1", role: "assistant" },
      })).resolves.toMatchObject({ action: "allow", by: "core" });
      expect(seen).toEqual([{
        kind: "image",
        url: "https://remote.example/image.png",
        from: { sessionId: "s1", role: "assistant" },
      }]);
    } finally {
      removeAllow();
      removeBlock();
      Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    }
  });

  it("uses ask from a timed-out hook over a conflicting hook allow", async () => {
    vi.useFakeTimers();
    const previousWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { origin: "https://pi.example.test" }, setTimeout, clearTimeout },
    });
    const removeAllow = registerContentPolicy(() => ({ action: "allow", by: "allow-test" }));
    const removeTimeout = registerContentPolicy(() => new Promise(() => undefined));
    const resource = {
      kind: "image" as const,
      url: "https://slow.example/image.png",
      from: { sessionId: "s1", role: "assistant" as const },
    };
    try {
      const pending = decideContent(resource);
      await vi.advanceTimersByTimeAsync(1_500);
      await expect(pending).resolves.toMatchObject({ action: "ask", by: "policy-timeout" });
    } finally {
      removeAllow();
      removeTimeout();
      vi.useRealTimers();
      Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    }
  });

  it("stops at the built-in allowlist before consulting internal hooks", async () => {
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { origin: "https://pi.example.test" }, setTimeout, clearTimeout },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { dispatchEvent: vi.fn() },
    });
    const hook = vi.fn(() => ({ action: "block" as const, by: "block-test" }));
    const remove = registerContentPolicy(hook);
    try {
      applyContentPolicySettings({ security: { remoteContentHosts: ["trusted.example.test"] } });
      await expect(decideContent({
        kind: "image",
        url: "https://trusted.example.test/image.png",
        from: { sessionId: "s1", role: "assistant" },
      })).resolves.toMatchObject({ action: "allow", by: "user-host-allowlist" });
      expect(hook).not.toHaveBeenCalled();
    } finally {
      applyContentPolicySettings({ security: { remoteContentHosts: [] } });
      remove();
      Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
      Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    }
  });

  it("invalidates cached host verdicts when persisted user settings change", async () => {
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { origin: "https://pi.example.test" }, setTimeout, clearTimeout },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { dispatchEvent: vi.fn() },
    });
    const resource = {
      kind: "image" as const,
      url: "https://changing.example.test/image.png",
      from: { sessionId: "s1", role: "assistant" as const },
    };
    try {
      await expect(decideContent(resource)).resolves.toMatchObject({ action: "ask", by: "default" });
      applyContentPolicySettings({ security: { remoteContentHosts: ["changing.example.test"] } });
      await expect(decideContent(resource)).resolves.toMatchObject({ action: "allow", by: "user-host-allowlist" });
      applyContentPolicySettings({ security: { remoteContentHosts: [] } });
      await expect(decideContent(resource)).resolves.toMatchObject({ action: "ask", by: "default" });
    } finally {
      applyContentPolicySettings({ security: { remoteContentHosts: [] } });
      Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
      Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    }
  });
});

describe("preview containment policy", () => {
  it("keeps the base deny policy and adds only exact approved origins", () => {
    expect(previewContentSecurityPolicy()).toBe(
      "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'",
    );
    const approved = previewContentSecurityPolicy(["https://cdn.example:8443"]);
    expect(approved).toContain("connect-src https://cdn.example:8443");
    expect(approved).toContain("img-src data: blob: https://cdn.example:8443");
    expect(approved).not.toContain("*");
  });
});
