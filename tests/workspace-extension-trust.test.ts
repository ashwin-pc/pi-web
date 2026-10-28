import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectTrustStore, SettingsManager } from "@earendil-works/pi-coding-agent";
import { resolveGlobalPiWebExtensionPaths } from "../server/extensions.js";
import { ResilientResourceLoader } from "../server/extensions/resilientLoader.js";
import { WorkspaceExtensionTrust, realWorkspacePath } from "../server/extensions/workspaceTrust.js";
import { handleWorkspaceExtensionTrustRoute } from "../server/extensions/workspaceTrustRoute.js";

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

async function fixture() {
  const root = await tempRoot();
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const webHome = join(root, "web-home");
  const marker = join(root, "executed.txt");
  const packageDir = join(workspace, "local-package");
  await mkdir(join(workspace, ".pi", "extensions"), { recursive: true });
  await mkdir(join(workspace, ".pi", "web", "extensions"), { recursive: true });
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(join(webHome, "extensions"), { recursive: true });
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(workspace, ".pi", "extensions", "regular.js"), extensionSource(marker, "regular"));
  await writeFile(join(workspace, ".pi", "web", "extensions", "web.js"), extensionSource(marker, "web"));
  await writeFile(join(agentDir, "extensions", "global.js"), extensionSource(marker, "global"));
  await writeFile(join(webHome, "extensions", "global-web.js"), extensionSource(marker, "global-web"));
  await writeFile(join(packageDir, "extension.js"), extensionSource(marker, "package"));
  await writeFile(join(packageDir, "package.json"), JSON.stringify({
    name: "local-project-extension",
    version: "1.0.0",
    pi: { extensions: ["./extension.js"] },
  }));
  await writeFile(join(workspace, ".pi", "settings.json"), JSON.stringify({
    packages: ["../local-package"],
  }));
  vi.stubEnv("PI_WEB_HOME", webHome);

  const trust = new WorkspaceExtensionTrust(agentDir);
  const settingsManager = SettingsManager.create(workspace, agentDir, { projectTrusted: false });
  const loader = new ResilientResourceLoader({
    loaderOptions: { cwd: workspace, agentDir, settingsManager, additionalExtensionPaths: [] },
    resolveProjectTrust: () => trust.isTrusted(workspace),
    resolveAdditionalExtensionPaths: () => [
      ...resolveGlobalPiWebExtensionPaths(),
      ...trust.extensionPaths(workspace),
    ],
  });
  return { root, workspace, agentDir, marker, packageDir, trust, loader };
}

describe("workspace extension trust", () => {
  it("keeps explicitly bundled extensions out of the workspace consent inventory", async () => {
    const root = await tempRoot();
    const workspace = join(root, "workspace");
    const workspaceAlias = join(root, "workspace-alias");
    const agentDir = join(root, "agent");
    const bundled = join(workspace, ".pi", "extensions", "bundled.js");
    await mkdir(join(bundled, ".."), { recursive: true });
    await writeFile(bundled, "export default function () {}\n");
    await symlink(workspace, workspaceAlias, "dir");

    const trust = new WorkspaceExtensionTrust(
      agentDir,
      [join(workspaceAlias, ".pi", "extensions", "bundled.js")],
    );
    expect(trust.isTrusted(workspace)).toBe(false);
    expect(trust.status(workspace).resources).toEqual([]);
  });

  it("shows workspace extensions when an explicitly trusted source path is missing", async () => {
    const root = await tempRoot();
    const workspace = join(root, "workspace");
    const agentDir = join(root, "agent");
    const regular = join(workspace, ".pi", "extensions", "regular.js");
    await mkdir(join(regular, ".."), { recursive: true });
    await writeFile(regular, "export default function () {}\n");

    const trust = new WorkspaceExtensionTrust(agentDir, [join(root, "missing.js")]);
    expect(trust.status(workspace).resources).toEqual([
      { kind: "extension", path: ".pi/extensions/regular.js" },
    ]);
  });

  it("blocks all project code while global extensions remain available", async () => {
    const { marker, trust, loader } = await fixture();

    await loader.reload();

    const executed = (await readFile(marker, "utf8")).trim().split("\n");
    expect(executed).toEqual(expect.arrayContaining(["global", "global-web"]));
    expect(executed).not.toContain("regular");
    expect(executed).not.toContain("web");
    expect(executed).not.toContain("package");
    expect(trust.status(loader.getStatus().cwd).resources).toEqual(expect.arrayContaining([
      { kind: "extension", path: ".pi/extensions/regular.js" },
      { kind: "extension", path: ".pi/web/extensions/web.js" },
      { kind: "package", path: "../local-package" },
    ]));
  });

  it("loads trusted project extensions and packages, then blocks them after revoke", async () => {
    const { workspace, marker, packageDir, trust, loader } = await fixture();
    await loader.reload();
    await trust.trust(workspace);
    await rm(marker, { force: true });

    await loader.reload();

    const trustedExecution = await readFile(marker, "utf8");
    expect(trustedExecution).toContain("regular");
    expect(trustedExecution).toContain("web");
    expect(trustedExecution).toContain("package");

    await trust.revoke(workspace);
    await rm(marker, { force: true });
    await loader.reload();
    expect(existsSync(marker)).toBe(false);
    const loadedPaths = loader.getExtensions().extensions.map((extension: any) => extension.path || extension.resolvedPath);
    expect(loadedPaths.some((path) => path?.includes(`${workspace}/.pi/`))).toBe(false);
    expect(loadedPaths.some((path) => path?.includes(packageDir))).toBe(false);
  });

  it("shares canonical native decisions with CLI and overrides inherited trust on revoke", async () => {
    const root = await tempRoot();
    const parent = join(root, "parent");
    const workspace = join(parent, "workspace");
    const alias = join(root, "alias");
    const agentDir = join(root, "agent");
    await mkdir(join(workspace, ".pi", "extensions"), { recursive: true });
    await writeFile(join(workspace, ".pi", "extensions", "entry.js"), "export default function () {}\n");
    await symlink(workspace, alias, "dir");

    const nativeStore = new ProjectTrustStore(agentDir);
    nativeStore.set(alias, true);
    const trust = new WorkspaceExtensionTrust(agentDir);
    expect(trust.isTrusted(workspace)).toBe(true);
    expect(trust.trustedWorkspaces()).toEqual([realWorkspacePath(workspace)]);
    expect(new WorkspaceExtensionTrust(agentDir).isTrusted(alias)).toBe(true);

    nativeStore.set(parent, true);
    nativeStore.set(workspace, null);
    expect(trust.isTrusted(workspace)).toBe(true);
    expect(trust.status(workspace).trustedWorkspaces).toEqual([
      realWorkspacePath(parent),
      realWorkspacePath(workspace),
    ]);
    trust.revoke(workspace);
    expect(nativeStore.getEntry(workspace)).toEqual({
      path: realWorkspacePath(workspace),
      decision: false,
    });
    expect(trust.isTrusted(alias)).toBe(false);
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

  function dependencies(calls: string[], displayedWorkspace = "/real/workspace") {
    return {
      trust: {
        status: () => ({
          workspace: "/real/workspace",
          trusted: false,
          resources: [{ kind: "extension", path: ".pi/extensions/demo.js" }],
          trustedWorkspaces: [],
        }),
        trust: () => {
          calls.push("trust");
          return { workspace: "/real/workspace", trusted: true, resources: [], trustedWorkspaces: ["/real/workspace"] };
        },
        revoke: () => { calls.push("revoke"); },
        trustedWorkspaces: () => [],
      },
      sessions: {
        require: async () => ({ sessionId: "session" }),
        cwdForSession: () => "/workspace",
        reloadExtensions: async () => { calls.push("reload"); return { state: "ready" }; },
      },
      readBody: async () => ({ sessionId: "session", workspace: displayedWorkspace }),
    } as any;
  }

  it("requires a browser owner session for trust and revoke", async () => {
    const calls: string[] = [];
    const deps = dependencies(calls);

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

  it("rejects approval when the session workspace no longer matches the displayed canonical path", async () => {
    const calls: string[] = [];
    const res = response();
    await handleWorkspaceExtensionTrustRoute(
      { method: "POST" } as any,
      res,
      new URL("http://localhost/api/extensions/workspace-trust"),
      { ok: true, via: "session", identity: { id: "owner" }, sessionHash: "session" },
      dependencies(calls, "/real/displayed-workspace"),
    );

    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).error).toContain("Workspace changed");
    expect(calls).toEqual([]);
  });
});
