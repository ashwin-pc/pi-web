import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { ResilientResourceLoader } from "../server/extensions/resilientLoader.js";
import { WorkspaceExtensionTrust } from "../server/extensions/workspaceTrust.js";
import { handleWorkspaceExtensionTrustRoute } from "../server/extensions/workspaceTrustRoute.js";
import { LocalSessionService } from "../server/session/service.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function extensionSource(marker: string, label: string) {
  return `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`${label}\n`)});
export default function () {}
`;
}

describe("workspace trust reload errors", () => {
  it("applies trust policy despite unrelated global extension errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-trust-reload-errors-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const agentDir = join(root, "agent");
    const marker = join(root, "executed.txt");
    await mkdir(join(workspace, ".pi", "extensions"), { recursive: true });
    await mkdir(join(workspace, ".pi", "web", "extensions"), { recursive: true });
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(join(workspace, ".pi", "extensions", "regular.js"), extensionSource(marker, "regular"));
    await writeFile(join(workspace, ".pi", "web", "extensions", "web.js"), extensionSource(marker, "web"));
    await writeFile(join(agentDir, "extensions", "broken.js"), "export default function (\n");

    const trust = new WorkspaceExtensionTrust(agentDir);
    const loader = new ResilientResourceLoader({
      loaderOptions: {
        cwd: workspace,
        agentDir,
        settingsManager: SettingsManager.create(workspace, agentDir, { projectTrusted: false }),
        additionalExtensionPaths: [],
      },
      resolveProjectTrust: () => trust.isTrusted(workspace),
      resolveAdditionalExtensionPaths: (trusted) => trust.extensionPaths(workspace, trusted),
    });
    const session = { sessionId: "session", isStreaming: false, isCompacting: false };
    const serviceAdapter = {
      productionFactory: { loaderFor: () => loader },
    };
    const routeStatus = async () => {
      const res = {
        status: 0,
        body: "",
        writeHead(status: number) { this.status = status; },
        end(value = "") { this.body = value; },
      } as any;
      await handleWorkspaceExtensionTrustRoute(
        { method: "GET" } as any,
        res,
        new URL("http://localhost/api/extensions/workspace-trust?sessionId=session"),
        { ok: true, via: "session", identity: { id: "owner" }, sessionHash: "owner" },
        {
          trust,
          sessions: {
            require: async () => session,
            cwdForSession: () => workspace,
            workspaceTrustState: (value) => LocalSessionService.prototype.workspaceTrustState.call(
              serviceAdapter as any,
              value,
            ),
            reloadExtensions: async () => loader.getStatus(),
          },
          readBody: async () => undefined,
          broadcast: () => undefined,
        },
      );
      return JSON.parse(res.body);
    };
    const expectBrokenGlobalHealth = () => {
      expect(loader.getStatus().state).toBe("degraded");
      expect(loader.getStatus().errors.some((error) => error.path.includes("broken.js"))).toBe(true);
    };

    await loader.reload();
    expect(loader.getAppliedProjectTrust()).toBe(false);
    expectBrokenGlobalHealth();

    trust.trust(workspace);
    await rm(marker, { force: true });
    await loader.reload();
    expect(loader.getAppliedProjectTrust()).toBe(true);
    expectBrokenGlobalHealth();
    const trustedExecution = await readFile(marker, "utf8");
    expect(trustedExecution).toContain("regular");
    expect(trustedExecution).toContain("web");
    expect(await routeStatus()).toMatchObject({
      desiredTrusted: true,
      appliedTrusted: true,
      pendingReload: false,
    });

    trust.revoke(workspace);
    await rm(marker, { force: true });
    await loader.reload();
    expect(loader.getAppliedProjectTrust()).toBe(false);
    expectBrokenGlobalHealth();
    const revokedExecution = existsSync(marker) ? await readFile(marker, "utf8") : "";
    expect(revokedExecution).not.toContain("regular");
    expect(revokedExecution).not.toContain("web");
    expect(await routeStatus()).toMatchObject({
      desiredTrusted: false,
      appliedTrusted: false,
      pendingReload: false,
    });
  });
});
