import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPushNotificationService, type PushEndpointResolver } from "../server/pushNotifications.js";

const subscription = {
  endpoint: "https://push.example.test/subscription-a",
  keys: { p256dh: "public-encryption-key", auth: "auth-secret" },
};

// Stub resolver so the endpoint-URL guard can be exercised in unit tests
// without touching real DNS. Returns a routable-looking address for the
// example push domain and whatever the caller-supplied map says for others.
function makeResolver(map: Record<string, string> = {}): PushEndpointResolver {
  return async (hostname) => {
    if (hostname === "push.example.test") return [{ address: "203.0.113.10", family: 4 }];
    const address = map[hostname];
    if (!address) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    return [{ address, family: address.includes(":") ? 6 : 4 }];
  };
}

describe("push notification subscriptions", () => {
  it("persists stable VAPID keys and replaces a browser installation subscription", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const file = join(dir, "push.json");
    const service = createPushNotificationService(file, undefined, { resolveHost: makeResolver() });
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
    expect(await createPushNotificationService(file, undefined, { resolveHost: makeResolver() }).publicKey()).toBe(publicKey);
  });

  it("unsubscribes the current browser installation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const file = join(dir, "push.json");
    const service = createPushNotificationService(file, undefined, { resolveHost: makeResolver() });
    await service.subscribe("browser-a", subscription);

    await service.unsubscribe("browser-a");

    const stored = JSON.parse(await readFile(file, "utf-8"));
    expect(stored.subscriptions).toEqual([]);
  });

  it("rejects malformed subscriptions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const service = createPushNotificationService(join(dir, "push.json"), undefined, { resolveHost: makeResolver() });
    await expect(service.subscribe("browser-a", { endpoint: "https://push.example.test" })).rejects.toThrow("valid installationId");
  });

  it("rejects non-https push endpoints", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const service = createPushNotificationService(join(dir, "push.json"), undefined, { resolveHost: makeResolver() });
    await expect(
      service.subscribe("browser-a", { ...subscription, endpoint: "http://push.example.test/x" }),
    ).rejects.toThrow(/https/);
  });

  it("rejects push endpoints on non-443 ports", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const service = createPushNotificationService(join(dir, "push.json"), undefined, { resolveHost: makeResolver() });
    await expect(
      service.subscribe("browser-a", { ...subscription, endpoint: "https://push.example.test:8443/x" }),
    ).rejects.toThrow(/port 443/);
  });

  it("rejects push endpoints that resolve to loopback addresses", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const service = createPushNotificationService(join(dir, "push.json"), undefined, { resolveHost: makeResolver({ "beacon.example.test": "127.0.0.1" }) });
    await expect(
      service.subscribe("browser-a", { ...subscription, endpoint: "https://beacon.example.test/collect" }),
    ).rejects.toThrow(/not permitted/);
  });

  it("rejects push endpoints that resolve to link-local metadata addresses", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const metadataIp = ["169", "254", "169", "254"].join(".");
    const service = createPushNotificationService(join(dir, "push.json"), undefined, { resolveHost: makeResolver({ "beacon.example.test": metadataIp }) });
    await expect(
      service.subscribe("browser-a", { ...subscription, endpoint: "https://beacon.example.test/collect" }),
    ).rejects.toThrow(/not permitted/);
  });

  it("rejects push endpoints whose host is a private IP literal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const service = createPushNotificationService(join(dir, "push.json"), undefined, { resolveHost: makeResolver() });
    await expect(
      service.subscribe("browser-a", { ...subscription, endpoint: "https://10.0.0.5/x" }),
    ).rejects.toThrow(/not permitted/);
    await expect(
      service.subscribe("browser-a", { ...subscription, endpoint: "https://[::1]/x" }),
    ).rejects.toThrow(/not permitted/);
  });

  it("rejects push endpoints with embedded credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const service = createPushNotificationService(join(dir, "push.json"), undefined, { resolveHost: makeResolver() });
    await expect(
      service.subscribe("browser-a", { ...subscription, endpoint: "https://user:pass@push.example.test/x" }),
    ).rejects.toThrow(/credentials/);
  });

  it("rejects oversized endpoint and key fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const service = createPushNotificationService(join(dir, "push.json"), undefined, { resolveHost: makeResolver() });
    const bigEndpoint = `https://push.example.test/${"a".repeat(4096)}`;
    await expect(
      service.subscribe("browser-a", { ...subscription, endpoint: bigEndpoint }),
    ).rejects.toThrow(/valid installationId/);
    await expect(
      service.subscribe("browser-a", { ...subscription, keys: { p256dh: "x".repeat(300), auth: subscription.keys.auth } }),
    ).rejects.toThrow(/valid installationId/);
    await expect(
      service.subscribe("browser-a", { ...subscription, keys: { p256dh: subscription.keys.p256dh, auth: "y".repeat(200) } }),
    ).rejects.toThrow(/valid installationId/);
  });
});
