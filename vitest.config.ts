import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@ashwin-pc/pi-web/extensions": new URL("./src/extensions.ts", import.meta.url).pathname },
  },
  test: {
    // Direct runs retain Vitest's default parallelism unless explicitly capped.
    maxWorkers: process.env.PI_WEB_UNIT_WORKERS ? Number(process.env.PI_WEB_UNIT_WORKERS) : undefined,
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/e2e/**", "node_modules/**", "dist/**"],
  },
});
