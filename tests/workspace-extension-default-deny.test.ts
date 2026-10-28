import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiSessionFactory } from "../server/session/piFactory.js";

vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
  ...await original<typeof import("@earendil-works/pi-coding-agent")>(),
  createAgentSession: vi.fn(async (input: any) => ({
    session: { sessionManager: input.sessionManager },
  })),
}));

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

describe("PiSessionFactory project trust default", () => {
  it("loads an explicit global extension without executing project extensions or packages", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-project-default-deny-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const agentDir = join(root, "agent");
    const marker = join(root, "executed.txt");
    const regularExtension = join(workspace, ".pi", "extensions", "workspace.js");
    const packageDir = join(workspace, "local-package");
    const packageExtension = join(packageDir, "extension.js");
    const globalExtension = join(root, "global.js");

    await mkdir(join(workspace, ".pi", "extensions"), { recursive: true });
    await mkdir(packageDir, { recursive: true });
    await writeFile(regularExtension, extensionSource(marker, "workspace"));
    await writeFile(packageExtension, extensionSource(marker, "package"));
    await writeFile(join(packageDir, "package.json"), JSON.stringify({
      name: "local-project-extension",
      version: "1.0.0",
      pi: { extensions: ["./extension.js"] },
    }));
    await writeFile(join(workspace, ".pi", "settings.json"), JSON.stringify({
      packages: ["../local-package"],
    }));
    await writeFile(globalExtension, extensionSource(marker, "global"));
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);

    const factory = new PiSessionFactory({
      noSession: true,
      modelRuntime: {} as any,
      additionalExtensionPaths: () => [globalExtension],
      sessionCwd: (manager) => String(manager.getCwd() || workspace),
      rememberCwd: () => undefined,
      readSession: async () => { throw new Error("not used"); },
    });
    await factory.create({ cwd: workspace });

    expect(existsSync(marker)).toBe(true);
    const executed = await readFile(marker, "utf8");
    expect(executed).toContain("global");
    expect(executed).not.toContain("workspace");
    expect(executed).not.toContain("package");
  });
});
