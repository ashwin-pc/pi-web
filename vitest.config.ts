import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@ashwin-pc/pi-web/extensions": new URL("./src/extensions.ts", import.meta.url).pathname },
  },
  test: {
    // Integration suites spawn TypeScript/Vite servers. Avoid saturating CPU
    // while the parallel test runner also builds production assets.
    maxWorkers: Number(process.env.PI_WEB_UNIT_WORKERS || 1),
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/e2e/**", "node_modules/**", "dist/**"],
  },
});
