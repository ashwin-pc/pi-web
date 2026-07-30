import { expect, test } from "@playwright/test";
import { openLauncherAction } from "./helpers/actionLauncher.js";

// These tests run against the auth-enabled server (PI_WEB_TOKEN=test-secret).
// The "auth" playwright project sets baseURL to the auth port.

const CORRECT_TOKEN = "test-secret";
const WRONG_TOKEN = "wrong";

test.beforeEach(async ({ page, context }) => {
  // Clear stored token before each test
  await context.clearCookies();
  await context.addInitScript(() => localStorage.removeItem("pi-web-token"));
});

test.describe("token overlay", () => {
  test("shows overlay on page load when no token stored", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#tokenOverlay")).toBeVisible();
    await expect(page.locator("#tokenInput")).toBeVisible();
    await expect(page.locator("#tokenScanButton")).toBeVisible();
  });

  test("main UI is behind the overlay when token required", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#tokenOverlay")).toBeVisible();
    // prompt should exist in DOM but not be interactable (overlay covers it)
    const overlayBox = await page.locator("#tokenOverlay").boundingBox();
    const promptBox = await page.locator("#prompt").boundingBox();
    expect(overlayBox).toBeTruthy();
    expect(promptBox).toBeTruthy();
    // overlay covers full viewport
    expect(overlayBox!.width).toBeGreaterThan(500);
    expect(overlayBox!.height).toBeGreaterThan(400);
  });

  test("wrong token keeps overlay visible", async ({ page }) => {
    await page.goto("/");
    await page.locator("#tokenInput").fill(WRONG_TOKEN);
    await page.locator("#tokenForm button[type=submit]").click();
    await expect(page.locator("#tokenOverlay")).toBeVisible();
  });

  test("correct token dismisses overlay and loads messages", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#tokenOverlay")).toBeVisible();
    await page.locator("#tokenInput").fill(CORRECT_TOKEN);
    await page.locator("#tokenForm button[type=submit]").click();
    await expect(page.locator("#tokenOverlay")).toBeHidden({ timeout: 5000 });
    await expect(page.locator("#prompt")).toBeVisible();
    await expect(page.locator("#messages")).toBeVisible();
  });

  test("token persisted in localStorage after login", async ({ page }) => {
    await page.goto("/");
    await page.locator("#tokenInput").fill(CORRECT_TOKEN);
    await page.locator("#tokenForm button[type=submit]").click();
    await expect(page.locator("#tokenOverlay")).toBeHidden({ timeout: 5000 });

    const stored = await page.evaluate(() => localStorage.getItem("pi-web-token"));
    expect(stored).toBe(CORRECT_TOKEN);
  });

  test("token in URL is accepted and cleaned from address bar", async ({ page }) => {
    await page.goto(`/?token=${CORRECT_TOKEN}`);
    await expect(page.locator("#tokenOverlay")).toBeHidden({ timeout: 5000 });
    await expect(page.locator("#prompt")).toBeVisible();
    expect(page.url()).not.toContain("token=");
  });

  test("settings reveals token QR only after explicit action", async ({ page }) => {
    await page.goto("/");
    await page.locator("#tokenInput").fill(CORRECT_TOKEN);
    await page.locator("#tokenForm button[type=submit]").click();
    await expect(page.locator("#tokenOverlay")).toBeHidden({ timeout: 5000 });

    await page.locator("#sessionButton").click();
    await openLauncherAction(page, "Settings");
    await expect(page.locator("#tokenShareSection")).toBeVisible();
    await expect(page.locator("#tokenShareQr")).toBeHidden();
    await expect(page.locator("#tokenShareUrl")).toBeHidden();
    await expect(page.locator("#tokenShareUrl")).toHaveValue("");

    await page.locator("#tokenShareCopyButton").click();
    await expect(page.locator("#tokenShareQr")).toBeHidden();
    await expect(page.locator("#tokenShareUrl")).toBeHidden();
    await expect(page.locator("#tokenShareUrl")).toHaveValue("");

    await page.locator("#tokenShareFullscreenButton").click();
    await expect(page.locator("#tokenShareQr svg")).toBeVisible();
    await expect(page.locator("#tokenShareUrl")).toHaveValue(/token=test-secret/);
    await expect(page.locator("#tokenShareFullscreen")).toBeVisible();
    await expect(page.locator("#tokenShareFullscreenQr svg")).toBeVisible();
    await page.locator("#tokenShareFullscreenCloseButton").click();
    await expect(page.locator("#tokenShareFullscreen")).toBeHidden();
  });
});

test.describe("/logout slash command", () => {
  test("clears token and shows overlay again", async ({ page }) => {
    // Log in first
    await page.goto("/");
    await page.locator("#tokenInput").fill(CORRECT_TOKEN);
    await page.locator("#tokenForm button[type=submit]").click();
    await expect(page.locator("#tokenOverlay")).toBeHidden({ timeout: 5000 });

    // Now logout
    await page.locator("#prompt").fill("/logout");
    await page.locator("#primaryButton").click();

    await expect(page.locator("#tokenOverlay")).toBeVisible();

    const stored = await page.evaluate(() => localStorage.getItem("pi-web-token"));
    expect(stored).toBeNull();
  });

  test("can log back in after logout", async ({ page }) => {
    await page.goto("/");
    await page.locator("#tokenInput").fill(CORRECT_TOKEN);
    await page.locator("#tokenForm button[type=submit]").click();
    await expect(page.locator("#tokenOverlay")).toBeHidden({ timeout: 5000 });

    await page.locator("#prompt").fill("/logout");
    await page.locator("#primaryButton").click();
    await expect(page.locator("#tokenOverlay")).toBeVisible();

    await page.locator("#tokenInput").fill(CORRECT_TOKEN);
    await page.locator("#tokenForm button[type=submit]").click();
    await expect(page.locator("#tokenOverlay")).toBeHidden({ timeout: 5000 });
    await expect(page.locator("#prompt")).toBeVisible();
  });
});
