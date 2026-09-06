import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import {
  hashPassword,
  hashSecret,
  isLoopback,
  verifyPassword,
  type AuthKernel,
  type AuthStore,
} from "./kernel.js";

const attempts = new Map<
  string,
  { count: number; resetAt: number; nextAt: number }
>();
export function loginPeer(req: IncomingMessage) {
  const peer = req.socket.remoteAddress || "unknown";
  const trusted = (process.env.PI_WEB_AUTH_PROXY_PEERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => isIP(s));
  const forwarded = req.headers["x-forwarded-for"];
  // Opt-in exact proxy peers; require one sanitized IP, never take an arbitrary chain.
  return trusted.includes(peer) &&
    typeof forwarded === "string" &&
    isIP(forwarded.trim())
    ? forwarded.trim()
    : peer;
}
let active = 0;
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
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_384) throw new Error("Body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}
function allow(req: IncomingMessage, store: AuthStore) {
  const now = Date.now();
  for (const [id, rate] of attempts)
    if (rate.resetAt <= now) attempts.delete(id);
  const id = `${store.path}:${loginPeer(req)}`;
  if ((!attempts.has(id) && attempts.size >= 4096) || active >= 1) return false;
  const rate = attempts.get(id) || {
    count: 0,
    resetAt: now + 60_000,
    nextAt: 0,
  };
  attempts.set(id, rate);
  return now >= rate.nextAt;
}
export function passwordLoginPage(
  res: ServerResponse,
  methods: readonly string[],
  setupToken?: string,
) {
  const setup = setupToken !== undefined;
  const form = (method: string, label: string, autocomplete: string) =>
    `<form data-method="${method}"><label>${label}<input name=secret type=password autocomplete="${autocomplete}" ${setup ? "minlength=12" : ""} required></label>${setup ? "<label>Confirm password<input name=confirm type=password autocomplete=new-password required></label>" : ""}<button>${setup ? "Set password" : "Sign in"}</button></form>`;
  const password = methods.includes("password")
    ? form(
        "password",
        setup ? "New password (12+ characters)" : "Password",
        setup ? "new-password" : "current-password",
      )
    : "";
  const legacy =
    !setup && methods.includes("legacy")
      ? form("legacy", "Legacy token (deprecated)", "off")
      : "";
  const external =
    !setup && methods.includes("external")
      ? '<form data-method="external"><button>Sign in through trusted proxy</button></form>'
      : "";
  const passkeyHref = setup
    ? `/api/auth/passkey-bootstrap?token=${encodeURIComponent(setupToken)}`
    : "/api/auth/passkey-login";
  const passkey = methods.includes("passkey")
    ? `<a href="${passkeyHref}">${setup ? "Set up" : "Sign in with"} a passkey</a>`
    : "";
  const html = `<!doctype html><meta name=viewport content="width=device-width"><meta name=referrer content=no-referrer><title>pi-web authentication</title><style>body{font:16px system-ui;max-width:28rem;margin:12vh auto;padding:2rem;background:#111;color:#eee}input,button{box-sizing:border-box;font:inherit;padding:.7rem;width:100%;margin:.5rem 0}a{color:#9cf}</style><h1>${setup ? "Set up pi-web" : "Sign in to pi-web"}</h1>${password}${passkey}${legacy}${external}<p id=e role=alert></p><script>const setup=${JSON.stringify(setupToken || "").replace(/</g, "\\u003c")};document.querySelectorAll('form').forEach(f=>f.addEventListener('submit',async x=>{x.preventDefault();const button=f.querySelector('button');button.disabled=true;try{if(setup&&f.elements.secret.value!==f.elements.confirm.value)throw Error('Passwords do not match');const method=f.dataset.method;const r=await fetch('/api/auth/'+method+(setup?'/bootstrap':'/login'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:f.elements.secret?.value,token:setup})});if(!r.ok)throw Error((await r.json()).error||'Sign in failed');location.href='/'}catch(error){document.getElementById('e').textContent=error.message;button.disabled=false}}))</script>`;
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'",
  });
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
  active++;
  try {
    const body = await input(req);
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
    const id = `${store.path}:${loginPeer(req)}`;
    if (res.statusCode < 400) attempts.delete(id);
    else {
      const rate = attempts.get(id);
      if (rate) {
        rate.count++;
        rate.nextAt =
          Date.now() + Math.min(2000, 100 * 2 ** Math.min(rate.count - 1, 5));
      }
    }
    active--;
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
) {
  const hash = await validatedPasswordHash(password);
  await store.update((state) => {
    if (
      !state.sessions.some(
        (s) =>
          s.hash === sessionHash && !s.revokedAt && s.expiresAt > Date.now(),
      )
    )
      throw new Error("Browser session revoked");
    state.password = { hash, changedAt: Date.now() };
    state.verifiedMethods = (state.verifiedMethods || []).filter(
      (m) => m !== "password",
    );
    for (const session of state.sessions)
      if (session.hash !== sessionHash) session.revokedAt = Date.now();
  });
}
