import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedAuthEnv } from "../auth-isolation.js";

test("restored custom selection without an upload renders fallback artwork", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop" && info.project.name !== "isolated", "Isolated server/browser regression");
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const dir = await mkdtemp(join(tmpdir(), "pi-identity-missing-custom-"));
  await writeFile(join(dir, "settings.json"), JSON.stringify({ version: 1, identity: { name: "Backup Brand", shortName: "Backup", avatar: { type: "custom" }, revision: 3 } }));
  const child = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
    env: { ...isolatedAuthEnv(), PI_WEB_AUTH_STORE: join(dir, "auth.json"), PI_WEB_AUTH_MODE: "none", PI_WEB_TOKEN: "", PI_WEB_MOCK: "1", PI_WEB_CWD: process.cwd(), PI_WEB_DEV: "0", NODE_ENV: "test", HOST: "127.0.0.1", PORT: String(port), PI_WEB_SETTINGS_FILE: join(dir, "settings.json"), PI_WEB_SESSION_UI_STATE_FILE: join(dir, "sessions.json") },
    stdio: "ignore",
  });
  const context = await browser.newContext({ serviceWorkers: "block", baseURL: `http://127.0.0.1:${port}` });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { ready = (await context.request.get("/identity/config.json")).ok(); if (ready) break; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    expect(ready).toBe(true);
    const page = await context.newPage();
    await page.goto("/");
    await expect(page).toHaveTitle("Backup Brand");
    const still = page.locator("#identityNewSessionStill");
    await expect(still).toHaveAttribute("src", "/identity/avatar.png?v=3");
    await expect.poll(() => still.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    const fab = page.locator(".actionLauncherToggle img");
    await expect(fab).toHaveAttribute("src", "/identity/avatar.png?v=3");
    await expect.poll(() => fab.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    expect((await context.request.get("/identity/avatar.png")).ok()).toBe(true);
    const login = await page.goto("/api/auth/login");
    expect(login?.status()).toBe(200);
    await expect(page).toHaveTitle("Backup Brand");
    await expect(page.locator(".avatarAnimation")).toHaveCount(1);
    await expect(page.locator(".avatarAnimation")).toHaveAttribute("src", "/avatars/current-pi/new-session.apng");
  } finally {
    await context.close();
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
