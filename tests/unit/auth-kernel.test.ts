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

  it("persists opaque hashed sessions and authenticates their cookie", async () => {
    const s = await store(); const k = new AuthKernel("passkey", s, "", false), res = response();
    await k.establishSession(res, { id: "passkey:owner" });
    const cookie = res.headers.get("set-cookie")!; const raw = /pi_web_session=([^;]+)/.exec(cookie)![1];
    expect((await k.gate(req({ cookie: `pi_web_session=${raw}` }))).ok).toBe(true);
    expect(await readFile(s.path, "utf8")).not.toContain(raw);
  });

  it("accepts only live named API tokens in passkey mode", async () => {
    const s = await store(); await s.update(x => x.apiTokens.push({ id: "1", name: "CI", hash: hashSecret("piw_secret"), createdAt: 1, expiresAt: Date.now() + 1000 }));
    const k = new AuthKernel("passkey", s);
    expect((await k.gate(req({ authorization: "Bearer piw_secret" }))).ok).toBe(true);
    await s.update(x => { x.apiTokens[0].revokedAt = Date.now(); });
    expect((await k.gate(req({ authorization: "Bearer piw_secret" }))).ok).toBe(false);
  });

  it("serializes atomic updates", async () => {
    const s = await store(); await Promise.all(Array.from({ length: 20 }, (_, i) => s.update(async x => { await new Promise(r => setTimeout(r, i % 3)); x.apiTokens.push({ id: String(i), name: "x", hash: "h", createdAt: 0, expiresAt: 1 }); })));
    expect((await s.read()).apiTokens).toHaveLength(20);
  });
});
