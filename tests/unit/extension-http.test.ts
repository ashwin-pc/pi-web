import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebUiBridge } from "../../server/extensions/webUi.js";
import type { PiWebUi } from "../../src/extensions.js";
import { AuthKernel, AuthStore } from "../../server/auth/kernel.js";
import { ExtensionHttpRegistry, extensionHttpOrigin, isLoopbackAddress } from "../../server/auth/extensionHttp.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const request = (secret: string, path = "/api/state?sessionId=parent", method = "GET") => ({
  headers: { authorization: secret }, url: path, method, socket: { remoteAddress: "127.0.0.1" },
}) as IncomingMessage;

function harness() {
  let now = 0;
  let active = true;
  let lastAuth = "";
  let lastUrl = "";
  const body = { sessionId: "parent" } as Record<string, unknown>;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    lastUrl = String(url);
    lastAuth = new Headers(init?.headers).get("authorization") || "";
    return new Response("{}");
  });
  const registry = new ExtensionHttpRegistry({ origin: () => "http://127.0.0.1:9999", readBody: async () => body, fetch: fetcher, now: () => now });
  const owner = {};
  const client = registry.createClient(owner, "parent", () => active, { name: "test", scopes: ["sessions.read", "sessions.create", "sessions.write"] });
  return { registry, owner, client, body, fetcher, get auth() { return lastAuth; }, get url() { return lastUrl; }, advance: () => { now += 301_000; }, unload: () => { active = false; } };
}

describe("scoped extension HTTP credentials", () => {
  it("rejects query and header viewer identities with copied credentials", async () => {
    const h = harness();
    await h.client.request("GET", "/api/state");
    for (const route of ["state", "messages", "models"]) {
      for (const query of ["clientId=browser", "unknown=x", "sessionId=parent&sessionId=parent"]) {
        const path = `/api/${route}?${query}`;
        await expect(h.client.request("GET", path)).rejects.toThrow();
        expect((await h.registry.authenticate(request(h.auth, path))).ok).toBe(false);
      }
    }
    const req = request(h.auth);
    req.headers["x-pi-web-client-id"] = "browser";
    expect((await h.registry.authenticate(req)).ok).toBe(false);
    for (const route of ["/api/new-chat", "/api/sessions/new", "/api/prompt"]) {
      await expect(h.client.request("POST", route, { body: { clientId: "browser" } })).rejects.toThrow("viewer identity");
      h.body.clientId = "browser";
      expect((await h.registry.authenticate(request(h.auth, route, "POST"))).ok).toBe(false);
      delete h.body.clientId;
      const headerReq = request(h.auth, route, "POST");
      headerReq.headers["x-pi-web-client-id"] = "browser";
      expect((await h.registry.authenticate(headerReq)).ok).toBe(false);
    }
    await expect(h.client.request("POST", "/api/prompt?unknown=x")).rejects.toThrow();
    expect((await h.registry.authenticate(request(h.auth, "/api/prompt?unknown=x", "POST"))).ok).toBe(false);
  });

  it("checks IPv4, IPv6 and mapped socket peers without trusting forwarding headers", async () => {
    const h = harness();
    await h.client.request("GET", "/api/state");
    for (const address of ["127.0.0.1", "127.2.3.4", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) {
      expect(isLoopbackAddress(address)).toBe(true);
      const req = request(h.auth);
      Object.defineProperty(req.socket, "remoteAddress", { value: address });
      expect((await h.registry.authenticate(req)).ok).toBe(true);
    }
    for (const address of [undefined, "192.168.1.1", "::", "::ffff:192.168.1.1", "::127.0.0.1", "fe80::1%lo0", "garbage"]) {
      const req = request(h.auth);
      Object.defineProperty(req.socket, "remoteAddress", { value: address });
      req.headers["x-forwarded-for"] = "127.0.0.1";
      req.headers.forwarded = "for=127.0.0.1";
      expect((await h.registry.authenticate(req)).ok).toBe(false);
    }
  });

  it("reports target exhaustion without logging secrets or request data", async () => {
    const h = harness();
    await h.client.request("POST", "/api/new-chat");
    const req = request(h.auth, "/api/new-chat", "POST");
    expect((await h.registry.authenticate(req)).ok).toBe(true);
    for (let i = 0; i < 4095; i++) h.registry.recordCreatedSession(req, `child${i}`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await h.registry.authenticate(request(h.auth, "/api/new-chat", "POST"))).toEqual({ ok: false, status: 403 });
      expect(warn).toHaveBeenCalledWith("Extension API creation denied: target limit (4096) reached; dispose and recreate the client to reset its created-target set.");
      expect(JSON.stringify(warn.mock.calls)).not.toContain(h.auth);
      expect((await h.registry.authenticate(request(h.auth))).ok).toBe(true);
    } finally { warn.mockRestore(); }
  });

  it.each(["127.0.0.1", "localhost", "::1", "0.0.0.0", "::"])("derives loopback transport from a real %s listener and its assigned port", async host => {
    const server = createServer(async (req, res) => {
      const result = await registry.authenticate(req);
      res.writeHead(result.ok ? 200 : 403); res.end();
    });
    const registry = new ExtensionHttpRegistry({ origin: () => extensionHttpOrigin(server.address()), readBody: async () => ({}) });
    const client = registry.createClient({}, "parent", () => true, { name: "socket", scopes: ["sessions.read"] });
    await expect(client.request("GET", "/api/state")).rejects.toThrow("listening TCP");
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, host, resolve); });
    cleanups.push(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(err => err ? reject(err) : resolve()); }));
    expect((await client.request("GET", "/api/state")).ok).toBe(true);
    expect(() => extensionHttpOrigin({ address: "192.168.1.1", family: "IPv4", port: 123 })).toThrow("loopback or wildcard");
  });
  it("injects a server-only factory and invalidates clients across runtime reload and session disposal", async () => {
    const h = harness();
    let web!: PiWebUi;
    const session = {
      sessionId: "parent", sessionFile: "/tmp/parent.jsonl", extensionRunner: {},
      bindExtensions: async (options: { uiContext: { web: PiWebUi } }) => { web = options.uiContext.web; },
    };
    const bridge = createWebUiBridge({
      extensionHttp: h.registry, emit: () => {}, clientCount: () => 0,
      withWorkLease: (_session, _label, operation) => operation(), createNewSession: async () => ({}),
      sessionCwd: () => "/tmp", state: () => ({}), settingsStore: {} as never, modelOptions: () => new Set(),
    });
    await bridge.bind(session);
    const first = web.createApiClient!({ name: "first", scopes: ["sessions.read"] });
    await first.request("GET", "/api/state");
    expect(JSON.stringify(bridge.entries(session))).not.toContain("createApiClient");
    const oldAuth = h.auth;
    session.extensionRunner = {}; // SDK reload replaces the runner.
    expect((await h.registry.authenticate(request(oldAuth))).ok).toBe(false);
    await expect(first.request("GET", "/api/state")).rejects.toThrow("disposed");
    const second = web.createApiClient!({ name: "second", scopes: ["sessions.read"] });
    await second.request("GET", "/api/state");
    expect((await h.registry.authenticate(request(h.auth))).ok).toBe(true);
    bridge.releaseSessionSettings(session);
    expect((await h.registry.authenticate(request(h.auth))).ok).toBe(false);
    expect(() => web.createApiClient!({ name: "after", scopes: ["sessions.read"] })).toThrow("no longer active");
  });

  it("uses a separate header, core-supplied target, safe transport options and audit identity", async () => {
    const h = harness();
    await h.client.request("GET", "/api/state");
    expect(h.auth).toMatch(/^PiWebExtension [A-Za-z0-9_-]{43}$/);
    expect(h.url).toBe("http://127.0.0.1:9999/api/state?sessionId=parent");
    const req = request(h.auth);
    expect(await h.registry.authenticate(req)).toMatchObject({ ok: true, via: "extension", identity: { id: "extension:parent:test" } });
    expect(h.registry.caller(req)).toBe("extension:parent:test");
    expect(h.fetcher.mock.calls[0][1]).toMatchObject({ redirect: "error", credentials: "omit" });
    expect(Object.keys(h.client).sort()).toEqual(["dispose", "request"]);
  });

  it("enforces scopes and resource targets at the server even with a stolen scoped credential", async () => {
    const h = harness();
    await h.client.request("GET", "/api/state");
    for (const path of ["/api/auth/tokens", "/api/auth/logout", "/api/ws-ticket", "/api/restart", "/api/settings", "/api/sessions/delete", "/api/mock/reset"]) {
      expect(await h.registry.authenticate(request(h.auth, path, "POST"))).toEqual({ ok: false, status: 403 });
    }
    expect(await h.registry.authenticate(request(h.auth, "/api/state?sessionId=other"))).toEqual({ ok: false, status: 403 });
    h.body.sessionId = "other";
    expect(await h.registry.authenticate(request(h.auth, "/api/prompt", "POST"))).toEqual({ ok: false, status: 403 });
    await expect(h.client.request("POST", "/api/auth/tokens")).rejects.toThrow("scope");
  });

  it("adds created sessions only after server-authorized creation and supports explicit all-session tools", async () => {
    const h = harness();
    await h.client.request("POST", "/api/new-chat");
    const req = request(h.auth, "/api/new-chat", "POST");
    expect((await h.registry.authenticate(req)).ok).toBe(true);
    h.registry.recordCreatedSession(req, "child");
    expect((await h.registry.authenticate(request(h.auth, "/api/state?sessionId=child"))).ok).toBe(true);
    h.registry.recordCreatedSession(request(h.auth), "forged");
    expect((await h.registry.authenticate(request(h.auth, "/api/state?sessionId=forged"))).ok).toBe(false);
    const all = h.registry.createClient({}, "parent", () => true, { name: "all", scopes: ["sessions.read"], sessionIds: "all" });
    await all.request("GET", "/api/state?sessionId=other");
    expect((await h.registry.authenticate(request(h.auth, "/api/state?sessionId=other"))).ok).toBe(true);
    expect((await h.registry.authenticate(request(h.auth, "/api/prompt", "POST"))).ok).toBe(false);
  });

  it("rejects ambiguous session aliases, duplicate targets, forged lineage and URL escapes", async () => {
    const h = harness();
    await h.client.request("GET", "/api/state");
    for (const path of ["https://evil.example/api/state", "//evil.example/api/state", "/api/../api/state", "/api/%73tate", "/api/state#fragment", "/api/\\evil", "/api/state?sessionId=parent&sessionId=other"]) {
      await expect(h.client.request("GET", path)).rejects.toThrow();
      expect((await h.registry.authenticate(request(h.auth, path))).ok).toBe(false);
    }
    h.body.origin = { sessionId: "forged" };
    expect((await h.registry.authenticate(request(h.auth, "/api/new-chat", "POST"))).ok).toBe(false);
  });

  it("expires credentials, renews without user secrets, and rejects them on another process", async () => {
    const h = harness();
    await h.client.request("GET", "/api/state");
    const oldAuth = h.auth;
    h.advance();
    expect(await h.registry.authenticate(request(oldAuth))).toEqual({ ok: false });
    await h.client.request("GET", "/api/state");
    expect(h.auth).not.toBe(oldAuth);
    expect((await h.registry.authenticate(request(h.auth))).ok).toBe(true);
    expect((await harness().registry.authenticate(request(h.auth))).ok).toBe(false);
  });

  it.each(["client", "owner", "runtime"])("revokes on %s disposal and cannot renew afterward", async (kind) => {
    const h = harness();
    await h.client.request("GET", "/api/state");
    if (kind === "client") h.client.dispose();
    else if (kind === "owner") h.registry.revokeOwner(h.owner);
    else h.unload();
    expect(await h.registry.authenticate(request(h.auth))).toEqual({ ok: false });
    await expect(h.client.request("GET", "/api/state")).rejects.toThrow("disposed");
  });

  it("fails closed in the shared gate even with open policy or browser credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "extension-auth-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const store = new AuthStore(join(dir, "auth.json"));
    const h = harness();
    const kernel = new AuthKernel("none", store, "", false, "", "open", [], r => h.registry.authenticate(r));
    expect(await kernel.gate(request("PiWebExtension invalid"))).toEqual({ ok: false });
    const unsupported = new AuthKernel("none", store);
    await h.client.request("GET", "/api/state");
    expect(await unsupported.gate(request(h.auth))).toEqual({ ok: false });
    const req = request(h.auth);
    req.headers.cookie = "pi_web_session=stale-browser";
    expect((await kernel.gate(req)).ok).toBe(true);
    const throwing = new AuthKernel("none", store, "", false, "", "open", [], async () => { throw new Error("boom"); });
    expect(await throwing.gate(req)).toEqual({ ok: false });
  });

  it("rechecks runtime lifetime after asynchronous body parsing", async () => {
    let resolve!: (body: unknown) => void;
    let auth = "";
    const registry = new ExtensionHttpRegistry({ origin: () => "http://127.0.0.1:9999", readBody: () => new Promise(r => { resolve = r; }), fetch: async (_url, options) => { auth = new Headers(options?.headers).get("authorization")!; return new Response("{}"); } });
    const client = registry.createClient({}, "parent", () => true, { name: "race", scopes: ["sessions.write"] });
    await client.request("POST", "/api/prompt", { body: { message: "hi" } });
    const pending = registry.authenticate(request(auth, "/api/prompt", "POST"));
    client.dispose(); resolve({ sessionId: "parent" });
    expect(await pending).toEqual({ ok: false });
  });

  it("bounds runtime client allocation without evicting existing grants", async () => {
    const h = harness();
    for (let i = 1; i < 32; i++) h.registry.createClient(h.owner, "parent", () => true, { name: `c${i}`, scopes: ["sessions.read"] });
    expect(() => h.registry.createClient(h.owner, "parent", () => true, { name: "excess", scopes: ["sessions.read"] })).toThrow("limit");
    await h.client.request("GET", "/api/state");
    expect((await h.registry.authenticate(request(h.auth))).ok).toBe(true);
  });

  it.each(["passkey", "password"] as const)("works over real HTTP with %s-only auth and no browser token", async mode => {
    const dir = await mkdtemp(join(tmpdir(), "extension-http-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    let origin = "";
    const bodies = new WeakMap<IncomingMessage, Promise<unknown>>();
    const readBody = (req: IncomingMessage) => {
      if (!bodies.has(req)) bodies.set(req, (async () => { let text = ""; for await (const chunk of req) text += chunk; return text ? JSON.parse(text) : {}; })());
      return bodies.get(req)!;
    };
    const registry = new ExtensionHttpRegistry({ origin: () => origin, readBody });
    const store = new AuthStore(join(dir, "auth.json"));
    const kernel = new AuthKernel("passkey", store, "", false, "", "authenticated", [mode], req => registry.authenticate(req));
    let authHeader = "";
    const server = createServer(async (req, res) => {
      const auth = await kernel.gate(req);
      if (!auth.ok) { res.writeHead(auth.status || 401); res.end(); return; }
      authHeader = req.headers.authorization || "";
      if (req.method === "POST") expect(await readBody(req)).toMatchObject({ sessionId: "parent" });
      if (req.url === "/api/new-chat") registry.recordCreatedSession(req, "child");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, via: auth.via, sessionId: "child" }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    cleanups.push(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(err => err ? reject(err) : resolve()); }));
    expect((await fetch(origin + "/api/state")).status).toBe(401);
    const client = registry.createClient({}, "parent", () => true, { name: "orchestrator", scopes: ["sessions.create", "sessions.read", "sessions.write"] });
    expect(await (await client.request("POST", "/api/new-chat")).json()).toMatchObject({ via: "extension", sessionId: "child" });
    expect((await client.request("GET", "/api/state?sessionId=child")).ok).toBe(true);
    expect((await fetch(origin + "/api/auth/tokens", { method: "POST", headers: { Authorization: authHeader } })).status).toBe(403);
    expect((await store.read()).sessions).toHaveLength(0);
    client.dispose();
    expect((await fetch(origin + "/api/state?sessionId=parent", { headers: { Authorization: authHeader } })).status).toBe(401);
  });
});
