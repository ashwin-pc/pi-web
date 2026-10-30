import { mkdtemp, readFile } from "node:fs/promises";
import { closeSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { isolatedAuthEnv } from "../auth-isolation.js";
import { join } from "node:path";
import { Readable } from "node:stream";
import { forwardedHost } from "../../server/auth/proxy.js";
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
    "passkey",
    store,
    false,
    "x-user",
    "authenticated",
    ["password", "passkey", "external"],
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
      for (const [origin, authority, accepted] of [
        ["https://public.example", "public.example:443", true],
        ["http://public.example", "public.example:80", true],
        ["https://public.example", "public.example:80", false],
        ["http://public.example", "public.example:443", false],
        ["https://public.example:8443", "public.example:8443", true],
        ["https://public.example", "public.example:8443", false],
      ] as const) {
        const request = req({}, { ...headers, origin, "x-forwarded-host": authority });
        expect(trustedOrigin(request, config.origin)).toBe(accepted);
        // The supervisor preserves the explicit authority while stripping XFH;
        // the child's direct Host comparison must have identical semantics.
        expect(forwardedHost(request)).toBe(authority);
        expect(trustedOrigin(req({}, { host: authority, origin }), config.origin)).toBe(accepted);
        request.socket.remoteAddress = "192.0.2.1";
        expect(trustedOrigin(request, config.origin)).toBe(false);
      }
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
      await kernel.establishSession(res, { id: "owner" }, grant ? "grant" : "password", undefined, !grant);
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
      await kernel.establishSession(res, { id: "owner" }, "password");
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
    await store.update(s => { s.config = { policy: "authenticated", methods: ["password"] }; });
    const warn = vi.fn(); await kernel.startupDiagnostics(warn);
    expect(warn.mock.calls[0][0]).toContain("environment-only methods=[passkey, external]");
  });
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
        s.verifiedMethods = ["password"];
      });
      expect(seen).toHaveBeenCalledOnce();
      expect((await store.read()).verifiedMethods).toEqual(["password"]);
    } finally {
      log.mockRestore();
    }
  });
  it("the gate observes API token revocation without relying on a prior config refresh", async () => {
    const { store, kernel } = await fixture();
    await store.update(s => s.apiTokens.push({ id: "test", name: "test", hash: hashSecret("piw_test"), createdAt: Date.now(), expiresAt: Date.now() + 60_000 }));
    const request = req({}, { authorization: "Bearer piw_test" });
    expect((await kernel.gate(request)).ok).toBe(true);
    await store.update((s) => {
      s.apiTokens[0].revokedAt = Date.now();
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
    expect(kernel.methods.has("password")).toBe(true);
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
    await kernel.establishSession(recent, { id: "owner" }, "password");
    const r = req(
      { methods: ["password", "passkey"] },
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
    expect(res.text).toContain('name="confirm"');
    expect(res.text).toContain("Passwords do not match");
    const { kernel } = await fixture();
    expect(await kernel.readyMethods()).toEqual(["external"]);
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
  it("translates supported compatibility configuration into independent policy and methods", () => {
    expect(resolveAuthConfig({ PI_WEB_AUTH_MODE: "none" })).toMatchObject({
      policy: "open",
      explicitOpenPolicy: false,
      methods: [],
    });
    expect(
      resolveAuthConfig({
        PI_WEB_AUTH_MODE: "none",
        PI_WEB_AUTH_POLICY: "open",
      }),
    ).toMatchObject({
      policy: "open",
      explicitOpenPolicy: true,
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
    expect(
      resolveAuthConfig({
        PI_WEB_AUTH_METHODS: "external",
        PI_WEB_AUTH_TRUSTED_HEADER: "x-amzn-tunnel-user",
      }),
    ).toMatchObject({
      policy: "authenticated",
      methods: ["external"],
    });
    expect(() =>
      resolveAuthConfig({
        PI_WEB_AUTH_MODE: "none",
        PI_WEB_AUTH_METHODS: "external",
      }),
    ).toThrow("cannot be combined");
    expect(() => resolveAuthConfig({ PI_WEB_AUTH_METHODS: "basic" })).toThrow();
  });
  it("preserves saved policy during method changes and never lets saved open weaken authenticated environment", async () => {
    const { store } = await fixture();
    await store.update((s) => {
      s.config = { policy: "open", methods: ["password"] };
    });
    const kernel = new AuthKernel(
      "passkey",
      store,
      false,
      "",
      "authenticated",
      ["password"],
    );
    await kernel.refreshConfig();
    expect(kernel.policy).toBe("authenticated");
    await kernel.configure(["password", "external"]);
    expect((await store.read()).config).toEqual({
      policy: "open",
      methods: ["password", "external"],
    });
    expect(kernel.policy).toBe("authenticated");
  });
  it("persists authenticated policy on first enrollment unless policy was explicitly changed", async () => {
    const store = new AuthStore(
      join(await mkdtemp(join(tmpdir(), "pi-first-enrollment-")), "auth.json"),
    );
    const kernel = new AuthKernel("none", store, false);
    expect(kernel.policy).toBe("open");

    await kernel.configure(["password"]);
    expect((await store.read()).config).toEqual({
      policy: "authenticated",
      methods: ["password"],
    });
    expect(kernel.policy).toBe("authenticated");

    const explicitOpenStore = new AuthStore(
      join(await mkdtemp(join(tmpdir(), "pi-explicit-open-")), "auth.json"),
    );
    const explicitOpenConfig = resolveAuthConfig({
      PI_WEB_AUTH_MODE: "none",
      PI_WEB_AUTH_POLICY: "open",
    });
    const explicitOpen = new AuthKernel(
      explicitOpenConfig.mode,
      explicitOpenStore,
      false,
      "",
      explicitOpenConfig.policy,
      explicitOpenConfig.methods,
      undefined,
      explicitOpenConfig.explicitOpenPolicy,
    );
    await explicitOpen.configure(["password"]);
    expect((await explicitOpenStore.read()).config).toEqual({
      policy: "open",
      methods: ["password"],
    });
    expect(explicitOpen.policy).toBe("open");
  });
  it("warns when an explicitly open policy advertises login methods", async () => {
    const store = new AuthStore(
      join(await mkdtemp(join(tmpdir(), "pi-open-methods-")), "auth.json"),
    );
    const kernel = new AuthKernel(
      "none",
      store,
      false,
      "",
      "open",
      ["password"],
    );
    const warn = vi.fn();
    await kernel.startupDiagnostics(warn);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('policy is "open" while login methods are enabled'),
    );
  });
  it("recovery removes saved legacy authority and creates a usable single-use bootstrap", async () => {
    const { store } = await fixture();
    const now = Date.now();
    await store.update((s) => {
      s.config = { policy: "authenticated", methods: ["legacy"] } as never;
      s.verifiedMethods = ["legacy"] as never;
      s.sessions.push(
        {
          hash: hashSecret("legacy-method"),
          identity: { id: "owner" },
          method: "legacy" as never,
          createdAt: now,
          lastSeenAt: now,
          expiresAt: now + 60_000,
        },
        {
          hash: hashSecret("legacy-grant-descendant"),
          identity: { id: "legacy:token" },
          method: "grant",
          createdAt: now,
          lastSeenAt: now,
          expiresAt: now + 60_000,
        },
        ...(["password", "passkey", "external"] as const).map((method) => ({
          hash: hashSecret(`supported-${method}`),
          identity: { id: `${method}:owner` },
          method,
          createdAt: now,
          lastSeenAt: now,
          expiresAt: now + 60_000,
        })),
      );
      s.deviceGrants = [
        {
          id: "legacy-method-grant",
          hash: "legacy-method-grant-hash",
          createdAt: now,
          expiresAt: now + 60_000,
          createdBy: { id: "owner" },
          createdBySessionHash: hashSecret("legacy-method"),
        },
        {
          id: "legacy-identity-grant",
          hash: "legacy-identity-grant-hash",
          createdAt: now,
          expiresAt: now + 60_000,
          createdBy: { id: "legacy:token" },
          createdBySessionHash: hashSecret("legacy-grant-descendant"),
        },
        {
          id: "supported-grant",
          hash: "supported-grant-hash",
          createdAt: now,
          expiresAt: now + 60_000,
          createdBy: { id: "password:owner" },
          createdBySessionHash: hashSecret("supported-password"),
        },
      ];
      s.apiTokens.push({
        id: "automation",
        name: "Automation",
        hash: hashSecret("piw_automation"),
        createdAt: now,
        expiresAt: now + 60_000,
      });
    });
    const outputPath = `${store.path}.recover-output`;
    const output = openSync(outputPath, "w");
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", "server/auth/cli.ts", "recover"],
          {
            env: { ...isolatedAuthEnv(), PI_WEB_AUTH_STORE: store.path },
            stdio: ["ignore", output, output],
          },
        );
        child.once("error", reject);
        child.once("close", code => code === 0 ? resolve() : reject(new Error(`recover exited ${code}`)));
      });
    } finally {
      closeSync(output);
    }
    const stdout = await readFile(outputPath, "utf8");
    const state = await store.read();
    expect(state.config?.methods).toEqual([]);
    expect(state.verifiedMethods).toEqual([]);
    expect(state.bootstrap?.usedAt).toBeUndefined();
    expect(
      state.sessions
        .filter(
          (session) =>
            (session.method as string) === "legacy" ||
            session.identity.id === "legacy:token",
        )
        .every((session) => session.revokedAt),
    ).toBe(true);
    expect(
      state.sessions
        .filter((session) => session.identity.id.endsWith(":owner"))
        .every((session) => !session.revokedAt),
    ).toBe(true);
    expect(
      state.deviceGrants
        ?.filter((grant) => grant.id.startsWith("legacy-"))
        .every((grant) => grant.cancelledAt),
    ).toBe(true);
    expect(
      state.deviceGrants?.find((grant) => grant.id === "supported-grant")
        ?.cancelledAt,
    ).toBeUndefined();
    expect(state.apiTokens[0].revokedAt).toBeUndefined();
    const link = String(stdout).match(/https?:\/\/\S+/)?.[0];
    expect(link).toBeTruthy();
    const kernel = new AuthKernel("passkey", store, false);
    await kernel.refreshConfig();
    for (const method of ["password", "passkey", "external"]) {
      expect(
        (await kernel.gate(
          req({}, { cookie: `pi_web_session=supported-${method}` }),
        )).ok,
      ).toBe(true);
    }
    expect(
      (await kernel.gate(
        req({}, { authorization: "Bearer piw_automation" }),
      )).ok,
    ).toBe(true);
    const setup = response();
    await handlePasswordLogin(
      req({
        token: new URL(link!).searchParams.get("token"),
        password: "recovered secure password",
      }),
      setup,
      new URL("/api/auth/password/bootstrap", config.origin),
      kernel,
      store,
    );
    expect(setup.status).toBe(200);
    expect((await store.read()).config?.methods).toEqual(["password"]);
    const replay = response();
    await handlePasswordLogin(
      req({
        token: new URL(link!).searchParams.get("token"),
        password: "another recovered password",
      }),
      replay,
      new URL("/api/auth/password/bootstrap", config.origin),
      kernel,
      store,
    );
    expect(replay.status).toBe(401);
  });
  it("serializes concurrent password work without rejecting a bounded waiter", async () => {
    const outcomes = await Promise.allSettled([
      hashPassword("first secure password"),
      hashPassword("second secure password"),
    ]);
    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(
      true,
    );
    for (const outcome of outcomes)
      if (outcome.status === "fulfilled")
        expect(outcome.value).toMatch(/^scrypt\$32768\$8\$1\$/);
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
    const kernel = new AuthKernel("passkey", store, false);
    const link = await initializeAuth(kernel, config.origin, false);
    expect(link).toBeTruthy();
    const token = new URL(link!).searchParams.get("token");
    expect(await readFile(store.path, "utf8")).not.toContain(token);
    expect((await kernel.gate(req({}, { authorization: "" }, "GET"))).ok).toBe(false);
    expect((await kernel.gate(req({}, {}, "GET"))).ok).toBe(false);
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
  it("lets an existing authenticated session rotate password and revoke sessions", async () => {
    const { store, kernel } = await fixture(),
      original = response();
    await kernel.establishSession(original, { id: "owner" }, "password");
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
      (await kernel.gate(req({}, { authorization: "Bearer removed-secret" })))
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
          req({}, { cookie, authorization: "Bearer removed-secret" }),
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
