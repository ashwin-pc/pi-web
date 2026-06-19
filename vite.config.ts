import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  appType: "spa",
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "pi web",
        short_name: "pi",
        description: "pi coding agent web UI",
        theme_color: "#1a1a1a",
        background_color: "#1a1a1a",
        display: "standalone",
        scope: "/",
        start_url: "/",
        icons: [
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
      },
      workbox: {
        // Navigations must be NETWORK-FIRST so a reload always fetches fresh
        // HTML (and therefore the current hashed asset names). vite-plugin-pwa
        // always registers an SPA NavigationRoute bound to the *precached*
        // index.html, and it is registered before runtimeCaching — so left
        // alone it shadows the NetworkFirst route and a stale service worker
        // keeps serving old HTML/JS forever (a deploy looks like it "did
        // nothing", especially on iOS). Deny-list every navigation from that
        // precache fallback so navigations fall through to the NetworkFirst
        // route below, which serves fresh HTML online and the cached copy
        // offline.
        navigateFallback: "index.html",
        navigateFallbackDenylist: [/./],
        globPatterns: ["index.html", "assets/index-*.{js,css}", "*.{svg,png,webmanifest}"],
        runtimeCaching: [
          {
            urlPattern: ({ request }) => request.mode === "navigate",
            handler: "NetworkFirst",
            options: {
              cacheName: "pages",
              networkTimeoutSeconds: 3,
            },
          },
        ],
      },
    }),
  ],
  server: {
    // Dev server is protected by PI_WEB_TOKEN and commonly accessed via
    // Tailscale MagicDNS names like http://studio:8787.
    allowedHosts: true,
  },
});
