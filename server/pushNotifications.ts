import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import webPush, { type PushSubscription } from "web-push";

const MAX_ENDPOINT_LENGTH = 2048;
const MAX_KEY_LENGTH = 256;
const MAX_INSTALLATION_ID_LENGTH = 160;

export const PUSH_SUBSCRIPTION_LIMITS = {
  total: 256,
  notifyConcurrency: 8,
} as const;

const allowedEndpointHosts = new Set([
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
]);

function allowedEndpointHost(hostname: string) {
  return allowedEndpointHosts.has(hostname)
    || hostname.endsWith(".push.services.mozilla.com")
    || hostname.endsWith(".notify.windows.com");
}

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

type SendNotification = (
  subscription: PushSubscription,
  payload: string,
  options: { TTL: number; urgency: "normal" },
) => Promise<unknown>;

export type PushNotificationServiceOptions = {
  maxSubscriptions?: number;
  notifyConcurrency?: number;
  sendNotification?: SendNotification;
};

function subscriptionId(endpoint: string) {
  return createHash("sha256").update(endpoint).digest("hex").slice(0, 24);
}

function normalizedSubscription(value: unknown): PushSubscription | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<PushSubscription>;
  const endpoint = typeof candidate.endpoint === "string" ? candidate.endpoint.trim() : "";
  const p256dh = typeof candidate.keys?.p256dh === "string" ? candidate.keys.p256dh : "";
  const auth = typeof candidate.keys?.auth === "string" ? candidate.keys.auth : "";
  if (!endpoint || endpoint.length > MAX_ENDPOINT_LENGTH || !p256dh || p256dh.length > MAX_KEY_LENGTH || !auth || auth.length > MAX_KEY_LENGTH) return undefined;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return undefined;
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !allowedEndpointHost(hostname)) return undefined;
  return { endpoint: url.toString(), keys: { p256dh, auth } };
}

function normalizeState(raw: Partial<PushState>): PushState {
  if (!raw.vapid?.publicKey || !raw.vapid.privateKey || !Array.isArray(raw.subscriptions)) throw new Error("Invalid push state");
  const now = new Date().toISOString();
  const subscriptions = raw.subscriptions.flatMap((value) => {
    const record = value as Partial<StoredSubscription>;
    const subscription = normalizedSubscription(record.subscription);
    const installationId = typeof record.installationId === "string" ? record.installationId.trim().slice(0, MAX_INSTALLATION_ID_LENGTH) : "";
    if (!subscription || !installationId) return [];
    return [{
      id: subscriptionId(subscription.endpoint),
      installationId,
      subscription,
      createdAt: typeof record.createdAt === "string" ? record.createdAt : now,
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : now,
    }];
  });
  return { version: 1, vapid: raw.vapid, subscriptions };
}

async function mapWithConcurrency<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>) {
  let next = 0;
  const count = Math.min(items.length, Math.max(1, limit));
  await Promise.all(Array.from({ length: count }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  }));
}

export function createPushNotificationService(
  file: string,
  subject = "https://github.com/ashwin-pc/pi-web",
  options: PushNotificationServiceOptions = {},
) {
  const maxSubscriptions = options.maxSubscriptions ?? PUSH_SUBSCRIPTION_LIMITS.total;
  const notifyConcurrency = options.notifyConcurrency ?? PUSH_SUBSCRIPTION_LIMITS.notifyConcurrency;
  const sendNotification = options.sendNotification ?? ((...args) => webPush.sendNotification(...args));
  let cached: PushState | undefined;
  let loading: Promise<PushState> | undefined;
  let writeQueue = Promise.resolve();

  async function persist(next: PushState) {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
    await rename(tmp, file);
    cached = next;
    return next;
  }

  async function readState() {
    return normalizeState(JSON.parse(await readFile(file, "utf-8")) as Partial<PushState>);
  }

  async function initializeState() {
    const next: PushState = { version: 1, vapid: webPush.generateVAPIDKeys(), subscriptions: [] };
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf-8", mode: 0o600, flag: "wx" });
      await link(tmp, file);
      cached = next;
      return next;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return readState();
    } finally {
      await unlink(tmp).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  async function serialize<T>(operation: () => Promise<T>) {
    const result = writeQueue.then(operation, operation);
    writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function state() {
    if (cached) return cached;
    if (!loading) {
      loading = (async () => {
        let loaded: PushState;
        try {
          loaded = await readState();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          loaded = await initializeState();
        }
        cached = loaded;
        webPush.setVapidDetails(subject, loaded.vapid.publicKey, loaded.vapid.privateKey);
        return loaded;
      })().finally(() => {
        loading = undefined;
      });
    }
    return loading;
  }

  async function mutationState() {
    const initialized = await state();
    try {
      return await readState();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return initialized;
    }
  }

  async function publicKey() {
    return (await state()).vapid.publicKey;
  }

  async function subscribe(installationIdValue: unknown, value: unknown) {
    const installationId = typeof installationIdValue === "string" ? installationIdValue.trim().slice(0, MAX_INSTALLATION_ID_LENGTH) : "";
    const subscription = normalizedSubscription(value);
    if (!installationId || !subscription) throw new Error("A valid installationId and supported push subscription are required");
    return serialize(async () => {
      const current = await mutationState();
      const now = new Date().toISOString();
      const id = subscriptionId(subscription.endpoint);
      const existing = current.subscriptions.find((item) => item.id === id);
      const replacingInstallation = current.subscriptions.find((item) => item.installationId === installationId);
      if (!existing && !replacingInstallation && current.subscriptions.length >= maxSubscriptions) throw new Error("Push subscription limit reached");
      const record: StoredSubscription = {
        id,
        installationId,
        subscription,
        createdAt: existing?.createdAt || replacingInstallation?.createdAt || now,
        updatedAt: now,
      };
      const subscriptions = [
        record,
        ...current.subscriptions.filter((item) =>
          item.id !== id && item.installationId !== installationId),
      ];
      await persist({ ...current, subscriptions });
      return { id };
    });
  }

  async function unsubscribe(installationIdValue: unknown, endpointValue?: unknown) {
    const installationId = typeof installationIdValue === "string" ? installationIdValue.trim() : "";
    const endpoint = typeof endpointValue === "string" ? endpointValue.trim() : "";
    if (!installationId && !endpoint) throw new Error("installationId or endpoint is required");
    return serialize(async () => {
      const current = await mutationState();
      const subscriptions = current.subscriptions.filter((item) => {
        if (installationId && item.installationId !== installationId) return true;
        if (endpoint && item.subscription.endpoint !== endpoint) return true;
        return false;
      });
      if (subscriptions.length !== current.subscriptions.length) await persist({ ...current, subscriptions });
    });
  }

  async function notifyRunCompleted(notification: RunCompletedNotification) {
    try {
      const current = await state();
      if (current.subscriptions.length === 0) return;
      const payload = JSON.stringify({ type: "run-complete", ...notification });
      const expired = new Set<string>();
      await mapWithConcurrency(current.subscriptions, notifyConcurrency, async (item) => {
        try {
          await sendNotification(item.subscription, payload, { TTL: 60 * 60, urgency: "normal" });
        } catch (error: any) {
          if (error?.statusCode === 404 || error?.statusCode === 410) expired.add(item.id);
          else console.warn("Could not send pi-web completion notification:", error instanceof Error ? error.message : error);
        }
      });
      if (expired.size > 0) {
        await serialize(async () => {
          const latest = await mutationState();
          const subscriptions = latest.subscriptions.filter((item) => !expired.has(item.id));
          if (subscriptions.length !== latest.subscriptions.length) await persist({ ...latest, subscriptions });
        });
      }
    } catch (error) {
      console.warn("Could not send pi-web completion notification:", error instanceof Error ? error.message : error);
    }
  }

  return { file, publicKey, subscribe, unsubscribe, notifyRunCompleted };
}
