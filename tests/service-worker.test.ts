import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("workbox-core", () => ({ clientsClaim: vi.fn() }));
vi.mock("workbox-precaching", () => ({ cleanupOutdatedCaches: vi.fn(), precacheAndRoute: vi.fn() }));

type Listener = (event: any) => void;
const listeners = new Map<string, Listener>();
const showNotification = vi.fn(async () => undefined);
const cache = { match: vi.fn(async () => undefined), put: vi.fn(async () => undefined) };
const client = { url: "https://pi.test/?sessionId=other", focus: vi.fn(async () => undefined), navigate: vi.fn(async () => undefined) };

beforeEach(async () => {
  listeners.clear();
  vi.clearAllMocks();
  vi.resetModules();
  vi.stubGlobal("caches", { open: vi.fn(async () => cache), keys: vi.fn(async () => ["pi-web-avatars-old", "pi-web-avatars-test", "other-cache"]), delete: vi.fn(async () => true) });
  vi.stubGlobal("__PI_WEB_AVATAR_CACHE_REVISION__", "test");
  vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({ name: "Custom Brand" }) })));
  vi.stubGlobal("self", {
    location: { origin: "https://pi.test" },
    clients: { matchAll: vi.fn(async () => [client]), openWindow: vi.fn(async () => undefined) },
    registration: { showNotification },
    skipWaiting: vi.fn(),
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
  });
  await import("../src/sw.js");
});

describe("service worker completion notifications", () => {
  it("cleans only stale avatar caches after an artwork revision", async () => {
    let pending!: Promise<unknown>;
    listeners.get("activate")?.({ waitUntil: (value: Promise<unknown>) => { pending = value; } });
    await pending;
    expect(caches.delete).toHaveBeenCalledWith("pi-web-avatars-old");
    expect(caches.delete).not.toHaveBeenCalledWith("pi-web-avatars-test");
    expect(caches.delete).not.toHaveBeenCalledWith("other-cache");
  });
  it("shows a visible, vibrating notification linked to the completed session", async () => {
    let pending!: Promise<unknown>;
    listeners.get("push")?.({
      data: { json: () => ({ type: "run-complete", sessionId: "completed", title: "Finished", completedAt: "now" }) },
      waitUntil: (value: Promise<unknown>) => { pending = value; },
    });
    await pending;

    expect(showNotification).toHaveBeenCalledWith("Custom Brand — Run complete", expect.objectContaining({
      body: "Finished",
      silent: false,
      vibrate: [180, 90, 240],
      data: { url: "https://pi.test/?sessionId=completed" },
    }));
  });

  it("closes the notification and navigates an existing pi-web window", async () => {
    let pending!: Promise<unknown>;
    const close = vi.fn();
    listeners.get("notificationclick")?.({
      notification: { data: { url: "https://pi.test/?sessionId=completed" }, close },
      waitUntil: (value: Promise<unknown>) => { pending = value; },
    });
    await pending;

    expect(close).toHaveBeenCalledOnce();
    expect(client.navigate).toHaveBeenCalledWith("https://pi.test/?sessionId=completed");
    expect(client.focus).toHaveBeenCalledOnce();
  });
});
