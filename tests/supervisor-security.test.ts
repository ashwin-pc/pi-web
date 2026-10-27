import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { AuthenticatedViteUpgrades, serveAuthenticatedViteRequest } from "../server/auth/devAccess.js";
import { AuthStore, hashSecret } from "../server/auth/kernel.js";
import { isolatedAuthEnv } from "./auth-isolation.js";

const projectRoot = new URL("..", import.meta.url).pathname;
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

async function waitFor<T>(operation: () => Promise<T | undefined>, process: ChildProcess, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await operation().catch(() => undefined);
    if (value !== undefined) return value;
    if (process.exitCode !== null || process.signalCode !== null) {
      throw new Error(`Supervisor exited early: code=${process.exitCode} signal=${process.signalCode}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

async function stop(process: ChildProcess): Promise<void> {
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

afterEach(async () => {
  await Promise.all([...supervisors].map(async (process) => {
    supervisors.delete(process);
    await stop(process);
  }));
});

async function startSupervisor(options: {
  dev?: boolean;
  host?: string;
  authMode?: "legacy" | "external";
  authMethods?: string;
  trustedHeader?: string;
  token?: string;
  configure?: (store: AuthStore) => Promise<void>;
} = {}) {
  const publicPort = await freePort();
  const childPort = await freePort();
  const home = await mkdtemp(join(tmpdir(), "pi-web-supervisor-security-"));
  const store = new AuthStore(join(home, "auth.json"));
  await options.configure?.(store);
  const origin = `http://127.0.0.1:${publicPort}`;
  const env = {
    ...isolatedAuthEnv(),
    HOST: options.host || "127.0.0.1",
    PORT: String(publicPort),
    PI_WEB_CHILD_PORT: String(childPort),
    PI_WEB_HOME: home,
    PI_WEB_AUTH_STORE: store.path,
    PI_WEB_AUTH_MODE: options.authMode || "external",
    PI_WEB_AUTH_METHODS: options.authMethods ?? "external",
    PI_WEB_AUTH_POLICY: "authenticated",
    PI_WEB_AUTH_TRUSTED_HEADER: options.trustedHeader ?? "x-amzn-tunnel-user",
    PI_WEB_AUTH_PROXY_PEERS: "127.0.0.1",
    PI_WEB_AUTH_ORIGIN: origin,
    PI_WEB_MOCK: "1",
    PI_WEB_NO_SESSION: "1",
    ...(options.dev ? { PI_WEB_DEV: "1" } : {}),
    ...(options.token ? { PI_WEB_TOKEN: options.token } : {}),
  };
  if (!options.token) delete env.PI_WEB_TOKEN;
  let output = "";
  const supervisorProcess = spawn(process.execPath, ["--import", "tsx", "supervisor.ts"], {
    cwd: projectRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  supervisorProcess.stdout?.on("data", (chunk) => { output += chunk; });
  supervisorProcess.stderr?.on("data", (chunk) => { output += chunk; });
  supervisors.add(supervisorProcess);
  await waitFor(async () => {
    const response = await fetch(`${origin}/api/state`, { headers: { authorization: "Bearer synthetic-machine-token" } });
    return response.ok ? true : undefined;
  }, supervisorProcess);
  return { publicPort, childPort, origin, process: supervisorProcess, store, output: () => output };
}

async function websocketHello(origin: string, cookie: string): Promise<void> {
  const ticketResponse = await fetch(`${origin}/api/ws-ticket`, {
    method: "POST",
    headers: { cookie, origin, "x-pi-web-client-id": "synthetic-browser" },
  });
  expect(ticketResponse.status).toBe(201);
  const { ticket } = await ticketResponse.json() as { ticket: string };
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`${origin.replace("http:", "ws:")}/ws?ticket=${encodeURIComponent(ticket)}`, {
      origin,
    });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("Timed out waiting for WebSocket hello"));
    }, 5_000);
    ws.once("message", () => {
      clearTimeout(timer);
      ws.close();
      resolve();
    });
    ws.once("error", reject);
  });
}

async function viteHmrUrl(origin: string, cookie: string): Promise<string> {
  const module = await fetch(`${origin}/src/main.ts`, { headers: { cookie } });
  expect(module.status).toBe(200);
  const viteClient = await (await fetch(`${origin}/@vite/client`, { headers: { cookie } })).text();
  const wsToken = /const wsToken = "([^"]+)"/.exec(viteClient)?.[1];
  expect(wsToken).toBeTruthy();
  return `${origin.replace("http:", "ws:")}/?token=${encodeURIComponent(wsToken!)}`;
}

async function expectHmrRejection(url: string, origin: string, headers: Record<string, string>, expectedStatus: number): Promise<void> {
  const status = await new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(url, "vite-hmr", { origin, headers });
    ws.once("unexpected-response", (_request, response) => resolve(response.statusCode));
    ws.once("open", () => {
      ws.close();
      reject(new Error(`HMR upgrade unexpectedly opened for ${origin}`));
    });
    ws.once("error", () => undefined);
  });
  expect(status).toBe(expectedStatus);
}

async function expectHmrOpen(url: string, origin: string, headers: Record<string, string>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url, "vite-hmr", { origin, headers });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("Authenticated HMR upgrade did not open"));
    }, 5_000);
    ws.once("open", () => {
      clearTimeout(timer);
      ws.close();
      resolve();
    });
    ws.once("error", reject);
  });
}

describe("supervisor authentication boundary", () => {
  it("keeps installed Vite HMR authenticated across an in-process Vite restart", async () => {
    const publicPort = await freePort();
    const origin = `http://127.0.0.1:${publicPort}`;
    const cookie = "pi_web_session=synthetic";
    const authKernel = {
      refreshConfig: async () => undefined,
      gate: async (req: { headers: { cookie?: string } }) => req.headers.cookie === cookie
        ? { ok: true, identity: { id: "session:owner" }, via: "session" }
        : { ok: false },
    } as any;
    const viteHmrServer = createServer();
    const viteUpgrades = new AuthenticatedViteUpgrades(authKernel, origin, viteHmrServer);
    let vite: ViteDevServer | undefined;
    const publicServer = createServer((req, res) => {
      if (!vite) {
        res.writeHead(503).end();
        return;
      }
      const pathname = new URL(req.url || "/", origin).pathname;
      void serveAuthenticatedViteRequest(vite, authKernel, "/does-not-exist", req, res, pathname);
    });
    publicServer.on("upgrade", (req, socket, head) => viteUpgrades.handle(req, socket, head));

    await new Promise<void>((resolve, reject) => {
      publicServer.once("error", reject);
      publicServer.listen(publicPort, "127.0.0.1", resolve);
    });
    try {
      vite = await createViteServer({
        appType: "spa",
        configFile: false,
        // This fixture exercises HMR ownership, not application dependency scanning.
        optimizeDeps: { noDiscovery: true, include: [] },
        server: {
          allowedHosts: true,
          middlewareMode: true,
          watch: null,
          hmr: { server: viteHmrServer },
        },
      });

      const initialHmr = await viteHmrUrl(origin, cookie);
      await expectHmrOpen(initialHmr, origin, { cookie });

      await vite.restart();
      expect(publicServer.listenerCount("upgrade")).toBe(1);
      expect(viteHmrServer.listenerCount("upgrade")).toBe(1);

      const replacementHmr = await viteHmrUrl(origin, cookie);
      await expectHmrRejection(replacementHmr, origin, {}, 401);
      await expectHmrRejection(
        replacementHmr,
        "https://hostile.example.invalid",
        { cookie },
        403,
      );
      await expectHmrOpen(replacementHmr, origin, { cookie });
    } finally {
      await Promise.all([
        vite?.close(),
        new Promise<void>((resolve, reject) => publicServer.close((error) => error ? reject(error) : resolve())),
      ]);
    }
  }, 30_000);

  it("preserves legitimate deployment flows while enforcing the authenticated outer peer", async () => {
    const setupToken = "synthetic-bootstrap-token";
    const instance = await startSupervisor({
      configure: async (store) => store.update((state) => {
        state.config = { policy: "authenticated", methods: ["external"] };
        state.bootstrap = { hash: hashSecret(setupToken), expiresAt: Date.now() + 60_000 };
        state.apiTokens.push({
          id: "synthetic-machine",
          name: "Synthetic machine",
          hash: hashSecret("synthetic-machine-token"),
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        });
      }),
    });

    const machineMutation = await fetch(`${instance.origin}/api/mock/reset`, {
      method: "POST",
      headers: { authorization: "Bearer synthetic-machine-token", "content-type": "application/json" },
      body: "{}",
    });
    expect(machineMutation.status).toBe(200);

    const remoteBootstrap = await fetch(`${instance.origin}/api/auth/password/bootstrap`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: instance.origin,
        "x-forwarded-for": "192.0.2.60",
      },
      body: JSON.stringify({ token: setupToken, password: "a synthetic setup password" }),
    });
    expect(remoteBootstrap.status).toBe(403);

    const chainedForwardedBootstrap = await fetch(`${instance.origin}/api/auth/password/bootstrap`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: instance.origin,
        "x-forwarded-for": "203.0.113.9, 198.51.100.2",
      },
      body: JSON.stringify({ token: setupToken, password: "a synthetic setup password" }),
    });
    expect(chainedForwardedBootstrap.status).toBe(403);

    const localBootstrap = await fetch(`${instance.origin}/api/auth/password/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: instance.origin, "x-forwarded-for": "127.0.0.1" },
      body: JSON.stringify({ token: setupToken, password: "a synthetic setup password" }),
    });
    expect(localBootstrap.status).toBe(200);

    const externalLogin = await fetch(`${instance.origin}/api/auth/external/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: instance.origin,
        "x-amzn-tunnel-user": "synthetic-owner@example.invalid",
        "x-forwarded-for": "192.0.2.50, 198.51.100.2",
      },
      body: "{}",
    });
    expect(externalLogin.status).toBe(200);
    const cookie = externalLogin.headers.get("set-cookie")!.split(";")[0];

    const wrongOrigin = await fetch(`${instance.origin}/api/auth/authorize`, {
      method: "POST",
      headers: { cookie, origin: "https://other.example.invalid", "x-pi-web-client-id": "synthetic-browser" },
    });
    expect(wrongOrigin.status).toBe(403);
    const rightOrigin = await fetch(`${instance.origin}/api/auth/authorize`, {
      method: "POST",
      headers: { cookie, origin: instance.origin, "x-pi-web-client-id": "synthetic-browser" },
    });
    expect(rightOrigin.status).toBe(200);

    await websocketHello(instance.origin, cookie);
    await websocketHello(instance.origin, cookie);

    const before = await (await fetch(`${instance.origin}/__supervisor/status`, {
      headers: { authorization: "Bearer synthetic-machine-token" },
    })).json() as { childGeneration: number };
    const restart = await fetch(`${instance.origin}/api/restart`, {
      method: "POST",
      headers: { cookie, origin: instance.origin, "x-pi-web-client-id": "synthetic-browser" },
    });
    expect(restart.status).toBe(202);
    await waitFor(async () => {
      const response = await fetch(`${instance.origin}/__supervisor/status`, {
        headers: { authorization: "Bearer synthetic-machine-token" },
      });
      if (!response.ok) return undefined;
      const current = await response.json() as { childGeneration: number };
      return current.childGeneration > before.childGeneration ? current : undefined;
    }, instance.process);
  }, 30_000);

  const configureMachineToken = async (store: AuthStore) => store.update((state) => {
    state.config = { policy: "authenticated", methods: [] };
    state.apiTokens.push({
      id: "synthetic-machine",
      name: "Synthetic machine",
      hash: hashSecret("synthetic-machine-token"),
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
  });

  it("defaults supervised startup to production", async () => {
    const production = await startSupervisor({ configure: configureMachineToken });
    await waitFor(async () => production.output().includes("Mode: production") ? true : undefined, production.process);
    expect((await fetch(`${production.origin}/src/main.ts`, {
      headers: { authorization: "Bearer synthetic-machine-token" },
    })).status).toBe(404);
  }, 30_000);

  it("keeps explicit dev mode authenticated on an explicit non-loopback bind", async () => {
    const development = await startSupervisor({ configure: configureMachineToken, dev: true, host: "0.0.0.0" });
    await waitFor(async () => development.output().includes("Mode: development") ? true : undefined, development.process);
    expect((await fetch(`${development.origin}/src/main.ts`)).status).toBe(401);
    expect((await fetch(`${development.origin}/src/main.ts`, {
      headers: { authorization: "Bearer synthetic-machine-token" },
    })).status).toBe(200);
    expect((await fetch(`${development.origin}/pwa-192x192.png`)).status).toBe(200);
    const viteClient = await (await fetch(`${development.origin}/@vite/client`, {
      headers: { authorization: "Bearer synthetic-machine-token" },
    })).text();
    const wsToken = /const wsToken = "([^"]+)"/.exec(viteClient)?.[1];
    expect(wsToken).toBeTruthy();
    const hmrUrl = `${development.origin.replace("http:", "ws:")}/?token=${encodeURIComponent(wsToken!)}`;

    await expectHmrRejection(hmrUrl, development.origin, {}, 401);
    await expectHmrOpen(hmrUrl, development.origin, { authorization: "Bearer synthetic-machine-token" });
  }, 30_000);

  it("turns legacy links and ambient external HTML auth into sessions before Vite modules and HMR load", async () => {
    const legacyToken = "synthetic-legacy-link-token";
    const legacy = await startSupervisor({
      dev: true,
      authMode: "legacy",
      authMethods: "legacy",
      trustedHeader: "",
      token: legacyToken,
      configure: async (store) => store.update((state) => {
        state.config = { policy: "authenticated", methods: ["legacy"] };
        state.apiTokens.push({
          id: "synthetic-machine",
          name: "Synthetic machine",
          hash: hashSecret("synthetic-machine-token"),
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        });
      }),
    });
    const legacyHtml = await fetch(`${legacy.origin}/?token=${encodeURIComponent(legacyToken)}`, {
      headers: { accept: "text/html" },
    });
    expect(legacyHtml.status).toBe(200);
    const legacySetCookie = legacyHtml.headers.get("set-cookie")!;
    expect(legacySetCookie).toContain("HttpOnly");
    const legacyCookie = legacySetCookie.split(";")[0];
    const legacyHmr = await viteHmrUrl(legacy.origin, legacyCookie);
    await expectHmrOpen(legacyHmr, legacy.origin, { cookie: legacyCookie });

    const external = await startSupervisor({
      dev: true,
      configure: async (store) => store.update((state) => {
        state.config = { policy: "authenticated", methods: ["external"] };
        state.apiTokens.push({
          id: "synthetic-machine",
          name: "Synthetic machine",
          hash: hashSecret("synthetic-machine-token"),
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        });
      }),
    });
    const externalHtml = await fetch(external.origin, {
      headers: {
        accept: "text/html",
        "x-amzn-tunnel-user": "synthetic-owner@example.invalid",
      },
    });
    expect(externalHtml.status).toBe(200);
    const externalSetCookie = externalHtml.headers.get("set-cookie")!;
    expect(externalSetCookie).toContain("HttpOnly");
    const externalCookie = externalSetCookie.split(";")[0];
    const externalHmr = await viteHmrUrl(external.origin, externalCookie);
    await expectHmrRejection(externalHmr, "https://hostile.example.invalid", { cookie: externalCookie }, 403);
    await expectHmrOpen(externalHmr, external.origin, { cookie: externalCookie });
  }, 30_000);
});
