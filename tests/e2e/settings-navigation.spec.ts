import { expect, test } from "@playwright/test";
import { openSessionDrawerFooterAction } from "./helpers/sessionDrawer.js";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

test("desktop settings uses category navigation and focused pages", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("pi-web.layout.panel-width.settings", "380px"));
  await openSessionDrawerFooterAction(page, "Settings");

  const panel = page.locator("#settingsPanel");
  await expect(panel).toBeVisible();
  await expect(page.locator("#settingsNavigation")).toBeVisible();
  await expect(page.locator("#settingsPageAppearance")).toBeVisible();
  await expect(page.locator("#settingsPageNotifications")).toBeHidden();
  await expect(page.locator("#settingsNavAppearance")).toHaveAttribute("aria-current", "page");

  await page.locator("#settingsNavNotifications").click();
  await expect(page.locator("#settingsPageAppearance")).toBeHidden();
  await expect(page.locator("#settingsPageNotifications")).toBeVisible();
  await expect(page.locator("#settingRunNotificationsCheckbox")).toBeVisible();
  await expect(page.locator("#settingsNavNotifications")).toHaveAttribute("aria-current", "page");

  await page.locator("#settingsSearchInput").fill("debug report");
  await expect(page.locator("#settingsNavAppearance")).toBeHidden();
  await expect(page.locator("#settingsNavDiagnostics")).toBeVisible();
  await page.locator("#settingsSearchInput").press("Enter");
  await expect(page.locator("#settingsPageDiagnostics")).toBeVisible();
  await expect(page.locator("#openDebugDiagnosticsButton")).toBeVisible();

  const panelBox = await panel.boundingBox();
  const navigationBox = await page.locator("#settingsNavigation").boundingBox();
  const contentBox = await page.locator("#settingsContent").boundingBox();
  expect(panelBox?.width).toBeGreaterThanOrEqual(680);
  expect(navigationBox?.x).toBeLessThan(contentBox?.x ?? 0);
});

test("mobile settings drills into one page and Escape returns before closing", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile");
  await page.goto("/");
  await openSessionDrawerFooterAction(page, "Settings");

  const panel = page.locator("#settingsPanel");
  await expect(panel).toBeVisible();
  await expect(page.locator("#settingsNavigation")).toBeVisible();
  await expect(page.locator("#settingsContent")).toBeHidden();
  await expect(page.locator("#settingsBackButton")).toBeHidden();

  await page.locator("#settingsNavNotifications").click();
  await expect(page.locator("#settingsNavigation")).toBeHidden();
  await expect(page.locator("#settingsContent")).toBeVisible();
  await expect(page.locator("#settingsBackButton")).toBeVisible();
  await expect(page.locator("#settingsMobileTitle")).toHaveText("Notifications");
  await expect(page.locator("#settingRunNotificationsCheckbox")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator("#settingsNavigation")).toBeVisible();
  await expect(page.locator("#settingsContent")).toBeHidden();
  await expect(panel).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});
