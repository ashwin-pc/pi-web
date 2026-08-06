import { expect, test, type Page } from "@playwright/test";

async function openShortcutTestApp(page: Page, pinnedSessions: Array<{ id: string }> = []) {
  await page.goto("about:blank");
  await page.request.post("/api/mock/reset");
  await page.request.patch("/api/settings", { data: { composer: { expanded: false } } });
  if (pinnedSessions.length > 0) {
    await page.request.patch("/api/session-ui-state", { data: { pinnedSessions } });
  }
  await page.goto("/");
  await expect(page.locator("#connectionStatus")).toBeHidden();
}

async function seedPinnedSessions(page: Page) {
  await openShortcutTestApp(page, [{ id: "mock-current" }, { id: "mock-older" }]);
  await expect(page.locator(".sessionBarTab.pinned")).toHaveCount(2);
}

async function trackNextKeyDefault(page: Page) {
  await page.evaluate(() => {
    const target = window as Window & { shortcutDefaultPrevented?: boolean };
    target.shortcutDefaultPrevented = false;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.key.startsWith("Arrow")) return;
      target.shortcutDefaultPrevented = event.defaultPrevented;
      window.removeEventListener("keydown", onKeyDown);
    };
    window.addEventListener("keydown", onKeyDown);
  });
}

test.beforeEach(async ({ page }) => {
  await openShortcutTestApp(page);
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
    await expect(dialog.locator(".shortcutHelpRow")).toHaveCount(9);
    await expect(dialog).toContainText("Pin or unpin current session");
    await expect(dialog.locator(".shortcutHelpRow").filter({ hasText: "Focus composer" }).locator("kbd").last()).toHaveText(".");
    await expect(dialog).toContainText("Open a new session");
    const previous = dialog.locator(".shortcutHelpRow").filter({ hasText: "Previous pinned session" });
    const next = dialog.locator(".shortcutHelpRow").filter({ hasText: "Next pinned session" });
    await expect(previous.locator("kbd").last()).toHaveText("←");
    await expect(next.locator("kbd").last()).toHaveText("→");

    await page.keyboard.press("Control+/");
    await expect(dialog).toBeHidden();
  });

  test("ctrl/cmd+shift+arrows cycle pinned sessions with guards and wraparound", async ({ page }) => {
    await seedPinnedSessions(page);
    const prompt = page.locator("#prompt");

    await prompt.focus();
    await trackNextKeyDefault(page);
    await page.keyboard.press("Control+Shift+ArrowRight");
    await expect(page.locator("#statusTitle")).toHaveText("Current mock session");
    expect(await page.evaluate(() => (window as Window & { shortcutDefaultPrevented?: boolean }).shortcutDefaultPrevented)).toBe(false);

    await page.keyboard.press("Control+/");
    await expect(page.locator(".shortcutHelp")).toBeVisible();
    await page.keyboard.press("Control+Shift+ArrowRight");
    await expect(page.locator("#statusTitle")).toHaveText("Current mock session");
    await expect(page.locator(".shortcutHelp")).toBeVisible();
    await page.keyboard.press("Control+/");
    await expect(page.locator(".shortcutHelp")).toBeHidden();
    await expect(prompt).toBeFocused();

    const cyclePinned = async (key: "ArrowLeft" | "ArrowRight") => {
      await page.locator("#statusTitle").dispatchEvent("keydown", {
        key,
        code: key,
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        shiftKey: true,
      });
    };

    await trackNextKeyDefault(page);
    await cyclePinned("ArrowRight");
    await expect(page.locator("#statusTitle")).toHaveText("Older mock session");
    expect(await page.evaluate(() => (window as Window & { shortcutDefaultPrevented?: boolean }).shortcutDefaultPrevented)).toBe(true);

    await cyclePinned("ArrowRight");
    await expect(page.locator("#statusTitle")).toHaveText("Current mock session");

    await cyclePinned("ArrowLeft");
    await expect(page.locator("#statusTitle")).toHaveText("Older mock session");
    await cyclePinned("ArrowLeft");
    await expect(page.locator("#statusTitle")).toHaveText("Current mock session");

    await page.keyboard.press("Control+Shift+O");
    await expect(page.locator("#statusTitle")).toHaveText("New session");
    await cyclePinned("ArrowRight");
    await expect(page.locator("#statusTitle")).toHaveText("Current mock session");

    await page.keyboard.press("Control+Shift+O");
    await expect(page.locator("#statusTitle")).toHaveText("New session");
    await cyclePinned("ArrowLeft");
    await expect(page.locator("#statusTitle")).toHaveText("Older mock session");
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

  test("period focuses the composer without replacing normal input", async ({ page }) => {
    const prompt = page.locator("#prompt");
    const statusTitle = page.locator("#statusTitle");
    await statusTitle.focus();

    await page.keyboard.press("Control+/");
    await expect(page.locator(".shortcutHelp")).toBeVisible();
    await page.keyboard.press(".");
    await expect(page.locator(".shortcutHelp")).toBeVisible();
    await expect(prompt).not.toBeFocused();
    await page.keyboard.press("Control+/");
    await expect(statusTitle).toBeFocused();
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));

    await page.keyboard.press(".");
    await expect(prompt).toBeFocused();
    await expect(prompt).toHaveValue("");

    await page.keyboard.press(".");
    await expect(prompt).toHaveValue(".");
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
