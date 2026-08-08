import { expect, test } from "@playwright/test";
import { openSessionDrawerFooterAction } from "./helpers/sessionDrawer.js";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

test("system information is available from the session drawer", async ({ page }) => {
  await page.goto("/");

  const response = await page.request.get("/api/system-info");
  expect(response.ok()).toBe(true);
  const payload = await response.json();
  expect(payload).toMatchObject({
    ok: true,
    system: {
      piWeb: { version: expect.any(String), nodeVersion: expect.stringMatching(/^v/) },
      pi: { version: expect.any(String), agentDirectory: expect.any(String) },
      host: {
        hostname: expect.any(String),
        architecture: expect.any(String),
        logicalCpuCount: expect.any(Number),
        totalMemoryBytes: expect.any(Number),
      },
    },
  });

  await openSessionDrawerFooterAction(page, "System info");
  const panel = page.locator("#systemInfoPanel");
  await expect(panel).toBeVisible();
  await expect(page.locator("#sessionDrawer")).toBeHidden();
  await expect(panel.getByRole("heading", { name: "System information" })).toBeVisible();
  await expect(panel.getByRole("heading", { name: "pi", exact: true })).toBeVisible();
  await expect(panel.getByRole("heading", { name: "pi-web runtime" })).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Host machine" })).toBeVisible();
  await expect(panel).toContainText("Agent directory");
  await expect(panel).toContainText("Operating system");
  await expect(panel.getByRole("button", { name: "Copy system report" })).toBeVisible();
});

test("settings lives in the drawer and the FAB contains session actions only", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/");

  await page.locator(".actionLauncherToggle").click();
  const launcher = page.locator(".actionLauncherMenu");
  await expect(launcher.getByRole("menuitem", { name: "Settings" })).toHaveCount(0);
  await expect(launcher.getByRole("menuitem", { name: "Git" })).toBeVisible();
  await expect(launcher.getByRole("menuitem", { name: "File explorer" })).toBeVisible();
  await expect(launcher.getByRole("menuitem", { name: "Conversation tree" })).toBeVisible();
  await expect(launcher.getByRole("menuitem", { name: "New session" })).toBeVisible();
  await expect(page.locator(".actionLauncherToggle")).toHaveAttribute("aria-label", "Close session actions");
  await page.locator(".actionLauncherToggle").click();

  await openSessionDrawerFooterAction(page, "Settings");
  await expect(page.locator("#settingsPanel")).toBeVisible();
  await expect(page.locator("#sessionDrawer")).toBeHidden();
});
