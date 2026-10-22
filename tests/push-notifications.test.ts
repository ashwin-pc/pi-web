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
  it("persists stable VAPID keys and replaces a browser installation subscription for its owner", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const file = join(dir, "push.json");
    const service = createPushNotificationService(file);
    const publicKey = await service.publicKey();

    await service.subscribe("session:owner", "browser-a", subscription);
    await service.subscribe("session:owner", "browser-a", { ...subscription, endpoint: "https://push.example.test/subscription-b" });

    const stored = JSON.parse(await readFile(file, "utf-8"));
    expect(stored.vapid.publicKey).toBe(publicKey);
    expect(stored.subscriptions).toHaveLength(1);
    expect(stored.subscriptions[0]).toMatchObject({
      identityId: "session:owner",
      installationId: "browser-a",
      subscription: { endpoint: "https://push.example.test/subscription-b" },
    });
    expect(await createPushNotificationService(file).publicKey()).toBe(publicKey);
  });

  it("unsubscribes only the caller's own record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const file = join(dir, "push.json");
    const service = createPushNotificationService(file);
    await service.subscribe("session:owner", "browser-a", subscription);

    await service.unsubscribe("session:owner", "browser-a");

    const stored = JSON.parse(await readFile(file, "utf-8"));
    expect(stored.subscriptions).toEqual([]);
  });

  it("rejects unsubscribe from a different identity even with the right key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const file = join(dir, "push.json");
    const service = createPushNotificationService(file);
    await service.subscribe("session:owner", "browser-a", subscription);

    await service.unsubscribe("external:attacker", "browser-a", subscription.endpoint);

    const stored = JSON.parse(await readFile(file, "utf-8"));
    expect(stored.subscriptions).toHaveLength(1);
    expect(stored.subscriptions[0].identityId).toBe("session:owner");
  });

  it("refuses to repoint a subscription owned by a different identity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const file = join(dir, "push.json");
    const service = createPushNotificationService(file);
    await service.subscribe("session:owner", "browser-a", subscription);

    await expect(
      service.subscribe("external:attacker", "browser-a", subscription),
    ).rejects.toThrow(/registered to another identity/);
    const stored = JSON.parse(await readFile(file, "utf-8"));
    expect(stored.subscriptions).toHaveLength(1);
    expect(stored.subscriptions[0].identityId).toBe("session:owner");
  });

  it("does not let one identity's subscribe evict another identity's record under the same installationId", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const file = join(dir, "push.json");
    const service = createPushNotificationService(file);
    const otherEndpoint = { ...subscription, endpoint: "https://push.example.test/other" };
    await service.subscribe("session:owner", "browser-a", subscription);
    await service.subscribe("external:other", "browser-a", otherEndpoint);

    const stored = JSON.parse(await readFile(file, "utf-8"));
    expect(stored.subscriptions).toHaveLength(2);
    const owners = stored.subscriptions.map((item: { identityId: string }) => item.identityId).sort();
    expect(owners).toEqual(["external:other", "session:owner"]);
  });

  it("rejects malformed subscriptions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const service = createPushNotificationService(join(dir, "push.json"));
    await expect(service.subscribe("session:owner", "browser-a", { endpoint: "https://push.example.test" })).rejects.toThrow("valid installationId");
  });

  it("rejects subscribe without an identity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const service = createPushNotificationService(join(dir, "push.json"));
    await expect(service.subscribe("", "browser-a", subscription)).rejects.toThrow("identity");
  });

  it("exposes the owner's records in listForIdentity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const service = createPushNotificationService(join(dir, "push.json"));
    await service.subscribe("session:owner", "browser-a", subscription);
    await service.subscribe("external:other", "browser-b", { ...subscription, endpoint: "https://push.example.test/other" });

    const owned = await service.listForIdentity("session:owner");
    expect(owned).toHaveLength(1);
    expect(owned[0]).toMatchObject({ installationId: "browser-a", endpointHost: "push.example.test" });
  });
});
