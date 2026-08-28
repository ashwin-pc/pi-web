import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

export type AuthMode = "none" | "legacy" | "passkey" | "external";
export type Identity = { id: string; displayName?: string };
export type CredentialRecord = { id: string; publicKey: string; counter: number; transports?: string[]; name: string; createdAt: number; revokedAt?: number };
export type SessionRecord = { hash: string; identity: Identity; createdAt: number; lastSeenAt: number; expiresAt: number; revokedAt?: number };
export type ApiTokenRecord = { id: string; name: string; hash: string; createdAt: number; expiresAt: number; revokedAt?: number };
export type BootstrapRecord = { hash: string; expiresAt: number; usedAt?: number };
export type AuthState = { version: 1; credentials: CredentialRecord[]; sessions: SessionRecord[]; apiTokens: ApiTokenRecord[]; bootstrap?: BootstrapRecord };

const EMPTY: AuthState = { version: 1, credentials: [], sessions: [], apiTokens: [] };
const DAY = 86_400_000;
export const SESSION_COOKIE = "pi_web_session";
export const hashSecret = (value: string) => createHash("sha256").update(value).digest("base64url");
const safeEqual = (a: string, b: string) => { const aa = Buffer.from(a); const bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); };

export class AuthStore {
  private queue = Promise.resolve();
  constructor(readonly path: string) {}
  async read(): Promise<AuthState> {
    try { return { ...EMPTY, ...JSON.parse(await readFile(this.path, "utf8")) } as AuthState; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY); throw error; }
  }
  async update(mutator: (state: AuthState) => void | Promise<void>): Promise<AuthState> {
    let result!: AuthState;
    const operation = this.queue.catch(() => undefined).then(async () => {
      const state = await this.read(); await mutator(state); await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 }); await rename(temp, this.path); result = state;
    });
    this.queue = operation.catch(() => undefined);
    await operation; return result;
  }
}

function cookies(req: IncomingMessage) { return Object.fromEntries((req.headers.cookie || "").split(";").map(v => v.trim().split(/=(.*)/s)).filter(v => v[0]).map(([k,v]) => [k, decodeURIComponent(v || "")])); }
export type GateResult = { ok: true; identity: Identity } | { ok: false };

export class AuthKernel {
  constructor(readonly mode: AuthMode, readonly store: AuthStore, readonly legacyToken = "", readonly secureCookie = true) {}
  async gate(req: IncomingMessage): Promise<GateResult> {
    if (this.mode === "none" || this.mode === "external") return { ok: true, identity: { id: this.mode } };
    if (this.mode === "legacy") {
      if (!this.legacyToken) return { ok: true, identity: { id: "legacy:open" } };
      const auth = req.headers.authorization || ""; const query = new URL(req.url || "/", "http://localhost").searchParams.get("token") || "";
      const supplied = auth.startsWith("Bearer ") ? auth.slice(7) : query;
      return safeEqual(supplied, this.legacyToken) ? { ok: true, identity: { id: "legacy:token" } } : { ok: false };
    }
    const state = await this.store.read(); const now = Date.now(); const raw = cookies(req)[SESSION_COOKIE];
    if (raw) {
      const record = state.sessions.find(s => safeEqual(s.hash, hashSecret(raw)) && !s.revokedAt && s.expiresAt > now);
      if (record) { if (now - record.lastSeenAt > 300_000) void this.store.update(s => { const found = s.sessions.find(x => x.hash === record.hash); if (found) found.lastSeenAt = now; }); return { ok: true, identity: record.identity }; }
    }
    const auth = req.headers.authorization || "";
    if (auth.startsWith("Bearer ")) {
      const hash = hashSecret(auth.slice(7)); const api = state.apiTokens.find(t => safeEqual(t.hash, hash) && !t.revokedAt && t.expiresAt > now);
      if (api) return { ok: true, identity: { id: `token:${api.id}`, displayName: api.name } };
    }
    return { ok: false };
  }
  async establishSession(res: ServerResponse, identity: Identity) {
    const raw = randomBytes(32).toString("base64url"), now = Date.now();
    await this.store.update(s => { s.sessions.push({ hash: hashSecret(raw), identity, createdAt: now, lastSeenAt: now, expiresAt: now + 30 * DAY }); });
    res.setHeader("set-cookie", `${SESSION_COOKIE}=${raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${this.secureCookie ? "; Secure" : ""}`);
  }
  clearSession(res: ServerResponse) { res.setHeader("set-cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${this.secureCookie ? "; Secure" : ""}`); }
}

export function isLoopback(req: IncomingMessage) { const ip = req.socket.remoteAddress || ""; return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1"; }
export function randomSecret() { return randomBytes(32).toString("base64url"); }
