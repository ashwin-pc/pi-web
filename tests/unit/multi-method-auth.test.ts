import { mkdtemp, readFile, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isolatedAuthEnv } from "../auth-isolation.js";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  AuthKernel,
  AuthStore,
  hashPassword,
  hashSecret,
  verifyPassword,
} from "../../server/auth/kernel.js";
import { resolveAuthConfig } from "../../server/auth/config.js";
import { initializeAuth } from "../../server/auth/bootstrap.js";
import { trustedOrigin } from "../../server/auth/origin.js";
import {
  changePassword,
  handlePasswordLogin,
  loginPeer,
  passwordLoginPage,
} from "../../server/auth/password.js";
import { handleSecurityRoute } from "../../server/auth/security.js";

async function fixture() {
  const store = new AuthStore(
    join(await mkdtemp(join(tmpdir(), "pi-multi-auth-")), "auth.json"),
  );
  const kernel = new AuthKernel(
    "legacy",
    store,
    "legacy-secret",
    false,
    "x-user",
    "authenticated",
    ["legacy", "password", "passkey", "external"],
  );
  return { store, kernel };
}
function req(
  body: unknown = {},
  headers: Record<string, string> = {},
  method = "POST",
) {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    headers,
    method,
    socket: { remoteAddress: "127.0.0.1" },
    url: "/",
  }) as any;
}
function response() {
  return {
    status: 0,
    text: "",
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
    writeHead(status: number, headers: Record<string, string>) {
      this.status = status;
      this.statusCode = status;
      Object.assign(this.headers, headers);
    },
    end(text: string) {
      this.text = text;
    },
  } as any;
}
const config = {
  origin: "http://localhost",
  rpID: "localhost",
  rpName: "Test",
};

describe("multi-method human authentication", () => {
  it("accepts the actual authority and configured origin but never forged forwarding headers", () => {
    for (const host of [
      "127.0.0.1:9300",
      "192.168.1.5:9300",
      "machine.tailnet:9300",
    ])
      expect(
        trustedOrigin(
          req({}, { host, origin: `http://${host}` }),
          "http://localhost:9300",
        ),
      ).toBe(true);
    expect(
      trustedOrigin(
        req({}, { host: "internal", origin: "https://public.example" }),
        "https://public.example",
      ),
    ).toBe(true);
    for (const origin of [
      "null",
      "garbage",
      "https://evil.example",
      "https://public.example/path",
    ])
      expect(
        trustedOrigin(
          req(
            {},
            { host: "internal", origin, "x-forwarded-host": "evil.example" },
          ),
          "https://public.example",
        ),
      ).toBe(false);
  });
  it("trusts only exact canonical proxy peers and a single strict forwarded authority", () => {
    const old = process.env.PI_WEB_AUTH_PROXY_PEERS;
    try {
      process.env.PI_WEB_AUTH_PROXY_PEERS = "::ffff:127.0.0.1";
      const headers = { host: "internal:9300", origin: "https://public.example", "x-forwarded-host": "public.example" };
      expect(trustedOrigin(req({}, headers), config.origin)).toBe(true);
      const untrusted = req({}, headers); untrusted.socket.remoteAddress = "192.0.2.1";
      expect(trustedOrigin(untrusted, config.origin)).toBe(false);
      for (const host of ["public.example,evil.example", "public.example/path", "public.example@evil.example", " public.example", "public.example:"])
        expect(trustedOrigin(req({}, { ...headers, "x-forwarded-host": host }), config.origin)).toBe(false);
    } finally {
      if (old === undefined) delete process.env.PI_WEB_AUTH_PROXY_PEERS;
      else process.env.PI_WEB_AUTH_PROXY_PEERS = old;
    }
  });
  it("denies stale-cookie and grant persistence and other-device lockout", async () => {
    for (const grant of [false, true]) {
      const { kernel, store } = await fixture(); const res = response();
      await kernel.establishSession(res, { id: "owner" }, grant ? "grant" : "legacy", undefined, !grant);
      const auth = await kernel.gate(req({}, { cookie: res.headers["set-cookie"].split(";")[0] }));
      if (!auth.ok) throw Error("missing session");
      if (!grant) await store.update(s => { s.sessions[0].authenticatedAt = Date.now() - 600000; });
      for (const [path, method] of [["tokens", "POST"], ["device-grants", "POST"], ["sessions/other", "DELETE"]]) {
        const result = response();
        await handleSecurityRoute(req({}, {}, method), result, new URL(`/api/auth/${path}`, config.origin), auth, kernel, store, config);
        expect(result.status).toBe(403);
        expect(JSON.parse(result.text).code).toBe("reauth_required");
      }
      expect((await store.read()).apiTokens).toHaveLength(0);
      expect((await store.read()).deviceGrants || []).toHaveLength(0);
    }
  });
  it("atomically revokes API tokens by default with an explicit retention option", async () => {
    for (const revokeApiTokens of [undefined, true, false]) for (const password of [true, false]) {
      const { kernel, store } = await fixture(); const res = response();
      await kernel.establishSession(res, { id: "owner" }, "legacy");
      const auth = await kernel.gate(req({}, { cookie: res.headers["set-cookie"].split(";")[0] }));
      if (!auth.ok || !auth.sessionHash) throw Error("missing session");
      await store.update(s => { s.apiTokens.push({ id: "test", hash: "hash", name: "test", createdAt: Date.now(), expiresAt: Date.now() + 60000 }); });
      const snapshots: boolean[] = [];
      store.listeners.add(s => { snapshots.push(!!s.apiTokens[0].revokedAt); });
      if (password) await changePassword(store, "a long replacement password", auth.sessionHash, revokeApiTokens);
      else {
        const result = response();
        await handleSecurityRoute(req({ revokeApiTokens }, {}, "DELETE"), result, new URL("/api/auth/sessions", config.origin), auth, kernel, store, config);
        expect(result.status).toBe(200);
      }
      expect(snapshots).toEqual([revokeApiTokens !== false]);
    }
  });
  it("setup validation does not consume credential failure cooldown", async () => {
    const { kernel, store } = await fixture();
    await store.update(s => { s.bootstrap = { hash: hashSecret("setup-secret"), expiresAt: Date.now() + 60000 }; });
    const url = new URL("/api/auth/password/bootstrap", config.origin);
    const invalid = response();
    await handlePasswordLogin(req({ token: "setup-secret", password: "short" }), invalid, url, kernel, store);
    expect(invalid.status).toBe(400);
    const valid = response();
    await handlePasswordLogin(req({ token: "setup-secret", password: "a long setup password" }), valid, url, kernel, store);
    expect(valid.status).toBe(200);
  });
  it("reports environment-only and store-only method deltas", async () => {
    const { kernel, store } = await fixture();
    await store.update(s => { s.config = { policy: "authenticated", methods: ["legacy"] }; });
    const warn = vi.fn(); await kernel.startupDiagnostics(warn);
    expect(warn.mock.calls[0][0]).toContain("environment-only methods=[password, passkey, external]");
    kernel.methods = new Set(["password"]);
    warn.mockClear(); await kernel.startupDiagnostics(warn);
    expect(warn.mock.calls[0][0]).toContain("store-only methods=[legacy]");
  });
  it("recovers dead PID locks but never steals a live lock by age", async () => {
    const { store } = await fixture();
    await writeFile(`${store.path}.lock`, JSON.stringify({ pid: 2147483647 }));
    await store.update((s) => {
      s.verifiedMethods = ["legacy"];
    });
    await writeFile(`${store.path}.lock`, JSON.stringify({ pid: process.pid }));
    await utimes(`${store.path}.lock`, new Date(0), new Date(0));
    await expect(store.update(() => {})).rejects.toThrow(
      "Auth store is locked",
    );
  }, 10_000);
  it("isolates listener failures from committed writes and other listeners", async () => {
    const { store } = await fixture();
    const seen = vi.fn();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      store.listeners.add(() => {
        throw Error("listener fault");
      });
      store.listeners.add(seen);
      await store.update((s) => {
        s.verifiedMethods = ["legacy"];
      });
      expect(seen).toHaveBeenCalledOnce();
      expect((await store.read()).verifiedMethods).toEqual(["legacy"]);
    } finally {
      log.mockRestore();
    }
  });
  it("the gate observes retirement without relying on a prior config refresh", async () => {
    const { store, kernel } = await fixture();
    const request = req({}, { authorization: "Bearer legacy-secret" });
    expect((await kernel.gate(request)).ok).toBe(true);
    await store.update((s) => {
      s.config = { policy: "authenticated", methods: [] };
    });
    expect((await kernel.gate(request)).ok).toBe(false);
  });
  it("warns about saved configuration precedence and no usable methods", async () => {
    const { store, kernel } = await fixture();
    await store.update((s) => {
      s.config = { policy: "authenticated", methods: ["password"] };
    });
    const warn = vi.fn();
    await kernel.startupDiagnostics(warn);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(kernel.methods.has("legacy")).toBe(false);
  });
  it("requires explicit sanitized proxy trust for throttle identities", () => {
    const old = process.env.PI_WEB_AUTH_PROXY_PEERS;
    try {
      delete process.env.PI_WEB_AUTH_PROXY_PEERS;
      const request = req({}, { "x-forwarded-for": "192.0.2.1" });
      expect(loginPeer(request)).toBe("127.0.0.1");
      process.env.PI_WEB_AUTH_PROXY_PEERS = "127.0.0.1";
      expect(loginPeer(request)).toBe("192.0.2.1");
      request.headers["x-forwarded-for"] = "192.0.2.1, 192.0.2.2";
      expect(loginPeer(request)).toBe("127.0.0.1");
    } finally {
      if (old === undefined) delete process.env.PI_WEB_AUTH_PROXY_PEERS;
      else process.env.PI_WEB_AUTH_PROXY_PEERS = old;
    }
  });
  it("denies destructive changes for old and grant sessions and rejects unenrolled methods", async () => {
    const { store, kernel } = await fixture();
    const res = response();
    await kernel.establishSession(
      res,
      { id: "owner" },
      "grant",
      undefined,
      false,
    );
    const request = req(
      {},
      { cookie: res.headers["set-cookie"].split(";")[0] },
      "DELETE",
    );
    const auth = await kernel.gate(request);
    if (!auth.ok) throw Error("session missing");
    const denied = response();
    await handleSecurityRoute(
      request,
      denied,
      new URL("/api/auth/sessions", config.origin),
      auth,
      kernel,
      store,
      config,
    );
    expect(denied.status).toBe(403);
    const enrollment = response();
    await handleSecurityRoute(
      req({}, {}, "POST"),
      enrollment,
      new URL("/api/auth/passkeys/options", config.origin),
      auth,
      kernel,
      store,
      config,
    );
    expect(enrollment.status).toBe(403);
    const recent = response();
    await kernel.establishSession(recent, { id: "legacy:token" }, "legacy");
    const r = req(
      { methods: ["legacy", "password"] },
      { cookie: recent.headers["set-cookie"].split(";")[0] },
      "PUT",
    );
    const a = await kernel.gate(r);
    if (!a.ok) throw Error("session missing");
    const result = response();
    await handleSecurityRoute(
      r,
      result,
      new URL("/api/auth/methods", config.origin),
      a,
      kernel,
      store,
      config,
    );
    expect(result.status).toBe(409);
    await store.update((s) => {
      s.sessions.find((s) => s.hash === a.sessionHash)!.authenticatedAt =
        Date.now() - 300001;
    });
    const expired = response();
    await handleSecurityRoute(
      req({}, {}, "DELETE"),
      expired,
      new URL("/api/auth/sessions", config.origin),
      a,
      kernel,
      store,
      config,
    );
    expect(expired.status).toBe(403);
  });
  it("renders password confirmation only for setup and exposes only ready login methods", async () => {
    const res = response();
    passwordLoginPage(res, ["password"], "setup-token");
    expect(res.text).toContain("name=confirm");
    expect(res.text).toContain("Passwords do not match");
    const { kernel } = await fixture();
    expect(await kernel.readyMethods()).toEqual(["legacy", "external"]);
  });
  it("clears the current cookie when self-revoking and records grant attribution honestly", async () => {
    const { kernel, store } = await fixture();
    const res = response();
    await kernel.establishSession(
      res,
      { id: "owner" },
      "grant",
      undefined,
      false,
    );
    const request = req(
      {},
      { cookie: res.headers["set-cookie"].split(";")[0] },
      "DELETE",
    );
    const auth = await kernel.gate(request);
    if (!auth.ok) throw Error("session missing");
    expect((await store.read()).sessions[0]).toMatchObject({ method: "grant" });
    expect((await store.read()).sessions[0].authenticatedAt).toBeUndefined();
    const result = response();
    await handleSecurityRoute(
      request,
      result,
      new URL(`/api/auth/sessions/${auth.sessionHash}`, config.origin),
      auth,
      kernel,
      store,
      config,
    );
    expect(result.status).toBe(200);
    expect(result.headers["set-cookie"]).toContain("Max-Age=0");
  });
  it("enforces password bootstrap loopback parity", async () => {
    const { store, kernel } = await fixture();
    const request = req({});
    request.socket.remoteAddress = "192.0.2.1";
    const res = response();
    await handlePasswordLogin(
      request,
      res,
      new URL("/api/auth/password/bootstrap", config.origin),
      kernel,
      store,
    );
    expect(res.status).toBe(403);
  });
  it("translates legacy configuration into independent policy and methods", () => {
    expect(resolveAuthConfig({ PI_WEB_AUTH_MODE: "none" })).toMatchObject({
      policy: "open",
      methods: [],
    });
    expect(
      resolveAuthConfig({
        PI_WEB_AUTH_MODE: "passkey",
        PI_WEB_AUTH_METHODS: "password,passkey,external",
      }),
    ).toMatchObject({
      policy: "authenticated",
      methods: ["password", "passkey", "external"],
    });
    expect(() => resolveAuthConfig({ PI_WEB_AUTH_METHODS: "basic" })).toThrow();
  });
  it("recovery does not re-enable a retired password method", async () => {
    const { store } = await fixture();
    await store.update((s) => {
      s.config = { policy: "authenticated", methods: ["passkey"] };
      s.password = { hash: "retired-password-hash", changedAt: 1 };
    });
    await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "server/auth/cli.ts", "recover"],
      { env: { ...isolatedAuthEnv(), PI_WEB_AUTH_STORE: store.path } },
    );
    const state = await store.read();
    expect(state.config?.methods).toEqual(["passkey"]);
    expect(state.password?.hash).toBe("retired-password-hash");
    expect(state.bootstrap?.usedAt).toBeUndefined();
  });
  it("bounds concurrent password work to one memory allocation", async () => {
    const outcomes = await Promise.allSettled([
      hashPassword("first secure password"),
      hashPassword("second secure password"),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(1);
    const success = outcomes.find(
      (o) => o.status === "fulfilled",
    ) as PromiseFulfilledResult<string>;
    expect(success.value).toMatch(/^scrypt\$32768\$8\$1\$/);
  });
  it("hashes salted passwords with scrypt and rejects incorrect passwords", async () => {
    const a = await hashPassword("a secure test password"),
      b = await hashPassword("a secure test password");
    expect(a).not.toBe(b);
    expect(await verifyPassword("a secure test password", a)).toBe(true);
    expect(await verifyPassword("incorrect", a)).toBe(false);
  });
  it("prints setup only for an unconfigured store and consumes its token once", async () => {
    const { store } = await fixture();
    const kernel = new AuthKernel("legacy", store, "", false);
    const link = await initializeAuth(kernel, config.origin, false);
    expect(link).toBeTruthy();
    const token = new URL(link!).searchParams.get("token");
    expect(await readFile(store.path, "utf8")).not.toContain(token);
    expect(await initializeAuth(kernel, config.origin, false)).toBeUndefined();
    const url = new URL("/api/auth/password/bootstrap", config.origin),
      res = response();
    await handlePasswordLogin(
      req({ token, password: "secure setup password" }),
      res,
      url,
      kernel,
      store,
    );
    expect(res.status).toBe(200);
    expect((await store.read()).config?.methods).toEqual(["password"]);
    const replay = response();
    await handlePasswordLogin(
      req({ token, password: "another password" }),
      replay,
      url,
      kernel,
      store,
    );
    expect(replay.status).toBe(401);
  });
  it("lets an existing legacy session enroll password, requires verified replacement, and revokes sessions", async () => {
    const { store, kernel } = await fixture(),
      original = response();
    await kernel.establishSession(original, { id: "legacy:token" });
    const cookie = original.headers["set-cookie"].split(";")[0];
    const auth = await kernel.gate(req({}, { cookie }));
    if (!auth.ok) throw new Error("No session");
    const manage = async (path: string, body: unknown, method = "PUT") => {
      const res = response();
      await handleSecurityRoute(
        req(body, { cookie }, method),
        res,
        new URL(path, config.origin),
        auth,
        kernel,
        store,
        config,
      );
      return res;
    };
    expect(
      (
        await manage("/api/auth/password", {
          password: "secure replacement password",
        })
      ).status,
    ).toBe(200);
    expect(
      (await manage("/api/auth/methods", { methods: ["password"] })).status,
    ).toBe(409);
    const login = response();
    await handlePasswordLogin(
      req(
        { password: "secure replacement password" },
        { "user-agent": "Test Browser" },
      ),
      login,
      new URL("/api/auth/password/login", config.origin),
      kernel,
      store,
    );
    expect(login.status).toBe(200);
    expect(
      (await manage("/api/auth/methods", { methods: ["password"] })).status,
    ).toBe(200);
    expect(
      (await kernel.gate(req({}, { authorization: "Bearer legacy-secret" })))
        .ok,
    ).toBe(false);
    expect(
      (await store.read()).sessions.some(
        (s) => s.method === "password" && s.device === "Test Browser",
      ),
    ).toBe(true);
    expect((await manage("/api/auth/sessions", {}, "DELETE")).status).toBe(200);
    expect(
      (
        await kernel.gate(
          req({}, { cookie, authorization: "Bearer legacy-secret" }),
        )
      ).ok,
    ).toBe(false);
  });
  it("exchanges trusted external identity for a revocable session without ambient reauthentication", async () => {
    const { store, kernel } = await fixture(),
      res = response();
    await handlePasswordLogin(
      req({}, { "x-user": "owner@example.com", "user-agent": "Proxy browser" }),
      res,
      new URL("/api/auth/external/login", config.origin),
      kernel,
      store,
    );
    expect(res.status).toBe(200);
    const cookie = res.headers["set-cookie"].split(";")[0];
    expect(await kernel.gate(req({}, { cookie }))).toMatchObject({
      ok: true,
      via: "session",
      identity: { id: "external:owner@example.com" },
    });
    await kernel.revokeSession(req({}, { cookie }));
    expect(
      (await kernel.gate(req({}, { cookie, "x-user": "owner@example.com" })))
        .ok,
    ).toBe(false);
  });
  it("rejects session issuance when a credential changes during verification", async () => {
    const { store, kernel } = await fixture();
    await store.update((s) => {
      s.password = { hash: "new-hash", changedAt: Date.now() };
    });
    const res = response();
    await expect(
      kernel.establishSession(res, { id: "owner" }, "password", req(), true, {
        passwordHash: "old-hash",
      }),
    ).rejects.toThrow("Password changed");
    await expect(
      kernel.establishSession(res, { id: "owner" }, "passkey", req(), true, {
        passkeyId: "revoked",
      }),
    ).rejects.toThrow("Passkey revoked");
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect((await store.read()).sessions).toHaveLength(0);
  });
  it("denies every human security mutation to API-token principals", async () => {
    const { store, kernel } = await fixture();
    for (const [path, method] of [
      ["password", "PUT"],
      ["methods", "PUT"],
      ["sessions", "DELETE"],
      ["passkeys/options", "POST"],
      ["passkeys/verify", "POST"],
      ["device-grants", "POST"],
    ]) {
      const res = response();
      await handleSecurityRoute(
        req({}, {}, method),
        res,
        new URL(`/api/auth/${path}`, config.origin),
        { ok: true, via: "token", identity: { id: "token:ci" } },
        kernel,
        store,
        config,
      );
      expect(res.status).toBe(403);
    }
    expect((await store.read()).sessions).toHaveLength(0);
  });
  it("rate limits invalid logins without issuing sessions", async () => {
    const { store, kernel } = await fixture();
    let last = response();
    for (let i = 0; i < 11; i++) {
      last = response();
      await handlePasswordLogin(
        req({ password: "wrong" }),
        last,
        new URL("/api/auth/password/login", config.origin),
        kernel,
        store,
      );
    }
    expect(last.status).toBe(429);
    expect((await store.read()).sessions).toHaveLength(0);
  });
});
