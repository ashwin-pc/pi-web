import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import {
  hashSecret,
  randomSecret,
  type AuthKernel,
  type AuthStore,
  type GateResult,
} from "./kernel.js";
import type { PasskeyConfig } from "./passkey.js";
import type { HumanAuthMethod } from "./config.js";
import { changePassword } from "./password.js";

const DAY = 86_400_000;
const registrations = new Map<
  string,
  { expiresAt: number; name: string; grantHash?: string; sessionHash?: string }
>();
function send(res: ServerResponse, status: number, value: unknown) {
  const text = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(text);
}
async function input(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const chunk of req) {
    n += chunk.length;
    if (n > 1_000_000) throw new Error("Body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}
function challengeOf(response: unknown) {
  try {
    const encoded = (response as any)?.response?.clientDataJSON;
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString());
    return typeof parsed.challenge === "string" ? parsed.challenge : undefined;
  } catch {
    return undefined;
  }
}
function sweep() {
  const now = Date.now();
  for (const [key, value] of registrations)
    if (value.expiresAt <= now) registrations.delete(key);
  while (registrations.size >= 256)
    registrations.delete(registrations.keys().next().value!);
}
const bytes64 = (value: Uint8Array) => Buffer.from(value).toString("base64url");

export async function handlePublicDeviceGrant(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  kernel: AuthKernel,
  store: AuthStore,
  _config: PasskeyConfig,
) {
  if (req.method === "GET" && url.pathname === "/api/auth/device") {
    const grant = JSON.stringify(url.searchParams.get("grant") || "").replace(
      /</g,
      "\\u003c",
    );
    const html = `<!doctype html><meta name=viewport content="width=device-width"><meta name=referrer content=no-referrer><title>Add device</title><h1>Add this device</h1><button id=go>Continue</button><p id=status></p><script>document.getElementById('go').onclick=async()=>{const r=await fetch('/api/auth/device/redeem',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({grant:${grant}})});if(r.ok)location.href='/';else document.getElementById('status').textContent='Invalid or expired grant'}</script>`;
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy":
        "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
    });
    res.end(html);
    return true;
  }
  if (req.method !== "POST" || url.pathname !== "/api/auth/device/redeem")
    return false;
  const body = (await input(req)) as { grant?: string };
  const hash = hashSecret(body.grant || "");
  let identity: import("./kernel.js").Identity | undefined;
  await store.update((state) => {
    const grant = (state.deviceGrants || []).find(
      (g) =>
        g.hash === hash &&
        !g.usedAt &&
        !g.cancelledAt &&
        g.expiresAt > Date.now(),
    );
    const minter =
      grant &&
      state.sessions.find(
        (s) =>
          s.hash === grant.createdBySessionHash &&
          !s.revokedAt &&
          s.expiresAt > Date.now(),
      );
    if (grant && minter) {
      grant.usedAt = Date.now();
      identity = grant.createdBy;
    }
  });
  if (!identity) {
    send(res, 401, { ok: false, error: "Invalid or expired device grant" });
    return true;
  }
  await kernel.establishSession(res, identity, "grant", req, false);
  send(res, 200, { ok: true });
  return true;
}

export async function handleSecurityRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  auth: Extract<GateResult, { ok: true }>,
  kernel: AuthKernel,
  store: AuthStore,
  config: PasskeyConfig,
) {
  if (!url.pathname.startsWith("/api/auth/")) return false;
  const state = await store.read();
  const now = Date.now();
  if (req.method === "GET" && url.pathname === "/api/auth/info") {
    send(res, 200, {
      mode: kernel.mode,
      policy: kernel.policy,
      methods: [...kernel.methods],
      identity: auth.identity,
    });
    return true;
  }
  const destructive =
    (req.method === "PUT" &&
      ["/api/auth/password", "/api/auth/methods"].includes(url.pathname)) ||
    (req.method === "DELETE" &&
      (url.pathname === "/api/auth/sessions" ||
        url.pathname.startsWith("/api/auth/passkeys/"))) ||
    (req.method === "POST" &&
      ["/api/auth/passkeys/options", "/api/auth/passkeys/verify"].includes(
        url.pathname,
      ));
  if (destructive) {
    const session = state.sessions.find(
      (s) => s.hash === auth.sessionHash && !s.revokedAt && s.expiresAt > now,
    );
    if (
      !session?.authenticatedAt ||
      session.authenticatedAt < now - 5 * 60_000
    ) {
      send(res, 403, {
        error:
          "Recent sign-in required. Sign in again using the Security page link, then retry within five minutes.",
        code: "reauth_required",
        url: "/api/auth/login",
      });
      return true;
    }
  }
  const requireSession = () => {
    if (auth.via === "session") return true;
    send(res, 403, { ok: false, error: "A browser session is required" });
    return false;
  };
  if (req.method === "GET" && url.pathname === "/api/auth/security") {
    send(res, 200, {
      mode: kernel.mode,
      policy: kernel.policy,
      methods: [...kernel.methods],
      identity: auth.identity,
      passwordConfigured: !!state.password,
      verifiedMethods: state.verifiedMethods || [],
      externalAvailable: !!kernel.trustedHeader,
      passkeys: state.credentials
        .filter((c) => !c.revokedAt)
        .map(({ publicKey, counter, ...c }) => c),
      sessions: state.sessions
        .filter((s) => !s.revokedAt && s.expiresAt > now)
        .map(({ hash, ...s }) => ({
          ...s,
          id: hashSecret(hash),
          current: hash === auth.sessionHash,
        })),
      apiTokens: state.apiTokens
        .filter((t) => !t.revokedAt)
        .map(({ hash, ...t }) => t),
      deviceGrants: (state.deviceGrants || [])
        .filter((g) => !g.usedAt && !g.cancelledAt && g.expiresAt > now)
        .map(({ hash, createdBySessionHash, ...g }) => g),
    });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/auth/tokens") {
    if (!requireSession()) return true;
    const b = (await input(req)) as { name?: string; days?: number };
    const secret = `piw_${randomSecret()}`,
      id = randomUUID(),
      days = Math.max(1, Math.min(365, Number(b.days) || 30));
    await store.update((s) => {
      s.apiTokens.push({
        id,
        name: b.name?.slice(0, 80) || "API token",
        hash: hashSecret(secret),
        createdAt: now,
        expiresAt: now + days * DAY,
      });
    });
    send(res, 201, { id, secret });
    return true;
  }
  let match = /^\/api\/auth\/tokens\/([^/]+)$/.exec(url.pathname);
  if (req.method === "DELETE" && match) {
    if (!requireSession()) return true;
    let found = false;
    await store.update((s) => {
      const item = s.apiTokens.find((x) => x.id === match![1] && !x.revokedAt);
      if (item) {
        item.revokedAt = now;
        found = true;
      }
    });
    send(
      res,
      found ? 200 : 404,
      found ? { ok: true } : { ok: false, error: "API token not found" },
    );
    return true;
  }
  if (req.method === "DELETE" && url.pathname === "/api/auth/sessions") {
    if (!requireSession()) return true;
    await store.update((s) => {
      for (const item of s.sessions) item.revokedAt = now;
    });
    kernel.clearSession(res);
    send(res, 200, { ok: true });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    if (!requireSession()) return true;
    await kernel.revokeSession(req);
    kernel.clearSession(res);
    send(res, 200, { ok: true });
    return true;
  }
  if (req.method === "PUT" && url.pathname === "/api/auth/methods") {
    if (!requireSession()) return true;
    const body = (await input(req)) as { methods?: HumanAuthMethod[] };
    const methods = body.methods;
    if (
      !Array.isArray(methods) ||
      methods.some(
        (m) => !["passkey", "password", "legacy", "external"].includes(m),
      )
    ) {
      send(res, 400, { error: "Invalid methods" });
      return true;
    }
    if (methods.includes("external") && !kernel.trustedHeader) {
      send(res, 400, {
        error: "Configure a trusted proxy header on the server first",
      });
      return true;
    }
    if (methods.includes("legacy") && !kernel.legacyToken) {
      send(res, 400, { error: "No legacy token configured" });
      return true;
    }
    const retiring = [...kernel.methods].some((m) => !methods.includes(m));
    const usable = methods.filter((m) => kernel.methodReady(m, state));
    if (usable.length !== methods.length) {
      send(res, 409, {
        error: "Enroll credentials before enabling a sign-in method",
      });
      return true;
    }
    if (retiring && !usable.some((m) => state.verifiedMethods?.includes(m))) {
      send(res, 409, {
        error: "Enroll and verify a replacement login before retiring a method",
      });
      return true;
    }
    await kernel.configure([...new Set(methods)]);
    send(res, 200, { ok: true });
    return true;
  }
  if (req.method === "PUT" && url.pathname === "/api/auth/password") {
    if (!requireSession()) return true;
    const b = (await input(req)) as { password?: unknown };
    try {
      await changePassword(store, b.password, auth.sessionHash!);
      await kernel.configure([
        ...new Set([...kernel.methods, "password" as const]),
      ]);
      send(res, 200, { ok: true });
    } catch (error) {
      send(res, 400, {
        ok: false,
        error: error instanceof Error ? error.message : "Invalid password",
      });
    }
    return true;
  }
  match = /^\/api\/auth\/sessions\/([^/]+)$/.exec(url.pathname);
  if (req.method === "DELETE" && match) {
    if (!requireSession()) return true;
    let found = false;
    let current = false;
    await store.update((s) => {
      const item = s.sessions.find(
        (x) => x.hash === match![1] || hashSecret(x.hash) === match![1],
      );
      if (item) {
        item.revokedAt = now;
        found = true;
        current = item.hash === auth.sessionHash;
      }
    });
    if (current) kernel.clearSession(res);
    send(
      res,
      found ? 200 : 404,
      found ? { ok: true } : { ok: false, error: "Session not found" },
    );
    return true;
  }
  match = /^\/api\/auth\/passkeys\/([^/]+)$/.exec(url.pathname);
  if (req.method === "DELETE" && match) {
    if (!requireSession()) return true;
    let found = false;
    await store.update((s) => {
      const item = s.credentials.find(
        (x) => x.id === decodeURIComponent(match![1]) && !x.revokedAt,
      );
      if (item) {
        item.revokedAt = now;
        found = true;
        for (const session of s.sessions) session.revokedAt = now;
      }
    });
    if (found) kernel.clearSession(res);
    send(
      res,
      found ? 200 : 404,
      found ? { ok: true } : { ok: false, error: "Passkey not found" },
    );
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/auth/device-grants") {
    if (auth.via !== "session" || !auth.sessionHash) {
      send(res, 403, { ok: false, error: "A browser session is required" });
      return true;
    }
    const secret = randomSecret(),
      id = randomUUID();
    await store.update((s) => {
      (s.deviceGrants ||= []).push({
        id,
        hash: hashSecret(secret),
        createdAt: now,
        expiresAt: now + 120_000,
        createdBy: auth.identity,
        createdBySessionHash: auth.sessionHash!,
      });
    });
    send(res, 201, {
      id,
      secret,
      expiresAt: now + 120_000,
      url: `${config.origin}/api/auth/device?grant=${encodeURIComponent(secret)}`,
    });
    return true;
  }
  match = /^\/api\/auth\/device-grants\/([^/]+)$/.exec(url.pathname);
  if (req.method === "DELETE" && match) {
    if (!requireSession()) return true;
    let found = false;
    await store.update((s) => {
      const grant = (s.deviceGrants || []).find(
        (g) =>
          g.id === match![1] &&
          g.createdBySessionHash === auth.sessionHash &&
          !g.usedAt &&
          !g.cancelledAt,
      );
      if (grant) {
        grant.cancelledAt = now;
        found = true;
      }
    });
    send(
      res,
      found ? 200 : 404,
      found ? { ok: true } : { ok: false, error: "Device grant not found" },
    );
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/auth/passkeys/options") {
    if (auth.via !== "session") {
      send(res, 403, { ok: false, error: "A passkey session is required" });
      return true;
    }
    const b = (await input(req)) as { name?: string };
    const options = await generateRegistrationOptions({
      rpName: config.rpName,
      rpID: config.rpID,
      userName: "pi-web-owner",
      userDisplayName: "Pi Web Owner",
      attestationType: "none",
      authenticatorSelection: { userVerification: "required" },
      excludeCredentials: state.credentials
        .filter((c) => !c.revokedAt)
        .map((c) => ({ id: c.id })),
    });
    sweep();
    registrations.set(options.challenge, {
      expiresAt: now + 120_000,
      name: b.name?.slice(0, 80) || "Passkey",
      sessionHash: auth.sessionHash,
    });
    send(res, 200, options);
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/auth/passkeys/verify") {
    if (!requireSession()) return true;
    const b = (await input(req)) as { response?: RegistrationResponseJSON };
    const challenge = challengeOf(b.response),
      pending = challenge ? registrations.get(challenge) : undefined;
    if (
      !challenge ||
      !pending ||
      pending.grantHash ||
      pending.sessionHash !== auth.sessionHash ||
      pending.expiresAt <= now ||
      !registrations.delete(challenge)
    ) {
      send(res, 400, { ok: false, error: "Expired challenge" });
      return true;
    }
    const result = await verifyRegistrationResponse({
      response: b.response!,
      expectedChallenge: challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
      requireUserVerification: true,
    });
    if (!result.verified || !result.registrationInfo) {
      send(res, 401, { ok: false });
      return true;
    }
    const c = result.registrationInfo.credential;
    await store.update((s) => {
      s.credentials.push({
        id: c.id,
        publicKey: bytes64(c.publicKey),
        counter: c.counter,
        transports: c.transports,
        name: pending.name,
        createdAt: now,
      });
    });
    await kernel.configure([
      ...new Set([...kernel.methods, "passkey" as const]),
    ]);
    send(res, 201, { ok: true });
    return true;
  }
  return false;
}
