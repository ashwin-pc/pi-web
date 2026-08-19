import { expect, test } from "@playwright/test";

// Issue #112 regression guard: the sessions drawer refetches `/api/sessions` on
// every message_end while open. With the drawer open and one basic streaming
// turn, the message_end-driven refetch is redundant — the drawer-open refresh
// already fetched the list right before the prompt. This asserts the coalesce
// keeps the whole interaction to at most one `/api/sessions` request.
//
// On today's HEAD (no coalesce) this fails: drawer-open (1) + message_end (1) = 2.

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
  await page.goto("/");
  await expect(page.locator("#connectionStatus")).toBeHidden();
});

test.describe("session-list refetch budget", () => {
  test("open drawer + one streaming turn makes at most one /api/sessions request", async ({ page }, testInfo) => {
    let sessionListRequests = 0;
    page.on("request", (req) => {
      if (new URL(req.url()).pathname === "/api/sessions") sessionListRequests += 1;
    });

    // Start counting just before opening the drawer (excludes any load-time fetches).
    await page.locator("#sessionButton").click();
    sessionListRequests = 0;
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

    // Allow any late message_end-driven refetch to land before asserting the budget.
    // 600ms leaves comfortable margin over the 250ms refresh debounce.
    await page.waitForTimeout(600);
    expect(sessionListRequests).toBeLessThanOrEqual(1);
  });
});
