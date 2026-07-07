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
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", PI_WEB_CWD: cwd, PI_WEB_NO_SESSION: "1", PI_WEB_TOKEN: "", PI_WEB_RUNTIMES_FILE: join(cwd, ".pi", "web", "runtimes.json"), PI_WEB_RUNTIME_BINDINGS_FILE: join(cwd, ".pi", "web", "runtime-bindings.json") },
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

    const connected = await (await fetch(`${baseUrl}/api/runtimes/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "cmd-api", label: "Command API", command: process.execPath, args: ["--import", "tsx", "server/runner.ts"], cwd, kind: "local" }),
    })).json() as any;
    expect(connected).toMatchObject({ ok: true, runtime: { id: "cmd-api", label: "Command API" } });
    const updatedRuntimes = await (await fetch(`${baseUrl}/api/runtimes`)).json() as any;
    expect(updatedRuntimes.runtimes.some((runtime: any) => runtime.id === "cmd-api")).toBe(true);

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

    const state = await (await fetch(`${baseUrl}/api/state?sessionId=${encodeURIComponent(created.sessionId)}`)).json() as any;
    expect(state).toMatchObject({ ok: true, sessionId: created.sessionId, cwd, runtimeRef: { id: "cmd-api" } });

    const listed = await (await fetch(`${baseUrl}/api/sessions?cwd=${encodeURIComponent(cwd)}`)).json() as any;
    const listedRuntimeSession = listed.sessions.find((item: any) => item.id === created.sessionId);
    expect(listedRuntimeSession).toMatchObject({ id: created.sessionId, cwd, runtimeRef: { id: "cmd-api" } });

    const opened = await (await fetch(`${baseUrl}/api/sessions/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: created.sessionId, cwd }),
    })).json() as any;
    expect(opened).toMatchObject({ ok: true, sessionId: created.sessionId, runtimeRef: { id: "cmd-api" } });

    const inherited = await (await fetch(`${baseUrl}/api/sessions/new`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: created.sessionId }),
    })).json() as any;
    expect(inherited).toMatchObject({ ok: true, runtimeRef: { id: "cmd-api" }, cwd });

    const git = await (await fetch(`${baseUrl}/api/git/status?sessionId=${encodeURIComponent(created.sessionId)}`)).json() as any;
    expect(git).toMatchObject({ ok: true, cwd });

    const diff = await (await fetch(`${baseUrl}/api/git/diff?sessionId=${encodeURIComponent(created.sessionId)}&path=README.md`)).json() as any;
    expect(diff).toMatchObject({ ok: true, path: "README.md" });
    expect(diff.diff).toContain("after");

    const messages = await (await fetch(`${baseUrl}/api/messages?sessionId=${encodeURIComponent(created.sessionId)}`)).json() as any;
    expect(messages).toMatchObject({ ok: true });
    expect(Array.isArray(messages.messages)).toBe(true);

    const prompt = await fetch(`${baseUrl}/api/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: created.sessionId, message: "Say hello" }),
    });
    expect(prompt.status).toBe(202);

    const abort = await fetch(`${baseUrl}/api/abort`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: created.sessionId }),
    });
    expect(abort.status).toBe(202);
  }, 60_000);
});
