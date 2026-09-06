import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  AuthKernel,
  AuthStore,
  hashPassword,
  verifyPassword,
} from "../../server/auth/kernel.js";
import { resolveAuthConfig } from "../../server/auth/config.js";
import { initializeAuth } from "../../server/auth/bootstrap.js";
import { handlePasswordLogin } from "../../server/auth/password.js";
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
