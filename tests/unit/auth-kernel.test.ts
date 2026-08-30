import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { AuthKernel, AuthStore, hashSecret } from "../../server/auth/kernel.js";

function req(headers: Record<string, string> = {}, url = "/") { return { headers, url } as any; }
function response() { const headers = new Map<string, string>(); return { setHeader(k: string, v: string) { headers.set(k.toLowerCase(), v); }, headers } as any; }
async function store() { return new AuthStore(join(await mkdtemp(join(tmpdir(), "pi-web-auth-")), "auth.json")); }

describe("auth kernel", () => {
  it("preserves legacy behavior only in explicit legacy mode", async () => {
    const s = await store(); const k = new AuthKernel("legacy", s, "secret", false);
    expect((await k.gate(req({ authorization: "Bearer secret" }))).ok).toBe(true);
    expect((await k.gate(req({}, "/?token=secret"))).ok).toBe(true);
    expect((await k.gate(req({ authorization: "Bearer wrong" }))).ok).toBe(false);
    expect((await new AuthKernel("passkey", s, "secret", false).gate(req({ authorization: "Bearer secret" }))).ok).toBe(false);
  });

  it("attributes external requests using a configured trusted header and fails closed when absent", async () => {
    const s = await store(); const k = new AuthKernel("external", s, "", false, "Tailscale-User-Login");
    expect(await k.gate(req({ "tailscale-user-login": "alice@example.com" }))).toMatchObject({ ok: true, identity: { id: "external:alice@example.com", displayName: "alice@example.com" } });
    expect((await k.gate(req())).ok).toBe(false);
    expect((await new AuthKernel("external", s).gate(req())).ok).toBe(true);
  });

  it("persists opaque hashed sessions and authenticates their cookie", async () => {
    const s = await store(); const k = new AuthKernel("passkey", s, "", false), res = response();
    await k.establishSession(res, { id: "passkey:owner" });
    const cookie = res.headers.get("set-cookie")!; const raw = /pi_web_session=([^;]+)/.exec(cookie)![1];
    expect(await k.gate(req({ cookie: `pi_web_session=${raw}` }))).toMatchObject({ ok: true, via: "session", sessionHash: hashSecret(raw) });
    expect(await readFile(s.path, "utf8")).not.toContain(raw);
  });

  it("accepts legacy session cookies and ignores malformed cookies", async () => {
    const s = await store(); const k = new AuthKernel("legacy", s, "secret", false), res = response();
    await k.establishSession(res, { id: "legacy:token" });
    const raw = /pi_web_session=([^;]+)/.exec(res.headers.get("set-cookie")!)![1];
    expect(await k.gate(req({ cookie: `bad=%; pi_web_session=${raw}` }))).toMatchObject({ ok: true, via: "session" });
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
    const k = new AuthKernel("none", await store()); const ticket = k.mintWsTicket({ id: "token:automation" });
    expect(k.redeemWsTicket(ticket)).toEqual({ id: "token:automation" });
    expect(k.redeemWsTicket(ticket)).toBeUndefined();
  });

  it("serializes atomic updates", async () => {
    const s = await store(); await Promise.all(Array.from({ length: 20 }, (_, i) => s.update(async x => { await new Promise(r => setTimeout(r, i % 3)); x.apiTokens.push({ id: String(i), name: "x", hash: "h", createdAt: 0, expiresAt: 1 }); })));
    expect((await s.read()).apiTokens).toHaveLength(20);
  });
});
