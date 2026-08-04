import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
  await page.goto("/");
  await expect(page.locator("#connectionStatus")).toBeHidden();
});

test.describe("keyboard shortcuts", () => {
  test("ctrl/cmd+b toggles the session drawer", async ({ page }) => {
    await expect(page.locator("#sessionDrawer")).toBeHidden();

    await page.keyboard.press("Control+B");
    await expect(page.locator("#sessionDrawer")).toBeVisible();

    await page.keyboard.press("Control+B");
    await expect(page.locator("#sessionDrawer")).toBeHidden();
  });

  test("ctrl/cmd+/ shows and hides keyboard shortcut help", async ({ page }) => {
    await page.locator("#prompt").focus();

    await page.keyboard.press("Control+/");

    const dialog = page.locator(".shortcutHelp");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading")).toHaveText("Keyboard shortcuts");
    await expect(dialog.locator(".shortcutHelpRow")).toHaveCount(6);
    await expect(dialog).toContainText("Pin or unpin current session");
    await expect(dialog).toContainText("Open a new session");

    await page.keyboard.press("Control+/");
    await expect(dialog).toBeHidden();
  });

  test("ctrl/cmd+shift+p pins and unpins the current session", async ({ page }) => {
    const prompt = page.locator("#prompt");
    await expect(page.locator(".sessionBarTab.temporary")).toContainText("Current mock session");
    await prompt.focus();

    await page.keyboard.press("Control+Shift+P");
    await expect(page.locator(".sessionBarTab.pinned")).toContainText("Current mock session");

    await page.keyboard.press("Control+Shift+P");
    await expect(page.locator(".sessionBarTab.temporary")).toContainText("Current mock session");
  });

  test("ctrl/cmd+shift+o opens a new session", async ({ page }) => {
    await expect(page.locator("#statusTitle")).toHaveText("Current mock session");
    await page.locator("#prompt").focus();

    await page.keyboard.press("Control+Shift+O");

    await expect(page.locator("#statusTitle")).toHaveText("New session");
  });

  test("ctrl/cmd+enter sends the prompt", async ({ page }) => {
    const prompt = page.locator("#prompt");
    await prompt.fill("Sent with a shortcut");

    await page.keyboard.press("Control+Enter");

    await expect(page.locator(".message.user").last()).toContainText("Sent with a shortcut");
  });

  test("escape in the prompt stops the running session", async ({ page }) => {
    const prompt = page.locator("#prompt");
    await prompt.fill("slow running task");
    await page.locator("#primaryButton").click();
    await expect(page.locator("#stopButton")).toBeVisible();

    await prompt.focus();
    await page.keyboard.press("Escape");
    await expect(page.locator("#stopButton")).toBeHidden({ timeout: 3000 });
  });
});
