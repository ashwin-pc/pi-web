import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePiWebExtensionPaths } from "../server/extensions.js";
import { ResilientResourceLoader } from "../server/extensions/resilientLoader.js";

const roots: string[] = [];

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

describe("workspace web extension safe default", () => {
  it("loads global extensions without executing untrusted workspace extensions", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-extension-default-deny-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const webHome = join(root, "web-home");
    const marker = join(root, "executed.txt");
    await mkdir(join(workspace, ".pi", "web", "extensions"), { recursive: true });
    await mkdir(join(webHome, "extensions"), { recursive: true });
    await writeFile(
      join(workspace, ".pi", "web", "extensions", "workspace.js"),
      extensionSource(marker, "workspace"),
    );
    await writeFile(
      join(webHome, "extensions", "global.js"),
      extensionSource(marker, "global"),
    );
    vi.stubEnv("PI_WEB_HOME", webHome);

    const loader = new ResilientResourceLoader({
      loaderOptions: {
        cwd: workspace,
        agentDir: join(root, "agent"),
        additionalExtensionPaths: resolvePiWebExtensionPaths(workspace),
      },
    });
    await loader.reload();

    expect(existsSync(marker)).toBe(true);
    const executed = await readFile(marker, "utf8");
    expect(executed).toContain("global");
    expect(executed).not.toContain("workspace");
  });
});
