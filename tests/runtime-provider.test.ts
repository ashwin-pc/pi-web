import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StdioRunnerProvider } from "../server/runtime/stdioProvider.js";
import { DockerRunnerProvider } from "../server/runtime/dockerProvider.js";
import { CommandRunnerProvider } from "../server/runtime/commandProvider.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-runtime-provider-"));
  tempDirs.push(dir);
  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "README.md"), "runtime provider\n");
  return dir;
}

describe("StdioRunnerProvider", () => {
  it("can create, inspect, and reopen a runtime-owned pi session", async () => {
    const cwd = await tempWorkspace();
    const provider = new StdioRunnerProvider({ cwd, agentDir: join(cwd, ".pi", "agent") });
    try {
      await expect(provider.health()).resolves.toMatchObject({ ok: true, cwd });
      await expect(provider.listDirectories()).resolves.toMatchObject({ path: cwd });
      const created = await provider.createSession();
      expect(created).toMatchObject({ ok: true, cwd, isStreaming: false });
      await expect(provider.listSessions()).resolves.toMatchObject({ ok: true, total: 1, sessions: [{ sessionId: created.sessionId, cwd }] });
      await expect(provider.state(created.sessionId)).resolves.toMatchObject({ ok: true, sessionId: created.sessionId, cwd });
      await expect(provider.messages(created.sessionId)).resolves.toMatchObject({ ok: true, sessionId: created.sessionId });
      await expect(provider.start().request("artifacts.write", { cwd, name: "hello.txt", text: "artifact from runner" })).resolves.toMatchObject({ ok: true });
      await expect(provider.readArtifactBase64(cwd, "hello.txt")).resolves.toMatchObject({ ok: true, name: "hello.txt", base64: Buffer.from("artifact from runner").toString("base64") });
      await expect(provider.abort(created.sessionId)).resolves.toMatchObject({ ok: true, sessionId: created.sessionId });
      const sessionFile = created.sessionFile;
      provider.stop();

      const reopenedProvider = new StdioRunnerProvider({ cwd, agentDir: join(cwd, ".pi", "agent") });
      try {
        reopenedProvider.rememberSession(created.sessionId, sessionFile, cwd);
        await expect(reopenedProvider.state(created.sessionId)).resolves.toMatchObject({ ok: true, sessionId: created.sessionId, cwd });
      } finally {
        reopenedProvider.stop();
      }
    } finally {
      provider.stop();
    }
  }, 60_000);
});

describe("CommandRunnerProvider", () => {
  it("can use an arbitrary command transport", async () => {
    const cwd = await tempWorkspace();
    const provider = new CommandRunnerProvider({ id: "cmd:test", label: "Command test", command: process.execPath, args: ["--import", "tsx", "server/runner.ts"], cwd, kind: "local", env: { ...process.env, PI_RUNNER_CWD: cwd, PI_CODING_AGENT_DIR: join(cwd, ".pi", "agent") } });
    try {
      await expect(provider.health()).resolves.toMatchObject({ ok: true });
      const created = await provider.createSession();
      expect(created).toMatchObject({ ok: true, cwd });

      const reconnected = new Promise<void>((resolve, reject) => {
        let disconnected = false;
        const timeout = setTimeout(() => { unsubscribe(); reject(new Error("runtime did not reconnect")); }, 10_000);
        const unsubscribe = provider.onStatus((status) => {
          if (status.state === "disconnected") disconnected = true;
          if (!disconnected || status.state !== "connected") return;
          clearTimeout(timeout);
          unsubscribe();
          resolve();
        });
      });
      provider.start().child.kill("SIGTERM");
      await expect(reconnected).resolves.toBeUndefined();
      await expect(provider.state(created.sessionId)).resolves.toMatchObject({ ok: true, sessionId: created.sessionId, cwd });
    } finally {
      provider.stop();
    }
  }, 60_000);
});

describe("DockerRunnerProvider", () => {
  it("builds an isolated docker runner command with one configured workspace mount", async () => {
    const cwd = await tempWorkspace();
    const provider = new DockerRunnerProvider({ appDir: "/app-src", hostWorkspace: cwd, containerWorkspace: "/workspace", image: "node:test", network: "none", readOnly: true, envAllowlist: ["SHOULD_NOT_EXIST"] });
    const args = provider.dockerArgs();
    expect(args).toContain("--network");
    expect(args).toContain("none");
    expect(args).toContain(`${cwd}:/workspace:ro`);
    expect(args).toContain(`${provider.sessionVolume}:/root/.pi/agent`);
    expect(provider.metadata).toMatchObject({ sessionPersistence: "volume", sessionVolume: provider.sessionVolume });
    expect(args).not.toContain(process.env.HOME || "");
    expect(args.at(-4)).toBe("node:test");
  });
});
