/// <reference lib="webworker" />

import { clientsClaim } from "workbox-core";
import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import { CacheFirst } from "workbox-strategies";

declare let self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<unknown> };
declare const __PI_WEB_AVATAR_CACHE_REVISION__: string;

type CompletionPayload = {
  type: "run-complete";
  sessionId: string;
  title?: string;
  completedAt?: string;
};

self.skipWaiting();
clientsClaim();
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Avatars are cached only after selection/use, rather than downloading every
// animation during service-worker installation. Changed artwork at the same
// URL gets a new content-derived namespace on deployment.
const avatarCachePrefix = "pi-web-avatars-";
const avatarCacheName = `${avatarCachePrefix}${__PI_WEB_AVATAR_CACHE_REVISION__}`;
registerRoute(
  ({ url }) => url.origin === self.location.origin && /^\/avatars\/[^/]+\/(?:still\.png|icon\.png|new-session\.apng|new-session\.webm)$/.test(url.pathname),
  new CacheFirst({ cacheName: avatarCacheName }),
);
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(names => Promise.all(names
    .filter(name => name.startsWith(avatarCachePrefix) && name !== avatarCacheName)
    .map(name => caches.delete(name)))));
});

const preferencesCacheName = "pi-web-device-preferences";
const preferencesUrl = new URL("/__pi-web/device-preferences", self.location.origin).href;

function completionUrl(sessionId: string) {
  const url = new URL("/", self.location.origin);
  url.searchParams.set("sessionId", sessionId);
  return url.href;
}

async function completionVibrationEnabled() {
  const response = await (await caches.open(preferencesCacheName)).match(preferencesUrl);
  if (!response) return true;
  return Boolean((await response.json().catch(() => ({})))?.completionVibration);
}

self.addEventListener("message", (event) => {
  if (event.data?.type !== "pi-web-device-preferences") return;
  event.waitUntil(caches.open(preferencesCacheName).then((cache) => cache.put(preferencesUrl, new Response(JSON.stringify({
    completionVibration: Boolean(event.data.completionVibration),
  }), { headers: { "content-type": "application/json" } }))));
});

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let payload: CompletionPayload;
    try {
      payload = event.data?.json() as CompletionPayload;
    } catch {
      return;
    }
    if (payload?.type !== "run-complete" || !payload.sessionId) return;

    const options: NotificationOptions & { vibrate?: number[] } = {
      body: payload.title || "A session finished running.",
      icon: "/identity/icon.png",
      badge: "/identity/icon.png",
      silent: false,
      vibrate: await completionVibrationEnabled() ? [180, 90, 240] : undefined,
      tag: `pi-web-run-complete:${payload.sessionId}:${payload.completedAt || "latest"}`,
      data: { url: completionUrl(payload.sessionId) },
    };
    const config = await fetch("/identity/config.json", { cache: "no-store" }).then(response => response.json()).catch(() => ({}));
    const appName = typeof config.name === "string" && config.name.trim() ? config.name : "Pi Web";
    await self.registration.showNotification(`${appName} — Run complete`, options);
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const url = typeof event.notification.data?.url === "string" ? event.notification.data.url : self.location.origin;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      await existing.navigate(url);
      await existing.focus();
      return;
    }
    await self.clients.openWindow(url);
  })());
});
