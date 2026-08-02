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
  vi.stubGlobal("caches", { open: vi.fn(async () => cache) });
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
  it("shows a visible, vibrating notification linked to the completed session", async () => {
    let pending!: Promise<unknown>;
    listeners.get("push")?.({
      data: { json: () => ({ type: "run-complete", sessionId: "completed", title: "Finished", completedAt: "now" }) },
      waitUntil: (value: Promise<unknown>) => { pending = value; },
    });
    await pending;

    expect(showNotification).toHaveBeenCalledWith("pi-web — Run complete", expect.objectContaining({
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
