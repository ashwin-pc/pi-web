import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
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
  async function loadWithPolicy(defaultProjectTrust?: "ask" | "always" | "never", saved?: boolean) {
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
    if (defaultProjectTrust) {
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust }));
    }
    if (saved !== undefined) new ProjectTrustStore(agentDir).set(workspace, saved);
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
    return readFile(marker, "utf8");
  }

  it.each([
    ["default ask", undefined, undefined, false],
    ["global never", "never", undefined, false],
    ["global always", "always", undefined, true],
    ["saved deny over global always", "always", false, false],
    ["saved grant over global never", "never", true, true],
  ] as const)("loads resources according to %s", async (_label, policy, saved, projectLoaded) => {
    const executed = await loadWithPolicy(policy, saved);
    expect(executed).toContain("global");
    expect(executed.includes("workspace")).toBe(projectLoaded);
    expect(executed.includes("package")).toBe(projectLoaded);
  });
});
