import { PassThrough, Readable } from "node:stream";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  AuthKernel,
  AuthStore,
  AuthStoreBusyError,
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
import type { HumanAuthMethod } from "../../server/auth/config.js";

const config = {
  origin: "https://public.example",
  rpID: "public.example",
  rpName: "Test",
};

function cborLength(major: number, length: number) {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  const result = Buffer.alloc(3);
  result[0] = (major << 5) | 25;
  result.writeUInt16BE(length, 1);
  return result;
}

function cbor(value: string | number | Buffer | Map<string | number, unknown>) {
  if (typeof value === "number")
    return value >= 0
      ? cborLength(0, value)
      : cborLength(1, -1 - value);
  if (typeof value === "string") {
    const bytes = Buffer.from(value);
    return Buffer.concat([cborLength(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value))
    return Buffer.concat([cborLength(2, value.length), value]);
  const entries = [...value.entries()];
  return Buffer.concat([
    cborLength(5, entries.length),
    ...entries.flatMap(([key, item]) => [
      cbor(key),
      cbor(item as Parameters<typeof cbor>[0]),
    ]),
  ]);
}

function credentialKey(publicKey: KeyObject) {
  const jwk = publicKey.export({ format: "jwk" });
  return cbor(
    new Map<number, unknown>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, "base64url")],
      [-3, Buffer.from(jwk.y!, "base64url")],
    ]),
  );
}

function clientData(challenge: string, type: string) {
  return Buffer.from(
    JSON.stringify({ type, challenge, origin: config.origin }),
  );
}

function authenticationResponse(
  challenge: string,
  credentialId: string,
  privateKey: KeyObject,
) {
  const client = clientData(challenge, "webauthn.get");
  const authenticator = Buffer.alloc(37);
  createHash("sha256").update(config.rpID).digest().copy(authenticator);
  authenticator[32] = 0x05;
  authenticator.writeUInt32BE(1, 33);
  const signature = sign(
    "sha256",
    Buffer.concat([
      authenticator,
      createHash("sha256").update(client).digest(),
    ]),
    privateKey,
  );
  return {
    id: credentialId,
    rawId: credentialId,
    type: "public-key" as const,
    clientExtensionResults: {},
    response: {
      authenticatorData: authenticator.toString("base64url"),
      clientDataJSON: client.toString("base64url"),
      signature: signature.toString("base64url"),
    },
  };
}

function registrationResponse(
  challenge: string,
  credentialId: Buffer,
  publicKey: KeyObject,
) {
  const client = clientData(challenge, "webauthn.create");
  const fixed = Buffer.alloc(55);
  createHash("sha256").update(config.rpID).digest().copy(fixed);
  fixed[32] = 0x45;
  fixed.writeUInt16BE(credentialId.length, 53);
  const authData = Buffer.concat([
    fixed,
    credentialId,
    credentialKey(publicKey),
  ]);
  const attestation = cbor(
    new Map<string, unknown>([
      ["fmt", "none"],
      ["attStmt", new Map()],
      ["authData", authData],
    ]),
  );
  const id = credentialId.toString("base64url");
  return {
    id,
    rawId: id,
    type: "public-key" as const,
    clientExtensionResults: {},
    response: {
      attestationObject: attestation.toString("base64url"),
      clientDataJSON: client.toString("base64url"),
      transports: ["internal" as const],
    },
  };
}

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
  methods: readonly HumanAuthMethod[] = ["password", "passkey"],
) {
  const store = new AuthStore(
    join(await mkdtemp(join(tmpdir(), "pi-stepup-")), "auth.json"),
  );
  const kernel = new AuthKernel(
    "passkey",
    store,
    false,
    "",
    "authenticated",
    [...methods],
  );
  return { store, kernel };
}

async function recentSession(kernel: AuthKernel) {
  const res = response();
  await kernel.establishSession(res, { id: "owner" }, "password");
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
    const { store, kernel } = await fixture(["password"]);
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
    req.end(JSON.stringify({ methods: ["password"] }));
    await expect(route).rejects.toThrow("Recent sign-in required");
    expect((await store.read()).config?.methods).not.toEqual(["password"]);
    vi.restoreAllMocks();
  });

  it("does not let a stalled login body occupy credential admission", async () => {
    const { store, kernel } = await fixture(["password"]);
    const passwordHash = await hashPassword("correct test password");
    await store.update((state) => {
      state.password = {
        hash: passwordHash,
        changedAt: Date.now(),
      };
    });
    const stalled = pendingRequest({}, "POST", "192.0.2.20");
    const stalledRes = response();
    const blocked = handlePasswordLogin(
      stalled as any,
      stalledRes,
      new URL("/api/auth/password/login", config.origin),
      kernel,
      store,
      config.origin,
    );
    await new Promise((resolve) => setImmediate(resolve));
    const valid = response();
    await handlePasswordLogin(
      request(
        { password: "correct test password" },
        {},
        "POST",
        "192.0.2.20",
      ),
      valid,
      new URL("/api/auth/password/login", config.origin),
      kernel,
      store,
      config.origin,
    );
    expect(valid.status).toBe(200);
    stalled.destroy(new Error("test complete"));
    await blocked;
    expect(stalledRes.status).toBe(400);
  });

  it("allows one in-flight password attempt per peer without blocking another peer", async () => {
    const { store, kernel } = await fixture(["password"]);
    const passwordHash = await hashPassword("correct test password");
    await store.update((state) => {
      state.password = {
        hash: passwordHash,
        changedAt: Date.now(),
      };
    });
    const url = new URL("/api/auth/password/login", config.origin);
    const first = response();
    const firstAttempt = handlePasswordLogin(
      request({ password: "wrong password" }, {}, "POST", "192.0.2.60"),
      first,
      url,
      kernel,
      store,
      config.origin,
    );
    await new Promise((resolve) => setImmediate(resolve));

    const samePeer = response();
    const distinctPeer = response();
    await Promise.all([
      handlePasswordLogin(
        request({ password: "another wrong password" }, {}, "POST", "192.0.2.60"),
        samePeer,
        url,
        kernel,
        store,
        config.origin,
      ),
      handlePasswordLogin(
        request({ password: "wrong password" }, {}, "POST", "192.0.2.61"),
        distinctPeer,
        url,
        kernel,
        store,
        config.origin,
      ),
      firstAttempt,
    ]);
    expect(first.status).toBe(401);
    expect(samePeer.status).toBe(429);
    expect(samePeer.headers["retry-after"]).toBe("2");
    expect(distinctPeer.status).toBe(401);
  });

  it("maps store overload to retryable failure without consuming password cooldown", async () => {
    const { store, kernel } = await fixture(["password"]);
    const passwordHash = await hashPassword("correct test password");
    await store.update((state) => {
      state.password = {
        hash: passwordHash,
        changedAt: Date.now(),
      };
    });
    const establish = vi
      .spyOn(kernel, "establishSession")
      .mockRejectedValueOnce(new AuthStoreBusyError());
    const url = new URL("/api/auth/password/login", config.origin);
    const busy = response();
    await handlePasswordLogin(
      request({ password: "correct test password" }, {}, "POST", "192.0.2.62"),
      busy,
      url,
      kernel,
      store,
      config.origin,
    );
    expect(busy.status).toBe(503);
    expect(busy.headers["retry-after"]).toBe("2");

    establish.mockRestore();
    const retry = response();
    await handlePasswordLogin(
      request({ password: "correct test password" }, {}, "POST", "192.0.2.62"),
      retry,
      url,
      kernel,
      store,
      config.origin,
    );
    expect(retry.status).toBe(200);
  });

  it("keeps rotation available when the bounded login work queue is full", async () => {
    const { store, kernel } = await fixture(["password"]);
    const encoded = await hashPassword("correct test password");
    await store.update((state) => {
      state.password = { hash: encoded, changedAt: Date.now() };
    });
    const { auth } = await recentSession(kernel);
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

  it("rotates a shared peer's pending ceremonies while preserving the global cap", async () => {
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
    const verify = async (peer: string, challenge: string) => {
      const res = response();
      await handlePasskeyRoute(
        request({
          id: "unknown",
          response: {
            clientDataJSON: Buffer.from(JSON.stringify({ challenge })).toString("base64url"),
          },
        }, {}, "POST", peer),
        res,
        new URL("/api/auth/passkey/verify", config.origin),
        kernel,
        store,
        config,
      );
      return res.status;
    };

    const peer = "192.0.2.40";
    const owner = await options(peer);
    expect(owner.status).toBe(200);
    expect((await options(peer)).status).toBe(429);
    const ownerChallenges = [JSON.parse(owner.text).challenge as string];
    for (let index = 0; index < 4; index++) {
      await new Promise(resolve => setTimeout(resolve, 260));
      const rotated = await options(peer);
      expect(rotated.status).toBe(200);
      ownerChallenges.push(JSON.parse(rotated.text).challenge);
    }
    expect(await verify(peer, ownerChallenges[0])).toBe(400);

    expect((await options("192.0.2.41")).status).toBe(200);
    for (let index = 0; index < 251; index++)
      expect((await options(`198.51.${Math.floor(index / 250)}.${index % 250}`)).status).toBe(200);
    expect((await options("203.0.113.250")).status).toBe(429);
    expect(await verify(peer, ownerChallenges.at(-1)!)).toBe(401);
  });

  it("accepts signed passkey ceremonies after a peer change and keeps them single-use", async () => {
    const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const credentialId = Buffer.from("peer-change-credential");

    const login = await fixture(["passkey"]);
    await login.store.update((state) => {
      state.credentials.push({
        id: credentialId.toString("base64url"),
        publicKey: credentialKey(keys.publicKey).toString("base64url"),
        counter: 0,
        name: "Test passkey",
        createdAt: Date.now(),
      });
    });
    const loginOptions = response();
    await handlePasskeyRoute(
      request({}, {}, "POST", "192.0.2.70"),
      loginOptions,
      new URL("/api/auth/passkey/options", config.origin),
      login.kernel,
      login.store,
      config,
    );
    const assertion = authenticationResponse(
      JSON.parse(loginOptions.text).challenge,
      credentialId.toString("base64url"),
      keys.privateKey,
    );
    const loginVerify = response();
    await handlePasskeyRoute(
      request(assertion, {}, "POST", "198.51.100.70"),
      loginVerify,
      new URL("/api/auth/passkey/verify", config.origin),
      login.kernel,
      login.store,
      config,
    );
    expect(loginVerify.status).toBe(200);
    const loginReplay = response();
    await handlePasskeyRoute(
      request(assertion, {}, "POST", "203.0.113.70"),
      loginReplay,
      new URL("/api/auth/passkey/verify", config.origin),
      login.kernel,
      login.store,
      config,
    );
    expect(loginReplay.status).toBe(400);

    const bootstrap = await fixture(["passkey"]);
    await bootstrap.store.update((state) => {
      state.bootstrap = {
        hash: hashSecret("setup-secret"),
        expiresAt: Date.now() + 60_000,
      };
    });
    const bootstrapOptions = response();
    await handlePasskeyRoute(
      request(
        { token: "setup-secret", name: "Changed peer" },
        {},
        "POST",
        "192.0.2.71",
      ),
      bootstrapOptions,
      new URL("/api/auth/bootstrap/options", config.origin),
      bootstrap.kernel,
      bootstrap.store,
      config,
    );
    const registration = registrationResponse(
      JSON.parse(bootstrapOptions.text).challenge,
      Buffer.from("bootstrap-peer-change"),
      keys.publicKey,
    );
    const bootstrapVerify = response();
    await handlePasskeyRoute(
      request(
        { response: registration, name: "Changed peer" },
        {},
        "POST",
        "198.51.100.71",
      ),
      bootstrapVerify,
      new URL("/api/auth/bootstrap/verify", config.origin),
      bootstrap.kernel,
      bootstrap.store,
      config,
    );
    expect(bootstrapVerify.status).toBe(200);
    const bootstrapReplay = response();
    await handlePasskeyRoute(
      request(
        { response: registration, name: "Changed peer" },
        {},
        "POST",
        "203.0.113.71",
      ),
      bootstrapReplay,
      new URL("/api/auth/bootstrap/verify", config.origin),
      bootstrap.kernel,
      bootstrap.store,
      config,
    );
    expect(bootstrapReplay.status).toBe(400);
  });

  it("skips auth-store rewrites for unauthenticated logout and bounds backlog", async () => {
    const { store, kernel } = await fixture(["password"]);
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
