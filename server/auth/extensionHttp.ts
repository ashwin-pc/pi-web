import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { PiWebHttpClient, PiWebHttpClientOptions, PiWebHttpScope } from "../../src/extensionHttp.js";
import type { GateResult } from "./kernel.js";

const SCHEME = "PiWebExtension";
const TTL = 5 * 60_000;
const scopes = new Set<PiWebHttpScope>(["sessions.read", "sessions.create", "sessions.write", "sessions.delete"]);
const routes: Readonly<Record<string, PiWebHttpScope>> = Object.freeze({
  "GET /api/state": "sessions.read",
  "GET /api/messages": "sessions.read",
  "GET /api/models": "sessions.read",
  "POST /api/new-chat": "sessions.create",
  "POST /api/sessions/new": "sessions.create",
  "POST /api/prompt": "sessions.write",
  "POST /api/abort": "sessions.write",
  "POST /api/session/name": "sessions.write",
  "POST /api/model": "sessions.write",
  "POST /api/session-ui-state/read": "sessions.write",
  "POST /api/sessions/delete": "sessions.delete",
});
const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");
const validId = (id: unknown): id is string => typeof id === "string" && !!id && id.length <= 256 && id.trim() === id;

export function hasExtensionCredential(req: Pick<IncomingMessage, "headers">): boolean {
  return /^PiWebExtension(?:\s|$)/i.test(req.headers.authorization || "");
}

function relativeUrl(path: string): URL {
  // Never resolve arbitrary URLs, backslashes, encoded path separators or dot segments.
  if (!/^\/api\/[a-zA-Z0-9/-]+(?:\?[^#]*)?$/.test(path) || path.includes("\\") || path.includes("/../") || path.includes("/./")) {
    throw new TypeError("Extension API requires an unambiguous relative /api/ path");
  }
  return new URL(path, "http://extension.invalid");
}

type ClientRecord = {
  name: string;
  ownerSessionId: string;
  owner: object;
  scopes: Set<PiWebHttpScope>;
  targets: Set<string> | "all";
  active(): boolean;
  abort: AbortController;
};
type Credential = { client: ClientRecord; expiresAt: number };

/** In-memory, instance-local grants. Not user API tokens, browser sessions, or a sandbox.
 * Credentials can be issued only by the trusted runtime bridge, never an HTTP route.
 */
export class ExtensionHttpRegistry {
  private credentials = new Map<string, Credential>();
  private clients = new Set<ClientRecord>();
  private authorized = new WeakMap<IncomingMessage, ClientRecord>();

  constructor(private readonly deps: {
    origin(): string;
    readBody(req: IncomingMessage): Promise<unknown>;
    now?: () => number;
    fetch?: typeof fetch;
  }) {}

  private now() { return this.deps.now?.() ?? Date.now(); }
  private live(client: ClientRecord) { return !client.abort.signal.aborted && client.active(); }
  private sweep() {
    for (const client of this.clients) if (!this.live(client)) this.disposeClient(client);
    for (const [key, record] of this.credentials) {
      if (record.expiresAt <= this.now()) this.credentials.delete(key);
    }
  }
  private disposeClient(client: ClientRecord) {
    client.abort.abort();
    this.clients.delete(client);
    for (const [key, record] of this.credentials) if (record.client === client) this.credentials.delete(key);
  }
  revokeOwner(owner: object) {
    for (const client of this.clients) if (client.owner === owner) this.disposeClient(client);
  }

  createClient(owner: object, ownerSessionId: string, active: () => boolean, options: PiWebHttpClientOptions): PiWebHttpClient {
    this.sweep();
    if (!active()) throw new Error("Extension runtime is no longer active");
    if (!validId(ownerSessionId) || !/^[a-zA-Z0-9._-]{1,100}$/.test(options.name)) throw new TypeError("Invalid extension client identity");
    if (!Array.isArray(options.scopes) || !options.scopes.length || options.scopes.some(s => !scopes.has(s))) throw new TypeError("Unknown or missing extension API scope");
    if (options.sessionIds !== undefined && options.sessionIds !== "all" && (!Array.isArray(options.sessionIds) || options.sessionIds.length > 256 || options.sessionIds.some(id => !validId(id)))) throw new TypeError("Invalid extension session targets");
    if (this.clients.size >= 1024 || [...this.clients].filter(c => c.owner === owner).length >= 32) throw new Error("Extension API client limit reached");
    const client: ClientRecord = {
      name: options.name, ownerSessionId, owner, active,
      scopes: new Set(options.scopes),
      targets: options.sessionIds === "all" ? "all" : new Set([ownerSessionId, ...options.sessionIds || []]),
      abort: new AbortController(),
    };
    this.clients.add(client);
    let credential: { secret: string; expiresAt: number } | undefined;
    return Object.freeze({
      dispose: () => this.disposeClient(client),
      request: async (method: "GET" | "POST", path: string, input?: { body?: Record<string, unknown>; signal?: AbortSignal }) => {
        this.sweep();
        if (!this.live(client)) throw new Error("Extension API client has been disposed");
        const url = relativeUrl(path);
        const scope = routes[`${method} ${url.pathname}`];
        if (!scope || !client.scopes.has(scope)) throw new Error("Extension API scope does not permit this route");
        const body = input?.body === undefined ? {} : JSON.parse(JSON.stringify(input.body)) as Record<string, unknown>;
        if (method === "GET") {
          if (input?.body !== undefined) throw new TypeError("GET requests cannot have a body");
          if (!url.searchParams.has("sessionId")) url.searchParams.set("sessionId", ownerSessionId);
        } else if (body.sessionId === undefined) body.sessionId = ownerSessionId;
        this.validateTarget(client, method, url, body);
        if (!credential || credential.expiresAt - this.now() < 30_000) {
          // Older tokens remain valid until their short expiry for concurrent requests.
          const secret = randomBytes(32).toString("base64url");
          credential = { secret, expiresAt: this.now() + TTL };
          this.credentials.set(hash(secret), { client, expiresAt: credential.expiresAt });
        }
        const base = new URL(this.deps.origin());
        if (base.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(base.hostname) || base.username || base.password) throw new Error("Extension API transport must target the local application server");
        const signals = [client.abort.signal, AbortSignal.timeout(20_000), ...(input?.signal ? [input.signal] : [])];
        return (this.deps.fetch || fetch)(new URL(url.pathname + url.search, base), {
          method, redirect: "error", credentials: "omit", signal: AbortSignal.any(signals),
          headers: { Authorization: `${SCHEME} ${credential.secret}`, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
          ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
        });
      },
    });
  }

  private validateTarget(client: ClientRecord, method: string, url: URL, body: unknown) {
    const value = body as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request body");
    // Explicit sessionId only: never fall back to the browser's currently active session.
    const ids = url.searchParams.getAll("sessionId");
    const id = method === "GET" ? ids[0] : value.sessionId;
    if ((method === "GET" && ids.length !== 1) || (method === "POST" && ids.length) || !validId(id) || value.id && url.pathname === "/api/sessions/delete") throw new Error("Unambiguous sessionId is required");
    if (client.targets !== "all" && !client.targets.has(id)) throw new Error("Session is outside this extension client's targets");
    if (value.origin !== undefined) {
      const origin = value.origin as Record<string, unknown>;
      if (!origin || origin.sessionId !== client.ownerSessionId) throw new Error("Session origin must identify the calling agent session");
    }
  }

  async authenticate(req: IncomingMessage): Promise<GateResult> {
    this.sweep();
    const match = /^PiWebExtension ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || "");
    const credential = match && this.credentials.get(hash(match[1]));
    if (!credential || !this.live(credential.client)) return { ok: false };
    try {
      const url = relativeUrl(req.url || "");
      const scope = routes[`${req.method} ${url.pathname}`];
      if (!scope || !credential.client.scopes.has(scope)) return { ok: false, status: 403 };
      if (scope === "sessions.create" && credential.client.targets !== "all" && credential.client.targets.size >= 4096) return { ok: false, status: 403 };
      const body = req.method === "GET" ? {} : await this.deps.readBody(req);
      this.validateTarget(credential.client, req.method || "", url, body);
      // Recheck after reading an asynchronous request body.
      if (credential.expiresAt <= this.now() || !this.live(credential.client)) return { ok: false };
      this.authorized.set(req, credential.client);
      return { ok: true, via: "extension", identity: { id: `extension:${credential.client.ownerSessionId}:${credential.client.name}` } };
    } catch { return { ok: false, status: 403 }; }
  }

  caller(req: IncomingMessage): string | undefined {
    const client = this.authorized.get(req);
    return client ? `extension:${client.ownerSessionId}:${client.name}` : undefined;
  }

  recordCreatedSession(req: IncomingMessage, id: string) {
    const client = this.authorized.get(req);
    if (client && this.live(client) && client.targets !== "all") client.targets.add(id);
  }
}
