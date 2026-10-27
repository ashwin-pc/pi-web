import { isolatedAuthEnv } from "./auth-isolation.js";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { AuthStore, hashSecret } from "../server/auth/kernel.js";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

const projectRoot = process.env.PI_WEB_TEST_SOURCE_ROOT || new URL("..", import.meta.url).pathname;
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

async function status(port: number, supervisor: ChildProcess, secret: string, host?: string) {
  let last = "no response";
  return waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/__supervisor/status`, {
      headers: { authorization: `Bearer ${secret}`, ...(host ? { host } : {}) },
    });
    last = `HTTP ${response.status}: ${await response.clone().text()}`;
    if (!response.ok) return undefined;
    return response.json() as Promise<{ childPid?: number; childGeneration: number }>;
  }, supervisor).catch(error => {
    throw new Error(`${String(error)}; last supervisor status: ${last}`);
  });
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

function rawStatus(port: number, host: string, authorization: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path: "/api/state",
      headers: { host, authorization },
    }, response => {
      response.resume();
      response.once("end", () => resolve(response.statusCode || 0));
    });
    request.once("error", reject);
    request.end();
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
    const authEnv = isolatedAuthEnv();
    const machineSecret = "synthetic-supervisor-machine";
    const store = new AuthStore(authEnv.PI_WEB_AUTH_STORE!);
    await store.update(s => {
      s.config = { policy: "authenticated", methods: [] };
      s.apiTokens.push({ id: "supervisor", name: "supervisor", hash: hashSecret(machineSecret), createdAt: Date.now(), expiresAt: Date.now() + 60_000 });
    });
    const env = {
      ...authEnv,
      HOST: "127.0.0.1",
      PORT: String(publicPort),
      PI_WEB_CHILD_PORT: String(childPort),
      PI_WEB_AUTH_MODE: "none",
      PI_WEB_MOCK: "1",
      PI_WEB_NO_SESSION: "1",
    };
    delete env.PI_WEB_TOKEN;
    const supervisor = spawn(process.execPath, ["--import", "tsx", "supervisor.ts"], {
      cwd: projectRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    supervisors.add(supervisor);

    const initial = await status(publicPort, supervisor, machineSecret);
    expect(initial.childPid).toBeTypeOf("number");
    process.kill(initial.childPid!, "SIGTERM");

    const recovered = await waitFor(async () => {
      const current = await status(publicPort, supervisor, machineSecret);
      if (current.childGeneration <= initial.childGeneration || current.childPid === initial.childPid) return undefined;
      const response = await fetch(`http://127.0.0.1:${publicPort}/api/state`, {
        headers: { authorization: `Bearer ${machineSecret}` },
      });
      return response.ok ? current : undefined;
    }, supervisor);
    expect(recovered.childGeneration).toBe(initial.childGeneration + 1);

    process.kill(recovered.childPid!, "SIGSTOP");
    try {
      const denied = await fetch(`http://127.0.0.1:${publicPort}/__supervisor/status`);
      expect(denied.status).toBe(401);
      const allowed = await fetch(`http://127.0.0.1:${publicPort}/__supervisor/status`, { headers: { authorization: `Bearer ${machineSecret}` }, signal: AbortSignal.timeout(2000) });
      expect(allowed.status).toBe(200);
    } finally { process.kill(recovered.childPid!, "SIGCONT"); }

    const restartResponse = await fetch(`http://127.0.0.1:${publicPort}/api/restart`, {
      method: "POST",
      headers: { authorization: `Bearer ${machineSecret}` },
    });
    expect(restartResponse.status).toBe(202);

    const intentionallyRestarted = await waitFor(async () => {
      const current = await status(publicPort, supervisor, machineSecret);
      return current.childGeneration > recovered.childGeneration && current.childPid !== recovered.childPid
        ? current
        : undefined;
    }, supervisor);
    expect(intentionallyRestarted.childGeneration).toBe(recovered.childGeneration + 1);

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect((await status(publicPort, supervisor, machineSecret)).childGeneration).toBe(intentionallyRestarted.childGeneration);
  }, 20_000);

  it("preserves the external, machine, browser WebSocket, restart, and public-origin contracts", async () => {
    const publicPort = await freePort();
    const childPort = await freePort();
    const publicHost = `pi.example.test:${publicPort}`;
    const publicOrigin = `https://${publicHost}`;
    const authEnv = isolatedAuthEnv();
    const machineSecret = "synthetic-api-machine";
    const store = new AuthStore(authEnv.PI_WEB_AUTH_STORE!);
    await store.update(s => {
      s.config = { policy: "authenticated", methods: ["external"] };
      s.apiTokens.push({ id: "machine", name: "machine", hash: hashSecret(machineSecret), createdAt: Date.now(), expiresAt: Date.now() + 60_000 });
    });
    const env = {
      ...authEnv,
      HOST: "127.0.0.1",
      PORT: String(publicPort),
      PI_WEB_CHILD_PORT: String(childPort),
      PI_WEB_AUTH_MODE: "external",
      PI_WEB_AUTH_METHODS: "external",
      PI_WEB_AUTH_TRUSTED_HEADER: "x-amzn-tunnel-user",
      PI_WEB_AUTH_ORIGIN: publicOrigin,
      PI_WEB_MOCK: "1",
      PI_WEB_DEV: "0",
      NODE_ENV: "test",
    };
    delete env.PI_WEB_TOKEN;
    const supervisor = spawn(process.execPath, ["--import", "tsx", "supervisor.ts"], {
      cwd: projectRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    supervisors.add(supervisor);
    const output: string[] = [];
    supervisor.stdout?.on("data", data => output.push(String(data)));
    supervisor.stderr?.on("data", data => output.push(String(data)));

    await status(publicPort, supervisor, machineSecret, publicHost).catch(error => {
      throw new Error(`${String(error)}\n${output.join("")}`);
    });
    const external = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${publicPort}/api/state`, {
        headers: {
          host: publicHost,
          "x-amzn-tunnel-user": "owner@example.test",
          "x-pi-web-client-id": "browser-client",
        },
      });
      return response.status === 502 ? undefined : response;
    }, supervisor);
    expect(external.status, output.join("")).toBe(200);
    const cookie = external.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toContain("pi_web_session=");

    const machineTicket = await fetch(`http://127.0.0.1:${publicPort}/api/ws-ticket`, {
      method: "POST",
      headers: { host: publicHost, authorization: `Bearer ${machineSecret}` },
    });
    expect(machineTicket.status).toBe(201);

    const externalCrossSite = await fetch(`http://127.0.0.1:${publicPort}/api/ws-ticket`, {
      method: "POST",
      headers: {
        host: publicHost,
        origin: "http://other.example.test",
        "x-amzn-tunnel-user": "owner@example.test",
        "x-pi-web-client-id": "browser-client",
      },
    });
    expect.soft(externalCrossSite.status).toBe(403);
    const externalMissingOrigin = await fetch(`http://127.0.0.1:${publicPort}/api/ws-ticket`, {
      method: "POST",
      headers: {
        host: publicHost,
        "x-amzn-tunnel-user": "owner@example.test",
        "x-pi-web-client-id": "browser-client",
      },
    });
    expect.soft(externalMissingOrigin.status).toBe(403);
    expect.soft(await rawStatus(publicPort, `other.example.test:${publicPort}`, `Bearer ${machineSecret}`)).toBe(200);

    const browserHeaders = {
      host: publicHost,
      cookie: cookie!,
      origin: publicOrigin,
      "x-pi-web-client-id": "browser-client",
    };
    const wrongOrigin = await fetch(`http://127.0.0.1:${publicPort}/api/ws-ticket`, {
      method: "POST",
      headers: { ...browserHeaders, origin: "http://other.example.test" },
    });
    expect(wrongOrigin.status).toBe(403);
    const matchingHostWrongOrigin = await fetch(`http://127.0.0.1:${publicPort}/api/ws-ticket`, {
      method: "POST",
      headers: {
        ...browserHeaders,
        host: `other.example.test:${publicPort}`,
        origin: `https://other.example.test:${publicPort}`,
      },
    });
    expect(matchingHostWrongOrigin.status).toBe(403);

    const connect = async () => {
      const response = await fetch(`http://127.0.0.1:${publicPort}/api/ws-ticket`, {
        method: "POST",
        headers: browserHeaders,
      });
      expect(response.status).toBe(201);
      const { ticket } = await response.json() as { ticket: string };
      const socket = new WebSocket(`ws://127.0.0.1:${publicPort}/ws?ticket=${encodeURIComponent(ticket)}`, {
        origin: publicOrigin,
        headers: { host: publicHost },
      });
      await new Promise<void>((resolve, reject) => {
        socket.once("message", data => {
          expect(JSON.parse(String(data)).type).toBe("hello");
          resolve();
        });
        socket.once("error", reject);
      });
      socket.close();
      await new Promise<void>(resolve => socket.once("close", () => resolve()));
    };
    await connect();
    await connect();

    const beforeRestart = await status(publicPort, supervisor, machineSecret, publicHost);
    const restart = await fetch(`http://127.0.0.1:${publicPort}/api/restart`, {
      method: "POST",
      headers: browserHeaders,
    });
    expect(restart.status).toBe(202);
    const afterRestart = await waitFor(async () => {
      const current = await status(publicPort, supervisor, machineSecret, publicHost);
      return current.childGeneration > beforeRestart.childGeneration ? current : undefined;
    }, supervisor);
    expect(afterRestart.childPid).not.toBe(beforeRestart.childPid);
  }, 30_000);
});
