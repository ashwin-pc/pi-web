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
  if (await page.locator("#sessionDrawer").isVisible()) await page.locator("#sessionCloseButton").click();
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
