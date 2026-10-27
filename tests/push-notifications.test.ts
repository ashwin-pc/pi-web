import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
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
    await expect(createPushNotificationService(file).subscribe("browser-a", subscription)).rejects.toThrow();
    expect(await readFile(file, "utf-8")).toBe("{not valid json");
  });

  it("fails closed when initialized state cannot be persisted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const blockedParent = join(dir, "not-a-directory");
    await writeFile(blockedParent, "unchanged");

    await expect(createPushNotificationService(join(blockedParent, "push.json")).publicKey()).rejects.toThrow();
    expect(await readFile(blockedParent, "utf-8")).toBe("unchanged");
  });

  it("treats notification initialization failures as best-effort", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const blockedParent = join(dir, "not-a-directory");
    await writeFile(blockedParent, "unchanged");
    const sendNotification = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const service = createPushNotificationService(join(blockedParent, "push.json"), undefined, { sendNotification });

    await expect(service.notifyRunCompleted({
      sessionId: "session",
      title: "Done",
      completedAt: "2026-10-26T00:00:00.000Z",
    })).resolves.toBeUndefined();

    expect(sendNotification).not.toHaveBeenCalled();
    expect(await readFile(blockedParent, "utf-8")).toBe("unchanged");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("treats notification startup failures as best-effort without changing corrupt state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const file = join(dir, "push.json");
    const corrupt = "{not valid json";
    await writeFile(file, corrupt);
    const sendNotification = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const service = createPushNotificationService(file, undefined, { sendNotification });

    await expect(service.notifyRunCompleted({
      sessionId: "session",
      title: "Done",
      completedAt: "2026-10-26T00:00:00.000Z",
    })).resolves.toBeUndefined();

    expect(sendNotification).not.toHaveBeenCalled();
    expect(await readFile(file, "utf-8")).toBe(corrupt);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("treats cleanup failures as best-effort without overwriting newly corrupt state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const file = join(dir, "push.json");
    const corrupt = "{corrupted during delivery";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const service = createPushNotificationService(file, undefined, {
      sendNotification: async () => {
        await writeFile(file, corrupt);
        throw Object.assign(new Error("expired"), { statusCode: 410 });
      },
    });
    await service.subscribe("browser-a", subscription);

    await expect(service.notifyRunCompleted({
      sessionId: "session",
      title: "Done",
      completedAt: "2026-10-26T00:00:00.000Z",
    })).resolves.toBeUndefined();

    expect(await readFile(file, "utf-8")).toBe(corrupt);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("delivers healthy notifications and removes expired subscriptions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const file = join(dir, "push.json");
    const delivered: string[] = [];
    const service = createPushNotificationService(file, undefined, {
      sendNotification: async (target) => {
        if (target.endpoint.endsWith("/expired")) {
          throw Object.assign(new Error("expired"), { statusCode: 410 });
        }
        delivered.push(target.endpoint);
      },
    });
    const healthy = { ...subscription, endpoint: "https://fcm.googleapis.com/fcm/send/healthy" };
    const expired = { ...subscription, endpoint: "https://fcm.googleapis.com/fcm/send/expired" };
    await service.subscribe("browser-healthy", healthy);
    await service.subscribe("browser-expired", expired);

    await service.notifyRunCompleted({
      sessionId: "session",
      title: "Done",
      completedAt: "2026-10-26T00:00:00.000Z",
    });

    expect(delivered).toEqual([healthy.endpoint]);
    expect((await storedState(file)).subscriptions).toMatchObject([
      { installationId: "browser-healthy", subscription: { endpoint: healthy.endpoint } },
    ]);
  });

  it("replaces a browser installation globally", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const file = join(dir, "push.json");
    const service = createPushNotificationService(file);
    await service.subscribe("browser-a", subscription);
    await service.subscribe("browser-a", {
      ...subscription,
      endpoint: "https://updates.push.services.mozilla.com/wpush/v2/subscription-b",
    });

    const stored = await storedState(file);
    expect(stored.subscriptions).toHaveLength(1);
    expect(stored.subscriptions[0]).toMatchObject({
      installationId: "browser-a",
      subscription: { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/subscription-b" },
    });
    expect(stored.subscriptions[0]).not.toHaveProperty("identityId");
  });

  it("uses AND matching when both unsubscribe keys are supplied", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const file = join(dir, "push.json");
    const service = createPushNotificationService(file);
    const second = { ...subscription, endpoint: "https://web.push.apple.com/QP1/b" };
    await service.subscribe("browser-a", subscription);
    await service.subscribe("browser-b", second);

    await service.unsubscribe("browser-a", second.endpoint);
    expect((await storedState(file)).subscriptions).toHaveLength(2);
    await service.unsubscribe("browser-a", subscription.endpoint);

    expect((await storedState(file)).subscriptions).toMatchObject([
      { installationId: "browser-b", subscription: { endpoint: second.endpoint } },
    ]);
  });

  it("supports installation-only and endpoint-only unsubscribe", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const file = join(dir, "push.json");
    const service = createPushNotificationService(file);
    const second = { ...subscription, endpoint: "https://web.push.apple.com/QP1/b" };
    await service.subscribe("browser-a", subscription);
    await service.subscribe("browser-b", second);

    await service.unsubscribe("browser-a");
    expect((await storedState(file)).subscriptions).toHaveLength(1);
    await service.unsubscribe(undefined, second.endpoint);
    expect((await storedState(file)).subscriptions).toEqual([]);
  });

  it("reads, refreshes, and removes persisted records with obsolete identity fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const file = join(dir, "push.json");
    const original = createPushNotificationService(file);
    const second = { ...subscription, endpoint: "https://fcm.googleapis.com/fcm/send/legacy-b" };
    await original.subscribe("browser-a", subscription);
    await original.subscribe("browser-b", second);
    const legacy = await storedState(file);
    legacy.subscriptions[0].identityId = "token:old-owner";
    legacy.subscriptions[1].identityId = "passkey:new-owner";
    await writeFile(file, JSON.stringify(legacy));

    const service = createPushNotificationService(file);
    const refreshed = {
      ...subscription,
      endpoint: "https://updates.push.services.mozilla.com/wpush/v2/refreshed",
    };
    await service.subscribe("browser-a", refreshed);
    const afterRefresh = await storedState(file);
    expect(afterRefresh.subscriptions).toHaveLength(2);
    expect(afterRefresh.subscriptions.every((record: object) => !("identityId" in record))).toBe(true);
    expect(afterRefresh.subscriptions).toContainEqual(expect.objectContaining({
      installationId: "browser-a",
      subscription: expect.objectContaining({ endpoint: refreshed.endpoint }),
    }));

    await service.unsubscribe("browser-b", second.endpoint);
    expect((await storedState(file)).subscriptions).toMatchObject([
      { installationId: "browser-a", subscription: { endpoint: refreshed.endpoint } },
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
      await service.subscribe(`browser-${index}`, { ...subscription, endpoint });
    }
    await expect(service.subscribe("private", {
      ...subscription,
      endpoint: "https://push.invalid.example/internal",
    })).rejects.toThrow("supported push subscription");
    await expect(service.subscribe("http", {
      ...subscription,
      endpoint: "http://fcm.googleapis.com/fcm/send/a",
    })).rejects.toThrow("supported push subscription");
    await expect(service.subscribe("port", {
      ...subscription,
      endpoint: "https://fcm.googleapis.com:8443/fcm/send/a",
    })).rejects.toThrow("supported push subscription");
  });

  it("bounds field sizes and global records without blocking refresh or replacement", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const file = join(dir, "push.json");
    const service = createPushNotificationService(file, undefined, {
      maxSubscriptions: 3,
    });
    await expect(service.subscribe("large", {
      ...subscription,
      endpoint: `https://fcm.googleapis.com/${"x".repeat(2048)}`,
    })).rejects.toThrow("supported push subscription");
    await service.subscribe("a-1", { ...subscription, endpoint: "https://fcm.googleapis.com/a-1" });
    await service.subscribe("a-2", { ...subscription, endpoint: "https://fcm.googleapis.com/a-2" });
    await service.subscribe("a-3", { ...subscription, endpoint: "https://web.push.apple.com/a-3" });
    await expect(service.subscribe("a-4", {
      ...subscription,
      endpoint: "https://updates.push.services.mozilla.com/a-4",
    })).rejects.toThrow("limit reached");
    await service.subscribe("a-1", { ...subscription, endpoint: "https://fcm.googleapis.com/a-1-new" });
    await service.subscribe("replacement-installation", { ...subscription, endpoint: "https://fcm.googleapis.com/a-2" });
    expect((await storedState(file)).subscriptions).toHaveLength(3);
  });

  it("bounds completion fan-out concurrency", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    let active = 0;
    let peak = 0;
    let sent = 0;
    const service = createPushNotificationService(join(dir, "push.json"), undefined, {
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
      await service.subscribe(`browser-${index}`, {
        ...subscription,
        endpoint: `https://fcm.googleapis.com/fcm/send/${index}`,
      });
    }

    await service.notifyRunCompleted({ sessionId: "session", title: "Done", completedAt: "2026-10-26T00:00:00.000Z" });

    expect(sent).toBe(6);
    expect(peak).toBe(2);
  });
});
