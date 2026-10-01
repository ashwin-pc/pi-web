import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// A content-derived revision keeps cached motion offline across unchanged
// builds, but an artwork replacement at the same URL changes the cache name.
export function avatarAssetRevision(root = fileURLToPath(new URL("./public/avatars/", import.meta.url))) {
  const hash = createHash("sha256");
  function visit(directory: string, relative = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = join(directory, entry.name);
      const key = `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(path, key);
      else if (entry.isFile()) hash.update(key).update("\0").update(readFileSync(path));
    }
  }
  visit(root);
  return hash.digest("hex").slice(0, 16);
}

export default defineConfig({
  appType: "spa",
  define: { __PI_WEB_AVATAR_CACHE_REVISION__: JSON.stringify(avatarAssetRevision()) },
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
      includeAssets: ["apple-touch-icon.png", "pwa-192x192.png", "pwa-512x512.png", "avatars/current-pi/still.png"],
      // The server owns /manifest.webmanifest and updates it with identity.
      // Generating a static plugin manifest would also add it to the precache.
      manifest: false,
      injectManifest: {
        // Do not precache HTML or register a navigation route. Native browser
        // navigations must continue to handle redirects from auth proxies.
        globPatterns: ["assets/{index,artifactPreview,render}-*.{js,css}", "*.{svg,png}"],
        globIgnores: ["manifest.webmanifest"],
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
