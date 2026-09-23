import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { isolatedAuthEnv } from "../../../tests/auth-isolation.js";

const hostRoot = resolve(import.meta.dirname, "../../..");
const port = Number(process.env.PLAYWRIGHT_PORT || 9876);
const runtimeDir = mkdtempSync(join(tmpdir(), "pi-web-wavy-playwright-"));

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  fullyParallel: true,
  workers: 1,
  retries: process.env.CI ? 2 : 1,
  outputDir: resolve(import.meta.dirname, "test-results"),
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    serviceWorkers: "block",
    trace: process.env.PI_WEB_E2E_TRACE === "1" ? "on-first-retry" : "off",
  },
  webServer: {
    cwd: hostRoot,
    env: Object.fromEntries(Object.entries(isolatedAuthEnv()).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    command: `PI_WEB_DEV=0 NODE_ENV=test PI_WEB_MOCK=1 HOST=127.0.0.1 PORT=${port} PI_WEB_AUTH_STORE=${JSON.stringify(join(runtimeDir, "auth.json"))} PI_WEB_AUTH_MODE=none PI_WEB_AUTH_POLICY= PI_WEB_AUTH_METHODS= PI_WEB_AUTH_ORIGIN=http://127.0.0.1:${port} PI_WEB_AUTH_TRUSTED_HEADER= PI_WEB_AUTH_PROXY_PEERS= PI_WEB_TOKEN= PI_WEB_CWD=$PWD PI_WEB_SETTINGS_FILE=${JSON.stringify(join(runtimeDir, "settings.json"))} PI_WEB_SESSION_UI_STATE_FILE=${JSON.stringify(join(runtimeDir, "session-ui.json"))} node --import tsx server.ts`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 20_000,
  },
  projects: [
    { name: "mobile", use: { ...devices["Pixel 5"] } },
    { name: "tablet", use: { viewport: { width: 768, height: 1024 } } },
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } } },
  ],
});
