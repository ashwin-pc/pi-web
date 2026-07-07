import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { StdioRuntimeClient } from "../server/runtime/stdioClient.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function tempRepo() {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-runtime-runner-"));
  tempDirs.push(dir);
  await mkdir(join(dir, "src"));
  await mkdir(join(dir, "docs"));
  await writeFile(join(dir, "README.md"), "runtime spike\n");
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: dir });
  await execFileAsync("git", ["add", "README.md"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

function createClient(cwd: string) {
  return new StdioRuntimeClient(process.execPath, ["--import", "tsx", "server/runner.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, PI_RUNNER_CWD: cwd },
  });
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("runtime runner spike", () => {
  it("serves health, filesystem, git, artifacts, and events over stdio", async () => {
    const cwd = await tempRepo();
    const client = createClient(cwd);
    const ready = new Promise((resolve) => client.onEvent((event) => event.event === "ready" && resolve(event)));
    try {
      await expect(ready).resolves.toMatchObject({ event: "ready" });
      await expect(client.request("health")).resolves.toMatchObject({ ok: true, cwd, protocol: "pi-runner-v1" });

      const listing = await client.request<any>("fs.list", { path: cwd });
      expect(listing.dirs.map((dir: any) => dir.name)).toEqual(["docs", "src"]);

      const status = await client.request<any>("git.status", { cwd });
      expect(status).toMatchObject({ ok: true, cwd, isRepo: true });

      await expect(client.request("artifacts.write", { cwd, name: "spike.txt", text: "hello from runner" })).resolves.toMatchObject({ ok: true, name: "spike.txt" });
      await expect(client.request("artifacts.read", { cwd, name: "spike.txt" })).resolves.toMatchObject({ ok: true, name: "spike.txt", text: "hello from runner" });

      const created = await client.request<any>("sessions.create", { cwd });
      expect(created).toMatchObject({ ok: true, cwd, isStreaming: false, isCompacting: false });
      expect(created.sessionId).toBeTruthy();
      await expect(client.request("sessions.state", { sessionId: created.sessionId })).resolves.toMatchObject({ ok: true, sessionId: created.sessionId, cwd });
      await expect(client.request("sessions.messages", { sessionId: created.sessionId })).resolves.toMatchObject({ ok: true, sessionId: created.sessionId });
      await expect(client.request("sessions.abort", { sessionId: created.sessionId })).resolves.toMatchObject({ ok: true, sessionId: created.sessionId });
    } finally {
      client.close();
    }
  }, 60_000);
});
