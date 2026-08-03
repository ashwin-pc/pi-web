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
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      devOptions: { enabled: true, type: "module" },
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
      injectManifest: {
        // Do not precache HTML or register a navigation route. Native browser
        // navigations must continue to handle redirects from auth proxies.
        globPatterns: ["assets/{index,artifactPreview,render}-*.{js,css}", "*.{svg,png,webmanifest}"],
      },
    }),
  ],
  server: {
    // Runtime uploads and generated artifacts live below .pi. Watching those
    // files makes Vite reload the page as soon as an attachment is persisted.
    watch: { ignored: ["**/.pi/**"] },
    // Dev server is protected by PI_WEB_TOKEN and commonly accessed via
    // Tailscale MagicDNS names like http://studio:8787.
    allowedHosts: true,
  },
});
