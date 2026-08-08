import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverExtensionEntryPaths, resolveBundledExtensionPaths } from "../server/extensions.js";
import { createWebUiBridge } from "../server/extensions/webUi.js";
import downloadArtifactExtension from "../examples/pi-web-extensions/download-artifact.js";
import { createGitFooterExtension } from "../examples/pi-web-extensions/git-footer.js";

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-extensions-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("bundled extension path discovery", () => {
  it("expands an extensions directory to concrete extension entry files", async () => {
    const root = await makeTempDir();
    const appDir = join(root, "app");
    const bundledExtensionsDir = join(appDir, ".pi", "extensions");
    await mkdir(join(bundledExtensionsDir, "nested"), { recursive: true });
    await writeFile(join(bundledExtensionsDir, "auto-session-name.ts"), "export default () => {};\n");
    await writeFile(join(bundledExtensionsDir, "status.js"), "export default () => {};\n");
    await writeFile(join(bundledExtensionsDir, "ignored.md"), "not an extension\n");
    await writeFile(join(bundledExtensionsDir, "nested", "index.ts"), "export default () => {};\n");

    const paths = resolveBundledExtensionPaths({
      piCwd: join(root, "project"),
      appDir,
      bundledExtensionsDir,
    });

    expect(paths).toEqual([
      join(bundledExtensionsDir, "auto-session-name.ts"),
      join(bundledExtensionsDir, "nested", "index.ts"),
      join(bundledExtensionsDir, "status.js"),
    ]);
    expect(paths).not.toContain(bundledExtensionsDir);
  });

  it("resolves package-style extension directories through their pi manifest", async () => {
    const root = await makeTempDir();
    const extensionsDir = join(root, "extensions");
    const packageDir = join(extensionsDir, "bundle");
    await mkdir(join(packageDir, "src"), { recursive: true });
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ pi: { extensions: ["./src/main.ts"] } }));
    await writeFile(join(packageDir, "src", "main.ts"), "export default () => {};\n");

    expect(discoverExtensionEntryPaths(extensionsDir)).toEqual([join(packageDir, "src", "main.ts")]);
  });

  it("does not add bundled extensions while running from the pi-web app directory", async () => {
    const root = await makeTempDir();
    const appDir = join(root, "app");
    const bundledExtensionsDir = join(appDir, ".pi", "extensions");
    await mkdir(bundledExtensionsDir, { recursive: true });
    await writeFile(join(bundledExtensionsDir, "auto-session-name.ts"), "export default () => {};\n");

    expect(resolveBundledExtensionPaths({ piCwd: appDir, appDir, bundledExtensionsDir })).toEqual([]);
  });

  it("registers the download example for every artifact and clears it on shutdown", async () => {
    const handlers = new Map<string, (event: unknown, context: any) => unknown>();
    downloadArtifactExtension({ on: (event: string, handler: (event: unknown, context: any) => unknown) => handlers.set(event, handler) } as any);
    const calls: Array<[string, any]> = [];
    const context = { ui: { web: { contribute: (key: string, contribution: unknown) => calls.push([key, contribution]) } } };

    await handlers.get("session_start")?.({}, context);
    const action = calls.at(-1)?.[1];
    expect(calls.at(-1)?.[0]).toBe("download-artifact");
    expect(action).toMatchObject({
      slot: "artifact-action",
      kind: "rendered",
      title: "Download artifact to this device",
      label: "Download",
    });
    expect(await action.render({ context: { name: "report.md", path: "/api/artifacts/report.md", kind: "markdown" } }))
      .toEqual({ download: { filename: "report.md" } });

    await handlers.get("session_shutdown")?.({}, context);
    expect(calls.at(-1)).toEqual(["download-artifact", undefined]);
  });

  it("serializes and securely invokes artifact actions through the web bridge", async () => {
    let ui: any;
    const emitted: any[] = [];
    const bridge = createWebUiBridge({
      emit: (value) => emitted.push(value), clientCount: () => 1, acquireWorkLease: () => () => undefined,
      createNewSession: async () => ({}), sessionCwd: () => process.cwd(), state: () => ({}),
    });
    const session = {
      sessionId: "session", sessionFile: "/tmp/session.jsonl", agent: { waitForIdle: async () => undefined },
      bindExtensions: async (options: any) => { ui = options.uiContext; },
    };
    await bridge.bind(session);
    ui.web.setArtifactAction("download", {
      title: "Download", kinds: ["html"], extensions: [".html"],
      invoke: ({ name }: { name: string }) => ({ download: { filename: `saved-${name}` } }),
    });

    expect(bridge.entries(session).webContributions).toEqual([{
      version: 1, key: "download", slot: "artifact-action", kind: "rendered", title: "Download", label: undefined,
      match: { kinds: ["html"], extensions: [".html"] },
    }]);
    expect(emitted.at(-1)).toMatchObject({ type: "web_contributions_changed", sessionId: "session" });
    await expect(bridge.invokeArtifactAction(session, { key: "download", name: "page.html", path: "/api/artifacts/page.html", kind: "html" }))
      .resolves.toMatchObject({ download: { path: "/api/artifacts/page.html", filename: "saved-page.html" } });
    await expect(bridge.invokeContribution(session, {
      slot: "artifact-action", key: "download",
      event: { context: { key: "another-action", name: "page.html", path: "/api/artifacts/page.html", kind: "html" } },
    })).resolves.toMatchObject({ download: { filename: "saved-page.html" } });
    await expect(bridge.invokeArtifactAction(session, { key: "download", name: "notes.md", path: "/api/artifacts/notes.md", kind: "markdown" }))
      .rejects.toThrow("does not match this artifact");
    await expect(bridge.invokeArtifactAction(session, { key: "download", name: "page.html", path: "/api/artifacts/other.html", kind: "html" }))
      .rejects.toThrow("Invalid artifact context");

    ui.web.setArtifactAction("malformed", {
      title: "Malformed filters", kinds: "html", extensions: ".html",
      invoke: () => ({ message: "invoked" }),
    } as any);
    await expect(bridge.invokeArtifactAction(session, { key: "malformed", name: "notes.md", path: "/api/artifacts/notes.md", kind: "markdown" }))
      .resolves.toMatchObject({ message: "invoked" });
  });

  it("keeps legacy surfaces isolated over one contribution registry", async () => {
    let ui: any;
    const emitted: any[] = [];
    const bridge = createWebUiBridge({
      emit: (value) => emitted.push(value), clientCount: () => 1, acquireWorkLease: () => () => undefined,
      createNewSession: async () => ({}), sessionCwd: () => process.cwd(), state: () => ({}),
    });
    const session = {
      sessionId: "session", sessionFile: "/tmp/session.jsonl", agent: { waitForIdle: async () => undefined },
      bindExtensions: async (options: any) => { ui = options.uiContext; },
    };
    await bridge.bind(session);

    ui.web.setFooter("first", "one");
    ui.web.setFooter("shared", "ready");
    ui.web.setFooter("last", "three");
    ui.web.setFooter("shared", "updated");
    ui.web.setHeaderAction("shared", { title: "Summary", invoke: () => ({ markdown: "# Done" }) });
    ui.web.setGitTab("shared", { title: "Issues", render: () => ({ html: "<p>Open</p>" }) });
    const broadcastsBeforeInvalidKey = emitted.length;
    ui.web.setFooter("", "ignored");
    ui.web.setFooter("", undefined);

    expect(emitted).toHaveLength(broadcastsBeforeInvalidKey);
    const contributions = () => bridge.entries(session).webContributions;
    expect(contributions().filter((entry: any) => entry.slot === "footer").map(({ key }: { key: string }) => key)).toEqual(["first", "shared", "last"]);
    expect(contributions()).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "first", slot: "footer", view: { kind: "text", lines: ["one"] } }),
      expect.objectContaining({ key: "shared", slot: "footer", view: { kind: "text", lines: ["updated"] } }),
      expect.objectContaining({ key: "last", slot: "footer", view: { kind: "text", lines: ["three"] } }),
      expect.objectContaining({ key: "shared", slot: "header-action", title: "Summary" }),
      expect.objectContaining({ key: "shared", slot: "git-tab", title: "Issues" }),
    ]));
    await expect(bridge.invokeHeaderAction(session, "shared")).resolves.toMatchObject({ markdown: "# Done" });
    await expect(bridge.invokeGitTab(session, { key: "shared" })).resolves.toMatchObject({ html: "<p>Open</p>" });

    ui.web.setHeaderAction("shared", undefined);
    expect(contributions().filter((entry: any) => entry.slot === "header-action")).toEqual([]);
    expect(contributions().filter((entry: any) => entry.slot === "footer")).toHaveLength(3);
    expect(contributions().filter((entry: any) => entry.slot === "git-tab")).toHaveLength(1);
    expect(emitted.at(-1)).toMatchObject({ type: "web_contributions_changed" });
  });

  it("publishes normalized contributions and emits pull invalidations", async () => {
    let ui: any;
    let bindOptions: any;
    const emitted: any[] = [];
    const bridge = createWebUiBridge({
      emit: (value) => emitted.push(value), clientCount: () => 1, acquireWorkLease: () => () => undefined,
      createNewSession: async () => ({}), sessionCwd: () => process.cwd(), state: () => ({}),
    });
    const session = {
      sessionId: "session", sessionFile: "/tmp/session.jsonl", agent: { waitForIdle: async () => undefined },
      bindExtensions: async (options: any) => { ui = options.uiContext; bindOptions = options; },
    };
    await bridge.bind(session);

    expect(ui.web.capabilities).toEqual({
      apiVersion: 1,
      slots: ["footer", "header-action", "artifact-action", "git-tab", "panel", "fab"],
      kinds: ["static", "rendered"],
      effects: ["open-panel"],
    });
    expect(Object.isFrozen(ui.web.capabilities)).toBe(true);
    expect(Object.isFrozen(ui.web.capabilities.slots)).toBe(true);

    bindOptions.onError({ extensionPath: "/tmp/broken.ts", eventName: "session_start", error: new Error("registration failed") });
    expect(bridge.runtimeErrors(session)).toEqual([
      expect.objectContaining({ path: "/tmp/broken.ts", event: "session_start", error: "registration failed" }),
    ]);
    for (let index = 0; index < 21; index++) bindOptions.onError({ extensionPath: "/tmp/noisy.ts", eventName: "turn_start", error: `failure ${index}` });
    expect(bridge.runtimeErrors(session)).toHaveLength(20);
    expect(bridge.runtimeErrors(session).at(-1)).toMatchObject({ error: "failure 20" });

    let revision = 1;
    ui.web.contribute("status", {
      slot: "panel", kind: "rendered", title: "Worker status",
      render: () => ({ html: `<p>Revision ${revision}</p>` }),
    });
    expect(bridge.entries(session).webContributions).toEqual([
      expect.objectContaining({ version: 1, key: "status", slot: "panel", kind: "rendered", title: "Worker status" }),
    ]);
    await expect(bridge.invokeContribution(session, { slot: "panel", key: "status" }))
      .resolves.toMatchObject({ html: "<p>Revision 1</p>" });

    revision += 1;
    ui.web.update("status");
    expect(emitted.at(-1)).toMatchObject({ type: "web_contribution_updated", sessionId: "session", key: "status" });
    const eventCount = emitted.length;
    ui.web.update("missing");
    expect(emitted).toHaveLength(eventCount);

    ui.web.contribute("status", { slot: "footer", kind: "static", view: "Ready" });
    expect(bridge.entries(session).webContributions).toEqual([
      expect.objectContaining({ key: "status", slot: "footer", kind: "static" }),
    ]);
    expect(() => ui.web.contribute("bad", { slot: "panel", kind: "static", view: {} })).toThrow("Unsupported contribution slot/kind");
    expect(() => ui.web.contribute("conflict", {
      slot: "panel", kind: "rendered", title: "Conflict", view: {}, render: () => ({ html: "" }),
    })).toThrow("conflicting or missing delivery fields");
    ui.web.contribute("status", undefined);
    expect(bridge.entries(session).webContributions).toEqual([]);
  });

  it("serializes and invokes FAB-backed web panels through the web bridge", async () => {
    let ui: any;
    const emitted: any[] = [];
    const bridge = createWebUiBridge({
      emit: (value) => emitted.push(value), clientCount: () => 1, acquireWorkLease: () => () => undefined,
      createNewSession: async () => ({}), sessionCwd: () => process.cwd(), state: () => ({}),
    } as any);
    const session = {
      sessionId: "session", sessionFile: "/tmp/session.jsonl", agent: { waitForIdle: async () => undefined },
      bindExtensions: async (options: any) => { ui = options.uiContext; },
    };
    await bridge.bind(session);
    let lastPanelEvent: any;
    ui.web.setPanel("notes", {
      title: "Global notes", label: "Notepad", icon: "notebook-pen",
      render: (event: any) => {
        lastPanelEvent = event;
        return { title: event?.action === "save" ? "Saved notes" : undefined, html: `<p>${event?.fields?.content || "empty"}</p>` };
      },
    });

    // Panels are pure surfaces: registering one contributes no FAB entry.
    expect(bridge.entries(session).webContributions).toEqual([
      { version: 1, key: "notes", slot: "panel", kind: "rendered", title: "Global notes", label: "Notepad", icon: "notebook-pen" },
    ]);
    expect(emitted.at(-1)).toMatchObject({ type: "web_contributions_changed", sessionId: "session" });

    // Entry points are explicit registrations that reference a panel.
    ui.web.setFabAction("notes-launcher", { title: "Notes", icon: "notebook-pen", opens: "notes" });
    expect(bridge.entries(session).webContributions).toContainEqual(
      { version: 1, key: "notes-launcher", slot: "fab", kind: "static", title: "Notes", label: undefined, icon: "notebook-pen", opens: "notes" },
    );
    expect(emitted.at(-1)).toMatchObject({ type: "web_contributions_changed", sessionId: "session" });
    ui.web.setFabAction("notes-launcher", undefined);
    expect(bridge.entries(session).webContributions.filter((entry: any) => entry.slot === "fab")).toEqual([]);

    const manyFields = Object.fromEntries(Array.from({ length: 130 }, (_, index) => [`field-${index}`, "value"]));
    await expect(bridge.invokeContribution(session, {
      slot: "panel", key: "notes", event: { action: "save", fields: { content: "remember me\n", ...manyFields } },
    })).resolves.toEqual({ title: "Saved notes", html: "<p>remember me\n</p>" });
    expect(lastPanelEvent.fields.content).toBe("remember me\n");
    expect(Object.keys(lastPanelEvent.fields)).toHaveLength(128);
    await expect(bridge.invokePanel(session, { key: "missing" })).rejects.toThrow("Panel not found");

    // Launchers are decoupled from panels: a header action can open one.
    ui.web.setHeaderAction("open-notes", { title: "Open notes", invoke: () => ({ effects: [{ type: "open-panel", key: "notes" }] }) });
    await expect(bridge.invokeContribution(session, { slot: "header-action", key: "open-notes" }))
      .resolves.toEqual({ label: "Open notes", effects: [{ type: "open-panel", key: "notes" }] });
    ui.web.setHeaderAction("open-missing", { title: "Broken", invoke: () => ({ effects: [{ type: "open-panel", key: "nope" }] }) });
    await expect(bridge.invokeHeaderAction(session, "open-missing")).rejects.toThrow('unknown panel "nope"');
  });

  it("re-emits a footer when the same session id gets a new runtime", async () => {
    vi.useFakeTimers();
    try {
      const handlers = new Map<string, Array<(event: unknown, context: any) => unknown>>();
      const extension = createGitFooterExtension({
        git: async (args) => {
          if (args[0] === "rev-parse") return { ok: true, output: "true" };
          if (args[0] === "branch") return { ok: true, output: "main" };
          return { ok: true, output: "" };
        },
      });
      extension({
        on(event: string, handler: (event: unknown, context: any) => unknown) {
          const list = handlers.get(event) || [];
          list.push(handler);
          handlers.set(event, list);
        },
      } as any);

      const makeContext = () => {
        const calls: Array<[string, unknown]> = [];
        const sessionManager = { getSessionId: () => "same-session", getCwd: () => process.cwd() };
        return {
          calls,
          context: {
            cwd: process.cwd(),
            sessionManager,
            ui: { web: { contribute: (key: string, contribution: unknown) => calls.push([key, contribution]) } },
          },
        };
      };
      const first = makeContext();
      const replacement = makeContext();
      const start = handlers.get("session_start")![0];
      const shutdown = handlers.get("session_shutdown")![0];

      await start({}, first.context);
      await vi.advanceTimersByTimeAsync(0);
      await start({}, replacement.context);
      await vi.advanceTimersByTimeAsync(0);
      expect(first.calls.at(-1)?.[1]).toMatchObject({ slot: "footer", kind: "static", view: { kind: "html" } });
      expect(replacement.calls.at(-1)?.[1]).toMatchObject({ slot: "footer", kind: "static", view: { kind: "html" } });

      await shutdown({}, first.context);
      expect(replacement.calls.at(-1)?.[1]).toMatchObject({ slot: "footer", kind: "static", view: { kind: "html" } });
      await shutdown({}, replacement.context);
      expect(replacement.calls.at(-1)).toEqual(["local-git-footer", undefined]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not overlap footer refreshes when a Git command stalls", async () => {
    vi.useFakeTimers();
    try {
      const handlers = new Map<string, (event: unknown, context: any) => unknown>();
      const git = vi.fn(() => new Promise<{ ok: boolean; output: string }>(() => undefined));
      createGitFooterExtension({ git, refreshMs: 10 })({
        on: (event: string, handler: (event: unknown, context: any) => unknown) => handlers.set(event, handler),
      } as any);
      const calls: Array<[string, unknown]> = [];
      const sessionManager = { getSessionId: () => "stalled-git", getCwd: () => process.cwd() };
      const context = {
        cwd: process.cwd(),
        sessionManager,
        ui: { web: { contribute: (key: string, contribution: unknown) => calls.push([key, contribution]) } },
      };

      handlers.get("session_start")?.({}, context);
      await vi.advanceTimersByTimeAsync(100);

      expect(git).toHaveBeenCalledTimes(1);
      expect(calls).toEqual([]);

      handlers.get("session_shutdown")?.({}, context);
      expect(calls).toEqual([["local-git-footer", undefined]]);
    } finally {
      vi.useRealTimers();
    }
  });
});
