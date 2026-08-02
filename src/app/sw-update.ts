/**
 * Auto-reload on service-worker update.
 *
 * With `registerType: "autoUpdate"` the generated SW already calls
 * `skipWaiting()` + `clientsClaim()`, so a new SW activates as soon as it
 * installs.  The missing piece is a client-side `controllerchange` listener
 * that reloads the page when that happens — without it, long-lived tabs keep
 * running the old JS bundles indefinitely.
 *
 * See: GitHub issue #9
 */
export function initSwAutoReload(): void {
  if (!("serviceWorker" in navigator)) return;

  // The development worker intentionally has an empty precache manifest. Keep
  // it registered so Web Push can be exercised locally without caching Vite
  // assets or reloading the page whenever the worker source changes.
  if (Boolean((import.meta as any).env?.DEV)) return;

  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
}
