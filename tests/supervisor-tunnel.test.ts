import { spawn, type ChildProcess } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { AuthStore, hashSecret } from "../server/auth/kernel.js";
import { closeTunnelSocket, listenOnTunnelSocket } from "../server/tunnelSocket.js";
import { isolatedAuthEnv } from "./auth-isolation.js";

const projectRoot = new URL("..", import.meta.url).pathname;
const processes = new Set<ChildProcess>();
const temporaryDirectories = new Set<string>();
const helperTimeoutMs = 5_000;

type Response = {
  status: number;
  headers: import("node:http").IncomingHttpHeaders;
  body: string;
};

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function httpRequest(options: {
  port?: number;
  socketPath?: string;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: options.socketPath ? undefined : "127.0.0.1",
      port: options.port,
      socketPath: options.socketPath,
      path: options.path,
      method: options.method || "GET",
      headers: {
        host: "pi.example.invalid",
        ...options.headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        clearTimeout(timer);
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString(),
        });
      });
    });
    const timer = setTimeout(() => {
      req.destroy(new Error(`HTTP request timed out after ${helperTimeoutMs}ms`));
    }, helperTimeoutMs);
    req.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    if (options.body) req.end(options.body);
    else req.end();
  });
}

async function waitFor<T>(
  operation: () => Promise<T | undefined>,
  process: ChildProcess,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await operation().catch(() => undefined);
    if (value !== undefined) return value;
    if (process.exitCode !== null || process.signalCode !== null)
      throw new Error(`Process exited early: code=${process.exitCode} signal=${process.signalCode}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

async function stopProcess(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return;
  process.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      process.kill("SIGKILL");
      resolve();
    }, 5_000);
    process.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function websocketOpen(
  url: string,
  options: import("ws").ClientOptions,
  expectedStatus?: number,
): Promise<void> {
  const ws = new WebSocket(url, options);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.once("error", () => undefined);
      ws.terminate();
      reject(new Error(`WebSocket did not settle after ${helperTimeoutMs}ms`));
    }, helperTimeoutMs);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.removeAllListeners();
      const complete = () => error ? reject(error) : resolve();
      if (ws.readyState === WebSocket.CLOSED) return complete();
      const closeTimer = setTimeout(() => {
        ws.terminate();
        complete();
      }, helperTimeoutMs);
      ws.once("close", () => {
        clearTimeout(closeTimer);
        complete();
      });
      ws.once("error", () => undefined);
      if (ws.readyState === WebSocket.OPEN) ws.close();
      else ws.terminate();
    };
    ws.once("open", () => {
      if (expectedStatus !== undefined)
        return finish(new Error(`WebSocket opened; expected HTTP ${expectedStatus}`));
      finish();
    });
    ws.once("unexpected-response", (_request, response) => {
      response.resume();
      if (response.statusCode === expectedStatus) finish();
      else finish(new Error(`WebSocket returned HTTP ${response.statusCode}; expected ${expectedStatus ?? "upgrade"}`));
    });
    ws.once("error", error => finish(error));
  });
}

async function startSupervisor(tunnel = true) {
  const publicPort = await freePort();
  const childPort = await freePort();
  const authEnv = isolatedAuthEnv();
  const parent = await mkdtemp(join(tmpdir(), "pi-web-tunnel-test-"));
  temporaryDirectories.add(parent);
  await chmod(parent, 0o700);
  const socketPath = join(parent, "pi-web.sock");
  const store = new AuthStore(authEnv.PI_WEB_AUTH_STORE!);
  await store.update(state => {
    state.config = { policy: "authenticated", methods: ["external"] };
    state.apiTokens.push({
      id: "synthetic-machine",
      name: "Synthetic machine",
      hash: hashSecret("synthetic-machine-token"),
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
  });
  const child = spawn(process.execPath, ["--import", "tsx", "supervisor.ts"], {
    cwd: projectRoot,
    env: {
      ...authEnv,
      HOST: "127.0.0.1",
      PORT: String(publicPort),
      PI_WEB_CHILD_PORT: String(childPort),
      PI_WEB_DEV: "0",
      PI_WEB_MOCK: "1",
      PI_WEB_NO_SESSION: "1",
      PI_WEB_AUTH_MODE: "external",
      PI_WEB_AUTH_METHODS: "external",
      PI_WEB_AUTH_TRUSTED_HEADER: "x-verified-user",
      PI_WEB_AUTH_ORIGIN: "https://pi.example.invalid",
      ...(tunnel ? { PI_WEB_TUNNEL_SOCKET: socketPath } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  processes.add(child);
  await waitFor(async () => {
    const status = await httpRequest({
      port: publicPort,
      path: "/__supervisor/status",
      headers: { authorization: "Bearer synthetic-machine-token" },
    });
    if (status.status !== 200) return undefined;
    const state = await httpRequest({
      port: publicPort,
      path: "/api/sessions",
      headers: { authorization: "Bearer synthetic-machine-token" },
    });
    return state.status === 200 ? JSON.parse(status.body) as {
      childGeneration: number;
      childPid: number;
    } : undefined;
  }, child);
  return { child, publicPort, childPort, socketPath };
}

afterEach(async () => {
  await Promise.all([...processes].map(async process => {
    processes.delete(process);
    await stopProcess(process);
  }));
  await Promise.all([...temporaryDirectories].map(async directory => {
    temporaryDirectories.delete(directory);
    await rm(directory, { recursive: true, force: true });
  }));
});

describe("supervisor tunnel socket identity", () => {
  it("binds external identity to the private socket while preserving TCP credentials and restart", async () => {
    const instance = await startSupervisor();
    const forgedTcp = await httpRequest({
      port: instance.publicPort,
      path: "/api/sessions",
      headers: { "x-verified-user": "attacker@example.invalid" },
    });
    expect(forgedTcp.status).toBe(401);

    const socket = await lstat(instance.socketPath);
    expect(socket.isSocket()).toBe(true);
    expect(socket.mode & 0o777).toBe(0o600);
    if (typeof process.getuid === "function") expect(socket.uid).toBe(process.getuid());

    expect((await httpRequest({
      port: instance.publicPort,
      path: "/__supervisor/status",
      headers: { "x-verified-user": "attacker@example.invalid" },
    })).status).toBe(401);

    const forgedChild = await httpRequest({
      port: instance.childPort,
      path: "/api/sessions",
      headers: { "x-verified-user": "attacker@example.invalid" },
    });
    expect(forgedChild.status).toBe(401);

    const forgedMarkedChild = await httpRequest({
      port: instance.childPort,
      path: "/api/sessions",
      headers: {
        "x-verified-user": "attacker@example.invalid",
        "x-pi-web-tunnel": "1",
        "x-pi-web-supervisor-secret": "guessed",
      },
    });
    expect(forgedMarkedChild.status).toBe(401);

    const tokenRead = await httpRequest({
      port: instance.publicPort,
      path: "/api/sessions",
      headers: { authorization: "Bearer synthetic-machine-token" },
    });
    expect(tokenRead.status).toBe(200);

    const login = await httpRequest({
      socketPath: instance.socketPath,
      path: "/api/auth/external/login",
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://pi.example.invalid",
        "x-verified-user": "owner@example.invalid",
        "x-forwarded-for": "127.0.0.1",
        "x-forwarded-host": "attacker.example.invalid",
      },
      body: "{}",
    });
    expect(login.status).toBe(200);
    const cookie = login.headers["set-cookie"]![0].split(";")[0];
    const security = await httpRequest({
      port: instance.publicPort,
      path: "/api/auth/security",
      headers: { cookie },
    });
    expect(security.status).toBe(200);
    expect(JSON.parse(security.body).sessions.find((session: { current: boolean }) => session.current).ip).toBe("unknown");
    expect((await httpRequest({
      socketPath: instance.socketPath,
      path: "/__supervisor/status",
      headers: { "x-verified-user": "owner@example.invalid" },
    })).status).toBe(200);

    expect((await httpRequest({
      port: instance.publicPort,
      path: "/api/sessions",
      headers: { cookie },
    })).status).toBe(200);
    expect((await httpRequest({
      port: instance.publicPort,
      path: "/api/auth/authorize",
      method: "POST",
      headers: {
        cookie,
        origin: "https://pi.example.invalid",
        "x-pi-web-client-id": "synthetic-browser",
      },
    })).status).toBe(200);
    expect((await httpRequest({
      port: instance.publicPort,
      path: "/api/auth/authorize",
      method: "POST",
      headers: {
        cookie,
        origin: "https://other.example.invalid",
        "x-pi-web-client-id": "synthetic-browser",
      },
    })).status).toBe(403);
    expect((await httpRequest({
      port: instance.publicPort,
      path: "/api/auth/authorize",
      method: "POST",
      headers: {
        cookie,
        origin: "https://pi.example.invalid",
      },
    })).status).toBe(403);

    await websocketOpen(
      `ws://127.0.0.1:${instance.publicPort}/ws`,
      {
        origin: "https://pi.example.invalid",
        headers: {
          host: "pi.example.invalid",
          "x-verified-user": "owner@example.invalid",
        },
      },
      401,
    );

    for (let reconnect = 0; reconnect < 2; reconnect++) {
      const ticket = await httpRequest({
        socketPath: instance.socketPath,
        path: "/api/ws-ticket",
        method: "POST",
        headers: {
          cookie,
          origin: "https://pi.example.invalid",
          "x-pi-web-client-id": "synthetic-browser",
        },
      });
      expect(ticket.status).toBe(201);
      await websocketOpen(
        `ws://pi.example.invalid/ws?ticket=${encodeURIComponent(JSON.parse(ticket.body).ticket)}`,
        {
          origin: "https://pi.example.invalid",
          headers: { cookie },
          createConnection: () => net.connect(instance.socketPath),
        },
      );
    }

    for (let reconnect = 0; reconnect < 2; reconnect++) {
      const ticket = await httpRequest({
        port: instance.publicPort,
        path: "/api/ws-ticket",
        method: "POST",
        headers: {
          cookie,
          origin: "https://pi.example.invalid",
          "x-pi-web-client-id": "synthetic-browser",
        },
      });
      expect(ticket.status).toBe(201);
      await websocketOpen(
        `ws://127.0.0.1:${instance.publicPort}/ws?ticket=${encodeURIComponent(JSON.parse(ticket.body).ticket)}`,
        {
          origin: "https://pi.example.invalid",
          headers: { host: "pi.example.invalid", cookie },
        },
      );
    }

    const before = await httpRequest({
      port: instance.publicPort,
      path: "/__supervisor/status",
      headers: { authorization: "Bearer synthetic-machine-token" },
    });
    const generation = JSON.parse(before.body).childGeneration as number;
    expect((await httpRequest({
      port: instance.publicPort,
      path: "/api/restart",
      method: "POST",
      headers: { authorization: "Bearer synthetic-machine-token" },
    })).status).toBe(202);
    await waitFor(async () => {
      const response = await httpRequest({
        port: instance.publicPort,
        path: "/__supervisor/status",
        headers: { authorization: "Bearer synthetic-machine-token" },
      });
      if (
        response.status !== 200 ||
        (JSON.parse(response.body).childGeneration as number) <= generation
      ) return undefined;
      const socketRead = await httpRequest({
        socketPath: instance.socketPath,
        path: "/api/sessions",
        headers: { cookie },
      });
      return socketRead.status === 200 ? true : undefined;
    }, instance.child);
    expect((await httpRequest({
      socketPath: instance.socketPath,
      path: "/api/sessions",
      headers: { cookie },
    })).status).toBe(200);
  }, 30_000);

  it("leaves unset deployments compatible with trusted-header identity over TCP", async () => {
    const instance = await startSupervisor(false);
    expect((await httpRequest({
      port: instance.publicPort,
      path: "/api/sessions",
    })).status).toBe(401);
    expect((await httpRequest({
      port: instance.publicPort,
      path: "/api/sessions",
      headers: { "x-verified-user": "legacy-owner@example.invalid" },
    })).status).toBe(200);
  }, 20_000);

  it("reclaims a private stale socket after an unclean process exit", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-web-tunnel-stale-"));
    temporaryDirectories.add(parent);
    await chmod(parent, 0o700);
    const socketPath = join(parent, "stale.sock");
    const stale = spawn(process.execPath, [
      "-e",
      `process.umask(0o177); require("node:net").createServer().listen(${JSON.stringify(socketPath)})`,
    ]);
    processes.add(stale);
    await waitFor(async () => {
      try {
        return (await lstat(socketPath)).isSocket() || undefined;
      } catch {
        return undefined;
      }
    }, stale);
    const exited = new Promise<void>((resolve) => stale.once("exit", () => resolve()));
    stale.kill("SIGKILL");
    await exited;
    processes.delete(stale);
    expect((await lstat(socketPath)).isSocket()).toBe(true);

    const replacement = createServer();
    const identity = await listenOnTunnelSocket(replacement, socketPath);
    expect(replacement.listening).toBe(true);
    await closeTunnelSocket(replacement, socketPath, identity);
    await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses pre-existing paths and removes only its own socket on clean shutdown", async () => {
    const authEnv = isolatedAuthEnv();
    const parent = await mkdtemp(join(tmpdir(), "pi-web-tunnel-refusal-"));
    temporaryDirectories.add(parent);
    await chmod(parent, 0o700);
    const filePath = join(parent, "occupied-file");
    await writeFile(filePath, "operator data", { mode: 0o600 });

    const spawnRefusal = async (socketPath: string) => {
      const child = spawn(process.execPath, ["--import", "tsx", "supervisor.ts"], {
        cwd: projectRoot,
        env: {
          ...authEnv,
          HOST: "127.0.0.1",
          PORT: String(await freePort()),
          PI_WEB_CHILD_PORT: String(await freePort()),
          PI_WEB_DEV: "0",
          PI_WEB_TUNNEL_SOCKET: socketPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      processes.add(child);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Refusal process did not exit")), 10_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      expect(child.exitCode).toBe(1);
      processes.delete(child);
    };

    await spawnRefusal(filePath);
    expect((await lstat(filePath)).isFile()).toBe(true);

    const livePath = join(parent, "live.sock");
    const live = net.createServer();
    await new Promise<void>((resolve, reject) => {
      live.once("error", reject);
      live.listen(livePath, resolve);
    });
    try {
      await spawnRefusal(livePath);
      expect((await lstat(livePath)).isSocket()).toBe(true);
    } finally {
      await new Promise<void>(resolve => live.close(() => resolve()));
    }

    const replaced = await startSupervisor();
    await unlink(replaced.socketPath);
    await writeFile(replaced.socketPath, "replacement must survive", { mode: 0o600 });
    await stopProcess(replaced.child);
    processes.delete(replaced.child);
    expect(await readFile(replaced.socketPath, "utf8")).toBe("replacement must survive");

    const cleaned = await startSupervisor();
    await stopProcess(cleaned.child);
    processes.delete(cleaned.child);
    await expect(lstat(cleaned.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);
});
