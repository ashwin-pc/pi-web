import { loginPageHeaders, renderLoginPage, type LoginPresentation } from "./loginPage.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { trustedProxyPeer } from "./proxy.js";
import { readJsonBody } from "./requestBody.js";
import type { AccessPolicy, HumanAuthMethod } from "./config.js";
import {
  hashPassword,
  hashSecret,
  isLoopback,
  AuthStoreBusyError,
  PasswordWorkUnavailableError,
  verifyPassword,
  type AuthKernel,
  type AuthStore,
} from "./kernel.js";

const attempts = new Map<
  string,
  { count: number; resetAt: number; nextAt: number; inFlight: boolean }
>();
const ATTEMPTS_CAPACITY = 4096;
export function loginPeer(req: IncomingMessage) {
  const peer = req.socket.remoteAddress || "unknown";
  const forwarded = req.headers["x-forwarded-for"];
  // Opt-in exact proxy peers; require one sanitized IP, never take an arbitrary chain.
  return trustedProxyPeer(req) &&
    typeof forwarded === "string" &&
    isIP(forwarded.trim())
    ? forwarded.trim()
    : peer;
}
const send = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
};
function reserveAttempt(req: IncomingMessage, store: AuthStore) {
  const now = Date.now();
  for (const [id, rate] of attempts)
    if (!rate.inFlight && rate.resetAt <= now) attempts.delete(id);
  const id = `${store.path}:${loginPeer(req)}`;
  const existing = attempts.get(id);
  if (existing) {
    attempts.delete(id);
    attempts.set(id, existing);
    if (existing.inFlight || now < existing.nextAt) return undefined;
    existing.inFlight = true;
    return id;
  }
  if (attempts.size >= ATTEMPTS_CAPACITY) {
    const oldestIdle = [...attempts].find(([, rate]) => !rate.inFlight)?.[0];
    if (oldestIdle === undefined) return undefined;
    attempts.delete(oldestIdle);
  }
  const rate = {
    count: 0,
    resetAt: now + 60_000,
    nextAt: 0,
    inFlight: true,
  };
  attempts.set(id, rate);
  return id;
}
function finishAttempt(
  id: string,
  outcome: "success" | "wrong-password" | "other",
) {
  const rate = attempts.get(id);
  if (!rate) return;
  if (outcome === "success") {
    attempts.delete(id);
    return;
  }
  rate.inFlight = false;
  if (outcome === "wrong-password") {
    rate.count++;
    rate.nextAt =
      Date.now() + Math.min(2000, 100 * 2 ** Math.min(rate.count - 1, 5));
  }
}
export function passwordLoginPage(
  res: ServerResponse,
  methods: readonly string[],
  setupToken?: string,
  presentation?: LoginPresentation,
) {
  const html = renderLoginPage({ methods, setupToken, presentation });
  res.writeHead(200, loginPageHeaders);
  res.end(html);
}
export async function handlePasswordLogin(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  kernel: AuthKernel,
  store: AuthStore,
  origin = "http://localhost",
) {
  const match =
    /^\/api\/auth\/(password|external)\/(login|bootstrap)$/.exec(
      url.pathname,
    );
  if (req.method !== "POST" || !match) return false;
  const method = match[1] as "password" | "external",
    setup = match[2] === "bootstrap";
  if (
    (!setup && !kernel.methods.has(method)) ||
    (setup && method !== "password")
  ) {
    send(res, 403, { error: "Method disabled" });
    return true;
  }
  let body: Record<string, unknown>;
  try {
    body = (await readJsonBody(req, {
      maxBytes: 16_384,
      idleTimeoutMs: 5_000,
      totalTimeoutMs: 10_000,
    })) as Record<string, unknown>;
  } catch (error) {
    send(res, 400, {
      error: error instanceof Error ? error.message : "Invalid request",
    });
    return true;
  }
  const attemptId = method === "password" ? reserveAttempt(req, store) : "";
  if (method === "password" && !attemptId) {
    res.setHeader("retry-after", "2");
    send(res, 429, { error: "Too many attempts. Try again later." });
    return true;
  }
  let outcome: "success" | "wrong-password" | "other" = "other";
  try {
    const state = await store.read();
    let passwordHash = state.password?.hash;
    if (setup) {
      if (new URL(origin).hostname === "localhost" && !isLoopback(req)) {
        send(res, 403, {
          error: "Bootstrap requires loopback access for localhost origins",
        });
        return true;
      }
      const tokenHash =
        typeof body.token === "string" ? hashSecret(body.token) : "";
      if (
        !state.bootstrap ||
        state.bootstrap.hash !== tokenHash ||
        state.bootstrap.usedAt ||
        state.bootstrap.expiresAt <= Date.now()
      ) {
        send(res, 401, { error: "Invalid or expired setup token" });
        return true;
      }
      const hash = await validatedPasswordHash(body.password);
      passwordHash = hash;
      await store.update((s) => {
        if (
          !s.bootstrap ||
          s.bootstrap.hash !== tokenHash ||
          s.bootstrap.usedAt ||
          s.bootstrap.expiresAt <= Date.now()
        )
          throw new Error("Setup token already used or expired");
        s.bootstrap.usedAt = Date.now();
        s.password = { hash, changedAt: Date.now() };
        s.config = {
          policy: "authenticated",
          methods: [
            ...new Set([
              ...(s.config?.methods || kernel.methods),
              "password" as const,
            ]),
          ],
        };
        for (const session of s.sessions) session.revokedAt = Date.now();
      });
    } else if (method === "password") {
      if (
        typeof body.password !== "string" ||
        body.password.length > 1024 ||
        !state.password ||
        !(await verifyPassword(body.password, state.password.hash))
      ) {
        outcome = "wrong-password";
        send(res, 401, { error: "Invalid credentials" });
        return true;
      }
    } else {
      // Explicit login may replace a revoked cookie; ordinary gated traffic may not.
      const headers = {
        ...req.headers,
        cookie: "",
        authorization: "",
      };
      const result = await kernel.gate({
        headers,
        url: "/",
        socket: req.socket,
      } as IncomingMessage);
      if (!result.ok || result.via !== method) {
        send(res, 401, { error: "Invalid credentials" });
        return true;
      }
      await kernel.establishSession(res, result.identity, method, req);
      send(res, 200, { ok: true });
      outcome = "success";
      return true;
    }
    await kernel.establishSession(
      res,
      { id: "owner", displayName: "Owner" },
      "password",
      req,
      true,
      { passwordHash },
    );
    send(res, 200, { ok: true });
    outcome = "success";
    return true;
  } catch (error) {
    const busy =
      error instanceof PasswordWorkUnavailableError ||
      error instanceof AuthStoreBusyError;
    if (busy) res.setHeader("retry-after", "2");
    send(res, busy ? 503 : 400, {
      error: error instanceof Error ? error.message : "Invalid request",
    });
    return true;
  } finally {
    if (attemptId) finishAttempt(attemptId, outcome);
  }
}
export async function validatedPasswordHash(password: unknown) {
  if (
    typeof password !== "string" ||
    password.length < 12 ||
    password.length > 1024
  )
    throw new Error("Password must be 12–1024 characters");
  return hashPassword(password);
}
export async function changePassword(
  store: AuthStore,
  password: unknown,
  sessionHash: string,
  revokeApiTokens = true,
  enable?: { policy: AccessPolicy; methods: Iterable<HumanAuthMethod> },
) {
  const hash = await validatedPasswordHash(password);
  await store.update((state) => {
    if (
      !state.sessions.some(
        (s) =>
          s.hash === sessionHash && !s.revokedAt && s.expiresAt > Date.now() &&
          !!s.authenticatedAt && s.authenticatedAt >= Date.now() - 5 * 60_000,
      )
    )
      throw new Error("Browser session revoked");
    for (const grant of state.deviceGrants || []) grant.cancelledAt = Date.now();
    if (revokeApiTokens)
      for (const token of state.apiTokens) token.revokedAt = Date.now();
    state.password = { hash, changedAt: Date.now() };
    state.verifiedMethods = (state.verifiedMethods || []).filter(
      (m) => m !== "password",
    );
    for (const session of state.sessions)
      if (session.hash !== sessionHash) session.revokedAt = Date.now();
    if (enable) {
      state.config = {
        policy: state.config?.policy || enable.policy,
        methods: [...new Set([...(state.config?.methods || enable.methods), "password" as const])],
      };
    }
  });
}
