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

test("bucket names edit, persist, reset, and propagate to bucket controls", async ({ page }) => {
  await page.goto("/");
  await openSessionDrawerFooterAction(page, "Settings");
  await page.locator("#settingsNavNewSessions").click();

  const rows = page.locator(".settingsBucketNameRow");
  await expect(rows).toHaveCount(8);
  await expect(rows.locator(".settingsBucketNameSwatch")).toHaveCount(8);
  await expect(rows.locator(".settingsBucketNameDefault")).toHaveText(["Blue", "Purple", "Yellow", "Red", "Green", "Orange", "Cyan", "Pink"]);
  const cyan = page.getByRole("textbox", { name: "Cyan bucket name" });
  await expect(cyan).toHaveAttribute("maxlength", "40");
  await expect(cyan).toHaveAttribute("placeholder", "Cyan");

  await cyan.fill("  Builds  ");
  await cyan.press("Tab");
  await expect.poll(async () => (await (await page.request.get("/api/session-ui-state")).json()).sessionUiState.bucketLabels).toEqual({ cyan: "Builds" });
  await expect(cyan).toHaveValue("Builds");

  await page.locator("#settingsCloseButton").click();
  await page.locator("#sessionButton").click();
  await expect(page.getByRole("button", { name: "Mark multiple sessions Builds" })).toBeVisible();
  await page.keyboard.press("Escape");
  await openSessionDrawerFooterAction(page, "Settings");
  await page.locator("#settingsNavNewSessions").click();
  await expect(page.getByRole("textbox", { name: "Cyan bucket name" })).toHaveValue("Builds");

  await page.getByRole("textbox", { name: "Cyan bucket name" }).fill("");
  await page.getByRole("textbox", { name: "Cyan bucket name" }).press("Tab");
  await expect.poll(async () => (await (await page.request.get("/api/session-ui-state")).json()).sessionUiState.bucketLabels).toEqual({});
  await page.locator("#settingsCloseButton").click();
  await page.locator("#sessionButton").click();
  await expect(page.getByRole("button", { name: "Mark multiple sessions Cyan" })).toBeVisible();
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
