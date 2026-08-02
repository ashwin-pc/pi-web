import type { ApiClient } from "../app/api.js";
import type { AppElements } from "../app/elements.js";
import {
  completionSoundEnabled,
  completionVibrationEnabled,
  playCompletionAlerts,
  setCompletionSoundEnabled,
  setCompletionVibrationEnabled,
} from "../app/completionAlerts.js";

const installationStorageKey = "pi-web-push-installation-id";

function installationId() {
  try {
    const existing = localStorage.getItem(installationStorageKey);
    if (existing) return existing;
    const created = crypto.randomUUID();
    localStorage.setItem(installationStorageKey, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

function applicationServerKey(value: string) {
  const padded = `${value}${"=".repeat((4 - value.length % 4) % 4)}`;
  const bytes = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bytes, (character) => character.charCodeAt(0));
}

export function createRunNotifications(options: {
  elements: AppElements;
  api: ApiClient;
  onError: (error: unknown) => void;
}) {
  const { elements, api, onError } = options;
  const checkbox = elements.settingRunNotificationsCheckbox;
  const soundCheckbox = elements.settingCompletionSoundCheckbox;
  const vibrationCheckbox = elements.settingCompletionVibrationCheckbox;
  const status = elements.settingRunNotificationsStatus;
  const testButton = elements.settingRunNotificationsTestButton;
  const id = installationId();
  let updating = false;

  function supported() {
    return window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  }

  function setStatus(message: string, isError = false) {
    status.textContent = message;
    status.classList.toggle("error", isError);
  }

  async function registration() {
    const value = await navigator.serviceWorker.getRegistration();
    if (!value) throw new Error("Install or reload the production PWA before enabling notifications.");
    return value;
  }

  async function refresh() {
    if (!supported()) {
      checkbox.checked = false;
      checkbox.disabled = true;
      testButton.disabled = true;
      setStatus(window.isSecureContext ? "This browser does not support Web Push." : "Notifications require HTTPS or localhost.");
      return;
    }
    if (Notification.permission === "denied") {
      checkbox.checked = false;
      checkbox.disabled = true;
      testButton.disabled = true;
      setStatus("Notifications are blocked in this browser’s site settings.", true);
      return;
    }
    const worker = await navigator.serviceWorker.getRegistration();
    const subscription = await worker?.pushManager.getSubscription();
    checkbox.checked = Boolean(subscription && Notification.permission === "granted");
    checkbox.disabled = !worker || updating;
    testButton.disabled = !worker || !checkbox.checked || updating;
    setStatus(!worker
      ? "Available after the production PWA service worker is installed."
      : checkbox.checked
        ? "Enabled on this browser. Clicking a notification opens the completed session."
        : "Disabled on this browser.");
  }

  async function enable() {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error(permission === "denied" ? "Notifications were blocked by the browser." : "Notification permission was not granted.");
    const worker = await registration();
    const statusResponse = await fetch("/api/push/status", { headers: api.headers() });
    const statusData = await statusResponse.json().catch(() => ({}));
    if (!statusResponse.ok || !statusData.vapidPublicKey) throw new Error(statusData.error || "Could not load push configuration.");
    const existing = await worker.pushManager.getSubscription();
    const subscription = existing || await worker.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(String(statusData.vapidPublicKey)),
    });
    const response = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: api.headers(),
      body: JSON.stringify({ installationId: id, subscription: subscription.toJSON() }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      if (!existing) await subscription.unsubscribe().catch(() => undefined);
      throw new Error(data.error || "Could not save the push subscription.");
    }
  }

  async function disable() {
    const worker = await navigator.serviceWorker.getRegistration();
    const subscription = await worker?.pushManager.getSubscription();
    const response = await fetch("/api/push/subscribe", {
      method: "DELETE",
      headers: api.headers(),
      body: JSON.stringify({ installationId: id, endpoint: subscription?.endpoint }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.error || "Could not disable notifications.");
    await subscription?.unsubscribe();
  }

  async function syncDevicePreferences() {
    if (!("serviceWorker" in navigator)) return;
    const worker = await navigator.serviceWorker.ready;
    worker.active?.postMessage({
      type: "pi-web-device-preferences",
      completionVibration: completionVibrationEnabled(),
    });
  }

  async function sendTestNotification() {
    testButton.disabled = true;
    try {
      const worker = await registration();
      const options: NotificationOptions & { vibrate?: number[] } = {
        body: "Notification, sound, and vibration test.",
        icon: "/pwa-192x192.png",
        badge: "/pwa-192x192.png",
        silent: false,
        vibrate: completionVibrationEnabled() ? [180, 90, 240] : undefined,
        tag: `pi-web-local-test:${Date.now()}`,
        data: { url: window.location.href },
      };
      await worker.showNotification("pi-web — Test notification", options);
      playCompletionAlerts();
      setStatus("Test alert sent. Check the notification, completion sound, and vibration.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
      onError(error);
    } finally {
      testButton.disabled = !checkbox.checked;
    }
  }

  async function toggle() {
    if (updating) return;
    updating = true;
    checkbox.disabled = true;
    testButton.disabled = true;
    setStatus(checkbox.checked ? "Enabling notifications…" : "Disabling notifications…");
    try {
      if (checkbox.checked) await enable();
      else await disable();
    } catch (error) {
      onError(error);
    } finally {
      updating = false;
      await refresh().catch(onError);
    }
  }

  function init() {
    soundCheckbox.checked = completionSoundEnabled();
    vibrationCheckbox.checked = completionVibrationEnabled();
    soundCheckbox.addEventListener("change", () => {
      void setCompletionSoundEnabled(soundCheckbox.checked).then(() => {
        setStatus(soundCheckbox.checked ? "Completion sound enabled for this browser." : "Completion sound disabled for this browser.");
      }).catch(onError);
    });
    vibrationCheckbox.addEventListener("change", () => {
      setCompletionVibrationEnabled(vibrationCheckbox.checked);
      void syncDevicePreferences().catch(onError);
      setStatus(vibrationCheckbox.checked ? "Completion vibration enabled where supported." : "Completion vibration disabled for this browser.");
    });
    checkbox.addEventListener("change", () => void toggle());
    testButton.addEventListener("click", () => void sendTestNotification());
    void syncDevicePreferences().catch(onError);
    void refresh().catch(onError);
    navigator.serviceWorker?.addEventListener("controllerchange", () => void refresh().catch(onError));
  }

  return { init, refresh };
}
