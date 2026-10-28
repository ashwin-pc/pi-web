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
  const createLoader = () => new ResilientResourceLoader({
    loaderOptions: {
      cwd: workspace,
      agentDir,
      settingsManager: SettingsManager.create(workspace, agentDir, { projectTrusted: false }),
      additionalExtensionPaths: [],
    },
    resolveProjectTrust: () => trust.isTrusted(workspace),
    resolveAdditionalExtensionPaths: (trusted) => [
      ...resolveGlobalPiWebExtensionPaths(),
      ...trust.extensionPaths(workspace, trusted),
    ],
  });
  return { root, workspace, agentDir, marker, packageDir, trust, loader: createLoader(), createLoader };
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

  it("projects global always for revocation without saving a workspace grant", async () => {
    const root = await tempRoot();
    const workspace = join(root, "workspace");
    const agentDir = join(root, "agent");
    await mkdir(join(workspace, ".pi", "extensions"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(workspace, ".pi", "extensions", "entry.js"), "export default function () {}\n");
    const trust = new WorkspaceExtensionTrust(agentDir);

    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
    expect(trust.isTrusted(workspace)).toBe(true);
    expect(existsSync(join(agentDir, "trust.json"))).toBe(false);
    expect(trust.status(workspace).trustedWorkspaces).toEqual([realWorkspacePath(workspace)]);

    trust.revoke(workspace);
    expect(JSON.parse(await readFile(join(agentDir, "trust.json"), "utf8"))).toEqual({
      [realWorkspacePath(workspace)]: false,
    });
    expect(trust.status(workspace).trustedWorkspaces).toEqual([]);

    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never" }));
    expect(trust.isTrusted(workspace)).toBe(false);
  });

  it("honors a saved denial after protected resources disappear", async () => {
    const root = await tempRoot();
    const workspace = join(root, "workspace");
    const agentDir = join(root, "agent");
    await mkdir(workspace, { recursive: true });
    new ProjectTrustStore(agentDir).set(workspace, false);

    const trust = new WorkspaceExtensionTrust(agentDir);
    expect(trust.requiresTrust(workspace)).toBe(false);
    expect(trust.isTrusted(workspace)).toBe(false);
    expect(trust.status(workspace)).toMatchObject({
      desiredTrusted: false,
      resources: [],
    });
  });

  it("keeps applied trust per session until each session explicitly reloads", async () => {
    const { workspace, marker, trust, loader: loaderA, createLoader } = await fixture();
    const canonicalWorkspace = realWorkspacePath(workspace);
    const response = () => ({
      status: 0,
      body: "",
      writeHead(status: number) { this.status = status; },
      end(value = "") { this.body = value; },
    }) as any;
    const loaderB = createLoader();
    await loaderA.reload();
    await loaderB.reload();
    expect(loaderA.getAppliedProjectTrust()).toBe(false);
    expect(loaderB.getAppliedProjectTrust()).toBe(false);

    const sessions = new Map([
      ["session-a", { sessionId: "session-a", loader: loaderA, isStreaming: false, isCompacting: false }],
      ["session-b", { sessionId: "session-b", loader: loaderB, isStreaming: false, isCompacting: false }],
    ]);
    let body: unknown;
    const broadcasts: unknown[] = [];
    const deps = {
      trust,
      sessions: {
        require: async (sessionId?: string) => sessions.get(sessionId || "session-a")!,
        cwdForSession: () => workspace,
        workspaceTrustState: (session: any) => ({
          appliedTrusted: session.loader.getAppliedProjectTrust(),
          busy: session.isStreaming || session.isCompacting,
        }),
        reloadExtensions: async (sessionId: string) => {
          const session = sessions.get(sessionId)!;
          if (session.isStreaming || session.isCompacting) throw new Error("busy");
          await session.loader.reload();
          return session.loader.getStatus();
        },
      },
      readBody: async () => body,
      broadcast: (value: unknown) => broadcasts.push(value),
    };
    const auth = { ok: true, via: "session", identity: { id: "owner" }, sessionHash: "owner" } as const;

    await rm(marker, { force: true });
    body = { sessionId: "session-a", workspace: canonicalWorkspace };
    const grant = response();
    await handleWorkspaceExtensionTrustRoute(
      { method: "POST" } as any,
      grant,
      new URL("http://localhost/api/extensions/workspace-trust"),
      auth,
      deps,
    );
    expect(grant.status).toBe(200);
    expect(loaderA.getAppliedProjectTrust()).toBe(true);
    expect(loaderB.getAppliedProjectTrust()).toBe(false);
    expect(await readFile(marker, "utf8")).toMatch(/regular|web|package/);

    const pendingGrant = response();
    await handleWorkspaceExtensionTrustRoute(
      { method: "GET" } as any,
      pendingGrant,
      new URL("http://localhost/api/extensions/workspace-trust?sessionId=session-b"),
      auth,
      deps,
    );
    expect(JSON.parse(pendingGrant.body)).toMatchObject({
      desiredTrusted: true,
      appliedTrusted: false,
      pendingReload: true,
      busy: false,
    });

    await deps.sessions.reloadExtensions("session-b");
    expect(loaderB.getAppliedProjectTrust()).toBe(true);

    body = { workspace: canonicalWorkspace, sessionId: "session-a" };
    const revoke = response();
    await handleWorkspaceExtensionTrustRoute(
      { method: "DELETE" } as any,
      revoke,
      new URL("http://localhost/api/extensions/workspace-trust"),
      auth,
      deps,
    );
    expect(revoke.status).toBe(200);
    expect(JSON.parse(revoke.body)).toMatchObject({
      desiredTrusted: false,
      appliedTrusted: true,
      pendingReload: true,
      busy: false,
    });
    for (const sessionId of sessions.keys()) {
      const pendingRevoke = response();
      await handleWorkspaceExtensionTrustRoute(
        { method: "GET" } as any,
        pendingRevoke,
        new URL(`http://localhost/api/extensions/workspace-trust?sessionId=${sessionId}`),
        auth,
        deps,
      );
      expect(JSON.parse(pendingRevoke.body)).toMatchObject({
        desiredTrusted: false,
        appliedTrusted: true,
        pendingReload: true,
      });
    }

    const sessionB = sessions.get("session-b")!;
    sessionB.isStreaming = true;
    await expect(deps.sessions.reloadExtensions("session-b")).rejects.toThrow("busy");
    expect(loaderB.getAppliedProjectTrust()).toBe(true);

    sessionB.isStreaming = false;
    await rm(marker, { force: true });
    await deps.sessions.reloadExtensions("session-b");
    expect(loaderB.getAppliedProjectTrust()).toBe(false);
    const afterRevoke = existsSync(marker) ? (await readFile(marker, "utf8")).trim().split("\n") : [];
    expect(afterRevoke).not.toContain("regular");
    expect(afterRevoke).not.toContain("web");
    expect(afterRevoke).not.toContain("package");
    expect(broadcasts).toEqual([
      { type: "workspace_trust_changed", workspace: canonicalWorkspace },
      { type: "workspace_trust_changed", workspace: canonicalWorkspace },
    ]);
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
    let trusted = false;
    let appliedTrusted = false;
    return {
      trust: {
        status: () => ({
          workspace: "/real/workspace",
          trusted,
          desiredTrusted: trusted,
          resources: [{ kind: "extension", path: ".pi/extensions/demo.js" }],
          trustedWorkspaces: trusted ? ["/real/workspace"] : [],
        }),
        trust: () => {
          calls.push("trust");
          trusted = true;
          return { workspace: "/real/workspace", trusted: true, desiredTrusted: true, resources: [], trustedWorkspaces: ["/real/workspace"] };
        },
        revoke: () => { calls.push("revoke"); },
        trustedWorkspaces: () => [],
      },
      sessions: {
        require: async () => ({ sessionId: "session" }),
        cwdForSession: () => "/workspace",
        workspaceTrustState: () => ({ appliedTrusted, busy: false }),
        reloadExtensions: async () => {
          calls.push("reload");
          appliedTrusted = trusted;
          return { state: "ready" };
        },
      },
      readBody: async () => ({ sessionId: "session", workspace: displayedWorkspace }),
      broadcast: () => { calls.push("broadcast"); },
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
    expect(calls).toEqual(["trust", "broadcast", "reload"]);
    expect(JSON.parse(res.body)).toMatchObject({
      desiredTrusted: true,
      appliedTrusted: true,
      pendingReload: false,
      busy: false,
    });
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
