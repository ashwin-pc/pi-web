import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

let child: ChildProcess;
let baseUrl = "";
let cwd = "";

async function waitForServer(url: string) {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    try {
      const res = await fetch(`${url}/api/runtimes`);
      if (res.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("server did not start");
}

async function freePort() {
  return new Promise<number>((resolve) => {
    const server: Server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "pi-web-runtime-api-"));
  await writeFile(join(cwd, "README.md"), "before\n");
  await execFileAsync("git", ["init"], { cwd });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd });
  await execFileAsync("git", ["add", "README.md"], { cwd });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd });
  await writeFile(join(cwd, "README.md"), "after\n");
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", PI_WEB_CWD: cwd, PI_WEB_NO_SESSION: "1", PI_WEB_TOKEN: "", PI_WEB_LOCAL_RUNNER: "1", PI_WEB_ALLOW_CUSTOM_RUNTIMES: "1", PI_CODING_AGENT_DIR: join(cwd, ".pi", "agent"), PI_WEB_RUNTIMES_FILE: join(cwd, ".pi", "web", "runtimes.json"), PI_WEB_RUNTIME_BINDINGS_FILE: join(cwd, ".pi", "web", "runtime-bindings.json") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", () => undefined);
  child.stderr?.on("data", () => undefined);
  await waitForServer(baseUrl);
}, 60_000);

afterAll(async () => {
  child?.kill("SIGTERM");
  await rm(cwd, { recursive: true, force: true });
});

describe("experimental runtime API integration", () => {
  it("creates a runner-owned session and accesses it through normal state/messages/prompt/abort routes", async () => {
    const runtimes = await (await fetch(`${baseUrl}/api/runtimes`)).json() as any;
    expect(runtimes.runtimes.some((runtime: any) => runtime.id === "local-runner")).toBe(true);

    const missingModelDecision = await fetch(`${baseUrl}/api/runtimes/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "missing-model-choice", label: "Missing choice", command: process.execPath, args: [], cwd, kind: "local" }),
    });
    expect(missingModelDecision.status).toBe(400);
    await expect(missingModelDecision.json()).resolves.toMatchObject({ error: expect.stringMatching(/modelBroker is required/) });

    const unsafeGuided = await fetch(`${baseUrl}/api/runtimes/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "ssh:unsafe", label: "Unsafe", adapter: "ssh", target: "devbox; touch /tmp/nope", cwd, runnerDir: cwd, modelBroker: false }),
    });
    expect(unsafeGuided.status).toBe(400);
    await expect(unsafeGuided.json()).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/host alias/) });

    const connected = await (await fetch(`${baseUrl}/api/runtimes/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "cmd-api", label: "Command API", command: process.execPath, args: ["--import", "tsx", "server/runner.ts"], cwd, kind: "local", modelBroker: false }),
    })).json() as any;
    expect(connected).toMatchObject({ ok: true, runtime: { id: "cmd-api", label: "Command API" } });
    const updatedRuntimes = await (await fetch(`${baseUrl}/api/runtimes`)).json() as any;
    expect(updatedRuntimes.runtimes.find((runtime: any) => runtime.id === "cmd-api")).toMatchObject({
      capabilities: { messageBranching: true, sessionRename: false, slashCommands: false, shellCommands: false, sessionStats: false, gitPanel: false, gitSync: false, extensionUi: false, compactionCancel: false },
    });

    const brokered = await (await fetch(`${baseUrl}/api/runtimes/model-access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "cmd-api", modelBroker: true }),
    })).json() as any;
    expect(brokered).toMatchObject({ ok: true, runtime: { id: "cmd-api", modelTransport: "host-broker" } });
    const runtimeOwned = await (await fetch(`${baseUrl}/api/runtimes/model-access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "cmd-api", modelBroker: false }),
    })).json() as any;
    expect(runtimeOwned).toMatchObject({ ok: true, runtime: { id: "cmd-api", modelTransport: "runtime" } });

    const dirs = await (await fetch(`${baseUrl}/api/fs/dirs?path=${encodeURIComponent(cwd)}&runtimeId=cmd-api`)).json() as any;
    expect(dirs.path).toBe(cwd);

    const created = await (await fetch(`${baseUrl}/api/sessions/new`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runtimeId: "cmd-api", cwd }),
    })).json() as any;
    expect(created.ok).toBe(true);
    expect(created.runtimeRef.id).toBe("cmd-api");
    expect(created.sessionId).toBeTruthy();

    const runtimeHeaders = { "x-pi-web-runtime-id": "cmd-api" };
    const removedWhileOnline = await (await fetch(`${baseUrl}/api/sessions/remove`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: created.sessionId, runtimeId: "cmd-api" }),
    })).json() as any;
    expect(removedWhileOnline).toMatchObject({ ok: true, disposition: "removed" });

    // An explicit runtime route can rediscover authoritative data after its local locator was removed.
    const state = await (await fetch(`${baseUrl}/api/state?sessionId=${encodeURIComponent(created.sessionId)}`, { headers: runtimeHeaders })).json() as any;
    expect(state).toMatchObject({ ok: true, sessionId: created.sessionId, cwd, runtimeRef: { id: "cmd-api" } });

    const cached = await (await fetch(`${baseUrl}/api/sessions?runtimeId=cmd-api&cached=1`)).json() as any;
    expect(cached.sessions.find((item: any) => item.id === created.sessionId)).toMatchObject({ id: created.sessionId, cwd, runtimeRef: { id: "cmd-api" } });
    const listed = await (await fetch(`${baseUrl}/api/sessions?runtimeId=cmd-api&limit=100`)).json() as any;
    const listedRuntimeSession = listed.sessions.find((item: any) => item.id === created.sessionId);
    expect(listedRuntimeSession).toMatchObject({ id: created.sessionId, cwd, runtimeRef: { id: "cmd-api" } });
    expect(listed.runtimeId).toBe("cmd-api");

    const opened = await (await fetch(`${baseUrl}/api/sessions/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: created.sessionId, runtimeId: "cmd-api", cwd }),
    })).json() as any;
    expect(opened).toMatchObject({ ok: true, sessionId: created.sessionId, runtimeRef: { id: "cmd-api" } });

    const inherited = await (await fetch(`${baseUrl}/api/sessions/new`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: created.sessionId, runtimeId: "cmd-api" }),
    })).json() as any;
    expect(inherited).toMatchObject({ ok: true, runtimeRef: { id: "cmd-api" }, cwd });

    const git = await (await fetch(`${baseUrl}/api/git/status?sessionId=${encodeURIComponent(created.sessionId)}`, { headers: runtimeHeaders })).json() as any;
    expect(git).toMatchObject({ ok: true, cwd });

    const diff = await (await fetch(`${baseUrl}/api/git/diff?sessionId=${encodeURIComponent(created.sessionId)}&path=README.md`, { headers: runtimeHeaders })).json() as any;
    expect(diff).toMatchObject({ ok: true, path: "README.md" });
    expect(diff.diff).toContain("after");

    const messages = await (await fetch(`${baseUrl}/api/messages?sessionId=${encodeURIComponent(created.sessionId)}`, { headers: runtimeHeaders })).json() as any;
    expect(messages).toMatchObject({ ok: true });
    expect(Array.isArray(messages.messages)).toBe(true);

    const prompt = await fetch(`${baseUrl}/api/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json", ...runtimeHeaders },
      body: JSON.stringify({ sessionId: created.sessionId, message: "Say hello" }),
    });
    expect(prompt.status).toBe(202);

    const abort = await fetch(`${baseUrl}/api/abort`, {
      method: "POST",
      headers: { "content-type": "application/json", ...runtimeHeaders },
      body: JSON.stringify({ sessionId: created.sessionId }),
    });
    expect(abort.status).toBe(202);

    const deleted = await (await fetch(`${baseUrl}/api/sessions/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: created.sessionId, runtimeId: "cmd-api" }),
    })).json() as any;
    expect(deleted).toMatchObject({ ok: true, id: created.sessionId, disposition: "deleted" });
    const afterDelete = await (await fetch(`${baseUrl}/api/sessions?runtimeId=cmd-api`)).json() as any;
    expect(afterDelete.sessions.some((item: any) => item.id === created.sessionId)).toBe(false);

    const disconnected = await (await fetch(`${baseUrl}/api/runtimes/disconnect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "cmd-api" }),
    })).json() as any;
    expect(disconnected).toMatchObject({ ok: true, id: "cmd-api", removedLocators: expect.any(Number) });
    expect(disconnected.removedLocators).toBeGreaterThan(0);

    // A stale or omitted runtime route must never let former locator metadata
    // hijack a local session after the runtime is forgotten.
    const implicitLocalResponse = await fetch(`${baseUrl}/api/state?sessionId=${encodeURIComponent(inherited.sessionId)}`);
    const implicitLocal = await implicitLocalResponse.json() as any;
    expect(implicitLocalResponse.status).not.toBe(503);
    expect(String(implicitLocal.error || "")).not.toContain("cmd-api");

    const unavailableDeleteResponse = await fetch(`${baseUrl}/api/sessions/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: inherited.sessionId, runtimeId: "cmd-api" }),
    });
    expect(unavailableDeleteResponse.status).toBe(503);
    await expect(unavailableDeleteResponse.json()).resolves.toMatchObject({ ok: false, runtimeId: "cmd-api" });

    const forgotten = await (await fetch(`${baseUrl}/api/sessions?runtimeId=cmd-api&cached=1`)).json() as any;
    expect(forgotten.sessions).toEqual([]);
    const removedAfterForget = await fetch(`${baseUrl}/api/sessions/remove`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: inherited.sessionId, runtimeId: "cmd-api" }),
    });
    expect(removedAfterForget.status).toBe(404);
  }, 60_000);
});
