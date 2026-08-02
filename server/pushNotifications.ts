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

function validSubscription(value: unknown): value is PushSubscription {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const subscription = value as Partial<PushSubscription>;
  return typeof subscription.endpoint === "string" && Boolean(subscription.endpoint.trim())
    && typeof subscription.keys?.p256dh === "string" && Boolean(subscription.keys.p256dh)
    && typeof subscription.keys?.auth === "string" && Boolean(subscription.keys.auth);
}

export function createPushNotificationService(file: string, subject = "https://github.com/ashwin-pc/pi-web") {
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
