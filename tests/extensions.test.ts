import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverExtensionEntryPaths, resolveBundledExtensionPaths } from "../server/extensions.js";
import { createWebUiBridge } from "../server/extensions/webUi.js";
import downloadArtifactExtension from "../examples/pi-web-extensions/download-artifact.js";
import gitFooterExtension from "../examples/pi-web-extensions/git-footer.js";

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

  it("re-emits a footer when the same session id gets a new runtime", async () => {
    vi.useFakeTimers();
    try {
      const handlers = new Map<string, Array<(event: unknown, context: any) => unknown>>();
      gitFooterExtension({
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
      await start({}, replacement.context);
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
});
