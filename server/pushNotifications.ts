import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import webPush, { type PushSubscription } from "web-push";

type StoredSubscription = {
  id: string;
  identityId: string;
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

export type OwnedSubscriptionSummary = {
  id: string;
  installationId: string;
  endpointHost: string;
  updatedAt: string;
  createdAt: string;
};

function subscriptionId(endpoint: string) {
  return createHash("sha256").update(endpoint).digest("hex").slice(0, 24);
}

function endpointHost(endpoint: string) {
  try { return new URL(endpoint).host; } catch { return ""; }
}

function normalizeIdentity(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
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
      cached = {
        version: 1,
        vapid: raw.vapid,
        subscriptions: raw.subscriptions
          .filter((item) => validSubscription(item?.subscription))
          .map((item) => {
            const record = item as Partial<StoredSubscription>;
            const sub = record.subscription as PushSubscription;
            return {
              // Legacy records persisted before identity ownership was
              // recorded keep working but default to an empty identityId.
              // An empty identityId will never match an authenticated
              // identity in subscribe/unsubscribe/notify ownership checks
              // below, which closes the retroactive hijack window on
              // upgrade.
              id: String(record.id || subscriptionId(sub.endpoint)),
              identityId: typeof record.identityId === "string" ? record.identityId : "",
              installationId: String(record.installationId || ""),
              subscription: sub,
              createdAt: String(record.createdAt || new Date().toISOString()),
              updatedAt: String(record.updatedAt || new Date().toISOString()),
            } as StoredSubscription;
          }),
      };
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

  async function subscribe(identityIdValue: unknown, installationIdValue: unknown, value: unknown) {
    const identityId = normalizeIdentity(identityIdValue);
    const installationId = typeof installationIdValue === "string" ? installationIdValue.trim().slice(0, 160) : "";
    if (!identityId) throw new Error("An authenticated identity is required");
    if (!installationId || !validSubscription(value)) throw new Error("A valid installationId and push subscription are required");
    return serialize(async () => {
      const current = await state();
      const now = new Date().toISOString();
      const id = subscriptionId(value.endpoint);
      const existing = current.subscriptions.find((item) => item.id === id);
      // Only the owning identity may replace an existing record for the
      // same endpoint-derived id. If some other identity owns that id
      // (e.g. the same browser previously registered under a different
      // auth), refuse the write so we never silently repoint another
      // identity's device.
      if (existing && existing.identityId && existing.identityId !== identityId) {
        throw new Error("Subscription endpoint is already registered to another identity");
      }
      const record: StoredSubscription = {
        id,
        identityId,
        installationId,
        subscription: value,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      };
      // Replace the record for this endpoint and evict any prior record
      // that this *same* identity previously registered under this
      // installationId. We never touch records belonging to other
      // identities, so one identity cannot evict another identity's
      // registration by reusing its installationId.
      const subscriptions = [
        record,
        ...current.subscriptions.filter((item) => item.id !== id && !(item.identityId === identityId && item.installationId === installationId)),
      ];
      await persist({ ...current, subscriptions });
      return { id };
    });
  }

  async function unsubscribe(identityIdValue: unknown, installationIdValue: unknown, endpointValue?: unknown) {
    const identityId = normalizeIdentity(identityIdValue);
    const installationId = typeof installationIdValue === "string" ? installationIdValue.trim() : "";
    const endpoint = typeof endpointValue === "string" ? endpointValue.trim() : "";
    if (!identityId) throw new Error("An authenticated identity is required");
    if (!installationId && !endpoint) throw new Error("installationId or endpoint is required");
    return serialize(async () => {
      const current = await state();
      // Delete a record only when it is owned by the calling identity AND
      // the caller-supplied key matches that specific record. When both
      // installationId and endpoint are supplied, both must match. A
      // caller-supplied key alone is never sufficient to delete a record
      // that is not owned by that identity.
      const subscriptions = current.subscriptions.filter((item) => {
        if (!item.identityId || item.identityId !== identityId) return true;
        const installationMatches = installationId ? item.installationId === installationId : true;
        const endpointMatches = endpoint ? item.subscription.endpoint === endpoint : true;
        const shouldDelete = installationMatches && endpointMatches;
        return !shouldDelete;
      });
      if (subscriptions.length !== current.subscriptions.length) await persist({ ...current, subscriptions });
    });
  }

  async function listForIdentity(identityIdValue: unknown): Promise<OwnedSubscriptionSummary[]> {
    const identityId = normalizeIdentity(identityIdValue);
    if (!identityId) return [];
    const current = await state();
    return current.subscriptions
      .filter((item) => item.identityId === identityId)
      .map((item) => ({
        id: item.id,
        installationId: item.installationId,
        endpointHost: endpointHost(item.subscription.endpoint),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      }));
  }

  async function notifyRunCompleted(notification: RunCompletedNotification, options?: { identityIds?: readonly string[] | null }) {
    const current = await state();
    if (current.subscriptions.length === 0) return;
    // Scope delivery to subscriptions owned by an identity entitled to the
    // completed session when the caller tells us who those identities
    // are. When no identityIds filter is supplied the service falls back
    // to notifying every subscription with a non-empty owning identityId
    // (single-owner deployments where every authenticated identity is
    // entitled to every session). Legacy records with no recorded owner
    // are never notified until their owner re-subscribes.
    const allowed = options?.identityIds
      ? new Set<string>(options.identityIds.map((id) => id.trim()).filter(Boolean))
      : null;
    const targets = allowed === null
      ? current.subscriptions.filter((item) => Boolean(item.identityId))
      : current.subscriptions.filter((item) => item.identityId && allowed.has(item.identityId));
    if (targets.length === 0) return;
    const payload = JSON.stringify({ type: "run-complete", ...notification });
    const expired = new Set<string>();
    await Promise.all(targets.map(async (item) => {
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

  return { file, publicKey, subscribe, unsubscribe, listForIdentity, notifyRunCompleted };
}
