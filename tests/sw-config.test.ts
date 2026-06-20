import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards the generated service worker's navigation strategy.
 *
 * Regression: vite-plugin-pwa registers an SPA NavigationRoute bound to the
 * *precached* index.html, and it is registered before runtimeCaching. Left
 * alone it shadows our NetworkFirst navigate route, so a stale service worker
 * keeps serving the old precached HTML/JS forever — a deploy looks like it
 * "did nothing" on the client (especially iOS). We deny-list every navigation
 * from that precache fallback so navigations fall through to NetworkFirst and
 * a reload always fetches fresh HTML.
 */
describe("service worker navigation strategy", () => {
  const swPath = join(process.cwd(), "dist", "sw.js");

  it("denylists the precache navigation fallback and serves navigations NetworkFirst", async () => {
    if (!existsSync(swPath)) {
      // dist/ not built in this environment (e.g. unit-only CI without build).
      return;
    }
    const sw = await readFile(swPath, "utf8");

    // The SPA precache NavigationRoute must be present but neutralised by a
    // catch-all denylist so it never serves stale precached HTML.
    expect(sw).toMatch(/NavigationRoute/);
    expect(sw).toMatch(/denylist:\[\/\.\/\]/);

    // Navigations must be handled by a NetworkFirst route (fresh HTML online,
    // cached fallback offline).
    expect(sw).toMatch(/"navigate"===\w+\.mode/);
    expect(sw).toMatch(/NetworkFirst\(\{cacheName:"pages"/);

    // The auto-update primitives must stay in place so a new SW activates and
    // claims open clients immediately.
    expect(sw).toMatch(/skipWaiting\(\)/);
    expect(sw).toMatch(/clientsClaim\(\)/);
    expect(sw).toMatch(/cleanupOutdatedCaches\(\)/);
  });
});
