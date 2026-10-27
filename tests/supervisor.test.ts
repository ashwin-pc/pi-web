import { isolatedAuthEnv } from "./auth-isolation.js";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import net from "node:net";
import { AuthStore, hashSecret } from "../server/auth/kernel.js";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

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

async function status(port: number, supervisor: ChildProcess, bearer = token) {
  return waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/__supervisor/status`, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    if (!response.ok) return undefined;
    return response.json() as Promise<{ childPid?: number; childGeneration: number }>;
  }, supervisor);
}

async function rawExchange(port: number, request: string, timeoutMs = 2_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.connect(port, "127.0.0.1", () => socket.write(request));
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Raw request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      clearTimeout(timeout);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

async function expectWebSocketHello(url: string, origin: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url, { origin });
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error("Timed out waiting for supervisor WebSocket hello"));
    }, 5_000);
    ws.once("message", (data) => {
      clearTimeout(timeout);
      expect(JSON.parse(String(data))).toMatchObject({ type: "hello" });
      ws.once("close", () => resolve());
      ws.close();
    });
    ws.once("error", reject);
  });
}

async function expectWebSocketOpen(url: string, protocol: string, origin: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url, protocol, { origin });
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error("Timed out waiting for supervisor WebSocket open"));
    }, 5_000);
    ws.once("open", () => {
      clearTimeout(timeout);
      ws.close();
      resolve();
    });
    ws.once("error", reject);
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

afterEach(async () => {
  await Promise.all(Array.from(supervisors, async (supervisor) => {
    supervisors.delete(supervisor);
    await stopSupervisor(supervisor);
  }));
});

describe("pi-web supervisor", () => {
  it("keeps the synthetic external-browser, machine-token, WebSocket, restart, and Origin contract working", async () => {
    const publicPort = await freePort();
    const childPort = await freePort();
    const authEnv = isolatedAuthEnv();
    const machineToken = "synthetic-machine-token";
    const publicOrigin = `http://127.0.0.1:${publicPort}`;
    const store = new AuthStore(authEnv.PI_WEB_AUTH_STORE!);
    await store.update((state) => {
      state.config = { policy: "authenticated", methods: ["external"] };
      state.apiTokens.push({
        id: "synthetic-machine",
        name: "synthetic machine",
        hash: hashSecret(machineToken),
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      });
    });
    const supervisor = spawn(process.execPath, ["--import", "tsx", "supervisor.ts"], {
      cwd: projectRoot,
      env: {
        ...authEnv,
        HOST: "127.0.0.1",
        PORT: String(publicPort),
        PI_WEB_CHILD_PORT: String(childPort),
        PI_WEB_AUTH_POLICY: "authenticated",
        PI_WEB_AUTH_METHODS: "external",
        PI_WEB_AUTH_TRUSTED_HEADER: "x-synthetic-browser-identity",
        PI_WEB_AUTH_ORIGIN: publicOrigin,
        PI_WEB_MOCK: "1",
        PI_WEB_DEV: "0",
        PI_WEB_NO_SESSION: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    supervisors.add(supervisor);
    const initial = await status(publicPort, supervisor, machineToken);
    await waitFor(async () => {
      const response = await fetch(`${publicOrigin}/api/state`, {
        headers: { authorization: `Bearer ${machineToken}` },
      });
      return response.ok ? true : undefined;
    }, supervisor);

    const browserState = await fetch(`${publicOrigin}/api/state`, {
      headers: {
        "x-synthetic-browser-identity": "owner@synthetic.invalid",
        "x-pi-web-client-id": "synthetic-browser",
      },
    });
    expect(browserState.status).toBe(200);
    const cookie = browserState.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toContain("pi_web_session=");
    expect((await store.read()).sessions.at(-1)?.identity.id).toBe("external:owner@synthetic.invalid");

    const browserMutationHeaders = {
      cookie: cookie!,
      origin: publicOrigin,
      "x-pi-web-client-id": "synthetic-browser",
    };
    expect((await fetch(`${publicOrigin}/api/auth/authorize`, {
      method: "POST",
      headers: browserMutationHeaders,
    })).status).toBe(200);
    expect((await fetch(`${publicOrigin}/api/auth/authorize`, {
      method: "POST",
      headers: { ...browserMutationHeaders, origin: "https://wrong.synthetic.invalid" },
    })).status).toBe(403);

    expect((await fetch(`${publicOrigin}/api/state`, {
      headers: { authorization: `Bearer ${machineToken}` },
    })).status).toBe(200);

    for (let attempt = 0; attempt < 2; attempt++) {
      const ticketResponse = await fetch(`${publicOrigin}/api/ws-ticket`, {
        method: "POST",
        headers: browserMutationHeaders,
      });
      expect(ticketResponse.status).toBe(201);
      const { ticket } = await ticketResponse.json() as { ticket: string };
      await expectWebSocketHello(
        `ws://127.0.0.1:${publicPort}/ws?ticket=${encodeURIComponent(ticket)}`,
        publicOrigin,
      );
    }

    const restartResponse = await fetch(`${publicOrigin}/api/restart`, {
      method: "POST",
      headers: { authorization: `Bearer ${machineToken}` },
    });
    expect(restartResponse.status).toBe(202);
    const restarted = await waitFor(async () => {
      const current = await status(publicPort, supervisor, machineToken);
      if (current.childGeneration <= initial.childGeneration || current.childPid === initial.childPid) return undefined;
      const state = await fetch(`${publicOrigin}/api/state`, {
        headers: { authorization: `Bearer ${machineToken}` },
      });
      return state.ok ? current : undefined;
    }, supervisor);
    expect(restarted.childGeneration).toBe(initial.childGeneration + 1);
  }, 30_000);

  it("closes unrelated upgrades through the supervisor without leaking the connection", async () => {
    const publicPort = await freePort();
    const childPort = await freePort();
    const supervisor = spawn(process.execPath, ["--import", "tsx", "supervisor.ts"], {
      cwd: projectRoot,
      env: {
        ...isolatedAuthEnv(),
        HOST: "127.0.0.1",
        PORT: String(publicPort),
        PI_WEB_CHILD_PORT: String(childPort),
        PI_WEB_AUTH_MODE: "legacy",
        PI_WEB_TOKEN: token,
        PI_WEB_MOCK: "1",
        PI_WEB_NO_SESSION: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    supervisors.add(supervisor);
    await status(publicPort, supervisor);
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${publicPort}/api/state`, {
        headers: { authorization: `Bearer ${token}` },
      });
      return response.ok ? true : undefined;
    }, supervisor);
    const response = await rawExchange(publicPort,
      `GET /not-websocket HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
    expect(response).toBe("");
    expect((await status(publicPort, supervisor)).childPid).toBeTypeOf("number");
  }, 15_000);

  it("denies forged Vite HMR upgrades when the child is in production mode", async () => {
    const publicPort = await freePort();
    const childPort = await freePort();
    const publicOrigin = `http://127.0.0.1:${publicPort}`;
    const supervisor = spawn(process.execPath, ["--import", "tsx", "supervisor.ts"], {
      cwd: projectRoot,
      env: {
        ...isolatedAuthEnv(),
        NODE_ENV: "test",
        HOST: "127.0.0.1",
        PORT: String(publicPort),
        PI_WEB_CHILD_PORT: String(childPort),
        PI_WEB_AUTH_ORIGIN: publicOrigin,
        PI_WEB_DEV: "0",
        PI_WEB_MOCK: "1",
        PI_WEB_NO_SESSION: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    supervisors.add(supervisor);
    await status(publicPort, supervisor);

    const response = await rawExchange(
      publicPort,
      `GET /?token=fake HTTP/1.1\r\nHost: 127.0.0.1:${publicPort}\r\nOrigin: ${publicOrigin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Protocol: vite-hmr\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: c3ludGhldGljLWhtcg==\r\n\r\n`,
    );
    expect(response).toBe("");
    expect((await status(publicPort, supervisor)).childPid).toBeTypeOf("number");
  }, 15_000);

  it("proxies only real root-path Vite HMR upgrades in development mode", async () => {
    const publicPort = await freePort();
    const childPort = await freePort();
    const publicOrigin = `http://127.0.0.1:${publicPort}`;
    const supervisor = spawn(process.execPath, ["--import", "tsx", "supervisor.ts"], {
      cwd: projectRoot,
      env: {
        ...isolatedAuthEnv(),
        NODE_ENV: "test",
        HOST: "127.0.0.1",
        PORT: String(publicPort),
        PI_WEB_CHILD_PORT: String(childPort),
        PI_WEB_AUTH_ORIGIN: publicOrigin,
        PI_WEB_DEV: "1",
        PI_WEB_MOCK: "1",
        PI_WEB_NO_SESSION: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    supervisors.add(supervisor);
    await status(publicPort, supervisor);
    const viteClient = await waitFor(async () => {
      const response = await fetch(`${publicOrigin}/@vite/client`);
      return response.ok ? response.text() : undefined;
    }, supervisor);
    const viteToken = /const wsToken = "([^"]+)"/.exec(viteClient)?.[1];
    expect(viteToken).toBeTruthy();

    const unrelatedPath = await rawExchange(
      publicPort,
      `GET /unrelated?token=${viteToken} HTTP/1.1\r\nHost: 127.0.0.1:${publicPort}\r\nOrigin: ${publicOrigin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Protocol: vite-hmr\r\n\r\n`,
    );
    expect(unrelatedPath).toBe("");
    const unrelatedProtocol = await rawExchange(
      publicPort,
      `GET /?token=${viteToken} HTTP/1.1\r\nHost: 127.0.0.1:${publicPort}\r\nOrigin: ${publicOrigin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Protocol: not-vite\r\n\r\n`,
    );
    expect(unrelatedProtocol).toBe("");

    await expectWebSocketOpen(
      `ws://127.0.0.1:${publicPort}/?token=${encodeURIComponent(viteToken!)}`,
      "vite-hmr",
      publicOrigin,
    );
  }, 20_000);

  it("returns 400 for malformed authority and stays alive", async () => {
    const publicPort = await freePort();
    const childPort = await freePort();
    const authEnv = isolatedAuthEnv();
    const supervisor = spawn(process.execPath, ["--import", "tsx", "supervisor.ts"], {
      cwd: projectRoot,
      env: {
        ...authEnv,
        HOST: "127.0.0.1",
        PORT: String(publicPort),
        PI_WEB_CHILD_PORT: String(childPort),
        PI_WEB_AUTH_MODE: "legacy",
        PI_WEB_TOKEN: token,
        PI_WEB_MOCK: "1",
        PI_WEB_NO_SESSION: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    supervisors.add(supervisor);
    await status(publicPort, supervisor);

    const response = await rawExchange(
      publicPort,
      `GET /api/state HTTP/1.1\r\nHost: [\r\nAuthorization: Bearer ${token}\r\nConnection: close\r\n\r\n`,
    );
    expect(response).toContain("400 Bad Request");
    expect((await status(publicPort, supervisor)).childPid).toBeTypeOf("number");
  });

  it("expires a stalled supervisor upgrade and accepts a later valid WebSocket", async () => {
    const publicPort = await freePort();
    const childPort = await freePort();
    const authEnv = isolatedAuthEnv();
    const publicOrigin = `http://127.0.0.1:${publicPort}`;
    const supervisor = spawn(process.execPath, ["--import", "tsx", "supervisor.ts"], {
      cwd: projectRoot,
      env: {
        ...authEnv,
        HOST: "127.0.0.1",
        PORT: String(publicPort),
        PI_WEB_CHILD_PORT: String(childPort),
        PI_WEB_AUTH_MODE: "legacy",
        PI_WEB_TOKEN: token,
        PI_WEB_AUTH_ORIGIN: publicOrigin,
        PI_WEB_MOCK: "1",
        PI_WEB_DEV: "0",
        PI_WEB_NO_SESSION: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    supervisors.add(supervisor);
    const initial = await status(publicPort, supervisor);
    const firstTicket = await (await fetch(`${publicOrigin}/api/ws-ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    })).json() as { ticket: string };

    process.kill(initial.childPid!, "SIGSTOP");
    try {
      const response = await rawExchange(
        publicPort,
        `GET /ws?ticket=${encodeURIComponent(firstTicket.ticket)} HTTP/1.1\r\nHost: 127.0.0.1:${publicPort}\r\nOrigin: ${publicOrigin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: c3ludGhldGljLXVwZ3JhZGU=\r\n\r\n`,
        12_000,
      );
      expect(response).toBe("");
    } finally {
      process.kill(initial.childPid!, "SIGCONT");
    }

    const nextTicket = await waitFor(async () => {
      const response = await fetch(`${publicOrigin}/api/ws-ticket`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      return response.status === 201 ? response.json() as Promise<{ ticket: string }> : undefined;
    }, supervisor);
    await expectWebSocketHello(
      `ws://127.0.0.1:${publicPort}/ws?ticket=${encodeURIComponent(nextTicket.ticket)}`,
      publicOrigin,
    );
  }, 25_000);

  it("restarts an unexpectedly terminated child without double-spawning on intentional restart", async () => {
    const publicPort = await freePort();
    const childPort = await freePort();
    const authEnv = isolatedAuthEnv();
    const supervisor = spawn(process.execPath, ["--import", "tsx", "supervisor.ts"], {
      cwd: projectRoot,
      env: {
        ...authEnv,
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

    // A stopped child cannot answer auth requests; the supervisor must verify
    // the same persistent store directly, including legacy retirement.
    const store = new AuthStore(authEnv.PI_WEB_AUTH_STORE!);
    await store.update(s => { s.config = { policy: "authenticated", methods: [] }; s.apiTokens.push({ id: "restart", name: "restart", hash: hashSecret("machine-restart"), createdAt: Date.now(), expiresAt: Date.now() + 60_000 }); });
    process.kill(recovered.childPid!, "SIGSTOP");
    try {
      const denied = await fetch(`http://127.0.0.1:${publicPort}/__supervisor/status`, { headers: { authorization: `Bearer ${token}` } });
      expect(denied.status).toBe(401);
      const allowed = await fetch(`http://127.0.0.1:${publicPort}/__supervisor/status`, { headers: { authorization: "Bearer machine-restart" }, signal: AbortSignal.timeout(2000) });
      expect(allowed.status).toBe(200);
      await store.update(s => { s.config = { policy: "authenticated", methods: ["legacy"] }; });
    } finally { process.kill(recovered.childPid!, "SIGCONT"); }

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
