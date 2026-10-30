import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { AuthKernel, AuthStore } from "./server/auth/kernel.js";
import { resolveAuthConfig } from "./server/auth/config.js";
import { browserMutationFailure, type MutationAdmissionFailure } from "./server/auth/admission.js";
import { trustedOrigin, originFailureHint } from "./server/auth/origin.js";
import { forwardedHost, trustedProxyPeer } from "./server/auth/proxy.js";
import { stampSupervisorOrigin, stripSupervisorOriginHeaders } from "./server/auth/supervisorOrigin.js";
import { proxyHttpRequest } from "./server/shared/httpProxy.js";
import { resolveWebHomePath } from "./server/shared/webHome.js";

const publicHost = process.env.HOST || "127.0.0.1";
const publicPort = Number(process.env.PORT || 8787);
const childHost = process.env.PI_WEB_CHILD_HOST || "127.0.0.1";
const childPort = Number(process.env.PI_WEB_CHILD_PORT || publicPort + 1);
const restartGraceMs = Number(process.env.PI_WEB_RESTART_GRACE_MS || 250);
const supervisorSecret = randomBytes(32).toString("base64url");
const authStorePath = resolveWebHomePath("web/auth.json", join(getAgentDir(), "web", "auth.json"), process.env.PI_WEB_AUTH_STORE);
const authStore = new AuthStore(authStorePath);
const authConfig = resolveAuthConfig(process.env, (await authStore.read()).config);

await new AuthKernel(authConfig.mode, authStore, true, authConfig.trustedHeader, authConfig.policy, authConfig.methods).refreshConfig();

let child: ChildProcess | undefined;
let childStarting = false;
let childGeneration = 0;
const intentionalStops = new Set<number>();

async function authorization(req: IncomingMessage, mutation = false): Promise<"allowed" | "unauthorized" | MutationAdmissionFailure> {
  try {
    const kernel = new AuthKernel(authConfig.mode, new AuthStore(authStorePath), true, authConfig.trustedHeader, authConfig.policy, authConfig.methods);
    await kernel.refreshConfig();
    const auth = await kernel.gate(req);
    if (!auth.ok) return "unauthorized";
    if (mutation) {
      const failure = browserMutationFailure(req, auth.via, process.env.PI_WEB_AUTH_ORIGIN || `http://localhost:${publicPort}`, process.env.PI_WEB_MOCK === "1");
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

const supervisor = createServer(async (req, res) => {
  stripSupervisorOriginHeaders(req.headers);
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/api/restart" || url.pathname === "/__supervisor/restart") {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST required" });
    const auth = await authorization(req, true);
    if (auth !== "allowed") return sendJson(res, auth === "unauthorized" ? 401 : 403, {
      ok: false,
      error: auth === "origin" ? originFailureHint : auth === "intent" ? "CSRF validation failed" : "Unauthorized",
    });
    sendJson(res, 202, { ok: true, message: "Restarting pi-web child" });
    void restartChild();
    return;
  }

  if (url.pathname === "/__supervisor/status") {
    if (await authorization(req) !== "allowed") return sendJson(res, 401, { ok: false, error: "Unauthorized" });
    return sendJson(res, 200, {
      ok: true,
      childPid: child?.pid,
      childGeneration,
      childHost,
      childPort,
    });
  }

  const originValidated = trustedOrigin(req, process.env.PI_WEB_AUTH_ORIGIN || `http://localhost:${publicPort}`);
  sanitizeProxyHeaders(req, originValidated);
  proxyHttpRequest(req, res, { host: childHost, port: childPort, preserveHost: true });
});

function sanitizeProxyHeaders(req: IncomingMessage, originValidated: boolean) {
  const authority = forwardedHost(req);
  if (authority) req.headers.host = authority;
  if (!trustedProxyPeer(req)) delete req.headers["x-forwarded-for"];
  // Resolve trust at the public socket, never at the supervisor's loopback hop.
  delete req.headers["x-forwarded-host"];
  stripSupervisorOriginHeaders(req.headers);
  if (originValidated) stampSupervisorOrigin(req, supervisorSecret);
}

supervisor.on("upgrade", (req, socket, head) => {
  stripSupervisorOriginHeaders(req.headers);
  const configuredOrigin = process.env.PI_WEB_AUTH_ORIGIN || `http://localhost:${publicPort}`;
  const originValidated = trustedOrigin(req, configuredOrigin);
  sanitizeProxyHeaders(req, originValidated);
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
});

supervisor.on("clientError", (_error, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

function shutdown(): void {
  console.log("[supervisor] shutting down");
  supervisor.close();
  void stopChild().finally(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown); // tmux kill-session must also stop the child.

startChild();
supervisor.listen(publicPort, publicHost, () => {
  console.log(`[supervisor] listening on http://${publicHost}:${publicPort}`);
  console.log(`[supervisor] child target http://${childHost}:${childPort}`);
  console.log("[supervisor] restart/status endpoints use canonical persistent auth policy");
});
