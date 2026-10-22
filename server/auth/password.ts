import { loginPageHeaders, renderLoginPage, type LoginPresentation } from "./loginPage.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { trustedProxyPeer } from "./proxy.js";
import {
  hashPassword,
  hashSecret,
  isLoopback,
  verifyPassword,
  type AuthKernel,
  type AuthStore,
} from "./kernel.js";

// Per-peer cooldown table. `attempts` is kept as an insertion-ordered Map so
// that when it reaches capacity we evict the least-recently-touched entry
// (Map iteration is insertion order; re-inserting on access moves an entry to
// the end, i.e. an O(1) LRU) rather than refusing to track new peers.
const attempts = new Map<
  string,
  { count: number; resetAt: number; nextAt: number }
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
// Credential-verification single-flight. The scrypt bound is what actually
// needs serializing; the slot is now acquired AFTER the request body has been
// read and validated so a stalled or malformed request cannot hold it, and
// cannot deny service to a different peer's cooldown decision either.
let active = 0;
const slotWaiters: Array<() => void> = [];
const SLOT_WAIT_MS = 500; // small queue wait before giving up (<< the 2 s retry-after)
const SLOT_HOLD_MS = 30_000; // hard upper bound on any single login handler
const BODY_READ_MS = 5_000; // hard upper bound on reading the JSON request body
async function acquireSlot(): Promise<boolean> {
  if (active < 1) {
    active++;
    return true;
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const i = slotWaiters.indexOf(wake);
      if (i >= 0) slotWaiters.splice(i, 1);
      resolve(false);
    }, SLOT_WAIT_MS);
    const wake = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      active++;
      resolve(true);
    };
    slotWaiters.push(wake);
  });
}
function releaseSlot() {
  if (active > 0) active--;
  const next = slotWaiters.shift();
  if (next) next();
}
const send = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
};
async function input(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  // Hard cap on how long an unauthenticated client may keep the handler blocked
  // in body read. The HTTP server's requestTimeout/headersTimeout cover the raw
  // socket; this is the per-handler belt-and-braces so the per-request timer
  // can fire predictably even if those are disabled by a reverse-proxy frontend.
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Request body read timed out")),
      BODY_READ_MS,
    );
    if (typeof (timer as unknown as { unref?: () => void })?.unref === "function")
      (timer as unknown as { unref: () => void }).unref();
  });
  const read = (async () => {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16_384) throw new Error("Body too large");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  })();
  try {
    return (await Promise.race([read, deadline])) as Record<string, unknown>;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
// Per-peer cooldown decision. Independent of the global single-flight slot so
// one peer's hold on the slot never denies another peer the right to attempt
// sign-in; and insertion-ordered LRU eviction keeps new peers trackable even
// under pressure from an attacker-controlled address pool.
function allow(req: IncomingMessage, store: AuthStore) {
  const now = Date.now();
  for (const [id, rate] of attempts)
    if (rate.resetAt <= now) attempts.delete(id);
  const id = `${store.path}:${loginPeer(req)}`;
  const existing = attempts.get(id);
  if (existing) {
    // Touch for LRU: re-insert to move to the end of iteration order.
    attempts.delete(id);
    attempts.set(id, existing);
    return now >= existing.nextAt;
  }
  if (attempts.size >= ATTEMPTS_CAPACITY) {
    // Evict least-recently-touched entry rather than refuse new peers.
    const oldest = attempts.keys().next().value;
    if (oldest !== undefined) attempts.delete(oldest);
  }
  attempts.set(id, { count: 0, resetAt: now + 60_000, nextAt: 0 });
  return true;
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
    /^\/api\/auth\/(password|legacy|external)\/(login|bootstrap)$/.exec(
      url.pathname,
    );
  if (req.method !== "POST" || !match) return false;
  const method = match[1] as "password" | "legacy" | "external",
    setup = match[2] === "bootstrap";
  if (
    (!setup && !kernel.methods.has(method)) ||
    (setup && method !== "password")
  ) {
    send(res, 403, { error: "Method disabled" });
    return true;
  }
  if (!allow(req, store)) {
    res.setHeader("retry-after", "2");
    send(res, 429, { error: "Too many attempts. Try again later." });
    return true;
  }
  // Read and validate the request body BEFORE taking the single-flight slot
  // so a stalled or malformed pre-auth request can never hold it. The slot
  // only needs to cover credential verification (which is what the scrypt
  // memory bound actually cares about).
  let body: Record<string, unknown>;
  try {
    body = await input(req);
  } catch (error) {
    send(res, 400, {
      error: error instanceof Error ? error.message : "Invalid request",
    });
    return true;
  }
  const slotAcquired = await acquireSlot();
  if (!slotAcquired) {
    res.setHeader("retry-after", "2");
    send(res, 429, { error: "Too many attempts. Try again later." });
    return true;
  }
  // Hard upper bound on how long any one login handler may hold the slot.
  const holdTimer = setTimeout(() => {
    try {
      req.destroy(new Error("Login handler exceeded time budget"));
    } catch {
      /* already closed */
    }
  }, SLOT_HOLD_MS);
  if (typeof (holdTimer as unknown as { unref?: () => void })?.unref === "function")
    (holdTimer as unknown as { unref: () => void }).unref();
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
        send(res, 401, { error: "Invalid credentials" });
        return true;
      }
    } else {
      // Explicit login may replace a revoked cookie; ordinary gated traffic may not.
      const headers = {
        ...req.headers,
        cookie: "",
        authorization:
          method === "legacy" && typeof body.password === "string"
            ? `Bearer ${body.password}`
            : "",
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
    return true;
  } catch (error) {
    send(res, 400, {
      error: error instanceof Error ? error.message : "Invalid request",
    });
    return true;
  } finally {
    clearTimeout(holdTimer);
    const id = `${store.path}:${loginPeer(req)}`;
    if (res.statusCode < 400) attempts.delete(id);
    else if (res.statusCode === 401) {
      const rate = attempts.get(id);
      if (rate) {
        rate.count++;
        rate.nextAt =
          Date.now() + Math.min(2000, 100 * 2 ** Math.min(rate.count - 1, 5));
      }
    }
    releaseSlot();
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
  });
}
