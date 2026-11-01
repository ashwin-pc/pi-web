import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { AuthKernel, AuthStore, bumpRevocationEpoch, hashSecret } from "../../server/auth/kernel.js";
import { handleSecurityRoute } from "../../server/auth/security.js";

function req(headers: Record<string, string> = {}, url = "/") { return { headers, url } as any; }
function response() { const headers = new Map<string, string>(); return { status: 0, body: "", setHeader(k: string, v: string) { headers.set(k.toLowerCase(), v); }, writeHead(status: number, values: Record<string, string> = {}) { this.status = status; for (const [key, value] of Object.entries(values)) headers.set(key.toLowerCase(), value); }, end(body = "") { this.body = body; }, headers } as any; }
async function store() { return new AuthStore(join(await mkdtemp(join(tmpdir(), "pi-web-auth-")), "auth.json")); }

describe("auth kernel", () => {
  it("never accepts query or arbitrary bearer credentials", async () => {
    const s = await store();
    const k = new AuthKernel("passkey", s, false);
    expect((await k.gate(req({}, "/?token=secret"))).ok).toBe(false);
    expect((await k.gate(req({ authorization: "Bearer secret" }))).ok).toBe(false);
  });

  it("attributes external requests using a configured trusted header and fails closed when absent", async () => {
    const s = await store(); const k = new AuthKernel("external", s, false, "Tailscale-User-Login");
    expect(await k.gate(req({ "tailscale-user-login": "alice@example.com" }))).toMatchObject({ ok: true, identity: { id: "external:alice@example.com", displayName: "alice@example.com" } });
    expect((await k.gate(req())).ok).toBe(false);
    expect((await new AuthKernel("external", s).gate(req())).ok).toBe(false);
  });

  it.each(["external", "none"] as const)("lets %s identities read security inventory but denies mutations", async mode => {
    const s = await store(); const k = new AuthKernel(mode, s, false, "x-verified-user"); const gated = await k.gate(req({ "x-verified-user": "owner" }));
    expect(gated.ok).toBe(true);
    if (!gated.ok) return;

    const readReq = req({}, "/api/auth/security"); readReq.method = "GET";
    const readRes = response();
    await handleSecurityRoute(readReq, readRes, new URL("http://localhost/api/auth/security"), gated, k, s, {} as any);
    expect(readRes.status).toBe(200);
    expect(JSON.parse(readRes.body)).toMatchObject({ mode, passkeys: [], sessions: [], apiTokens: [], deviceGrants: [] });

    const mutationReq = req({}, "/api/auth/tokens"); mutationReq.method = "POST";
    const mutationRes = response();
    await handleSecurityRoute(mutationReq, mutationRes, new URL("http://localhost/api/auth/tokens"), gated, k, s, {} as any);
    expect(mutationRes.status).toBe(403);
  });

  it("lets normally gated API tokens read security inventory but denies mutations", async () => {
    const s = await store();
    await s.update(state => state.apiTokens.push({ id: "reader", name: "Reader", hash: hashSecret("piw_reader"), createdAt: 1, expiresAt: Date.now() + 10_000 }));
    const k = new AuthKernel("passkey", s); const gated = await k.gate(req({ authorization: "Bearer piw_reader" }));
    expect(gated.ok).toBe(true);
    if (!gated.ok) return;

    const readReq = req({}, "/api/auth/security"); readReq.method = "GET"; const readRes = response();
    await handleSecurityRoute(readReq, readRes, new URL("http://localhost/api/auth/security"), gated, k, s, {} as any);
    expect(readRes.status).toBe(200);
    expect(JSON.parse(readRes.body).apiTokens).toEqual([expect.objectContaining({ id: "reader", name: "Reader" })]);

    const mutationReq = req({}, "/api/auth/tokens"); mutationReq.method = "POST"; const mutationRes = response();
    await handleSecurityRoute(mutationReq, mutationRes, new URL("http://localhost/api/auth/tokens"), gated, k, s, {} as any);
    expect(mutationRes.status).toBe(403);
  });

  it("persists opaque hashed sessions and authenticates their cookie", async () => {
    const s = await store(); const k = new AuthKernel("passkey", s, false), res = response();
    await k.establishSession(res, { id: "passkey:owner" });
    const cookie = res.headers.get("set-cookie")!; const raw = /pi_web_session=([^;]+)/.exec(cookie)![1];
    expect(await k.gate(req({ cookie: `pi_web_session=${raw}` }))).toMatchObject({ ok: true, via: "session", sessionHash: hashSecret(raw) });
    expect(await readFile(s.path, "utf8")).not.toContain(raw);
  });

  it("accepts existing session cookies and ignores malformed cookies", async () => {
    const s = await store(); const k = new AuthKernel("passkey", s, false), res = response();
    await k.establishSession(res, { id: "owner" });
    const raw = /pi_web_session=([^;]+)/.exec(res.headers.get("set-cookie")!)![1];
    expect(await k.gate(req({ cookie: `bad=%; pi_web_session=${raw}` }))).toMatchObject({ ok: true, via: "session" });
  });

  it("rejects retired legacy sessions by method or identity without denying supported sessions", async () => {
    const s = await store(); const now = Date.now();
    await s.update(state => {
      state.config = { policy: "authenticated", methods: ["password", "passkey", "external"] };
      state.sessions.push(
        { hash: hashSecret("legacy-method"), identity: { id: "owner" }, method: "legacy" as never, createdAt: now, lastSeenAt: now, expiresAt: now + 10_000 },
        { hash: hashSecret("legacy-identity"), identity: { id: "legacy:token" }, method: "grant", createdAt: now, lastSeenAt: now, expiresAt: now + 10_000 },
        { hash: hashSecret("supported"), identity: { id: "password:owner" }, method: "password", createdAt: now, lastSeenAt: now, expiresAt: now + 10_000 },
      );
      state.deviceGrants = [{
        id: "legacy-grant",
        hash: hashSecret("legacy-grant"),
        createdAt: now,
        expiresAt: now + 10_000,
        createdBy: { id: "owner" },
        createdBySessionHash: hashSecret("legacy-method"),
      }];
    });
    const k = new AuthKernel("passkey", s, false);
    expect((await k.gate(req({ cookie: "pi_web_session=legacy-method" }))).ok).toBe(false);
    expect((await k.gate(req({ cookie: "pi_web_session=legacy-identity" }))).ok).toBe(false);
    expect((await k.gate(req({ cookie: "pi_web_session=supported" }))).ok).toBe(true);
    await expect(
      k.establishSession(response(), { id: "owner" }, "grant", undefined, false, {
        grantHash: hashSecret("legacy-grant"),
      }),
    ).rejects.toThrow("Invalid or expired device grant");
  });

  it("prunes expired and revoked sessions on update", async () => {
    const s = await store(); const now = Date.now();
    await s.update(x => x.sessions.push(
      { hash: "expired", identity: { id: "x" }, createdAt: 1, lastSeenAt: 1, expiresAt: now - 1 },
      { hash: "revoked", identity: { id: "x" }, createdAt: 1, lastSeenAt: 1, expiresAt: now + 1000, revokedAt: now },
    ));
    await s.update(() => undefined);
    expect((await s.read()).sessions).toEqual([]);
  });

  it("accepts only live named API tokens in passkey mode", async () => {
    const s = await store(); await s.update(x => x.apiTokens.push({ id: "1", name: "CI", hash: hashSecret("piw_secret"), createdAt: 1, expiresAt: Date.now() + 1000 }));
    const k = new AuthKernel("passkey", s);
    expect((await k.gate(req({ authorization: "Bearer piw_secret" }))).ok).toBe(true);
    await s.update(x => { x.apiTokens[0].revokedAt = Date.now(); });
    expect((await k.gate(req({ authorization: "Bearer piw_secret" }))).ok).toBe(false);
  });

  it("mints hashed single-use WebSocket tickets with identity propagation", async () => {
    const k = new AuthKernel("none", await store()); const ticket = k.mintWsTicket({ ok: true, identity: { id: "token:automation" }, via: "token", revocationEpoch: 2 });
    expect(k.redeemWsTicket(ticket)).toMatchObject({ identity: { id: "token:automation" }, via: "token", revocationEpoch: 2 });
    expect(k.redeemWsTicket(ticket)).toBeUndefined();
  });

  it("enrolls successful extension authentication in the current revocation epoch", async () => {
    const s = await store();
    const extension = { ok: true, identity: { id: "extension:parent:test" }, via: "extension" } as const;
    const k = new AuthKernel("none", s, false, "", "open", [], async () => extension, true);
    const extensionReq = req({ authorization: "PiWebExtension synthetic" });

    const initial = await k.gate(extensionReq);
    expect(initial).toEqual({ ...extension, revocationEpoch: 0 });
    if (!initial.ok) return;
    expect(k.redeemWsTicket(k.mintWsTicket(initial))?.revocationEpoch).toBe(0);

    await s.update((state) => bumpRevocationEpoch(state));
    const reconnected = await k.gate(extensionReq);
    expect(reconnected).toEqual({ ...extension, revocationEpoch: 1 });
    if (!reconnected.ok) return;
    expect(k.redeemWsTicket(k.mintWsTicket(reconnected))?.revocationEpoch).toBe(1);
  });

  it("does not let failed extension credentials fall through to open access", async () => {
    const extensionReq = req({ authorization: "PiWebExtension invalid" });
    const rejected = new AuthKernel("none", await store(), false, "", "open", [], async () => ({ ok: false, status: 403 }), true);
    const unavailable = new AuthKernel("none", await store(), false, "", "open", [], undefined, true);
    expect(await rejected.gate(extensionReq)).toEqual({ ok: false, status: 403 });
    expect(await unavailable.gate(extensionReq)).toEqual({ ok: false });
  });

  it("serializes atomic updates", async () => {
    const s = await store(); await Promise.all(Array.from({ length: 20 }, (_, i) => s.update(async x => { await new Promise(r => setTimeout(r, i % 3)); x.apiTokens.push({ id: String(i), name: "x", hash: "h", createdAt: 0, expiresAt: 1 }); })));
    expect((await s.read()).apiTokens).toHaveLength(20);
  });
});
