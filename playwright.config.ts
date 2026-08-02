import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PLAYWRIGHT_PORT || 9876);
const authOnly = process.env.PI_WEB_E2E_AUTH === "1";
const runtimeDir = mkdtempSync(join(tmpdir(), "pi-web-playwright-"));
const settingsFile = (serverPort: number) => join(runtimeDir, `settings-${serverPort}.json`);
const sessionUiStateFile = (serverPort: number) => join(runtimeDir, `session-ui-state-${serverPort}.json`);

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  // Allow Playwright's --shard option to distribute individual tests rather
  // than assigning the large pi-web.spec.ts file to a single long-running shard.
  fullyParallel: true,
  workers: 1,
  retries: process.env.CI ? 2 : 1,
  // Concurrent shard processes must not delete or overwrite each other's
  // failure artifacts while Playwright prepares its output directory.
  outputDir: join("test-results", String(port)),
  snapshotPathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}{ext}",
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.025,
    },
  },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    // Tracing this bundle can add several minutes to a retry while Playwright
    // collects and compresses source maps. Enable it only for focused debugging.
    trace: process.env.PI_WEB_E2E_TRACE === "1" ? "on-first-retry" : "off",
    // Production builds register a service worker. Its activation can reload a
    // page in the middle of an interaction, producing detached-element flakes
    // and 30-second retries that dominate the suite runtime.
    serviceWorkers: "block",
  },
  webServer: {
    // E2E runs against the preflight production build. Starting many embedded
    // Vite optimizers in parallel made sharded runs slow and resource-sensitive.
    command: `PI_WEB_DEV=0 NODE_ENV=test PI_WEB_MOCK=1 HOST=127.0.0.1 PORT=${port} PI_WEB_TOKEN=${authOnly ? "test-secret" : ""} PI_WEB_CWD=$PWD PI_WEB_SETTINGS_FILE=${JSON.stringify(settingsFile(port))} PI_WEB_SESSION_UI_STATE_FILE=${JSON.stringify(sessionUiStateFile(port))} node --import tsx server.ts`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 20_000,
  },
  projects: [
    { name: "mobile", use: { ...devices["Pixel 5"] }, testIgnore: "**/token.spec.ts" },
    { name: "tablet", use: { viewport: { width: 768, height: 1024 } }, testIgnore: "**/token.spec.ts" },
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } }, testIgnore: "**/token.spec.ts" },
    { name: "auth", use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1280, height: 800 } }, testMatch: "**/token.spec.ts" },
  ],
});
