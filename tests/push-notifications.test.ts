import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPushNotificationService } from "../server/pushNotifications.js";

const subscription = {
  endpoint: "https://push.example.test/subscription-a",
  keys: { p256dh: "public-encryption-key", auth: "auth-secret" },
};

describe("push notification subscriptions", () => {
  it("persists stable VAPID keys and replaces a browser installation subscription", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const file = join(dir, "push.json");
    const service = createPushNotificationService(file);
    const publicKey = await service.publicKey();

    await service.subscribe("browser-a", subscription);
    await service.subscribe("browser-a", { ...subscription, endpoint: "https://push.example.test/subscription-b" });

    const stored = JSON.parse(await readFile(file, "utf-8"));
    expect(stored.vapid.publicKey).toBe(publicKey);
    expect(stored.subscriptions).toHaveLength(1);
    expect(stored.subscriptions[0]).toMatchObject({
      installationId: "browser-a",
      subscription: { endpoint: "https://push.example.test/subscription-b" },
    });
    expect(await createPushNotificationService(file).publicKey()).toBe(publicKey);
  });

  it("unsubscribes the current browser installation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const file = join(dir, "push.json");
    const service = createPushNotificationService(file);
    await service.subscribe("browser-a", subscription);

    await service.unsubscribe("browser-a");

    const stored = JSON.parse(await readFile(file, "utf-8"));
    expect(stored.subscriptions).toEqual([]);
  });

  it("rejects malformed subscriptions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const service = createPushNotificationService(join(dir, "push.json"));
    await expect(service.subscribe("browser-a", { endpoint: "https://push.example.test" })).rejects.toThrow("valid installationId");
  });
});
