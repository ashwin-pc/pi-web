import { expect, test, type Page } from "@playwright/test";

async function seedPinned(page: Page) {
  await page.request.patch("/api/session-ui-state", {
    data: { pinnedSessions: [{ id: "mock-current" }, { id: "mock-older" }] },
  });
}

async function switchToOlder(page: Page) {
  await page.locator("#sessionButton").click();
  await expect(page.locator("#sessionDrawer")).toBeVisible();
  await page.locator(".sessionItem").filter({ hasText: "Older mock session" }).locator(".sessionItemNavBtn").click();
  await expect(page.locator("#statusTitle")).toHaveText("Older mock session");
  if (await page.locator("#sessionDrawer").isVisible()) await page.locator("#sessionCloseButton").click({ force: true }).catch(() => undefined);
  await expect(page.locator("#sessionDrawer")).toBeHidden();
}

async function promptCurrentInBackground(page: Page, message: string) {
  await page.evaluate(async (promptMessage) => {
    const token = document.querySelector<HTMLInputElement>("#tokenInput")?.value || "";
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const openRes = await fetch("/api/sessions/open", {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId: "mock-current", cwd: "." }),
    });
    await openRes.json();
    await fetch("/api/prompt", {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId: "mock-current", message: promptMessage }),
    });
  }, message);
}

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
  await seedPinned(page);
  await page.goto("/");
  await expect(page.locator("#connectionStatus")).toBeHidden();
});

test("switching into a streaming session synchronizes the composer runtime", async ({ page }) => {
  await switchToOlder(page);
  await promptCurrentInBackground(page, "slow quiet runtime background task");

  const currentTab = page.locator(".sessionBarTab").filter({ hasText: "Current mock session" });
  await expect(currentTab).toHaveClass(/\brunning\b/, { timeout: 4_000 });
  await expect(page.locator("#stopButton")).toBeHidden();

  await currentTab.click();
  await expect(page.locator("#statusTitle")).toHaveText("Current mock session");
  await expect(page.locator("#stopButton")).toBeVisible();
  await expect(page.locator("#runtimeStatus")).toContainText("Running");
});

test("switching away from a streaming session clears the composer runtime", async ({ page }) => {
  await page.locator("#prompt").fill("slow quiet runtime foreground task");
  await page.locator("#primaryButton").click();
  await expect(page.locator("#stopButton")).toBeVisible();

  await switchToOlder(page);
  await expect(page.locator("#stopButton")).toBeHidden();
  await expect(page.locator("#runtimeStatus")).toBeHidden();

  const currentTab = page.locator(".sessionBarTab").filter({ hasText: "Current mock session" });
  await currentTab.click();
  await expect(page.locator("#stopButton")).toBeVisible();
});

test("compaction animation follows the active pinned session", async ({ page }) => {
  await page.locator("#prompt").fill("slow compaction foreground task");
  await page.locator("#primaryButton").click();
  await expect(page.locator("#contextMeter")).toHaveClass(/\bcompacting\b/);
  const fill = page.locator("#contextMeterFill");
  await expect(fill).toHaveCSS("width", /[1-9][0-9.]*px/);
  const firstAnimationTime = await fill.evaluate((element) => element.getAnimations()[0]?.currentTime as number | null);
  await expect.poll(() => fill.evaluate((element) => element.getAnimations()[0]?.currentTime as number | null))
    .not.toBe(firstAnimationTime);

  const olderTab = page.locator(".sessionBarTab").filter({ hasText: "Older mock session" });
  await olderTab.click();
  await expect(page.locator("#statusTitle")).toHaveText("Older mock session");
  await expect(page.locator("#contextMeter")).not.toHaveClass(/\bcompacting\b/);
  await expect(page.locator("#contextMeterLabel")).not.toHaveText("compacting");

  const currentTab = page.locator(".sessionBarTab").filter({ hasText: "Current mock session" });
  await currentTab.click();
  await expect(page.locator("#statusTitle")).toHaveText("Current mock session");
  await expect(page.locator("#contextMeter")).toHaveClass(/\bcompacting\b/);
  await expect(page.locator("#contextMeterLabel")).toHaveText("compacting");

  await page.request.post("/api/compaction/abort", { data: { sessionId: "mock-current" } });
  await expect(page.locator("#contextMeter")).not.toHaveClass(/\bcompacting\b/);
});
