import {
  createHash,
  randomBytes,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from "node:crypto";
import type { AccessPolicy, HumanAuthMethod } from "./config.js";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

export type AuthMode = "none" | "legacy" | "passkey" | "external";
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
  verifiedMethods?: HumanAuthMethod[];
  version: 1;
  credentials: CredentialRecord[];
  sessions: SessionRecord[];
  apiTokens: ApiTokenRecord[];
  password?: PasswordRecord;
  bootstrap?: BootstrapRecord;
  deviceGrants?: DeviceGrantRecord[];
};

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
let passwordWorkActive = false;
const scrypt = (
  password: string,
  salt: Buffer,
  length: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    if (passwordWorkActive) {
      reject(new Error("Password verification busy; retry shortly"));
      return;
    }
    passwordWorkActive = true;
    try {
      nodeScrypt(
        password,
        salt,
        length,
        { ...options, maxmem: 160 * 1024 * 1024 },
        (error, key) => {
          passwordWorkActive = false;
          error ? reject(error) : resolve(key);
        },
      );
    } catch (error) {
      passwordWorkActive = false;
      reject(error);
    }
  });
export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, 64, {
    N: 32768,
    r: 8,
    p: 1,
  })) as Buffer;
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
  try {
    const actual = (await scrypt(
      password,
      Buffer.from(salt, "base64url"),
      Buffer.from(expected, "base64url").length,
      { N: Number(n), r: Number(r), p: Number(p) },
    )) as Buffer;
    return safeEqual(actual.toString("base64url"), expected);
  } catch {
    return false;
  }
}

/** Serialize reapers so a second reaper cannot unlink a newly acquired lock.
 * Missing/malformed owner metadata and EPERM are deliberately not evidence of death.
 * A crash during recovery itself requires operator cleanup of .recovery. */
async function recoverDeadLock(path: string) {
  let guard: Awaited<ReturnType<typeof open>>;
  try {
    guard = await open(`${path}.recovery`, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
  try {
    let pid: unknown;
    try {
      pid = JSON.parse(await readFile(path, "utf8")).pid;
    } catch {
      return;
    }
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0)
      return;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH")
        await unlink(path).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
    }
  } finally {
    await guard.close();
    await unlink(`${path}.recovery`);
  }
}

export class AuthStore {
  private queue = Promise.resolve();
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
    mutator: (state: AuthState) => void | Promise<void>,
  ): Promise<AuthState> {
    let result!: AuthState;
    const operation = this.queue
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        const lockPath = `${this.path}.lock`;
        let lock: Awaited<ReturnType<typeof open>> | undefined;
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            lock = await open(lockPath, "wx", 0o600);
            await lock.writeFile(JSON.stringify({ pid: process.pid }));
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            await recoverDeadLock(lockPath);
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
        if (!lock)
          throw new Error(
            `Auth store is locked: ${lockPath}. If a writer crashed, stop writers before removing the lock.`,
          );
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
          await mutator(state);
          await mkdir(dirname(this.path), { recursive: true });
          const temp = `${this.path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
          await writeFile(temp, JSON.stringify(state, null, 2), {
            mode: 0o600,
          });
          await rename(temp, this.path);
          result = state;
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
          await lock.close();
          await unlink(lockPath);
        }
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
export type AuthVia = "session" | "token" | "legacy" | "external" | "open";
export type GateResult =
  | { ok: true; identity: Identity; via: AuthVia; sessionHash?: string }
  | { ok: false };

export class AuthKernel {
  private wsTickets = new Map<
    string,
    { identity: Identity; expiresAt: number; sessionHash?: string }
  >();
  policy: AccessPolicy;
  methods: ReadonlySet<HumanAuthMethod>;
  async refreshConfig() {
    const state = await this.store.read();
    if (state.config) {
      this.policy = state.config.policy;
      this.methods = new Set(state.config.methods);
    }
  }
  methodReady(method: HumanAuthMethod, state: AuthState) {
    return method === "password"
      ? !!state.password
      : method === "passkey"
        ? state.credentials.some((c) => !c.revokedAt)
        : method === "legacy"
          ? !!this.legacyToken
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
        "Auth environment/store disagreement: saved store policy and methods take precedence. Environment changes do not restore retired methods; use Settings or terminal recovery.",
      );
    await this.refreshConfig();
    if (this.policy === "authenticated" && !(await this.readyMethods()).length)
      warn(
        "No usable login method; run pi-web auth bootstrap, configure credentials, or deliberately set PI_WEB_AUTH_POLICY=open on an unconfigured store. Saved store policy takes precedence.",
      );
  }
  async configure(methods: HumanAuthMethod[]) {
    await this.store.update((state) => {
      state.config = { policy: this.policy, methods };
    });
    await this.refreshConfig();
  }
  async revokeSession(req: IncomingMessage) {
    const raw = cookies(req)[SESSION_COOKIE];
    if (raw)
      await this.store.update((state) => {
        const session = state.sessions.find((s) => s.hash === hashSecret(raw));
        if (session) session.revokedAt = Date.now();
      });
  }

  constructor(
    readonly mode: AuthMode,
    readonly store: AuthStore,
    readonly legacyToken = "",
    readonly secureCookie = true,
    readonly trustedHeader = "",
    policy?: AccessPolicy,
    methods?: HumanAuthMethod[],
  ) {
    this.policy = policy || (mode === "none" ? "open" : "authenticated");
    this.methods = new Set(methods || (mode === "none" ? [] : [mode]));
  }
  mintWsTicket(identity: Identity, sessionHash?: string) {
    const now = Date.now();
    for (const [key, ticket] of this.wsTickets)
      if (ticket.expiresAt <= now) this.wsTickets.delete(key);
    while (this.wsTickets.size >= 256)
      this.wsTickets.delete(this.wsTickets.keys().next().value!);
    const secret = randomSecret();
    this.wsTickets.set(hashSecret(secret), {
      identity,
      sessionHash,
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
    const state = await this.store.read();
    const now = Date.now();
    const raw = cookies(req)[SESSION_COOKIE];
    if (raw) {
      const record = state.sessions.find(
        (s) =>
          safeEqual(s.hash, hashSecret(raw)) &&
          !s.revokedAt &&
          s.expiresAt > now,
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
        };
      }
      // A revoked browser must explicitly sign in again, not silently re-exchange ambient credentials.
      return { ok: false };
    }
    const auth = req.headers.authorization || "";
    if (this.methods.has("legacy") && this.legacyToken) {
      const query =
        new URL(req.url || "/", "http://localhost").searchParams.get("token") ||
        "";
      const supplied = auth.startsWith("Bearer ") ? auth.slice(7) : query;
      if (safeEqual(supplied, this.legacyToken))
        return { ok: true, identity: { id: "legacy:token" }, via: "legacy" };
    }
    if (this.methods.has("external") && this.trustedHeader) {
      const value = req.headers[this.trustedHeader.toLowerCase()];
      const user = (Array.isArray(value) ? value[0] : value)?.trim();
      if (user)
        return {
          ok: true,
          identity: { id: `external:${user}`, displayName: user },
          via: "external",
        };
    }
    if (auth.startsWith("Bearer ")) {
      const hash = hashSecret(auth.slice(7));
      const api = state.apiTokens.find(
        (t) => safeEqual(t.hash, hash) && !t.revokedAt && t.expiresAt > now,
      );
      if (api)
        return {
          ok: true,
          identity: { id: `token:${api.id}`, displayName: api.name },
          via: "token",
        };
    }
    return this.policy === "open"
      ? { ok: true, identity: { id: "none" }, via: "open" }
      : { ok: false };
  }
  async establishSession(
    res: ServerResponse,
    identity: Identity,
    method?: HumanAuthMethod | "grant",
    req?: IncomingMessage,
    verified = true,
    credential?: { passwordHash?: string; passkeyId?: string },
  ) {
    const raw = randomBytes(32).toString("base64url"),
      now = Date.now();
    const device = req?.headers["user-agent"]?.slice(0, 200),
      ip = req?.socket?.remoteAddress;
    if (!method) {
      const prefix = identity.id.split(":")[0];
      if (["legacy", "passkey", "password", "external"].includes(prefix))
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
    res.setHeader(
      "set-cookie",
      `${SESSION_COOKIE}=${raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${this.secureCookie ? "; Secure" : ""}`,
    );
  }
  clearSession(res: ServerResponse) {
    res.setHeader(
      "set-cookie",
      `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${this.secureCookie ? "; Secure" : ""}`,
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
