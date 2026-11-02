import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { runtimeFingerprint, runtimePreflight, manualRuntimeRestartMessage } from "./server/runtimePreflight.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { AuthKernel, AuthStore } from "./server/auth/kernel.js";
import { resolveAuthConfig } from "./server/auth/config.js";
import { browserMutationFailure, type MutationAdmissionFailure } from "./server/auth/admission.js";
import { createOriginRejectionReporter, trustedOrigin, originFailureHint } from "./server/auth/origin.js";
import { forwardedHost, trustedProxyPeer } from "./server/auth/proxy.js";
import {
  UNKNOWN_SUPERVISOR_PEER,
  resolveSupervisorPeer,
  stampSupervisorProvenance,
  stripSupervisorProvenanceHeaders,
} from "./server/auth/supervisorPeer.js";
import { proxyHttpRequest } from "./server/shared/httpProxy.js";
import { createUpgradeProxy } from "./server/shared/upgradeProxy.js";
import {
  closeTunnelSocket,
  listenOnTunnelSocket,
} from "./server/tunnelSocket.js";
import { resolveWebHomePath } from "./server/shared/webHome.js";

const publicHost = process.env.HOST || "127.0.0.1";
const publicPort = Number(process.env.PORT || 8787);
const childHost = process.env.PI_WEB_CHILD_HOST || "127.0.0.1";
const childPort = Number(process.env.PI_WEB_CHILD_PORT || publicPort + 1);
const childAuthOrigin = process.env.PI_WEB_AUTH_ORIGIN || `http://localhost:${publicPort}`;
const reportOriginRejection = createOriginRejectionReporter(process.env.PI_WEB_AUTH_ORIGIN);
const restartGraceMs = Number(process.env.PI_WEB_RESTART_GRACE_MS || 250);
const tunnelSocketPath = process.env.PI_WEB_TUNNEL_SOCKET || "";
const supervisorSecret = randomBytes(32).toString("base64url");
const authStorePath = resolveWebHomePath("web/auth.json", join(getAgentDir(), "web", "auth.json"), process.env.PI_WEB_AUTH_STORE);
const authStore = new AuthStore(authStorePath);
const authConfig = resolveAuthConfig(process.env, (await authStore.read()).config);
await new AuthKernel(authConfig.mode, authStore, true, authConfig.trustedHeader, authConfig.policy, authConfig.methods).refreshConfig();
const upgradeHandshakeMs = 10_000;
const isChildDev = process.env.PI_WEB_DEV === "1";

const loadedRuntimeFingerprint = await runtimeFingerprint(process.cwd()).catch(() => undefined);
let shuttingDown = false;
let restartPending = false;
let crashTimer: ReturnType<typeof setTimeout> | undefined;
let child: ChildProcess | undefined;
let childStarting = false;
let childGeneration = 0;
const intentionalStops = new Set<number>();

async function authorization(req: IncomingMessage, mutation = false): Promise<"allowed" | "unauthorized" | MutationAdmissionFailure> {
  try {
    const kernel = new AuthKernel(authConfig.mode, new AuthStore(authStorePath), true, authConfig.trustedHeader, authConfig.policy, authConfig.methods, undefined, authConfig.explicitOpenPolicy);
    await kernel.refreshConfig();
    const auth = await kernel.gate(req);
    if (!auth.ok) return "unauthorized";
    if (mutation) {
      const failure = browserMutationFailure(req, auth.via, childAuthOrigin, process.env.PI_WEB_MOCK === "1");
      if (failure) return failure;
    }
    return "allowed";
  } catch { return "unauthorized"; }
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
  if (childStarting || shuttingDown || (child && child.exitCode === null && child.signalCode === null)) return;
  if (crashTimer) clearTimeout(crashTimer);
  crashTimer = undefined;
  childStarting = true;
  childGeneration += 1;
  const generation = childGeneration;

  const devMode = process.env.PI_WEB_DEV === "1";
  if (devMode) console.warn("[supervisor] development mode explicitly enabled");
  const env = {
    ...process.env,
    HOST: childHost,
    PORT: String(childPort),
    PI_WEB_DEV: devMode ? "1" : "0",
    PI_WEB_SUPERVISED: "1",
    PI_WEB_SUPERVISOR_SECRET: supervisorSecret,
    PI_WEB_AUTH_INTERNAL_ORIGIN: childAuthOrigin,
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
  nextChild.on("error", (error) => {
    childStarting = false;
    console.error(`[supervisor] Child spawn failed: ${error.message}`);
  });

  nextChild.on("exit", (code, signal) => {
    if (child?.pid === undefined || childGeneration !== generation) return;
    const wasIntentional = nextChild.pid !== undefined && intentionalStops.delete(nextChild.pid);
    console.log(`[supervisor] child #${generation} exited code=${code ?? ""} signal=${signal ?? ""}`);
    child = undefined;
    childStarting = false;
    if (!wasIntentional && !shuttingDown) {
      console.warn(`[supervisor] child #${generation} stopped unexpectedly; restarting in 1s`);
      const recover = () => {
        crashTimer = undefined;
        if (shuttingDown) return;
        if (restartPending) {
          crashTimer = setTimeout(recover, 1000);
          return;
        }
        // Availability takes priority after an unexpected exit. The identity
        // guard applies only to an operator-requested stop of a working child.
        startChild();
      };
      crashTimer = setTimeout(recover, 1000);
    }
  });
}

function stopChild(): Promise<void> {
  return new Promise((resolve, reject) => {
    const current = child;
    if (!current || current.pid === undefined || current.exitCode !== null) return resolve();
    intentionalStops.add(current.pid);

    let killTimeout: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      current.kill("SIGKILL");
      // Never launch a replacement before the old process actually exits.
      killTimeout = setTimeout(() => reject(new Error("Child did not exit after SIGKILL; replacement was not started.")), 1000);
    }, 5000);

    current.once("exit", () => {
      clearTimeout(timeout);
      clearTimeout(killTimeout);
      resolve();
    });

    if (!current.killed) current.kill("SIGTERM");
  });
}

async function restartChild(): Promise<void> {
  console.log("[supervisor] restarting child");
  try {
    if (crashTimer) clearTimeout(crashTimer);
    crashTimer = undefined;
    await stopChild();
    await new Promise((resolve) => setTimeout(resolve, restartGraceMs));
    startChild();
  } catch (error) {
    console.error(`[supervisor] ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    restartPending = false;
  }
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  tunnel: boolean,
): Promise<void> {
  try {
    let url: URL;
    try {
      url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    } catch {
      sendJson(res, 400, { ok: false, error: "Bad Request" });
      return;
    }

    sanitizeProxyHeaders(req, tunnel);

    if (url.pathname === "/api/restart" || url.pathname === "/__supervisor/restart") {
      if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST required" });
      const auth = await authorization(req, true);
      if (auth !== "allowed") {
        if (auth === "origin") reportOriginRejection(req);
        return sendJson(res, auth === "unauthorized" ? 401 : 403, {
          ok: false,
          error: auth === "origin" ? originFailureHint : auth === "intent" ? "CSRF validation failed" : "Unauthorized",
        });
      }
      if (shuttingDown || restartPending) return sendJson(res, 409, { ok: false, error: "A lifecycle operation is already in progress." });
      // Reserve before asynchronous filesystem checks so concurrent requests
      // cannot both pass admission and replace the child twice.
      restartPending = true;
      let preflight;
      try {
        preflight = await runtimePreflight(process.cwd(), loadedRuntimeFingerprint);
      } catch {
        restartPending = false;
        return sendJson(res, 503, { ok: false, error: "Runtime preflight failed; nothing has been stopped." });
      }
      if (!preflight.ok) {
        restartPending = false;
        return sendJson(res, 409, { ok: false, code: "FULL_RUNTIME_RESTART_REQUIRED", error: manualRuntimeRestartMessage });
      }
      if (shuttingDown) {
        restartPending = false;
        return sendJson(res, 409, { ok: false, error: "Shutdown is in progress." });
      }
      sendJson(res, 202, { ok: true, scope: "child", message: "Restarting pi-web child" });
      void restartChild();
      return;
    }

    if (url.pathname === "/__supervisor/status") {
      if (await authorization(req) !== "allowed") return sendJson(res, 401, { ok: false, error: "Unauthorized" });
      return sendJson(res, 200, {
        ok: true,
        runtimeProtocol: 1,
        childPid: child?.pid,
        childGeneration,
        childHost,
        childPort,
      });
    }

    proxyHttpRequest(req, res, { host: childHost, port: childPort, preserveHost: true });
  } catch (error) {
    if (!res.headersSent && !res.destroyed) {
      sendJson(res, 500, { ok: false, error: "Supervisor request failed" });
    } else if (!res.destroyed) {
      res.destroy(error instanceof Error ? error : undefined);
    }
  }
}

function sanitizeProxyHeaders(
  req: IncomingMessage,
  tunnel: boolean,
) {
  stripSupervisorProvenanceHeaders(req.headers);
  const trustedForwarder = trustedProxyPeer(req);
  const authority = forwardedHost(req);
  if (authority) req.headers.host = authority;
  const forwarded = req.headers["x-forwarded-for"];
  const peer = resolveSupervisorPeer(
    req.socket.remoteAddress,
    forwarded,
    trustedForwarder,
  );
  if (peer !== UNKNOWN_SUPERVISOR_PEER) {
    req.headers["x-forwarded-for"] = peer;
  } else {
    delete req.headers["x-forwarded-for"];
  }
  if (tunnelSocketPath && !tunnel) {
    const trustedHeader = (process.env.PI_WEB_AUTH_TRUSTED_HEADER || "").toLowerCase();
    if (trustedHeader) delete req.headers[trustedHeader];
  }
  // Resolve trust at the public socket, never at the supervisor's loopback hop.
  delete req.headers["x-forwarded-host"];
  stampSupervisorProvenance(req, peer, tunnel, supervisorSecret);
}

const supervisor = createServer((req, res) => {
  void handleRequest(req, res, false);
});
const tunnelSupervisor = createServer((req, res) => {
  void handleRequest(req, res, true);
});
const acceptedSockets = new Set<Socket>();

for (const server of [supervisor, tunnelSupervisor]) {
  server.on("connection", (socket) => {
    acceptedSockets.add(socket);
    socket.once("close", () => acceptedSockets.delete(socket));
  });
}

function upgradeProxy(tunnel: boolean) {
  return createUpgradeProxy({
    host: childHost,
    port: childPort,
    expectedPath: (req, url) => url.pathname === "/ws"
      || (isChildDev
        && url.pathname === "/"
        && (req.headers["sec-websocket-protocol"] === "vite-hmr"
          || req.headers["sec-websocket-protocol"] === "vite-ping")),
    handshakeTimeoutMs: upgradeHandshakeMs,
    maxPending: 32,
    maxPendingPerPeer: 8,
    // Originless ticket connections are valid for machine credentials. The
    // child redeems the ticket and applies browser-origin policy by auth class.
    accept: (req) => req.headers.origin === undefined
      || trustedOrigin(req, childAuthOrigin),
    prepare: (req) => {
      sanitizeProxyHeaders(req, tunnel);
    },
    rejectionBody: originFailureHint,
  });
}

// Separate relay instances keep TCP and trusted Unix pending budgets isolated.
supervisor.on("upgrade", upgradeProxy(false));
tunnelSupervisor.on("upgrade", upgradeProxy(true));

supervisor.on("clientError", (_error, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});
tunnelSupervisor.on("clientError", (_error, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

let tunnelSocketIdentity: Awaited<ReturnType<typeof listenOnTunnelSocket>> | undefined;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (crashTimer) clearTimeout(crashTimer);
  crashTimer = undefined;
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
