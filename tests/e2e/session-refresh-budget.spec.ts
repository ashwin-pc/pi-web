import { expect, test } from "@playwright/test";

// Session-list budget regression guard. Opening the drawer may fetch once, and a
// completed run performs one terminal reconciliation. Intermediate message_end
// events must not trigger additional list scans, so the whole interaction is
// bounded at two requests rather than growing with the number of messages.

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
  await page.goto("/");
  await expect(page.locator("#connectionStatus")).toBeHidden();
});

test.describe("session-list refetch budget", () => {
  test("open drawer + one streaming turn makes at most two /api/sessions requests", async ({ page }, testInfo) => {
    let sessionListRequests = 0;
    page.on("request", (req) => {
      if (new URL(req.url()).pathname === "/api/sessions") sessionListRequests += 1;
    });

    // Counter stays live from before the drawer click: drawer-open fetch (1) +
    // terminal reconciliation (1) must total <= 2.
    await page.locator("#sessionButton").click();
    await expect(page.locator("#sessionDrawer")).toBeVisible();

    const isMobile = testInfo.project.name === "mobile";
    if (isMobile) {
      // On mobile the drawer overlays the composer, so it must close before the
      // prompt can be sent (realistic flow). The message_end refresh is then gated
      // off by the hidden-drawer check, keeping the budget trivially low.
      await page.locator("#sessionCloseButton").click({ force: true }).catch(() => undefined);
      await expect(page.locator("#sessionDrawer")).toBeHidden();
    }

    // One basic streaming turn. The mock emits a single message_end on the prompt.
    await page.locator("#prompt").fill("budget regression");
    await page.locator("#primaryButton").click();
    await expect(page.locator(".message.assistant", { hasText: "Mock response." }).last()).toBeVisible();
    await expect(page.locator("#stopButton")).toBeHidden({ timeout: 5000 });

    // Allow terminal reconciliation to land before asserting the budget.
    await page.waitForTimeout(600);
    expect(sessionListRequests).toBeLessThanOrEqual(2);
  });
});
