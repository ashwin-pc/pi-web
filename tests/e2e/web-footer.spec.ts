import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

test("renders extension footers from session snapshots without queue data", async ({ page }) => {
  await page.routeWebSocket("**/ws**", () => {
    // Keep the test focused on the REST snapshot; older servers did not include queue data.
  });
  await page.route("**/api/state**", async (route) => {
    const response = await route.fetch();
    const state = await response.json();
    delete state.queue;
    state.webFooters = [{
      key: "test-footer",
      footer: { kind: "text", lines: ["Extension footer is active"] },
    }];
    await route.fulfill({ response, json: state });
  });

  await page.goto("/");

  await expect(page.locator("#extensionFooter")).toBeVisible();
  await expect(page.locator("#extensionFooter .webFooterEntry")).toHaveText("Extension footer is active");
});
