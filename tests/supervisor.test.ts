import { isolatedAuthEnv } from "./auth-isolation.js";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

const projectRoot = new URL("..", import.meta.url).pathname;
const token = "supervisor-test-token";
const supervisors = new Set<ChildProcess>();

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a test port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitFor<T>(
  operation: () => Promise<T | undefined>,
  supervisor: ChildProcess,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await operation().catch(() => undefined);
    if (value !== undefined) return value;
    if (supervisor.exitCode !== null || supervisor.signalCode !== null) {
      throw new Error(`Supervisor exited early: code=${supervisor.exitCode} signal=${supervisor.signalCode}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

async function status(port: number, supervisor: ChildProcess) {
  return waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/__supervisor/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) return undefined;
    return response.json() as Promise<{ childPid?: number; childGeneration: number }>;
  }, supervisor);
}

async function stopSupervisor(supervisor: ChildProcess) {
  if (supervisor.exitCode !== null || supervisor.signalCode !== null) return;
  supervisor.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      supervisor.kill("SIGKILL");
      resolve();
    }, 5_000);
    supervisor.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

afterEach(async () => {
  await Promise.all(Array.from(supervisors, async (supervisor) => {
    supervisors.delete(supervisor);
    await stopSupervisor(supervisor);
  }));
});

describe("pi-web supervisor", () => {
  it("restarts an unexpectedly terminated child without double-spawning on intentional restart", async () => {
    const publicPort = await freePort();
    const childPort = await freePort();
    const supervisor = spawn(process.execPath, ["--import", "tsx", "supervisor.ts"], {
      cwd: projectRoot,
      env: {
        ...isolatedAuthEnv(),
        HOST: "127.0.0.1",
        PORT: String(publicPort),
        PI_WEB_CHILD_PORT: String(childPort),
        PI_WEB_AUTH_MODE: "legacy", PI_WEB_TOKEN: token,
        PI_WEB_MOCK: "1",
        PI_WEB_NO_SESSION: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    supervisors.add(supervisor);

    const initial = await status(publicPort, supervisor);
    expect(initial.childPid).toBeTypeOf("number");
    process.kill(initial.childPid!, "SIGTERM");

    const recovered = await waitFor(async () => {
      const current = await status(publicPort, supervisor);
      if (current.childGeneration <= initial.childGeneration || current.childPid === initial.childPid) return undefined;
      const response = await fetch(`http://127.0.0.1:${publicPort}/api/state`, {
        headers: { authorization: `Bearer ${token}` },
      });
      return response.ok ? current : undefined;
    }, supervisor);
    expect(recovered.childGeneration).toBe(initial.childGeneration + 1);

    const restartResponse = await fetch(`http://127.0.0.1:${publicPort}/api/restart`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(restartResponse.status).toBe(202);

    const intentionallyRestarted = await waitFor(async () => {
      const current = await status(publicPort, supervisor);
      return current.childGeneration > recovered.childGeneration && current.childPid !== recovered.childPid
        ? current
        : undefined;
    }, supervisor);
    expect(intentionallyRestarted.childGeneration).toBe(recovered.childGeneration + 1);

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect((await status(publicPort, supervisor)).childGeneration).toBe(intentionallyRestarted.childGeneration);
  }, 20_000);
});
