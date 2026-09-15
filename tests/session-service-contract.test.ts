import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { RemoteSessionService } from "../server/session/remoteService.js";
import { createDeterministicLocalSessionService } from "./fixtures/deterministic-session-service.js";
import { describeSessionService, type ServiceHarness } from "./fixtures/session-service-contract.js";

const dirs: string[] = []; const children = new Set<ChildProcessWithoutNullStreams>();
afterEach(async () => { for (const child of children) child.kill(); children.clear(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function cwd() { const value = await mkdtemp(join(tmpdir(), "session-contract-")); dirs.push(value); return value; }
function childProcess(directory: string, build = "contract-build") {
  const child = spawn(process.execPath, ["--import", "tsx", join(process.cwd(), "tests/fixtures/session-runner-child.ts")], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, SESSION_FIXTURE_CWD: directory, SESSION_FIXTURE_BUILD: build } }); children.add(child); return child;
}
async function localHarness(): Promise<ServiceHarness> { const value = await createDeterministicLocalSessionService(await cwd()); return { service: value.service, initialId: value.initialId, close: async () => value.service.disposeAll("reset") }; }
async function remoteHarness(): Promise<ServiceHarness & { child: ChildProcessWithoutNullStreams }> { const child = childProcess(await cwd()); const service = await RemoteSessionService.connect(child, "contract-build"); return { service, child, initialId: "initial", close: async () => { child.kill(); children.delete(child); } }; }

describeSessionService("SessionService contract in process", localHarness);
describeSessionService("SessionService contract over spawned NDJSON runner", remoteHarness);

describe("spawned session runner transport", () => {
  it("fails closed on build mismatch", async () => { const child = childProcess(await cwd(), "runner-build"); await expect(RemoteSessionService.connect(child, "host-build")).rejects.toThrow(/Incompatible session runner/); });
  it("rejects pending work when the child exits", async () => { const h = await remoteHarness(); const pending = h.service.state("initial"); h.child.kill("SIGKILL"); await expect(pending).rejects.toThrow(/closed|exited/); });
  it("omits an undefined optional thinking level rather than sending null", async () => {
    const h = await remoteHarness();
    try {
      await h.service.setModel("initial", "fixture", "deterministic", undefined);
      expect((await h.service.state("initial")).thinkingLevel).toBe("medium");
    } finally {
      await h.close();
    }
  });
});
