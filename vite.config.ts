import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  appType: "spa",
  build: {
    rollupOptions: {
      input: {
        index: "index.html",
        artifactPreview: "artifact-preview.html",
      },
    },
  },
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
        // Always send document navigations through the server. Serving cached HTML
        // can bypass an auth proxy (such as Codespaces) after its session expires,
        // leaving a visible app shell whose authenticated API requests all fail.
        // Immutable assets remain precached, but HTML is deliberately excluded.
        globPatterns: ["assets/{index,artifactPreview,render}-*.{js,css}", "*.{svg,png,webmanifest}"],
        runtimeCaching: [
          {
            urlPattern: ({ request }) => request.mode === "navigate",
            handler: "NetworkOnly",
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
