import {
  createHash,
  randomBytes,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from "node:crypto";
import type { AccessPolicy, HumanAuthMethod } from "./config.js";
import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  PasswordWorkUnavailableError,
  runPasswordWork,
} from "./passwordWork.js";
import {
  acquireAuthStoreLock,
  releaseAuthStoreLock,
} from "./storeLock.js";

export type AuthMode = "none" | "passkey" | "external";
export type Identity = { id: string; displayName?: string };
export type CredentialRecord = {
  id: string;
  publicKey: string;
  counter: number;
  transports?: string[];
  name: string;
  createdAt: number;
  revokedAt?: number;
};
export type SessionRecord = {
  hash: string;
  identity: Identity;
  method?: HumanAuthMethod | "grant";
  device?: string;
  authenticatedAt?: number;
  ip?: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  revokedAt?: number;
};
export type PasswordRecord = { hash: string; changedAt: number };
export type ApiTokenRecord = {
  id: string;
  name: string;
  hash: string;
  createdAt: number;
  expiresAt: number;
  revokedAt?: number;
};
export type BootstrapRecord = {
  hash: string;
  expiresAt: number;
  usedAt?: number;
};
export type DeviceGrantRecord = {
  id: string;
  hash: string;
  createdAt: number;
  expiresAt: number;
  createdBy: Identity;
  createdBySessionHash: string;
  usedAt?: number;
  cancelledAt?: number;
};
export type AuthState = {
  config?: { policy: AccessPolicy; methods: HumanAuthMethod[] };
  revocationEpoch?: number;
  verifiedMethods?: HumanAuthMethod[];
  version: 1;
  credentials: CredentialRecord[];
  sessions: SessionRecord[];
  apiTokens: ApiTokenRecord[];
  password?: PasswordRecord;
  bootstrap?: BootstrapRecord;
  deviceGrants?: DeviceGrantRecord[];
};

export function isLegacySession(
  session: Pick<SessionRecord, "method" | "identity">,
) {
  return (session.method as string | undefined) === "legacy" ||
    session.identity.id === "legacy:token";
}

const EMPTY: AuthState = {
  version: 1,
  credentials: [],
  sessions: [],
  apiTokens: [],
};
const DAY = 86_400_000;
export const SESSION_COOKIE = "pi_web_session";
export const hashSecret = (value: string) =>
  createHash("sha256").update(value).digest("base64url");
const safeEqual = (a: string, b: string) => {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
};
const scrypt = (
  password: string,
  salt: Buffer,
  length: number,
  options: { N: number; r: number; p: number },
  lane: "login" | "credential",
): Promise<Buffer> =>
  runPasswordWork(
    lane,
    () =>
      new Promise((resolve, reject) => {
        nodeScrypt(
          password,
          salt,
          length,
          { ...options, maxmem: 160 * 1024 * 1024 },
          (error, key) => (error ? reject(error) : resolve(key)),
        );
      }),
  );
export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, 64, {
    N: 32768,
    r: 8,
    p: 1,
  }, "credential")) as Buffer;
  return `scrypt$32768$8$1$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}
export async function verifyPassword(password: string, encoded: string) {
  const [kind, n, r, p, salt, expected] = encoded.split("$");
  if (
    kind !== "scrypt" ||
    !salt ||
    !expected ||
    ![32768, 65536, 131072].includes(Number(n)) ||
    r !== "8" ||
    p !== "1" ||
    Buffer.from(expected, "base64url").length !== 64
  )
    return false;
  const actual = (await scrypt(
    password,
    Buffer.from(salt, "base64url"),
    Buffer.from(expected, "base64url").length,
    { N: Number(n), r: Number(r), p: Number(p) },
    "login",
  )) as Buffer;
  return safeEqual(actual.toString("base64url"), expected);
}

export class AuthStoreBusyError extends Error {
  readonly status = 503;
  constructor(message = "Auth store busy; retry shortly") {
    super(message);
    this.name = "AuthStoreBusyError";
  }
}

export class AuthStore {
  private queue = Promise.resolve();
  private pendingUpdates = 0;
  readonly listeners = new Set<(state: AuthState) => void>();
  constructor(readonly path: string) {}
  async read(): Promise<AuthState> {
    try {
      return {
        ...structuredClone(EMPTY),
        ...JSON.parse(await readFile(this.path, "utf8")),
      } as AuthState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return structuredClone(EMPTY);
      throw error;
    }
  }
  async update(
    mutator: (state: AuthState) => void | false | Promise<void | false>,
  ): Promise<AuthState> {
    if (this.pendingUpdates >= 64) throw new AuthStoreBusyError();
    this.pendingUpdates++;
    let result!: AuthState;
    const operation = this.queue
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        const lockPath = `${this.path}.lock`;
        let lock;
        try {
          lock = await acquireAuthStoreLock(lockPath);
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === `Auth store is locked: ${lockPath}`
          )
            throw new AuthStoreBusyError(error.message);
          throw error;
        }
        try {
          const state = await this.read();
          const now = Date.now();
          state.sessions = state.sessions.filter(
            (session) => !session.revokedAt && session.expiresAt > now,
          );
          state.deviceGrants = state.deviceGrants?.filter(
            (grant) =>
              !grant.usedAt && !grant.cancelledAt && grant.expiresAt > now,
          );
          const changed = await mutator(state);
          result = state;
          if (changed === false) return;
          await mkdir(dirname(this.path), { recursive: true });
          const temp = `${this.path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
          await writeFile(temp, JSON.stringify(state, null, 2), {
            mode: 0o600,
          });
          await rename(temp, this.path);
          for (const listener of this.listeners) {
            try {
              listener(state);
            } catch (error) {
              console.error(
                "Auth store listener failed after committed write",
                error,
              );
            }
          }
        } finally {
          await releaseAuthStoreLock(lock);
        }
      })
      .finally(() => {
        this.pendingUpdates--;
      });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }
}

function cookies(req: IncomingMessage) {
  const result: Record<string, string> = {};
  for (const value of (req.headers.cookie || "").split(";")) {
    const [key, encoded] = value.trim().split(/=(.*)/s);
    if (!key) continue;
    try {
      result[key] = decodeURIComponent(encoded || "");
    } catch {
      /* Ignore malformed cookies. */
    }
  }
  return result;
}
export type AuthVia = "session" | "token" | "external" | "open" | "extension";
export type GateResult =
  | {
      ok: true;
      identity: Identity;
      via: AuthVia;
      sessionHash?: string;
      revocationEpoch?: number;
    }
  | { ok: false; status?: 401 | 403 };

export type WsTicket = {
  identity: Identity;
  via: AuthVia;
  expiresAt: number;
  sessionHash?: string;
  revocationEpoch: number;
};

export function bumpRevocationEpoch(state: AuthState): void {
  state.revocationEpoch = (state.revocationEpoch || 0) + 1;
}

export class AuthKernel {
  private wsTickets = new Map<string, WsTicket>();
  private readonly configuredPolicy: AccessPolicy;
  policy: AccessPolicy;
  methods: ReadonlySet<HumanAuthMethod>;
  effectivePolicy(saved?: AccessPolicy) {
    return this.configuredPolicy === "authenticated" || saved === "authenticated"
      ? "authenticated"
      : "open";
  }
  async refreshConfig() {
    const state = await this.store.read();
    if (state.config) {
      if ((state.config.methods as string[]).includes("legacy"))
        throw new Error(
          "Saved authentication settings still enable removed legacy token authentication. Run `pi-web auth recover` to migrate the store and create a one-time password/passkey setup URL.",
        );
      this.policy = this.effectivePolicy(state.config.policy);
      this.methods = new Set(state.config.methods);
    }
  }
  methodReady(method: HumanAuthMethod, state: AuthState) {
    return method === "password"
      ? !!state.password
      : method === "passkey"
        ? state.credentials.some((c) => !c.revokedAt)
        : !!this.trustedHeader;
  }
  async readyMethods() {
    const state = await this.store.read();
    return [...this.methods].filter((method) =>
      this.methodReady(method, state),
    );
  }
  async startupDiagnostics(warn: (message: string) => void = console.warn) {
    const state = await this.store.read();
    if (
      state.config &&
      (state.config.policy !== this.policy ||
        [...this.methods].sort().join() !==
          [...state.config.methods].sort().join())
    )
      warn(
        `Auth environment/store disagreement. Authenticated policy is fail-closed and takes precedence; saved methods remain authoritative. Policy env=${this.policy}, saved=${state.config.policy}; environment-only methods=[${[...this.methods].filter(m => !state.config!.methods.includes(m)).join(", ")}]; store-only methods=[${state.config.methods.filter(m => !this.methods.has(m)).join(", ")}]. Use Settings or terminal recovery to change saved methods.`,
      );
    await this.refreshConfig();
    if (this.policy === "authenticated" && !(await this.readyMethods()).length)
      warn(
        "No usable login method; run pi-web auth bootstrap, configure credentials, or deliberately set PI_WEB_AUTH_POLICY=open on an unconfigured store. Saved store methods remain authoritative.",
      );
    if (this.policy === "open" && this.methods.size)
      warn(
        `Auth policy is "open" while login methods are enabled (${[...this.methods].join(", ")}). Requests are not required to authenticate; set PI_WEB_AUTH_POLICY=authenticated or clear the methods.`,
      );
  }
  configurationPolicy(saved?: AccessPolicy): AccessPolicy {
    return saved ?? (this.explicitOpenPolicy ? "open" : "authenticated");
  }
  async configure(methods: HumanAuthMethod[]) {
    await this.store.update((state) => {
      state.config = {
        policy: this.configurationPolicy(state.config?.policy),
        methods,
      };
    });
    await this.refreshConfig();
  }
  async revokeSession(req: IncomingMessage): Promise<boolean> {
    const raw = cookies(req)[SESSION_COOKIE];
    if (!raw) return false;
    const hash = hashSecret(raw);
    const now = Date.now();
    if (
      !(await this.store.read()).sessions.some(
        (session) =>
          session.hash === hash &&
          !session.revokedAt &&
          session.expiresAt > now,
      )
    )
      return false;
    let revoked = false;
    await this.store.update((state) => {
      const session = state.sessions.find(
        (candidate) =>
          candidate.hash === hash &&
          !candidate.revokedAt &&
          candidate.expiresAt > Date.now(),
      );
      if (!session) return false;
      session.revokedAt = Date.now();
      revoked = true;
    });
    return revoked;
  }

  constructor(
    readonly mode: AuthMode,
    readonly store: AuthStore,
    readonly secureCookie: boolean | ((req?: IncomingMessage) => boolean) = true,
    readonly trustedHeader = "",
    policy?: AccessPolicy,
    methods?: HumanAuthMethod[],
    private readonly extensionResolver?: (req: IncomingMessage) => Promise<GateResult>,
    private readonly explicitOpenPolicy = false,
  ) {
    this.configuredPolicy =
      policy || (mode === "none" ? "open" : "authenticated");
    this.policy = this.configuredPolicy;
    this.methods = new Set(methods || (mode === "none" ? [] : [mode]));
  }
  mintWsTicket(auth: Extract<GateResult, { ok: true }>) {
    const now = Date.now();
    for (const [key, ticket] of this.wsTickets)
      if (ticket.expiresAt <= now) this.wsTickets.delete(key);
    while (this.wsTickets.size >= 256)
      this.wsTickets.delete(this.wsTickets.keys().next().value!);
    const secret = randomSecret();
    this.wsTickets.set(hashSecret(secret), {
      identity: auth.identity,
      via: auth.via,
      sessionHash: auth.sessionHash,
      revocationEpoch: auth.revocationEpoch || 0,
      expiresAt: now + 30_000,
    });
    return secret;
  }
  redeemWsTicket(secret: string) {
    const key = hashSecret(secret),
      ticket = this.wsTickets.get(key);
    this.wsTickets.delete(key);
    return ticket && ticket.expiresAt > Date.now() ? ticket : undefined;
  }
  async gate(req: IncomingMessage): Promise<GateResult> {
    // Reserved credential class: never fall through to open/browser/machine auth.
    if (/^PiWebExtension(?:\s|$)/i.test(req.headers.authorization || "")) {
      try {
        const extension = await this.extensionResolver?.(req);
        if (!extension?.ok) return extension || { ok: false };
        const state = await this.store.read();
        return {
          ...extension,
          revocationEpoch: state.revocationEpoch || 0,
        };
      } catch { return { ok: false }; }
    }
    const state = await this.store.read();
    // Credential and policy decisions use one snapshot, never a stale refresh
    // that could restore retired authority during concurrent configuration changes.
    const methods = new Set(state.config?.methods || this.methods);
    const policy = this.effectivePolicy(state.config?.policy);
    const revocationEpoch = state.revocationEpoch || 0;
    const now = Date.now();
    const raw = cookies(req)[SESSION_COOKIE];
    if (raw) {
      const record = state.sessions.find(
        (s) =>
          safeEqual(s.hash, hashSecret(raw)) &&
          !s.revokedAt &&
          s.expiresAt > now &&
          !isLegacySession(s),
      );
      if (record) {
        if (now - record.lastSeenAt > 300_000)
          void this.store
            .update((s) => {
              const found = s.sessions.find((x) => x.hash === record.hash);
              if (found) found.lastSeenAt = now;
            })
            .catch(() => undefined);
        return {
          ok: true,
          identity: record.identity,
          via: "session",
          sessionHash: record.hash,
          revocationEpoch,
        };
      }
      // A revoked browser must explicitly sign in again, not silently re-exchange ambient credentials.
      return { ok: false };
    }
    const auth = req.headers.authorization || "";
    if (auth.startsWith("Bearer ")) {
      const hash = hashSecret(auth.slice(7));
      const api = state.apiTokens.find(
        (t) => safeEqual(t.hash, hash) && !t.revokedAt && t.expiresAt > now,
      );
      return api
        ? {
            ok: true,
            identity: { id: `token:${api.id}`, displayName: api.name },
            via: "token",
            revocationEpoch,
          }
        : { ok: false };
    }
    if (methods.has("external") && this.trustedHeader) {
      const value = req.headers[this.trustedHeader.toLowerCase()];
      const user = (Array.isArray(value) ? value[0] : value)?.trim();
      if (user)
        return {
          ok: true,
          identity: { id: `external:${user}`, displayName: user },
          via: "external",
          revocationEpoch,
        };
    }
    return policy === "open"
      ? {
          ok: true,
          identity: { id: "none" },
          via: "open",
          revocationEpoch,
        }
      : { ok: false };
  }
  async establishSession(
    res: ServerResponse,
    identity: Identity,
    method?: HumanAuthMethod | "grant",
    req?: IncomingMessage,
    verified = true,
    credential?: { passwordHash?: string; passkeyId?: string; grantHash?: string },
  ) {
    const raw = randomBytes(32).toString("base64url"),
      now = Date.now();
    const device = req?.headers["user-agent"]?.slice(0, 200),
      ip = req?.socket?.remoteAddress;
    if (!method) {
      const prefix = identity.id.split(":")[0];
      if (["passkey", "password", "external"].includes(prefix))
        method = prefix as HumanAuthMethod;
    }
    await this.store.update((s) => {
      if (
        verified &&
        method &&
        method !== "grant" &&
        !(s.config?.methods || [...this.methods]).includes(method)
      )
        throw new Error("Authentication method disabled");
      if (
        credential?.passwordHash &&
        s.password?.hash !== credential.passwordHash
      )
        throw new Error("Password changed; sign in again");
      if (
        credential?.passkeyId &&
        !s.credentials.some(
          (c) => c.id === credential.passkeyId && !c.revokedAt,
        )
      )
        throw new Error("Passkey revoked; sign in again");
      if (method === "grant" && credential?.grantHash) {
        const grant = s.deviceGrants?.find(g => g.hash === credential?.grantHash && !g.usedAt && !g.cancelledAt && g.expiresAt > now);
        if (!grant || !s.sessions.some(session => session.hash === grant.createdBySessionHash && !session.revokedAt && session.expiresAt > now && !isLegacySession(session)))
          throw new Error("Invalid or expired device grant");
        grant.usedAt = now;
        identity = grant.createdBy;
      }
      const previous = req && cookies(req)[SESSION_COOKIE];
      if (previous) {
        const old = s.sessions.find(
          (session) => session.hash === hashSecret(previous),
        );
        if (old) old.revokedAt = now;
      }
      if (method && method !== "grant" && verified)
        s.verifiedMethods = [
          ...new Set([...(s.verifiedMethods || []), method]),
        ];
      s.sessions.push({
        hash: hashSecret(raw),
        identity,
        method,
        authenticatedAt: verified && method !== "grant" ? now : undefined,
        device,
        ip,
        createdAt: now,
        lastSeenAt: now,
        expiresAt: now + 30 * DAY,
      });
    });
    const secure = typeof this.secureCookie === "function"
      ? this.secureCookie(req)
      : this.secureCookie;
    res.setHeader(
      "set-cookie",
      `${SESSION_COOKIE}=${raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secure ? "; Secure" : ""}`,
    );
  }
  clearSession(res: ServerResponse, req?: IncomingMessage) {
    const secure = typeof this.secureCookie === "function"
      ? this.secureCookie(req)
      : this.secureCookie;
    res.setHeader(
      "set-cookie",
      `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`,
    );
  }
}

export function isLoopback(req: IncomingMessage) {
  const ip = req.socket.remoteAddress || "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}
export function randomSecret() {
  return randomBytes(32).toString("base64url");
}

export { PasswordWorkUnavailableError };
