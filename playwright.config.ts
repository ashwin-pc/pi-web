import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PLAYWRIGHT_PORT || 9876);
const authPort = port + 1;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  snapshotPathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}{ext}",
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.025,
    },
  },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "on-first-retry",
  },
  webServer: [
    {
      command: `PI_WEB_MOCK=1 PI_WEB_DEV=1 HOST=127.0.0.1 PORT=${port} PI_WEB_TOKEN= PI_WEB_CWD=$PWD PI_WEB_SESSION_UI_STATE_FILE=.pi/playwright-session-ui-state-${port}.json node --import tsx server.ts`,
      url: `http://127.0.0.1:${port}`,
      reuseExistingServer: true,
      timeout: 20_000,
    },
    {
      command: `PI_WEB_MOCK=1 PI_WEB_DEV=1 HOST=127.0.0.1 PORT=${authPort} PI_WEB_TOKEN=test-secret PI_WEB_CWD=$PWD PI_WEB_SESSION_UI_STATE_FILE=.pi/playwright-session-ui-state-${authPort}.json node --import tsx server.ts`,
      url: `http://127.0.0.1:${authPort}`,
      reuseExistingServer: true,
      timeout: 20_000,
    },
  ],
  projects: [
    { name: "mobile", use: { ...devices["Pixel 5"] }, testIgnore: "**/token.spec.ts" },
    { name: "tablet", use: { viewport: { width: 768, height: 1024 } }, testIgnore: "**/token.spec.ts" },
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } }, testIgnore: "**/token.spec.ts" },
    { name: "auth", use: { baseURL: `http://127.0.0.1:${authPort}`, viewport: { width: 1280, height: 800 } }, testMatch: "**/token.spec.ts" },
  ],
});
