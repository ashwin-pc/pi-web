import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { AuthKernel, AuthStore } from "./server/auth/kernel.js";
import { resolveAuthConfig } from "./server/auth/config.js";
import { trustedOrigin, originFailureHint } from "./server/auth/origin.js";
import { forwardedHost, trustedProxyPeer } from "./server/auth/proxy.js";
import {
  isLocalTunnelRequest,
  markTunnelRequest,
  stampSupervisorTunnel,
  stripSupervisorPeerHeaders,
} from "./server/auth/supervisorPeer.js";
import { proxyHttpRequest } from "./server/shared/httpProxy.js";
import {
  closeTunnelSocket,
  listenOnTunnelSocket,
} from "./server/tunnelSocket.js";
import { resolveWebHomePath } from "./server/shared/webHome.js";

const publicHost = process.env.HOST || "127.0.0.1";
const publicPort = Number(process.env.PORT || 8787);
const childHost = process.env.PI_WEB_CHILD_HOST || "127.0.0.1";
const childPort = Number(process.env.PI_WEB_CHILD_PORT || publicPort + 1);
const restartGraceMs = Number(process.env.PI_WEB_RESTART_GRACE_MS || 250);
const tunnelSocketPath = process.env.PI_WEB_TUNNEL_SOCKET || "";
const supervisorSecret = randomBytes(32).toString("base64url");
const authStorePath = resolveWebHomePath("web/auth.json", join(getAgentDir(), "web", "auth.json"), process.env.PI_WEB_AUTH_STORE);
const authStore = new AuthStore(authStorePath);
const authConfig = resolveAuthConfig(process.env, (await authStore.read()).config);

await new AuthKernel(authConfig.mode, authStore, true, authConfig.trustedHeader, authConfig.policy, authConfig.methods).refreshConfig();

let child: ChildProcess | undefined;
let childStarting = false;
let childGeneration = 0;
const intentionalStops = new Set<number>();

async function isAuthorized(req: IncomingMessage, mutation = false): Promise<boolean> {
  try {
    const kernel = new AuthKernel(authConfig.mode, new AuthStore(authStorePath), true, authConfig.trustedHeader, authConfig.policy, authConfig.methods);
    await kernel.refreshConfig();
    const auth = await kernel.gate(req);
    if (!auth.ok) return false;
    return !mutation || auth.via !== "session" || (!!req.headers["x-pi-web-client-id"] && trustedOrigin(req, process.env.PI_WEB_AUTH_ORIGIN || `http://localhost:${publicPort}`));
  } catch { return false; }
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function startChild(): void {
  if (childStarting) return;
  childStarting = true;
  childGeneration += 1;
  const generation = childGeneration;

  const env = {
    ...process.env,
    HOST: childHost,
    PORT: String(childPort),
    PI_WEB_DEV: process.env.PI_WEB_DEV || "1",
    PI_WEB_SUPERVISED: "1",
    PI_WEB_SUPERVISOR_SECRET: supervisorSecret,
    PI_WEB_AUTH_ORIGIN: process.env.PI_WEB_AUTH_ORIGIN || `http://localhost:${publicPort}`,
  };

  console.log(`[supervisor] starting child #${generation} on ${childHost}:${childPort}`);
  const nextChild = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child = nextChild;

  nextChild.stdout?.on("data", (chunk) => process.stdout.write(`[server] ${chunk}`));
  nextChild.stderr?.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));

  nextChild.on("spawn", () => {
    childStarting = false;
  });

  nextChild.on("exit", (code, signal) => {
    if (child?.pid === undefined || childGeneration !== generation) return;
    const wasIntentional = nextChild.pid !== undefined && intentionalStops.delete(nextChild.pid);
    console.log(`[supervisor] child #${generation} exited code=${code ?? ""} signal=${signal ?? ""}`);
    child = undefined;
    childStarting = false;
    if (!wasIntentional) {
      console.warn(`[supervisor] child #${generation} stopped unexpectedly; restarting in 1s`);
      setTimeout(startChild, 1000);
    }
  });
}

function stopChild(): Promise<void> {
  return new Promise((resolve) => {
    const current = child;
    if (!current || current.pid === undefined || current.exitCode !== null) return resolve();
    intentionalStops.add(current.pid);

    const timeout = setTimeout(() => {
      current.kill("SIGKILL");
      resolve();
    }, 5000);

    current.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });

    if (!current.killed) current.kill("SIGTERM");
  });
}

async function restartChild(): Promise<void> {
  console.log("[supervisor] restarting child");
  await stopChild();
  await new Promise((resolve) => setTimeout(resolve, restartGraceMs));
  startChild();
}

function destroyQuietly(socket: NodeJS.WritableStream & { destroy?: (error?: Error) => void }, error?: Error): void {
  socket.destroy?.(error);
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  sanitizeProxyHeaders(req, isLocalTunnelRequest(req));
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/api/restart" || url.pathname === "/__supervisor/restart") {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST required" });
    if (!trustedOrigin(req, process.env.PI_WEB_AUTH_ORIGIN || `http://localhost:${publicPort}`)) return sendJson(res, 403, { ok: false, error: originFailureHint });
    if (!await isAuthorized(req, true)) return sendJson(res, 401, { ok: false, error: "Unauthorized" });
    sendJson(res, 202, { ok: true, message: "Restarting pi-web child" });
    void restartChild();
    return;
  }

  if (url.pathname === "/__supervisor/status") {
    if (!await isAuthorized(req)) return sendJson(res, 401, { ok: false, error: "Unauthorized" });
    return sendJson(res, 200, {
      ok: true,
      childPid: child?.pid,
      childGeneration,
      childHost,
      childPort,
    });
  }

  proxyHttpRequest(req, res, { host: childHost, port: childPort, preserveHost: true });
}

function sanitizeProxyHeaders(req: IncomingMessage, tunnel: boolean) {
  const authority = forwardedHost(req);
  if (authority) req.headers.host = authority;
  if (!trustedProxyPeer(req)) delete req.headers["x-forwarded-for"];
  if (tunnelSocketPath) {
    stripSupervisorPeerHeaders(req.headers);
    const trustedHeader = (process.env.PI_WEB_AUTH_TRUSTED_HEADER || "").toLowerCase();
    if (tunnel) {
      stampSupervisorTunnel(req, supervisorSecret);
    } else {
      if (trustedHeader) delete req.headers[trustedHeader];
    }
  }
  // Resolve trust at the public socket, never at the supervisor's loopback hop.
  delete req.headers["x-forwarded-host"];
}

const supervisor = createServer(handleRequest);
const tunnelSupervisor = createServer((req, res) => {
  markTunnelRequest(req);
  void handleRequest(req, res);
});
const acceptedSockets = new Set<net.Socket>();

for (const server of [supervisor, tunnelSupervisor]) {
  server.on("connection", (socket) => {
    acceptedSockets.add(socket);
    socket.once("close", () => acceptedSockets.delete(socket));
  });
}

function handleUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  tunnel: boolean,
): void {
  if (tunnel) markTunnelRequest(req);
  if (!trustedOrigin(req, process.env.PI_WEB_AUTH_ORIGIN || `http://localhost:${publicPort}`)) {
    socket.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(originFailureHint)}\r\n\r\n${originFailureHint}`);
    return;
  }
  sanitizeProxyHeaders(req, tunnel);
  proxyUpgrade(req, socket, head);
}

supervisor.on("upgrade", (req, socket, head) =>
  handleUpgrade(req, socket, head, false));
tunnelSupervisor.on("upgrade", (req, socket, head) =>
  handleUpgrade(req, socket, head, true));

function proxyUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  const upstream = net.connect(childPort, childHost);
  let closed = false;

  const closeBoth = (error?: Error) => {
    if (closed) return;
    closed = true;
    destroyQuietly(socket, error);
    destroyQuietly(upstream, error);
  };

  socket.on("error", (error) => closeBoth(error));
  upstream.on("error", (error) => closeBoth(error));
  socket.on("close", () => closeBoth());
  upstream.on("close", () => closeBoth());

  upstream.on("connect", () => {
    upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) {
        for (const item of value) upstream.write(`${name}: ${item}\r\n`);
      } else if (value !== undefined) {
        upstream.write(`${name}: ${value}\r\n`);
      }
    }
    upstream.write("\r\n");
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
}

supervisor.on("clientError", (_error, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});
tunnelSupervisor.on("clientError", (_error, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

let tunnelSocketIdentity: Awaited<ReturnType<typeof listenOnTunnelSocket>> | undefined;
async function shutdown(): Promise<void> {
  console.log("[supervisor] shutting down");
  const listenerClosures = [
    new Promise<void>((resolve) => {
      if (!supervisor.listening) return resolve();
      supervisor.close(() => resolve());
    }),
    tunnelSocketIdentity
      ? closeTunnelSocket(tunnelSupervisor, tunnelSocketPath, tunnelSocketIdentity)
      : Promise.resolve(),
  ];
  await stopChild();
  for (const socket of acceptedSockets) socket.destroy();
  await Promise.all(listenerClosures);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("SIGHUP", () => void shutdown()); // tmux kill-session must also stop the child.

async function listenTcp(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      supervisor.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      supervisor.off("error", onError);
      resolve();
    };
    supervisor.once("error", onError);
    supervisor.once("listening", onListening);
    supervisor.listen(publicPort, publicHost);
  });
}

async function start(): Promise<void> {
  if (tunnelSocketPath)
    tunnelSocketIdentity = await listenOnTunnelSocket(tunnelSupervisor, tunnelSocketPath);
  await listenTcp();
  startChild();
  console.log(`[supervisor] listening on http://${publicHost}:${publicPort}`);
  if (tunnelSocketPath)
    console.log(`[supervisor] trusted tunnel socket ${tunnelSocketPath}`);
  console.log(`[supervisor] child target http://${childHost}:${childPort}`);
  console.log("[supervisor] restart/status endpoints use canonical persistent auth policy");
}

void start().catch(async (error) => {
  console.error(`[supervisor] startup failed: ${error instanceof Error ? error.message : String(error)}`);
  if (tunnelSocketIdentity)
    await closeTunnelSocket(tunnelSupervisor, tunnelSocketPath, tunnelSocketIdentity).catch(() => undefined);
  await stopChild();
  process.exit(1);
});
