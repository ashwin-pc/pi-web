import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverExtensionEntryPaths, resolveBundledExtensionPaths } from "../server/extensions.js";
import { createWebUiBridge } from "../server/extensions/webUi.js";
import downloadArtifactExtension from "../examples/pi-web-extensions/download-artifact.js";
import { createGitFooterExtension } from "../examples/pi-web-extensions/git-footer.js";
import globalNotepadExtension from "../examples/pi-web-extensions/notepad.js";

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
    const context = { ui: { web: { setArtifactAction: (key: string, action: unknown) => calls.push([key, action]) } } };

    await handlers.get("session_start")?.({}, context);
    const action = calls.at(-1)?.[1];
    expect(calls.at(-1)?.[0]).toBe("download-artifact");
    expect(action).toMatchObject({ title: "Download artifact to this device", label: "Download" });
    expect(await action.invoke({ name: "report.md", path: "/api/artifacts/report.md", kind: "markdown" })).toEqual({ download: { filename: "report.md" } });

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

    expect(bridge.entries(session).webArtifactActions).toEqual([{
      key: "download", title: "Download", label: undefined, kinds: ["html"], extensions: [".html"],
    }]);
    expect(emitted.at(-1)).toMatchObject({ type: "web_artifact_actions_changed", sessionId: "session" });
    await expect(bridge.invokeArtifactAction(session, { key: "download", name: "page.html", path: "/api/artifacts/page.html", kind: "html" }))
      .resolves.toMatchObject({ download: { path: "/api/artifacts/page.html", filename: "saved-page.html" } });
    await expect(bridge.invokeArtifactAction(session, { key: "download", name: "notes.md", path: "/api/artifacts/notes.md", kind: "markdown" }))
      .rejects.toThrow("does not match this artifact");
    await expect(bridge.invokeArtifactAction(session, { key: "download", name: "page.html", path: "/api/artifacts/other.html", kind: "html" }))
      .rejects.toThrow("Invalid artifact context");
  });

  it("keeps the global notepad out of the prompt and behind an on-demand tool", async () => {
    const dir = await makeTempDir();
    const noteFile = join(dir, "notepad.json");
    const previousNoteFile = process.env.PI_WEB_NOTEPAD_FILE;
    process.env.PI_WEB_NOTEPAD_FILE = noteFile;
    try {
      const handlers = new Map<string, (event: unknown, context: any) => any>();
      const tools: any[] = [];
      globalNotepadExtension({
        on: (event: string, handler: (event: unknown, context: any) => unknown) => handlers.set(event, handler),
        registerTool: (tool: unknown) => tools.push(tool),
        getSessionName: () => "fix auth flow",
      } as any);

      const tool = tools.find((candidate) => candidate.name === "notepad");
      expect(tool).toMatchObject({ name: "notepad", label: "Notepad" });
      const toolCtx = { cwd: "/tmp/project", sessionManager: { getSessionId: () => "sess-1" } };
      const run = (params: Record<string, unknown>) => tool.execute("call", params, undefined, undefined, toolCtx);

      // Structured lifecycle with provenance captured from the calling session.
      const added = await run({ action: "add", text: "Ship the notepad extension", kind: "task", due: "2099-01-02", tags: ["pi-web"] });
      const id = added.details.id as string;
      expect(id).toMatch(/^n-[0-9a-f]{6}$/);
      const listed = await run({ action: "list" });
      expect(listed.content[0].text).toContain("Ship the notepad extension");
      expect(listed.content[0].text).toContain('agent in "fix auth flow"');
      expect(listed.content[0].text).toContain("(due 2099-01-02)");
      expect(listed.details.sessions).toEqual([{ sessionId: "sess-1", name: "fix auth flow" }]);

      // Anti-mess: duplicates are rejected with a pointer to the existing entry.
      const duplicate = await run({ action: "add", text: "  ship the NOTEPAD   extension " });
      expect(duplicate.details.duplicateOf).toBe(id);

      await run({ action: "pin", id });
      await run({ action: "done", id });
      const closed = await run({ action: "list", status: "done" });
      expect(closed.content[0].text).toContain("✓");
      expect((await run({ action: "list" })).content[0].text).toContain("no open entries");
      await expect(run({ action: "done", id: "n-nope" })).rejects.toThrow('No notepad entry with id');

      // Panel and settings registration.
      const panels: Array<[string, any]> = [];
      const fabActions: Array<[string, any]> = [];
      const settingsValues: Record<string, unknown> = { pinnedInPrompt: false };
      const context = {
        ui: {
          web: {
            setPanel: (key: string, panel: unknown) => panels.push([key, panel]),
            setFabAction: (key: string, action: unknown) => fabActions.push([key, action]),
            registerSettings: async () => ({ registered: true, migrated: false, usedBackup: false }),
            getSettings: async () => ({ schemaVersion: 1, values: settingsValues }),
          },
        },
      };
      await handlers.get("session_start")?.({}, context);
      const panel = panels.at(-1)?.[1];
      expect(panels.at(-1)?.[0]).toBe("global-notepad");
      expect(panel).toMatchObject({ title: "Global notepad", label: "Notepad", icon: "notebook-pen" });
      // Entry points are explicit: the FAB launcher is its own registration.
      expect(fabActions.at(-1)).toEqual(["global-notepad", expect.objectContaining({ opens: "global-notepad" })]);

      const quickAdded = await panel.render({ action: "add", fields: { text: "Water the plants", kind: "note" } });
      expect(quickAdded.html).toContain("Water the plants");
      const reRendered = await panel.render();
      expect(reRendered.html).toContain("Water the plants");
      expect(reRendered.html).toContain("Recently closed (1)");

      // Careful-context contract: nothing reaches the prompt unless the
      // default-off toggle is enabled, and then only pinned open entries.
      const before = handlers.get("before_agent_start")!;
      expect(await before({ systemPrompt: "BASE" }, context)).toBeUndefined();
      settingsValues.pinnedInPrompt = true;
      expect(await before({ systemPrompt: "BASE" }, context)).toBeUndefined(); // nothing pinned
      const noteId = JSON.parse(await readFile(noteFile, "utf8")).entries.find((entry: any) => entry.text === "Water the plants").id;
      await run({ action: "pin", id: noteId });
      const injected = await before({ systemPrompt: "BASE" }, context);
      expect(injected.systemPrompt).toContain("Water the plants");
      expect(injected.systemPrompt).not.toContain("Ship the notepad extension");

      await handlers.get("session_shutdown")?.({}, context);
      expect(panels.at(-1)).toEqual(["global-notepad", undefined]);
      expect(fabActions.at(-1)).toEqual(["global-notepad", undefined]);
    } finally {
      if (previousNoteFile === undefined) delete process.env.PI_WEB_NOTEPAD_FILE;
      else process.env.PI_WEB_NOTEPAD_FILE = previousNoteFile;
    }
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
    ui.web.setPanel("notes", {
      title: "Global notes", label: "Notepad", icon: "notebook-pen",
      render: (event: any) => ({ title: event?.action === "save" ? "Saved notes" : undefined, html: `<p>${event?.fields?.content || "empty"}</p>` }),
    });

    // Panels are pure surfaces: registering one contributes no FAB entry.
    expect(bridge.entries(session).webPanels).toEqual([
      { key: "notes", title: "Global notes", label: "Notepad", icon: "notebook-pen" },
    ]);
    expect(bridge.entries(session).webFabActions).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ type: "web_panels_changed", sessionId: "session" });

    // Entry points are explicit registrations that reference a panel.
    ui.web.setFabAction("notes-launcher", { title: "Notes", icon: "notebook-pen", opens: "notes" });
    expect(bridge.entries(session).webFabActions).toEqual([
      { key: "notes-launcher", title: "Notes", label: undefined, icon: "notebook-pen", opens: "notes" },
    ]);
    expect(emitted.at(-1)).toMatchObject({ type: "web_fab_actions_changed", sessionId: "session" });
    ui.web.setFabAction("notes-launcher", undefined);
    expect(bridge.entries(session).webFabActions).toEqual([]);

    await expect(bridge.invokePanel(session, { key: "notes", action: "save", fields: { content: "remember me" } }))
      .resolves.toEqual({ title: "Saved notes", html: "<p>remember me</p>" });
    await expect(bridge.invokePanel(session, { key: "missing" })).rejects.toThrow("Panel not found");

    // Launchers are decoupled from panels: a header action can open one.
    ui.web.setHeaderAction("open-notes", { title: "Open notes", invoke: () => ({ openPanel: "notes" }) });
    await expect(bridge.invokeHeaderAction(session, "open-notes")).resolves.toEqual({ label: "Open notes", openPanel: "notes" });
    ui.web.setHeaderAction("open-missing", { title: "Broken", invoke: () => ({ openPanel: "nope" }) });
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
            ui: { web: { setFooter: (key: string, footer: unknown) => calls.push([key, footer]) } },
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
      expect(first.calls.at(-1)?.[1]).toMatchObject({ kind: "html" });
      expect(replacement.calls.at(-1)?.[1]).toMatchObject({ kind: "html" });

      await shutdown({}, first.context);
      expect(replacement.calls.at(-1)?.[1]).toMatchObject({ kind: "html" });
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
        ui: { web: { setFooter: (key: string, footer: unknown) => calls.push([key, footer]) } },
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
