import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveGlobalPiWebExtensionPaths } from "../server/extensions.js";
import { ResilientResourceLoader } from "../server/extensions/resilientLoader.js";
import { WorkspaceExtensionTrust, realWorkspacePath } from "../server/extensions/workspaceTrust.js";
import { handleWorkspaceExtensionTrustRoute } from "../server/extensions/workspaceTrustRoute.js";
import { createSettingsStore } from "../server/settings.js";

const roots: string[] = [];

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "pi-web-workspace-trust-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function extensionSource(marker: string, label: string) {
  return `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`${label}\n`)});
export default function () {}
`;
}

async function loadedPaths(loader: ResilientResourceLoader) {
  await loader.reload();
  return loader.getExtensions().extensions.map((extension: any) => extension.path || extension.resolvedPath);
}

describe("workspace extension trust", () => {
  it("does not execute untrusted workspace web extensions while global and regular extensions still load", async () => {
    const root = await tempRoot();
    const workspace = join(root, "workspace");
    const webHome = join(root, "web-home");
    const agentDir = join(root, "agent");
    const marker = join(root, "executed.txt");
    await mkdir(join(workspace, ".pi", "web", "extensions"), { recursive: true });
    await mkdir(join(workspace, ".pi", "extensions"), { recursive: true });
    await mkdir(join(webHome, "extensions"), { recursive: true });
    await writeFile(join(workspace, ".pi", "web", "extensions", "workspace.js"), extensionSource(marker, "workspace"));
    await writeFile(join(workspace, ".pi", "extensions", "regular.js"), extensionSource(marker, "regular"));
    await writeFile(join(webHome, "extensions", "global.js"), extensionSource(marker, "global"));
    vi.stubEnv("PI_WEB_HOME", webHome);

    const store = createSettingsStore(join(root, "settings.json"));
    const trust = new WorkspaceExtensionTrust(store);
    await trust.initialize();
    const loader = new ResilientResourceLoader({
      loaderOptions: { cwd: workspace, agentDir, additionalExtensionPaths: [] },
      resolveAdditionalExtensionPaths: () => [
        ...resolveGlobalPiWebExtensionPaths(),
        ...trust.extensionPaths(workspace),
      ],
    });

    const paths = await loadedPaths(loader);
    const executed = await readFile(marker, "utf8");
    expect(executed).toContain("regular");
    expect(executed).toContain("global");
    expect(executed).not.toContain("workspace");
    expect(paths.some((path) => path?.endsWith("workspace.js"))).toBe(false);
  });

  it("loads after trust, excludes again after revoke, and shares trust across symlink aliases", async () => {
    const root = await tempRoot();
    const workspace = join(root, "workspace");
    const alias = join(root, "alias");
    const agentDir = join(root, "agent");
    const marker = join(root, "executed.txt");
    const extension = join(workspace, ".pi", "web", "extensions", "workspace.js");
    await mkdir(join(extension, ".."), { recursive: true });
    await writeFile(extension, extensionSource(marker, "workspace"));
    await symlink(workspace, alias, "dir");

    const store = createSettingsStore(join(root, "settings.json"));
    const trust = new WorkspaceExtensionTrust(store);
    await trust.initialize();
    expect(trust.status(alias).workspace).toBe(realWorkspacePath(workspace));
    const loader = new ResilientResourceLoader({
      loaderOptions: { cwd: workspace, agentDir, additionalExtensionPaths: [] },
      resolveAdditionalExtensionPaths: () => trust.extensionPaths(workspace),
    });
    expect((await loadedPaths(loader)).some((path) => path?.endsWith("workspace.js"))).toBe(false);

    await trust.trust(alias);
    expect(trust.isTrusted(workspace)).toBe(true);
    expect((await store.read()).trustedExtensionWorkspaces).toEqual([realWorkspacePath(workspace)]);

    expect((await loadedPaths(loader)).some((path) => path?.endsWith("workspace.js"))).toBe(true);
    expect(await readFile(marker, "utf8")).toContain("workspace");

    await trust.revoke(realWorkspacePath(workspace));
    await rm(marker);
    expect((await loadedPaths(loader)).some((path) => path?.endsWith("workspace.js"))).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("workspace extension trust route", () => {
  function response() {
    return {
      status: 0,
      body: "",
      writeHead(status: number) { this.status = status; },
      end(body = "") { this.body = body; },
    } as any;
  }

  it("requires a browser owner session for trust and revoke", async () => {
    const calls: string[] = [];
    const deps = {
      trust: {
        status: () => ({ workspace: "/real/workspace", trusted: false, extensions: [{ path: ".pi/web/extensions/demo.js" }], trustedWorkspaces: [] }),
        trust: async () => {
          calls.push("trust");
          return { workspace: "/real/workspace", trusted: true, extensions: [], trustedWorkspaces: ["/real/workspace"] };
        },
        revoke: async () => { calls.push("revoke"); },
      },
      sessions: {
        require: async () => ({ sessionId: "session" }),
        cwdForSession: () => "/workspace",
        reloadExtensions: async () => { calls.push("reload"); return { state: "ready" }; },
      },
      readBody: async () => ({ sessionId: "session", workspace: "/real/workspace" }),
      settings: async () => ({}),
      broadcast: () => undefined,
    } as any;

    for (const via of ["token", "extension", "legacy", "external", "open"] as const) {
      const res = response();
      await handleWorkspaceExtensionTrustRoute(
        { method: "POST" } as any,
        res,
        new URL("http://localhost/api/extensions/workspace-trust"),
        { ok: true, via, identity: { id: via } },
        deps,
      );
      expect(res.status).toBe(403);
    }
    expect(calls).toEqual([]);

    for (const via of ["token", "extension", "legacy", "external", "open"] as const) {
      const res = response();
      await handleWorkspaceExtensionTrustRoute(
        { method: "DELETE" } as any,
        res,
        new URL("http://localhost/api/extensions/workspace-trust"),
        { ok: true, via, identity: { id: via } },
        deps,
      );
      expect(res.status).toBe(403);
    }
    expect(calls).toEqual([]);

    const res = response();
    await handleWorkspaceExtensionTrustRoute(
      { method: "POST" } as any,
      res,
      new URL("http://localhost/api/extensions/workspace-trust"),
      { ok: true, via: "session", identity: { id: "owner" }, sessionHash: "session" },
      deps,
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual(["trust", "reload"]);
  });
});
