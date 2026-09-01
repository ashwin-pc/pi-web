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
export type DeviceGrantRecord = { id: string; hash: string; createdAt: number; expiresAt: number; createdBy: Identity; createdBySessionHash: string; usedAt?: number; cancelledAt?: number };
export type AuthState = { version: 1; credentials: CredentialRecord[]; sessions: SessionRecord[]; apiTokens: ApiTokenRecord[]; bootstrap?: BootstrapRecord; deviceGrants?: DeviceGrantRecord[] };

const EMPTY: AuthState = { version: 1, credentials: [], sessions: [], apiTokens: [] };
const DAY = 86_400_000;
export const SESSION_COOKIE = "pi_web_session";
export const hashSecret = (value: string) => createHash("sha256").update(value).digest("base64url");
const safeEqual = (a: string, b: string) => { const aa = Buffer.from(a); const bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); };

export class AuthStore {
  private queue = Promise.resolve();
  constructor(readonly path: string) {}
  async read(): Promise<AuthState> {
    try { return { ...structuredClone(EMPTY), ...JSON.parse(await readFile(this.path, "utf8")) } as AuthState; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY); throw error; }
  }
  async update(mutator: (state: AuthState) => void | Promise<void>): Promise<AuthState> {
    let result!: AuthState;
    const operation = this.queue.catch(() => undefined).then(async () => {
      const state = await this.read();
      const now = Date.now();
      state.sessions = state.sessions.filter(session => !session.revokedAt && session.expiresAt > now);
      state.deviceGrants = state.deviceGrants?.filter(grant => !grant.usedAt && !grant.cancelledAt && grant.expiresAt > now);
      await mutator(state); await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 }); await rename(temp, this.path); result = state;
    });
    this.queue = operation.catch(() => undefined);
    await operation; return result;
  }
}

function cookies(req: IncomingMessage) {
  const result: Record<string, string> = {};
  for (const value of (req.headers.cookie || "").split(";")) {
    const [key, encoded] = value.trim().split(/=(.*)/s);
    if (!key) continue;
    try { result[key] = decodeURIComponent(encoded || ""); } catch { /* Ignore malformed cookies. */ }
  }
  return result;
}
export type AuthVia = "session" | "token" | "legacy" | "open";
export type GateResult = { ok: true; identity: Identity; via: AuthVia; sessionHash?: string } | { ok: false };

export class AuthKernel {
  private wsTickets = new Map<string, { identity: Identity; expiresAt: number }>();
  constructor(readonly mode: AuthMode, readonly store: AuthStore, readonly legacyToken = "", readonly secureCookie = true, readonly trustedHeader = "") {}
  mintWsTicket(identity: Identity) { const now = Date.now(); for (const [key, ticket] of this.wsTickets) if (ticket.expiresAt <= now) this.wsTickets.delete(key); while (this.wsTickets.size >= 256) this.wsTickets.delete(this.wsTickets.keys().next().value!); const secret = randomSecret(); this.wsTickets.set(hashSecret(secret), { identity, expiresAt: now + 30_000 }); return secret; }
  redeemWsTicket(secret: string) { const key = hashSecret(secret), ticket = this.wsTickets.get(key); this.wsTickets.delete(key); return ticket && ticket.expiresAt > Date.now() ? ticket.identity : undefined; }
  async gate(req: IncomingMessage): Promise<GateResult> {
    if (this.mode === "none") return { ok: true, identity: { id: "none" }, via: "open" };
    if (this.mode === "external") {
      if (!this.trustedHeader) return { ok: true, identity: { id: "external" }, via: "open" };
      const value = req.headers[this.trustedHeader.toLowerCase()];
      const user = (Array.isArray(value) ? value[0] : value)?.trim();
      return user ? { ok: true, identity: { id: `external:${user}`, displayName: user }, via: "open" } : { ok: false };
    }
    const state = await this.store.read(); const now = Date.now(); const raw = cookies(req)[SESSION_COOKIE];
    if (raw) {
      const record = state.sessions.find(s => safeEqual(s.hash, hashSecret(raw)) && !s.revokedAt && s.expiresAt > now);
      if (record) { if (now - record.lastSeenAt > 300_000) void this.store.update(s => { const found = s.sessions.find(x => x.hash === record.hash); if (found) found.lastSeenAt = now; }).catch(() => undefined); return { ok: true, identity: record.identity, via: "session", sessionHash: record.hash }; }
    }
    const auth = req.headers.authorization || "";
    if (this.mode === "legacy") {
      if (!this.legacyToken) return { ok: true, identity: { id: "legacy:open" }, via: "open" };
      const query = new URL(req.url || "/", "http://localhost").searchParams.get("token") || "";
      const supplied = auth.startsWith("Bearer ") ? auth.slice(7) : query;
      return safeEqual(supplied, this.legacyToken) ? { ok: true, identity: { id: "legacy:token" }, via: "legacy" } : { ok: false };
    }
    if (auth.startsWith("Bearer ")) {
      const hash = hashSecret(auth.slice(7)); const api = state.apiTokens.find(t => safeEqual(t.hash, hash) && !t.revokedAt && t.expiresAt > now);
      if (api) return { ok: true, identity: { id: `token:${api.id}`, displayName: api.name }, via: "token" };
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
