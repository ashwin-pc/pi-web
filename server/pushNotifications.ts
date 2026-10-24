import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import webPush, { type PushSubscription } from "web-push";

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

const MAX_ENDPOINT_LENGTH = 2048;
const MAX_KEY_LENGTH = 256;
const MAX_SUBSCRIPTIONS = 1024;
const MAX_SUBSCRIPTIONS_PER_INSTALLATION = 4;
const SUBSCRIBE_RATE_LIMIT_WINDOW_MS = 60_000;
const SUBSCRIBE_RATE_LIMIT_MAX = 20;
const NOTIFY_CONCURRENCY = 8;

function validSubscription(value: unknown): value is PushSubscription {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const subscription = value as Partial<PushSubscription>;
  if (typeof subscription.endpoint !== "string" || !subscription.endpoint.trim()) return false;
  if (subscription.endpoint.length > MAX_ENDPOINT_LENGTH) return false;
  const keys = subscription.keys;
  if (!keys || typeof keys.p256dh !== "string" || !keys.p256dh) return false;
  if (keys.p256dh.length > MAX_KEY_LENGTH) return false;
  if (typeof keys.auth !== "string" || !keys.auth) return false;
  if (keys.auth.length > MAX_KEY_LENGTH) return false;
  return true;
}

async function mapWithConcurrency<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>) {
  const concurrency = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  const runners: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) {
    runners.push((async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        await worker(items[index]);
      }
    })());
  }
  await Promise.all(runners);
}

export function createPushNotificationService(file: string, subject = "https://github.com/ashwin-pc/pi-web") {
  let cached: PushState | undefined;
  let writeQueue = Promise.resolve();
  const rateLimiter = new Map<string, number[]>();

  function checkRateLimit(installationId: string) {
    const now = Date.now();
    const windowStart = now - SUBSCRIBE_RATE_LIMIT_WINDOW_MS;
    const history = (rateLimiter.get(installationId) || []).filter((timestamp) => timestamp > windowStart);
    if (history.length >= SUBSCRIBE_RATE_LIMIT_MAX) {
      throw new Error("Too many push subscription requests; please retry later");
    }
    history.push(now);
    rateLimiter.set(installationId, history);
    if (rateLimiter.size > 4096) {
      for (const [key, entries] of rateLimiter) {
        if (entries.every((timestamp) => timestamp <= windowStart)) rateLimiter.delete(key);
      }
    }
  }

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
    checkRateLimit(installationId);
    return serialize(async () => {
      const current = await state();
      const now = new Date().toISOString();
      const id = subscriptionId(value.endpoint);
      const existing = current.subscriptions.find((item) => item.id === id);
      const record: StoredSubscription = { id, installationId, subscription: value, createdAt: existing?.createdAt || now, updatedAt: now };
      // Replace any record with the same endpoint id. Older records for the same installationId
      // are dropped so a single installation cannot accumulate unlimited entries.
      let remaining = current.subscriptions.filter((item) => item.id !== id && item.installationId !== installationId);
      // Defensive per-installation cap: although identical installationIds are deduped above,
      // keep an explicit bound so historical state files or future dedupe changes cannot leave
      // more than MAX_SUBSCRIPTIONS_PER_INSTALLATION records per identity.
      const perInstallation = remaining.filter((item) => item.installationId === installationId);
      if (perInstallation.length >= MAX_SUBSCRIPTIONS_PER_INSTALLATION) {
        const retainIds = new Set(
          [...perInstallation]
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .slice(0, MAX_SUBSCRIPTIONS_PER_INSTALLATION - 1)
            .map((item) => item.id),
        );
        remaining = remaining.filter((item) => item.installationId !== installationId || retainIds.has(item.id));
      }
      let next = [record, ...remaining];
      // Global cap: evict the oldest-updated records once the list exceeds MAX_SUBSCRIPTIONS.
      if (next.length > MAX_SUBSCRIPTIONS) {
        next = [...next].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_SUBSCRIPTIONS);
      }
      await persist({ ...current, subscriptions: next });
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
    await mapWithConcurrency(current.subscriptions, NOTIFY_CONCURRENCY, async (item) => {
      try {
        await webPush.sendNotification(item.subscription, payload, { TTL: 60 * 60, urgency: "normal" });
      } catch (error: any) {
        if (error?.statusCode === 404 || error?.statusCode === 410) expired.add(item.id);
        else console.warn("Could not send pi-web completion notification:", error instanceof Error ? error.message : error);
      }
    });
    if (expired.size > 0) {
      await serialize(async () => {
        const latest = await state();
        await persist({ ...latest, subscriptions: latest.subscriptions.filter((item) => !expired.has(item.id)) });
      });
    }
  }

  return { file, publicKey, subscribe, unsubscribe, notifyRunCompleted };
}
