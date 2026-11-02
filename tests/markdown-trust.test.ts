import { describe, expect, it, vi } from "vitest";
import { classifyMarkdownImageSource, enhanceRemoteMarkdownImages, remoteMarkdownImagePlaceholder } from "../src/markdown/imageTrust.js";
import { parsePanelDeepLink, setPanelDeepLinkDescriptors, validatedPanelDeepLink } from "../src/messages/panelDeepLinks.js";
import { artifactPreviewBaseUrl, previewContentSecurityPolicy } from "../src/markdown/htmlPreviewGate.js";
import { applyContentPolicySettings, blockContentHost, decideContent, registerContentPolicy } from "../src/security/contentPolicy.js";
import { normalizeRemoteContentHost } from "../server/shared/remoteContentHosts.js";

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

  it("renders warned images with policy detail and blocks their host for later images", async () => {
    class FakeElement {
      dataset: Record<string, string> = {};
      attributes = new Map<string, string>();
      children: Array<FakeElement | string> = [];
      listeners = new Map<string, Array<(event: any) => void>>();
      parent?: FakeElement;
      replacement?: FakeElement;
      isConnected = true;
      className = "";
      textContent = "";
      alt = "";
      title = "";
      referrerPolicy = "";
      loading = "";
      src = "";

      constructor(readonly tagName: string) {}
      setAttribute(name: string, value: string) { this.attributes.set(name, value); }
      addEventListener(type: string, listener: (event: any) => void) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }
      append(...children: Array<FakeElement | string>) {
        for (const child of children) {
          if (child instanceof FakeElement) child.parent = this;
          this.children.push(child);
        }
      }
      replaceChildren(...children: Array<FakeElement | string>) {
        this.children = [];
        this.append(...children);
      }
      replaceWith(replacement: FakeElement) {
        this.isConnected = false;
        this.replacement = replacement;
      }
      closest(selector: string): FakeElement | undefined {
        if (selector === "button" && this.tagName === "button") return this;
        return this.parent?.closest(selector);
      }
      click() {
        const event = {
          target: this,
          defaultPrevented: false,
          propagationStopped: false,
          preventDefault() { this.defaultPrevented = true; },
          stopPropagation() { this.propagationStopped = true; },
        };
        let current: FakeElement | undefined = this;
        while (current) {
          for (const listener of current.listeners.get("click") || []) listener(event);
          if (event.propagationStopped) break;
          current = current.parent;
        }
        return event;
      }
    }

    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousElement = globalThis.Element;
    const documentListeners = new Map<string, Set<() => void>>();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { origin: "https://pi.example.test" } },
    });
    Object.defineProperty(globalThis, "Element", { configurable: true, value: FakeElement });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        createElement: (tag: string) => new FakeElement(tag),
        querySelectorAll: () => [],
        addEventListener: (type: string, listener: () => void) => {
          const listeners = documentListeners.get(type) || new Set();
          listeners.add(listener);
          documentListeners.set(type, listeners);
        },
        removeEventListener: (type: string, listener: () => void) => documentListeners.get(type)?.delete(listener),
        dispatchEvent: (event: Event) => {
          for (const listener of documentListeners.get(event.type) || []) listener();
          return true;
        },
      },
    });
    const removePolicy = registerContentPolicy(function imageClassifier(resource) {
      return resource.kind === "image" && resource.url.includes("warn-image.example.test")
        ? { action: "warn", reason: "Unverified image source", by: "image-classifier" }
        : undefined;
    });
    try {
      const source = {
        kind: "remote" as const,
        src: "https://warn-image.example.test/first.png",
        host: "warn-image.example.test",
      };
      const placeholder = remoteMarkdownImagePlaceholder(source, "warning example", "") as unknown as FakeElement;
      const root = { querySelectorAll: () => [placeholder] } as unknown as ParentNode;
      const enhanceImage = vi.fn();
      enhanceRemoteMarkdownImages(root, enhanceImage, { sessionId: "s1", role: "assistant" });
      await vi.waitFor(() => expect(placeholder.replacement).toBeDefined());

      const warning = placeholder.replacement!;
      expect(warning.className).toBe("remoteMarkdownImageWarning");
      const marker = warning.children[1] as FakeElement;
      expect((marker.children[0] as FakeElement).textContent).toBe("image-classifier: Unverified image source");
      const block = marker.children[1] as FakeElement;
      const click = block.click();
      expect(click.defaultPrevented).toBe(true);
      expect(click.propagationStopped).toBe(true);
      expect(warning.replacement?.textContent).toContain("warn-image.example.test was blocked");

      const later = remoteMarkdownImagePlaceholder({
        ...source,
        src: "https://warn-image.example.test/later.png",
      }, "later warning", "") as unknown as FakeElement;
      enhanceRemoteMarkdownImages({ querySelectorAll: () => [later] } as unknown as ParentNode, enhanceImage, {
        sessionId: "s1",
        role: "assistant",
      });
      await vi.waitFor(() => expect(later.replacement).toBeDefined());
      expect(later.replacement?.textContent).toContain("warn-image.example.test was blocked");
      expect(enhanceImage).toHaveBeenCalledTimes(1);
    } finally {
      removePolicy();
      Object.defineProperty(globalThis, "Element", { configurable: true, value: previousElement });
      Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
      Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
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
    expect(normalizeRemoteContentHost(" Images.Example.COM. ")).toBe("images.example.com");
    expect(normalizeRemoteContentHost("localhost:8787")).toBe("localhost:8787");
    expect(normalizeRemoteContentHost("https://example.com/path")).toBeUndefined();
    expect(normalizeRemoteContentHost("user@example.com")).toBeUndefined();
    expect(normalizeRemoteContentHost("bad_host.example")).toBeUndefined();
    expect(normalizeRemoteContentHost("empty..label.example")).toBeUndefined();
    expect(normalizeRemoteContentHost("-leading.example")).toBeUndefined();
  });

  it("uses the fixed intrinsic, user allowlist, and default policies in order", async () => {
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { origin: "https://pi.example.test" } },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { dispatchEvent: () => undefined },
    });
    try {
      applyContentPolicySettings({ security: { remoteContentHosts: ["trusted.example.test"] } });
      await expect(decideContent({
        kind: "image",
        url: "data:image/png;base64,AA==",
        from: { sessionId: "s1", role: "assistant" },
      })).resolves.toEqual({ action: "allow", by: "core" });
      await expect(decideContent({
        kind: "preview-request",
        url: "https://pi.example.test/api/artifacts/demo",
        from: { sessionId: "s1", role: "assistant" },
      })).resolves.toEqual({ action: "allow", by: "core" });
      await expect(decideContent({
        kind: "image",
        url: "https://trusted.example.test/image.png",
        from: { sessionId: "s1", role: "assistant" },
      })).resolves.toEqual({ action: "allow", by: "user-host-allowlist" });
      await expect(decideContent({
        kind: "image",
        url: "https://remote.example/image.png",
        from: { sessionId: "s1", role: "assistant" },
      })).resolves.toEqual({ action: "ask", by: "default" });
      await expect(decideContent({
        kind: "preview-navigation",
        url: "javascript:alert(1)",
        from: { sessionId: "s1", role: "assistant" },
      })).resolves.toMatchObject({ action: "block", by: "core" });
    } finally {
      applyContentPolicySettings({ security: { remoteContentHosts: [] } });
      Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
      Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    }
  });

  it("applies persisted host changes immediately without a verdict cache", async () => {
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { origin: "https://pi.example.test" } },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { dispatchEvent: () => undefined },
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

  it("lets registered classifiers strengthen core and allowlist decisions", async () => {
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { origin: "https://pi.example.test" } },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { dispatchEvent: () => undefined },
    });
    const removeWarn = registerContentPolicy(function classifierWarn() {
      return { action: "warn", reason: "Classifier uncertainty", by: "classifier" };
    });
    const removeBlock = registerContentPolicy(function classifierBlock(resource) {
      return resource.url.includes("trusted.example.test")
        ? { action: "block", reason: "Classifier rejection", by: "classifier" }
        : undefined;
    });
    try {
      applyContentPolicySettings({ security: { remoteContentHosts: ["trusted.example.test"] } });
      await expect(decideContent({
        kind: "image",
        url: "https://pi.example.test/api/artifacts/local.png",
        from: { sessionId: "s1", role: "assistant" },
      })).resolves.toEqual({ action: "warn", reason: "Classifier uncertainty", by: "classifier" });
      await expect(decideContent({
        kind: "image",
        url: "https://trusted.example.test/image.png",
        from: { sessionId: "s1", role: "assistant" },
      })).resolves.toEqual({ action: "block", reason: "Classifier rejection", by: "classifier" });
    } finally {
      removeWarn();
      removeBlock();
      applyContentPolicySettings({ security: { remoteContentHosts: [] } });
      Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
      Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    }
  });

  it("evaluates registered policies in order and keeps the earlier verdict on ties", async () => {
    const previousWindow = globalThis.window;
    const seen: string[] = [];
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { origin: "https://pi.example.test" } },
    });
    const removeFirst = registerContentPolicy(function firstClassifier() {
      seen.push("first");
      return { action: "allow", by: "first" };
    });
    const removeSecond = registerContentPolicy(function secondClassifier() {
      seen.push("second");
      return { action: "allow", by: "second" };
    });
    try {
      await expect(decideContent({
        kind: "image",
        url: "https://pi.example.test/api/artifacts/local.png",
        from: { sessionId: "s1", role: "assistant" },
      })).resolves.toEqual({ action: "allow", by: "core" });
      expect(seen).toEqual(["first", "second"]);
    } finally {
      removeFirst();
      removeSecond();
      Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    }
  });

  it("warns only for allowlisted remote HTTP images through the registered transport policy", async () => {
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { origin: "https://pi.example.test" } },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { dispatchEvent: () => undefined },
    });
    try {
      applyContentPolicySettings({ security: { remoteContentHosts: ["transport-warning.example.test"] } });
      await expect(decideContent({
        kind: "image",
        url: "http://transport-warning.example.test/image.png",
        from: { sessionId: "s1", role: "assistant" },
      })).resolves.toEqual({
        action: "warn",
        reason: "Allowed host uses unencrypted HTTP",
        by: "transport-policy",
      });
      await expect(decideContent({
        kind: "image",
        url: "http://unknown-http.example.test/image.png",
        from: { sessionId: "s1", role: "assistant" },
      })).resolves.toEqual({ action: "ask", by: "default" });
    } finally {
      applyContentPolicySettings({ security: { remoteContentHosts: [] } });
      Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
      Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    }
  });

  it("treats throwing and timed-out internal policies as ask", async () => {
    const previousWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { origin: "https://pi.example.test" } },
    });
    const resource = {
      kind: "image" as const,
      url: "https://unclassified.example.test/image.png",
      from: { sessionId: "s1", role: "assistant" as const },
    };
    const removeThrow = registerContentPolicy(function brokenClassifier() {
      throw new Error("classifier unavailable");
    });
    try {
      await expect(decideContent(resource)).resolves.toMatchObject({
        action: "ask",
        by: "internal-policy-error",
        reason: expect.stringContaining("brokenClassifier"),
      });
    } finally {
      removeThrow();
    }

    vi.useFakeTimers();
    const removeTimeout = registerContentPolicy(function slowClassifier() {
      return new Promise(() => undefined);
    });
    try {
      const pending = decideContent(resource);
      await vi.advanceTimersByTimeAsync(1_500);
      await expect(pending).resolves.toMatchObject({
        action: "ask",
        by: "internal-policy-timeout",
        reason: expect.stringContaining("slowClassifier"),
      });
    } finally {
      removeTimeout();
      vi.useRealTimers();
      Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    }
  });

  it("keeps a blocked host denied for the current app session", async () => {
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const dispatchEvent = vi.fn();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { origin: "https://pi.example.test" } },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { dispatchEvent },
    });
    try {
      applyContentPolicySettings({ security: { remoteContentHosts: ["blocked-this-session.example.test"] } });
      expect(blockContentHost("blocked-this-session.example.test")).toBe(true);
      await expect(decideContent({
        kind: "image",
        url: "https://blocked-this-session.example.test/image.png",
        from: { sessionId: "s1", role: "assistant" },
      })).resolves.toMatchObject({ action: "block", by: "user-session-blocklist" });
      expect(dispatchEvent).toHaveBeenCalled();
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
      "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; frame-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'",
    );
    const approved = previewContentSecurityPolicy(["https://cdn.example:8443"]);
    expect(approved).toContain("connect-src https://cdn.example:8443");
    expect(approved).toContain("img-src data: blob: https://cdn.example:8443");
    expect(approved).toContain("media-src data: blob: https://cdn.example:8443");
    expect(approved).toContain("frame-src https://cdn.example:8443");
    expect(approved).not.toContain("*");
  });

  it("allows only a validated artifact base origin for relative preview resources", () => {
    expect(artifactPreviewBaseUrl(
      "/api/session-artifacts/s1/reports/index.html",
      "https://pi.example.test",
    )).toBe("https://pi.example.test/api/session-artifacts/s1/reports/");
    expect(artifactPreviewBaseUrl(
      "https://remote.example.test/api/artifacts/index.html",
      "https://pi.example.test",
    )).toBeUndefined();
    const policy = previewContentSecurityPolicy([], "https://pi.example.test");
    expect(policy).toContain("script-src 'unsafe-inline' 'unsafe-eval' https://pi.example.test");
    expect(policy).toContain("style-src 'unsafe-inline' https://pi.example.test");
    expect(policy).toContain("img-src data: blob: https://pi.example.test");
    expect(policy).toContain("base-uri https://pi.example.test");
  });
});
