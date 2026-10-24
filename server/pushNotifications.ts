import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname } from "node:path";
import webPush, { type PushSubscription } from "web-push";

// Upper bounds for the three attacker-controlled subscription fields. Real
// Web Push endpoints and keys sit well below these limits (FCM/Mozilla/WNS
// endpoints are ~200 chars; p256dh is 88 chars base64url; auth is 24 chars
// base64url). The bounds exist to stop a caller stuffing arbitrary data into
// the on-disk push state file via /api/push/subscribe.
const MAX_ENDPOINT_LENGTH = 2048;
const MAX_P256DH_LENGTH = 256;
const MAX_AUTH_LENGTH = 128;

type StoredSubscription = {
  id: string;
  installationId: string;
  subscription: PushSubscription;
  createdAt: string;
  updatedAt: string;
};

type PushState = {
  version: 1;
  vapid: { publicKey: string; privateKey: string };
  subscriptions: StoredSubscription[];
};

export type RunCompletedNotification = {
  sessionId: string;
  title: string;
  completedAt: string;
};

function subscriptionId(endpoint: string) {
  return createHash("sha256").update(endpoint).digest("hex").slice(0, 24);
}

function isForbiddenIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split(".").map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    const [a, b] = parts;
    if (a === 0) return true;                      // 0.0.0.0/8
    if (a === 10) return true;                     // 10/8 private
    if (a === 127) return true;                    // 127/8 loopback
    if (a === 169 && b === 254) return true;       // 169.254/16 link-local + AWS/GCP metadata (169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
    if (a === 192 && b === 168) return true;       // 192.168/16 private
    if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0/24 IETF
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
    if (a >= 224) return true;                     // multicast / reserved
    return false;
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    if (normalized === "::" || normalized === "::1") return true; // unspecified + loopback
    if (normalized.startsWith("fe80:") || normalized.startsWith("fe80::")) return true; // link-local
    if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true; // fc00::/7 unique-local
    if (normalized.startsWith("ff")) return true; // multicast
    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible — recurse on the embedded v4.
    const mapped = normalized.match(/:((?:\d{1,3}\.){3}\d{1,3})$/);
    if (mapped && isIP(mapped[1]) === 4) return isForbiddenIp(mapped[1]);
    return false;
  }
  // Unparseable address: fail closed.
  return true;
}

export type PushEndpointResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export type PushNotificationServiceOptions = {
  /**
   * Resolve a hostname to its addresses. Overridable primarily so tests can
   * assert endpoint validation without hitting live DNS. Defaults to
   * `dns.lookup(hostname, { all: true, verbatim: true })`.
   */
  resolveHost?: PushEndpointResolver;
};

const defaultResolveHost: PushEndpointResolver = (hostname) => lookup(hostname, { all: true, verbatim: true });

/**
 * Validate the push endpoint URL before it is persisted and later POSTed to by
 * the server. Rejects anything that is not an https:// URL on the standard
 * TLS port with a plausibly-public host.
 *
 * This is run on the attacker-controllable `subscription.endpoint`; without
 * it, /api/push/subscribe would turn the server into an SSRF client (and a
 * blind beacon for session metadata, since the caller also supplies the
 * encryption keys). CWE-918.
 */
async function validateEndpointUrl(endpoint: string, resolveHost: PushEndpointResolver): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("Push endpoint must be a valid URL");
  }
  if (parsed.protocol !== "https:") throw new Error("Push endpoint must use https");
  if (parsed.username || parsed.password) throw new Error("Push endpoint must not include credentials");
  // An explicit non-443 port lets an attacker aim the server at internal
  // services on arbitrary ports. Real push services run on 443.
  if (parsed.port && parsed.port !== "443") throw new Error("Push endpoint must use port 443");
  const hostname = parsed.hostname;
  if (!hostname) throw new Error("Push endpoint must have a hostname");
  // Strip IPv6 brackets if the URL parser left them on hostname (it doesn't,
  // but be defensive).
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (isIP(bare)) {
    if (isForbiddenIp(bare)) throw new Error("Push endpoint host is not permitted");
    return;
  }
  // Resolve the hostname and reject if any answer is a disallowed address.
  // This blocks DNS names that point at loopback/private/metadata hosts.
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await resolveHost(bare);
  } catch {
    throw new Error("Push endpoint host could not be resolved");
  }
  if (addresses.length === 0) throw new Error("Push endpoint host could not be resolved");
  for (const entry of addresses) {
    if (isForbiddenIp(entry.address)) throw new Error("Push endpoint host is not permitted");
  }
}

function validSubscription(value: unknown): value is PushSubscription {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const subscription = value as Partial<PushSubscription>;
  if (typeof subscription.endpoint !== "string") return false;
  const endpoint = subscription.endpoint.trim();
  if (!endpoint || endpoint.length > MAX_ENDPOINT_LENGTH) return false;
  const p256dh = subscription.keys?.p256dh;
  const auth = subscription.keys?.auth;
  if (typeof p256dh !== "string" || !p256dh || p256dh.length > MAX_P256DH_LENGTH) return false;
  if (typeof auth !== "string" || !auth || auth.length > MAX_AUTH_LENGTH) return false;
  return true;
}

export function createPushNotificationService(file: string, subject = "https://github.com/ashwin-pc/pi-web", options: PushNotificationServiceOptions = {}) {
  const resolveHost = options.resolveHost ?? defaultResolveHost;
  let cached: PushState | undefined;
  let writeQueue = Promise.resolve();

  async function persist(state: PushState) {
    cached = state;
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
    await rename(tmp, file);
    return state;
  }

  async function serialize<T>(operation: () => Promise<T>) {
    const result = writeQueue.then(operation, operation);
    writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function state() {
    if (cached) return cached;
    try {
      const raw = JSON.parse(await readFile(file, "utf-8")) as Partial<PushState>;
      if (!raw.vapid?.publicKey || !raw.vapid.privateKey || !Array.isArray(raw.subscriptions)) throw new Error("Invalid push state");
      cached = { version: 1, vapid: raw.vapid, subscriptions: raw.subscriptions.filter((item) => validSubscription(item?.subscription)) as StoredSubscription[] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`Could not read pi-web push state at ${file}:`, error);
      cached = await persist({ version: 1, vapid: webPush.generateVAPIDKeys(), subscriptions: [] });
    }
    webPush.setVapidDetails(subject, cached.vapid.publicKey, cached.vapid.privateKey);
    return cached;
  }

  async function publicKey() {
    return (await state()).vapid.publicKey;
  }

  async function subscribe(installationIdValue: unknown, value: unknown) {
    const installationId = typeof installationIdValue === "string" ? installationIdValue.trim().slice(0, 160) : "";
    if (!installationId || !validSubscription(value)) throw new Error("A valid installationId and push subscription are required");
    await validateEndpointUrl(value.endpoint, resolveHost);
    return serialize(async () => {
      const current = await state();
      const now = new Date().toISOString();
      const id = subscriptionId(value.endpoint);
      const existing = current.subscriptions.find((item) => item.id === id);
      const record: StoredSubscription = { id, installationId, subscription: value, createdAt: existing?.createdAt || now, updatedAt: now };
      await persist({ ...current, subscriptions: [record, ...current.subscriptions.filter((item) => item.id !== id && item.installationId !== installationId)] });
      return { id };
    });
  }

  async function unsubscribe(installationIdValue: unknown, endpointValue?: unknown) {
    const installationId = typeof installationIdValue === "string" ? installationIdValue.trim() : "";
    const endpoint = typeof endpointValue === "string" ? endpointValue.trim() : "";
    if (!installationId && !endpoint) throw new Error("installationId or endpoint is required");
    return serialize(async () => {
      const current = await state();
      const subscriptions = current.subscriptions.filter((item) => item.installationId !== installationId && item.subscription.endpoint !== endpoint);
      if (subscriptions.length !== current.subscriptions.length) await persist({ ...current, subscriptions });
    });
  }

  async function notifyRunCompleted(notification: RunCompletedNotification) {
    const current = await state();
    if (current.subscriptions.length === 0) return;
    const payload = JSON.stringify({ type: "run-complete", ...notification });
    const expired = new Set<string>();
    await Promise.all(current.subscriptions.map(async (item) => {
      try {
        await webPush.sendNotification(item.subscription, payload, { TTL: 60 * 60, urgency: "normal" });
      } catch (error: any) {
        if (error?.statusCode === 404 || error?.statusCode === 410) expired.add(item.id);
        else console.warn("Could not send pi-web completion notification:", error instanceof Error ? error.message : error);
      }
    }));
    if (expired.size > 0) {
      await serialize(async () => {
        const latest = await state();
        await persist({ ...latest, subscriptions: latest.subscriptions.filter((item) => !expired.has(item.id)) });
      });
    }
  }

  return { file, publicKey, subscribe, unsubscribe, notifyRunCompleted };
}
