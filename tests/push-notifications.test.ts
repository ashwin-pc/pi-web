import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPushNotificationService } from "../server/pushNotifications.js";

const subscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/subscription-a",
  keys: { p256dh: "public-encryption-key", auth: "auth-secret" },
};

const storedState = (file: string) => readFile(file, "utf-8").then(JSON.parse);

describe("push notification subscriptions", () => {
  it("persists one VAPID identity when 24 service instances initialize together", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const file = join(dir, "push.json");
    const services = Array.from({ length: 24 }, () => createPushNotificationService(file));

    const keys = await Promise.all(services.map((service) => service.publicKey()));

    expect(new Set(keys)).toEqual(new Set([keys[0]]));
    expect((await storedState(file)).vapid.publicKey).toBe(keys[0]);
    expect(await createPushNotificationService(file).publicKey()).toBe(keys[0]);
  });

  it("fails closed without overwriting unreadable state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const file = join(dir, "push.json");
    await writeFile(file, "{not valid json");
    const service = createPushNotificationService(file);

    await expect(service.publicKey()).rejects.toThrow();
    expect(await readFile(file, "utf-8")).toBe("{not valid json");
  });

  it("fails closed when initialized state cannot be persisted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const blockedParent = join(dir, "not-a-directory");
    await writeFile(blockedParent, "unchanged");

    await expect(createPushNotificationService(join(blockedParent, "push.json")).publicKey()).rejects.toThrow();
    expect(await readFile(blockedParent, "utf-8")).toBe("unchanged");
  });

  it("replaces a browser installation while preserving its owner", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const file = join(dir, "push.json");
    const service = createPushNotificationService(file);
    await service.subscribe("user:owner", "browser-a", subscription);
    await service.subscribe("user:owner", "browser-a", {
      ...subscription,
      endpoint: "https://updates.push.services.mozilla.com/wpush/v2/subscription-b",
    });

    const stored = await storedState(file);
    expect(stored.subscriptions).toHaveLength(1);
    expect(stored.subscriptions[0]).toMatchObject({
      identityId: "user:owner",
      installationId: "browser-a",
      subscription: { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/subscription-b" },
    });
  });

  it("keeps subscribe and unsubscribe mutations inside the authenticated owner", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const file = join(dir, "push.json");
    const service = createPushNotificationService(file);
    await service.subscribe("user:a", "shared-browser-id", subscription);
    await service.subscribe("user:b", "shared-browser-id", {
      ...subscription,
      endpoint: "https://web.push.apple.com/QP1/b",
    });

    await expect(service.subscribe("user:b", "other", subscription)).rejects.toThrow("another identity");
    await service.unsubscribe("user:b", "shared-browser-id", subscription.endpoint);
    expect((await storedState(file)).subscriptions).toHaveLength(2);
    await service.unsubscribe("user:a", "shared-browser-id", "https://web.push.apple.com/not-the-record");
    expect((await storedState(file)).subscriptions).toHaveLength(2);
    await service.unsubscribe("user:a", "shared-browser-id", subscription.endpoint);

    expect((await storedState(file)).subscriptions).toMatchObject([{ identityId: "user:b" }]);
  });

  it("lets an existing browser claim or exactly remove its legacy record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const file = join(dir, "push.json");
    const original = createPushNotificationService(file);
    await original.subscribe("user:owner", "browser-a", subscription);
    const legacy = await storedState(file);
    delete legacy.subscriptions[0].identityId;
    await writeFile(file, JSON.stringify(legacy));

    const claimed = createPushNotificationService(file);
    await claimed.subscribe("user:owner", "browser-a", subscription);
    expect((await storedState(file)).subscriptions[0].identityId).toBe("user:owner");

    const withoutOwner = await storedState(file);
    delete withoutOwner.subscriptions[0].identityId;
    await writeFile(file, JSON.stringify(withoutOwner));
    await createPushNotificationService(file).unsubscribe("user:owner", "browser-a", subscription.endpoint);
    expect((await storedState(file)).subscriptions).toEqual([]);
  });

  it("applies the per-owner cap when claiming ownerless legacy records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const file = join(dir, "push.json");
    const original = createPushNotificationService(file);
    const first = { ...subscription, endpoint: "https://fcm.googleapis.com/fcm/send/legacy-a" };
    const second = { ...subscription, endpoint: "https://fcm.googleapis.com/fcm/send/legacy-b" };
    await original.subscribe("legacy:a", "browser-a", first);
    await original.subscribe("legacy:b", "browser-b", second);
    const legacy = await storedState(file);
    delete legacy.subscriptions[0].identityId;
    delete legacy.subscriptions[1].identityId;
    await writeFile(file, JSON.stringify(legacy));

    const claimed = createPushNotificationService(file, undefined, {
      maxSubscriptionsPerIdentity: 1,
    });
    await claimed.subscribe("user:owner", "browser-a", first);
    await expect(claimed.subscribe("user:owner", "browser-b", second)).rejects.toThrow("this identity");
    await claimed.subscribe("user:owner", "browser-a", first);

    expect((await storedState(file)).subscriptions).toMatchObject([
      { identityId: "user:owner", installationId: "browser-a" },
      { identityId: "", installationId: "browser-b" },
    ]);
  });

  it("accepts common browser push providers and rejects arbitrary destinations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const service = createPushNotificationService(join(dir, "push.json"));
    const validEndpoints = [
      "https://fcm.googleapis.com/fcm/send/a",
      "https://updates.push.services.mozilla.com/wpush/v2/b",
      "https://web.push.apple.com/QP1/c",
      "https://db5.notify.windows.com/w/?token=d",
    ];
    for (const [index, endpoint] of validEndpoints.entries()) {
      await service.subscribe("user:owner", `browser-${index}`, { ...subscription, endpoint });
    }
    await expect(service.subscribe("user:owner", "private", {
      ...subscription,
      endpoint: "https://push.invalid.example/internal",
    })).rejects.toThrow("supported push subscription");
    await expect(service.subscribe("user:owner", "http", {
      ...subscription,
      endpoint: "http://fcm.googleapis.com/fcm/send/a",
    })).rejects.toThrow("supported push subscription");
    await expect(service.subscribe("user:owner", "port", {
      ...subscription,
      endpoint: "https://fcm.googleapis.com:8443/fcm/send/a",
    })).rejects.toThrow("supported push subscription");
  });

  it("bounds field sizes, per-owner records, and total records without blocking replacement", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const file = join(dir, "push.json");
    const service = createPushNotificationService(file, undefined, {
      maxSubscriptions: 3,
      maxSubscriptionsPerIdentity: 2,
    });
    await expect(service.subscribe("user:a", "large", {
      ...subscription,
      endpoint: `https://fcm.googleapis.com/${"x".repeat(2048)}`,
    })).rejects.toThrow("supported push subscription");
    await service.subscribe("user:a", "a-1", { ...subscription, endpoint: "https://fcm.googleapis.com/a-1" });
    await service.subscribe("user:a", "a-2", { ...subscription, endpoint: "https://fcm.googleapis.com/a-2" });
    await expect(service.subscribe("user:a", "a-3", {
      ...subscription,
      endpoint: "https://fcm.googleapis.com/a-3",
    })).rejects.toThrow("this identity");
    await service.subscribe("user:b", "b-1", { ...subscription, endpoint: "https://web.push.apple.com/b-1" });
    await expect(service.subscribe("user:c", "c-1", {
      ...subscription,
      endpoint: "https://updates.push.services.mozilla.com/c-1",
    })).rejects.toThrow("limit reached");
    await service.subscribe("user:a", "a-1", { ...subscription, endpoint: "https://fcm.googleapis.com/a-1-new" });
    expect((await storedState(file)).subscriptions).toHaveLength(3);
  });

  it("bounds completion fan-out concurrency", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    let active = 0;
    let peak = 0;
    let sent = 0;
    const service = createPushNotificationService(join(dir, "push.json"), undefined, {
      maxSubscriptionsPerIdentity: 8,
      notifyConcurrency: 2,
      sendNotification: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => setImmediate(resolve));
        sent += 1;
        active -= 1;
      },
    });
    for (let index = 0; index < 6; index += 1) {
      await service.subscribe("user:owner", `browser-${index}`, {
        ...subscription,
        endpoint: `https://fcm.googleapis.com/fcm/send/${index}`,
      });
    }

    await service.notifyRunCompleted({ sessionId: "session", title: "Done", completedAt: "2026-10-26T00:00:00.000Z" });

    expect(sent).toBe(6);
    expect(peak).toBe(2);
  });
});
