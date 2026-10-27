import { PassThrough, Readable } from "node:stream";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AuthKernel,
  AuthStore,
  hashPassword,
  hashSecret,
  verifyPassword,
} from "../../server/auth/kernel.js";
import { handlePasskeyRoute } from "../../server/auth/passkey.js";
import {
  changePassword,
  handlePasswordLogin,
} from "../../server/auth/password.js";
import {
  handlePublicDeviceGrant,
  handleSecurityRoute,
} from "../../server/auth/security.js";

const config = {
  origin: "https://public.example",
  rpID: "public.example",
  rpName: "Test",
};

function request(
  body: unknown = {},
  headers: Record<string, string> = {},
  method = "POST",
  peer = "192.0.2.10",
) {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    headers,
    method,
    socket: { remoteAddress: peer },
    url: "/",
  }) as any;
}

function pendingRequest(
  headers: Record<string, string>,
  method: string,
  peer = "192.0.2.10",
) {
  return Object.assign(new PassThrough(), {
    headers,
    method,
    socket: { remoteAddress: peer },
    url: "/",
  }) as PassThrough & {
    headers: Record<string, string>;
    method: string;
    socket: { remoteAddress: string };
    url: string;
  };
}

function response() {
  return {
    status: 0,
    statusCode: 0,
    text: "",
    headers: {} as Record<string, string>,
    setHeader(key: string, value: string) {
      this.headers[key.toLowerCase()] = value;
    },
    writeHead(status: number, headers: Record<string, string> = {}) {
      this.status = status;
      this.statusCode = status;
      for (const [key, value] of Object.entries(headers))
        this.headers[key.toLowerCase()] = value;
    },
    end(text = "") {
      this.text = text;
    },
  } as any;
}

async function fixture(
  methods = ["legacy", "password", "passkey"] as const,
) {
  const store = new AuthStore(
    join(await mkdtemp(join(tmpdir(), "pi-stepup-")), "auth.json"),
  );
  const kernel = new AuthKernel(
    "legacy",
    store,
    "legacy-secret",
    false,
    "",
    "authenticated",
    [...methods],
  );
  return { store, kernel };
}

async function recentSession(kernel: AuthKernel) {
  const res = response();
  await kernel.establishSession(res, { id: "owner" }, "legacy");
  const cookie = res.headers["set-cookie"].split(";")[0];
  const auth = await kernel.gate(request({}, { cookie }));
  if (!auth.ok || !auth.sessionHash) throw new Error("Session missing");
  return { cookie, auth };
}

function waitForRouteRead(store: AuthStore) {
  const original = store.read.bind(store);
  let release!: () => void;
  const observed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  vi.spyOn(store, "read").mockImplementation(async () => {
    const state = await original();
    calls++;
    if (calls === 1) release();
    return state;
  });
  return observed;
}

describe("step-up and auth workload hardening", () => {
  it("requires recent credential authentication for API-token revocation", async () => {
    for (const stale of [true, false]) {
      const { store, kernel } = await fixture();
      const { cookie, auth } = await recentSession(kernel);
      await store.update((state) => {
        state.apiTokens.push({
          id: "machine",
          name: "Machine",
          hash: hashSecret("piw_machine"),
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        });
        if (stale)
          state.sessions.find(
            (session) => session.hash === auth.sessionHash,
          )!.authenticatedAt = Date.now() - 600_000;
      });
      const res = response();
      await handleSecurityRoute(
        request({}, { cookie }, "DELETE"),
        res,
        new URL("/api/auth/tokens/machine", config.origin),
        auth,
        kernel,
        store,
        config,
      );
      expect(res.status).toBe(stale ? 403 : 200);
      expect(!!(await store.read()).apiTokens[0].revokedAt).toBe(!stale);
    }
  });

  it("preserves public-origin device handoff links across peers", async () => {
    const { store, kernel } = await fixture();
    const { cookie, auth } = await recentSession(kernel);
    const minted = response();
    await handleSecurityRoute(
      request({}, { cookie }, "POST", "192.0.2.50"),
      minted,
      new URL("/api/auth/device-grants", config.origin),
      auth,
      kernel,
      store,
      config,
    );
    expect(minted.status).toBe(201);
    const handoff = JSON.parse(minted.text) as {
      secret: string;
      url: string;
    };
    expect(handoff.url).toBe(
      `${config.origin}/api/auth/device?grant=${encodeURIComponent(handoff.secret)}`,
    );

    const redeemed = response();
    await handlePublicDeviceGrant(
      request(
        { grant: handoff.secret },
        {},
        "POST",
        "198.51.100.60",
      ),
      redeemed,
      new URL("/api/auth/device/redeem", config.origin),
      kernel,
      store,
      config,
    );
    expect(redeemed.status).toBe(200);
    expect(redeemed.headers["set-cookie"]).toContain("pi_web_session=");
    expect((await store.read()).sessions.at(-1)).toMatchObject({
      identity: { id: "owner" },
      method: "grant",
    });
  });

  it("checks method readiness and replacement verification against locked live state", async () => {
    const { store, kernel } = await fixture();
    const { cookie, auth } = await recentSession(kernel);
    for (const invalidate of ["credential", "verification"] as const) {
      await store.update((state) => {
        state.password = { hash: "enrolled", changedAt: Date.now() };
        state.verifiedMethods = ["password"];
      });
      const req = pendingRequest({ cookie }, "PUT");
      const observed = waitForRouteRead(store);
      const res = response();
      const route = handleSecurityRoute(
        req as any,
        res,
        new URL("/api/auth/methods", config.origin),
        auth,
        kernel,
        store,
        config,
      );
      await observed;
      await store.update((state) => {
        if (invalidate === "credential") delete state.password;
        else state.verifiedMethods = [];
      });
      req.end(JSON.stringify({ methods: ["password"] }));
      await route;
      expect(res.status).toBe(409);
      expect((await store.read()).config?.methods).not.toEqual(["password"]);
      vi.restoreAllMocks();
    }

    await store.update((state) => {
      state.password = { hash: "enrolled", changedAt: Date.now() };
      state.verifiedMethods = ["password"];
    });
    const allowed = response();
    await handleSecurityRoute(
      request({ methods: ["password"] }, { cookie }, "PUT"),
      allowed,
      new URL("/api/auth/methods", config.origin),
      auth,
      kernel,
      store,
      config,
    );
    expect(allowed.status).toBe(200);
    expect((await store.read()).config?.methods).toEqual(["password"]);
  });

  it("rechecks recent authentication inside the locked method transaction", async () => {
    const { store, kernel } = await fixture(["legacy"]);
    const { cookie, auth } = await recentSession(kernel);
    const req = pendingRequest({ cookie }, "PUT");
    const observed = waitForRouteRead(store);
    const res = response();
    const route = handleSecurityRoute(
      req as any,
      res,
      new URL("/api/auth/methods", config.origin),
      auth,
      kernel,
      store,
      config,
    );
    await observed;
    await store.update((state) => {
      state.sessions.find(
        (session) => session.hash === auth.sessionHash,
      )!.authenticatedAt = Date.now() - 600_000;
    });
    req.end(JSON.stringify({ methods: ["legacy"] }));
    await expect(route).rejects.toThrow("Recent sign-in required");
    expect((await store.read()).config?.methods).not.toEqual(["legacy"]);
    vi.restoreAllMocks();
  });

  it("does not let a stalled login body occupy credential admission", async () => {
    const { store, kernel } = await fixture(["legacy"]);
    const stalled = pendingRequest({}, "POST", "192.0.2.20");
    const stalledRes = response();
    const blocked = handlePasswordLogin(
      stalled as any,
      stalledRes,
      new URL("/api/auth/legacy/login", config.origin),
      kernel,
      store,
      config.origin,
    );
    await new Promise((resolve) => setImmediate(resolve));
    const valid = response();
    await handlePasswordLogin(
      request(
        { password: "legacy-secret" },
        {},
        "POST",
        "192.0.2.21",
      ),
      valid,
      new URL("/api/auth/legacy/login", config.origin),
      kernel,
      store,
      config.origin,
    );
    expect(valid.status).toBe(200);
    stalled.destroy(new Error("test complete"));
    await blocked;
    expect(stalledRes.status).toBe(400);
  });

  it("keeps rotation available when the bounded login work queue is full", async () => {
    const { store, kernel } = await fixture(["password"]);
    const encoded = await hashPassword("correct test password");
    await store.update((state) => {
      state.password = { hash: encoded, changedAt: Date.now() };
    });
    const { auth } = await recentSession(
      new AuthKernel(
        "legacy",
        store,
        "legacy-secret",
        false,
        "",
        "authenticated",
        ["legacy", "password"],
      ),
    );
    const verificationLoad = Array.from({ length: 5 }, () =>
      verifyPassword("wrong password", encoded),
    );
    const rotation = changePassword(
      store,
      "replacement test password",
      auth.sessionHash!,
    );
    const busy = response();
    await handlePasswordLogin(
      request(
        { password: "correct test password" },
        {},
        "POST",
        "192.0.2.30",
      ),
      busy,
      new URL("/api/auth/password/login", config.origin),
      kernel,
      store,
      config.origin,
    );
    const workResults = await Promise.allSettled([
      ...verificationLoad,
      rotation,
    ]);
    expect(busy.status).toBe(503);
    expect(busy.headers["retry-after"]).toBe("2");
    expect(workResults.at(-1)?.status).toBe("fulfilled");
    expect(
      await verifyPassword(
        "replacement test password",
        (await store.read()).password!.hash,
      ),
    ).toBe(true);

    const retry = response();
    await handlePasswordLogin(
      request(
        { password: "replacement test password" },
        {},
        "POST",
        "192.0.2.30",
      ),
      retry,
      new URL("/api/auth/password/login", config.origin),
      kernel,
      store,
      config.origin,
    );
    expect(retry.status).toBe(200);
  });

  it("keeps passkey ceremonies isolated by peer under global pressure", async () => {
    const { store, kernel } = await fixture(["passkey"]);
    const options = async (peer: string) => {
      const res = response();
      await handlePasskeyRoute(
        request({}, {}, "POST", peer),
        res,
        new URL("/api/auth/passkey/options", config.origin),
        kernel,
        store,
        config,
      );
      return res;
    };
    const owner = await options("192.0.2.40");
    expect(owner.status).toBe(200);
    expect((await options("192.0.2.40")).status).toBe(429);
    expect((await options("192.0.2.41")).status).toBe(200);
    for (let index = 0; index < 254; index++)
      expect((await options(`198.51.${Math.floor(index / 250)}.${index % 250}`)).status).toBe(200);
    const saturated = await options("203.0.113.250");

    const challenge = JSON.parse(owner.text).challenge;
    const verify = response();
    await handlePasskeyRoute(
      request(
        {
          id: "unknown",
          response: {
            clientDataJSON: Buffer.from(
              JSON.stringify({ challenge }),
            ).toString("base64url"),
          },
        },
        {},
        "POST",
        "192.0.2.40",
      ),
      verify,
      new URL("/api/auth/passkey/verify", config.origin),
      kernel,
      store,
      config,
    );
    expect(verify.status).toBe(401);
    expect(saturated.status).toBe(429);
  });

  it("skips auth-store rewrites for unauthenticated logout and bounds backlog", async () => {
    const { store, kernel } = await fixture(["legacy"]);
    const { cookie } = await recentSession(kernel);
    const before = await readFile(store.path, "utf8");
    const listener = vi.fn();
    store.listeners.add(listener);
    expect(
      await kernel.revokeSession(
        request({}, { cookie: "pi_web_session=not-a-session" }),
      ),
    ).toBe(false);
    expect(await readFile(store.path, "utf8")).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    expect(await kernel.revokeSession(request({}, { cookie }))).toBe(true);
    expect(listener).toHaveBeenCalledOnce();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const active = store.update(async () => {
      await gate;
      return false;
    });
    const queued = Array.from({ length: 63 }, () =>
      store.update(() => false),
    );
    await expect(store.update(() => false)).rejects.toThrow("Auth store busy");
    release();
    await Promise.all([active, ...queued]);
  });
});
