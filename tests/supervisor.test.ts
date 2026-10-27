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

function pollingErrorCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = (current as NodeJS.ErrnoException).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function isTransientPollingError(error: unknown): boolean {
  return ["ECONNREFUSED", "ECONNRESET"].includes(pollingErrorCode(error) || "");
}

async function waitFor<T>(
  operation: () => Promise<T | undefined>,
  supervisor: ChildProcess,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let value: T | undefined;
    try {
      value = await operation();
    } catch (error) {
      if (!isTransientPollingError(error)) throw error;
    }
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

function rawRequest(
  port: number,
  options: {
    method?: string;
    path: string;
    headers: Record<string, string>;
    localAddress?: string;
  },
): Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      method: options.method,
      path: options.path,
      headers: options.headers,
      localAddress: options.localAddress,
    }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.once("end", () => resolve({
        status: response.statusCode || 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString(),
      }));
    });
    request.once("error", reject);
    request.end();
  });
}

async function startProxyFixture(
  authEnv: NodeJS.ProcessEnv,
  machineSecret: string,
  trustedPeer: string,
) {
  const publicPort = await freePort();
  const childPort = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...authEnv,
    HOST: "127.0.0.1",
    PORT: String(publicPort),
    PI_WEB_CHILD_PORT: String(childPort),
    PI_WEB_AUTH_MODE: "external",
    PI_WEB_AUTH_METHODS: "external",
    PI_WEB_AUTH_TRUSTED_HEADER: "x-amzn-tunnel-user",
    PI_WEB_AUTH_ORIGIN: `http://localhost:${publicPort}`,
    PI_WEB_AUTH_PROXY_PEERS: trustedPeer,
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
  await status(publicPort, supervisor, machineSecret).catch(error => {
    throw new Error(`${String(error)}\n${output.join("")}`);
  });
  return { publicPort, supervisor, output };
}

afterEach(async () => {
  await Promise.all(Array.from(supervisors, async (supervisor) => {
    supervisors.delete(supervisor);
    await stopSupervisor(supervisor);
  }));
});

describe("pi-web supervisor", () => {
  it("retries transient fixture polling errors but surfaces permanent bind errors", async () => {
    const runningSupervisor = { exitCode: null, signalCode: null } as ChildProcess;
    let transientAttempts = 0;
    await expect(waitFor(async () => {
      transientAttempts += 1;
      if (transientAttempts === 1) {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
        });
      }
      return "ready";
    }, runningSupervisor, 500)).resolves.toBe("ready");
    expect(transientAttempts).toBe(2);

    const bindError = Object.assign(new Error("bind EADDRNOTAVAIL"), { code: "EADDRNOTAVAIL" });
    let permanentAttempts = 0;
    await expect(waitFor(async () => {
      permanentAttempts += 1;
      throw bindError;
    }, runningSupervisor, 500)).rejects.toBe(bindError);
    expect(permanentAttempts).toBe(1);
  });

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

  it("carries a trusted proxy's validated local-origin decision only across the supervised child hop", async () => {
    const publicAuthority = "public.example.test";
    const publicOrigin = `https://${publicAuthority}`;
    const trustedPeer = "127.0.0.1";
    const authEnv = isolatedAuthEnv();
    const machineSecret = "synthetic-proxy-machine";
    const store = new AuthStore(authEnv.PI_WEB_AUTH_STORE!);
    await store.update(s => {
      s.config = { policy: "authenticated", methods: ["external"] };
      s.apiTokens.push({ id: "machine", name: "machine", hash: hashSecret(machineSecret), createdAt: Date.now(), expiresAt: Date.now() + 60_000 });
    });
    const trustedFixture = await startProxyFixture(authEnv, machineSecret, trustedPeer);
    const external = await waitFor(async () => {
      const response = await rawRequest(trustedFixture.publicPort, {
        path: "/api/state",
        localAddress: trustedPeer,
        headers: {
          host: "internal.example.test",
          "x-forwarded-host": publicAuthority,
          "x-amzn-tunnel-user": "owner@example.test",
          "x-pi-web-client-id": "browser-client",
        },
      });
      return response.status === 502 ? undefined : response;
    }, trustedFixture.supervisor);
    expect(external.status, trustedFixture.output.join("")).toBe(200);
    const setCookie = external.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";")[0];
    expect(cookie).toContain("pi_web_session=");

    const browserHeaders = {
      host: "internal.example.test",
      cookie: cookie!,
      origin: publicOrigin,
      "x-forwarded-host": publicAuthority,
      "x-pi-web-client-id": "browser-client",
    };
    const ticketResponse = await rawRequest(trustedFixture.publicPort, {
      method: "POST",
      path: "/api/ws-ticket",
      localAddress: trustedPeer,
      headers: browserHeaders,
    });
    expect(ticketResponse.status, ticketResponse.body).toBe(201);
    const { ticket } = JSON.parse(ticketResponse.body) as { ticket: string };
    const socket = new WebSocket(`ws://127.0.0.1:${trustedFixture.publicPort}/ws?ticket=${encodeURIComponent(ticket)}`, {
      origin: publicOrigin,
      localAddress: trustedPeer,
      headers: {
        host: "internal.example.test",
        "x-forwarded-host": publicAuthority,
      },
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

    supervisors.delete(trustedFixture.supervisor);
    await stopSupervisor(trustedFixture.supervisor);
    const untrustedFixture = await startProxyFixture(authEnv, machineSecret, "192.0.2.60");
    const forged = await waitFor(async () => {
      const response = await rawRequest(untrustedFixture.publicPort, {
        method: "POST",
        path: "/api/ws-ticket",
        localAddress: "127.0.0.1",
        headers: {
          ...browserHeaders,
          host: publicAuthority,
          "x-pi-web-supervisor-origin": "1",
          "x-pi-web-supervisor-secret": "caller-controlled",
        },
      });
      return response.status === 502 ? undefined : response;
    }, untrustedFixture.supervisor);
    expect(forged.status, forged.body).toBe(403);
    // Two independent cold supervisor+child startups keep separate 10-second readiness windows.
  }, 45_000);
});
