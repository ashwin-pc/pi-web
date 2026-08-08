import { expect, test } from "@playwright/test";
import { openSessionDrawerFooterAction } from "./helpers/sessionDrawer.js";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
  await page.addInitScript(() => {
    const calls = { notifications: [] as Array<{ title: string; options: NotificationOptions }>, vibrations: [] as number[][], audioStarts: 0, messages: [] as unknown[] };
    (window as any).__notificationTestCalls = calls;

    class TestNotification {
      static permission = "granted";
      static requestPermission = async () => "granted";
    }
    Object.defineProperty(window, "Notification", { configurable: true, value: TestNotification });
    Object.defineProperty(window, "PushManager", { configurable: true, value: class {} });
    Object.defineProperty(navigator, "vibrate", { configurable: true, value: (pattern: number[]) => { calls.vibrations.push(pattern); return true; } });

    const subscription = {
      endpoint: "https://push.example.test/current-browser",
      toJSON: () => ({ endpoint: "https://push.example.test/current-browser", keys: { p256dh: "key", auth: "secret" } }),
      unsubscribe: async () => true,
    };
    const registration = {
      active: { postMessage: (message: unknown) => calls.messages.push(message) },
      pushManager: { getSubscription: async () => subscription, subscribe: async () => subscription },
      showNotification: async (title: string, options: NotificationOptions) => { calls.notifications.push({ title, options }); },
    };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        ready: Promise.resolve(registration),
        getRegistration: async () => registration,
        addEventListener: () => undefined,
      },
    });

    class TestAudioContext {
      state = "running";
      currentTime = 0;
      destination = {};
      resume = async () => undefined;
      createGain = () => ({ gain: { setValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined }, connect: () => undefined });
      createOscillator = () => ({
        type: "sine",
        frequency: { value: 0 },
        connect: () => undefined,
        start: () => { calls.audioStarts++; },
        stop: () => undefined,
      });
    }
    Object.defineProperty(window, "AudioContext", { configurable: true, value: TestAudioContext });
  });
});

test("notification settings test notification, sound, vibration, and persistence", async ({ page }) => {
  await page.goto("/");
  await openSessionDrawerFooterAction(page, "Settings");
  await page.locator("#settingsNavNotifications").click();

  await expect(page.locator("#settingRunNotificationsCheckbox")).toBeChecked();
  await page.locator("#settingCompletionSoundCheckbox").check();
  await expect(page.locator("#settingCompletionVibrationCheckbox")).toBeChecked();
  await page.locator("#settingRunNotificationsTestButton").click();

  await expect.poll(() => page.evaluate(() => (window as any).__notificationTestCalls)).toMatchObject({
    notifications: [{ title: "pi-web — Test notification", options: { silent: false, vibrate: [180, 90, 240] } }],
    vibrations: [[180, 90, 240]],
    audioStarts: 2,
  });

  await page.reload();
  await openSessionDrawerFooterAction(page, "Settings");
  await page.locator("#settingsNavNotifications").click();
  await expect(page.locator("#settingCompletionSoundCheckbox")).toBeChecked();
  await expect(page.locator("#settingCompletionVibrationCheckbox")).toBeChecked();
});
