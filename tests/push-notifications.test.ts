import { randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createPushNotificationService } from "../server/pushNotifications.js";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomBytes: vi.fn((size: number) => actual.randomBytes(size)),
  };
});

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

  it("uses exclusive random sibling writes and removes its temporary after a failed replace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-push-"));
    const file = join(dir, "push.json");
    await createPushNotificationService(file).publicKey();
    const blockedFile = join(dir, "blocked.json");
    await mkdir(blockedFile);
    const replaceError = await createPushNotificationService(blockedFile).publicKey()
      .then(() => undefined, (error: NodeJS.ErrnoException & { dest?: string }) => error);
    expect(replaceError).toBeDefined();
    const temporary = String(replaceError?.path);
    expect(temporary).toMatch(new RegExp(`^${blockedFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.[0-9a-f]{32}\\.tmp$`));
    expect(replaceError?.dest).toBe(blockedFile);
    await expect(access(temporary)).rejects.toThrow();

    vi.mocked(randomBytes).mockReturnValueOnce(Buffer.alloc(16, 0xab));
    const reservedTemporary = `${file}.${"ab".repeat(16)}.tmp`;
    await writeFile(reservedTemporary, "reserved", { flag: "wx" });
    const collision = createPushNotificationService(file);
    await expect(collision.subscribe("browser-a", subscription)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(reservedTemporary, "utf-8")).toBe("reserved");
    expect(JSON.parse(await readFile(file, "utf-8")).subscriptions).toEqual([]);
    await unlink(reservedTemporary);
  });
});
