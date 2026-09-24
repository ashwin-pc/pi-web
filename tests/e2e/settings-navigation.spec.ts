import { expect, test } from "@playwright/test";
import { openSessionDrawerFooterAction } from "./helpers/sessionDrawer.js";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

test("desktop Preferences and System use scoped navigation and focused pages", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("pi-web.layout.panel-width.settings", "380px"));
  await openSessionDrawerFooterAction(page, "Preferences");

  const panel = page.locator("#settingsPanel");
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("data-scope", "preferences");
  await expect(panel.getByRole("heading", { name: "Preferences" })).toBeVisible();
  await expect(page.locator("#settingsNavigation")).toBeVisible();
  await expect(page.locator("#settingsNavDiagnostics")).toBeHidden();
  await expect(page.locator("#settingsNavAccess")).toBeHidden();
  await expect(page.locator("#settingsNavExtensions")).toBeVisible();
  await expect(page.locator("#settingsNavBuckets")).toBeVisible();
  await expect(page.locator("#settingsPageAppearance")).toBeVisible();
  await expect(page.locator("#settingsPageNotifications")).toBeHidden();
  await expect(page.locator("#settingsNavAppearance")).toHaveAttribute("aria-current", "page");

  await page.locator("#settingsNavNotifications").click();
  await expect(page.locator("#settingsPageAppearance")).toBeHidden();
  await expect(page.locator("#settingsPageNotifications")).toBeVisible();
  await expect(page.locator("#settingRunNotificationsCheckbox")).toBeVisible();
  await expect(page.locator("#settingsNavNotifications")).toHaveAttribute("aria-current", "page");

  await page.locator("#settingsCloseButton").click();
  await openSessionDrawerFooterAction(page, "System");
  await expect(panel).toHaveAttribute("data-scope", "system");
  await expect(panel.locator(".settingsDesktopTitle")).toBeVisible();
  await expect(page.locator("#settingsNavAppearance")).toBeHidden();
  await expect(page.locator("#settingsNavBuckets")).toBeHidden();
  await expect(page.locator("#settingsNavExtensions")).toBeHidden();
  await expect(page.locator("#settingsNavExtensionHealth")).toBeVisible();
  await page.locator("#settingsSearchInput").fill("debug report");
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

test("global Buckets page reorders, renames, persists, and propagates to bucket controls", async ({ page }, testInfo) => {
  const selectSettingsPage = async (selector: string) => {
    if (!await page.locator("#settingsNavigation").isVisible()) await page.locator("#settingsBackButton").click();
    await page.locator(selector).click();
  };
  await page.goto("/");
  await openSessionDrawerFooterAction(page, "Preferences");
  await page.locator("#settingsSearchInput").fill("global sessions organization");
  await expect(page.locator("#settingsNavBuckets")).toBeVisible();
  await expect(page.locator("#settingsNavNewSessions")).toBeHidden();
  await page.locator("#settingsSearchInput").press("Enter");
  await expect(page.locator("#settingsPageBuckets")).toBeVisible();
  await expect(page.locator("#settingsPageBuckets")).toContainText("across all sessions");
  if (testInfo.project.name === "mobile") await page.locator("#settingsBackButton").click();
  await page.locator("#settingsSearchInput").fill("");
  if (testInfo.project.name === "mobile") await page.locator("#settingsNavBuckets").click();

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

  // Reordering is keyboard/mobile-friendly, uses the custom label, and keeps stable color IDs.
  for (let index = 0; index < 6; index += 1) {
    await page.locator('[data-bucket-color="cyan"] .settingsBucketOrderButton').first().click();
  }
  await expect(page.locator('[data-bucket-color="cyan"] .settingsBucketOrderButton').first()).toBeDisabled();
  await expect(page.getByRole("button", { name: "Move Pink bucket down" })).toBeDisabled();
  await expect(rows.locator(".settingsBucketNameDefault")).toHaveText(["Cyan", "Blue", "Purple", "Yellow", "Red", "Green", "Orange", "Pink"]);
  await selectSettingsPage("#settingsNavNewSessions");
  await expect(page.locator("#settingsPageNewSessions #settingBucketNames")).toHaveCount(0);
  await expect(page.locator("#settingDefaultBucketColorSelect option")).toHaveText(["No default bucket", "Builds", "Blue", "Purple", "Yellow", "Red", "Green", "Orange", "Pink"]);
  await expect.poll(async () => (await (await page.request.get("/api/session-ui-state")).json()).sessionUiState.bucketOrder)
    .toEqual(["cyan", "blue", "purple", "yellow", "red", "green", "orange", "pink"]);

  await page.locator("#settingsCloseButton").click();
  await page.locator("#sessionButton").click();
  await expect(page.getByRole("button", { name: "Mark multiple sessions Builds" })).toBeVisible();
  await expect(page.locator(".sessionBucketFilter").first()).toHaveClass(/marker-cyan/);
  await page.keyboard.press("Escape");
  await page.reload();
  await openSessionDrawerFooterAction(page, "Preferences");
  await expect(page.locator("#settingsNavBuckets .settingsNavSummary")).toHaveText("1 custom · Custom order");
  await page.locator("#settingsNavBuckets").click();
  await expect(page.getByRole("textbox", { name: "Cyan bucket name" })).toHaveValue("Builds");
  await expect(rows.locator(".settingsBucketNameDefault").first()).toHaveText("Cyan");
  await expect(page.getByRole("button", { name: "Move Builds bucket up" })).toBeDisabled();

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
  await openSessionDrawerFooterAction(page, "Preferences");

  const panel = page.locator("#settingsPanel");
  await expect(panel).toBeVisible();
  await expect(page.locator("#settingsNavigation")).toBeVisible();
  await expect(page.locator("#settingsContent")).toBeHidden();
  await expect(page.locator("#settingsBackButton")).toBeHidden();

  await page.locator("#settingsNavBuckets").click();
  await expect(page.locator("#settingsNavigation")).toBeHidden();
  await expect(page.locator("#settingsContent")).toBeVisible();
  await expect(page.locator("#settingsBackButton")).toBeVisible();
  await expect(page.locator("#settingsBackButton")).toHaveAttribute("aria-label", "Back to preferences categories");
  await expect(page.locator("#settingsMobileTitle")).toHaveText("Buckets");
  await expect(page.locator("#settingsPageBuckets")).toContainText("across all sessions");
  await expect(page.getByRole("group", { name: "Bucket names and display order" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator("#settingsNavigation")).toBeVisible();
  await expect(page.locator("#settingsContent")).toBeHidden();
  await expect(panel).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});
