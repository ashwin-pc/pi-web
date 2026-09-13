import { expect, test, type Page } from "@playwright/test";
import { openSessionDrawerFooterAction } from "./helpers/sessionDrawer.js";

async function openServerSettings(page: Page) {
  await openSessionDrawerFooterAction(page, "Settings");
  await expect(page.locator("#settingsNavServer")).toBeVisible();
  await page.locator("#settingsNavServer").click();
}

async function mockSupervisor(page: Page, generation = 4) {
  await page.route("**/__supervisor/status", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, childGeneration: generation, childPid: 1234 }),
  }));
}

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

test("restart settings is hidden without a supervisor", async ({ page }) => {
  await page.goto("/");
  await openSessionDrawerFooterAction(page, "Settings");
  await expect(page.locator("#settingsNavServer")).toBeHidden();
});

test("restart cancellation sends no request", async ({ page }) => {
  await mockSupervisor(page);
  let requests = 0;
  await page.route("**/api/restart", route => { requests += 1; return route.fulfill({ status: 202, body: '{"ok":true}' }); });
  await page.goto("/");
  await openServerSettings(page);
  await page.locator("#restartServerButton").click();
  const dialog = page.getByRole("dialog", { name: "Restart pi-web server?" });
  await expect(dialog).toContainText("all sessions");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(requests).toBe(0);
});

test("accepted restart waits for a newer ready generation", async ({ page }) => {
  let statusReads = 0;
  await page.route("**/__supervisor/status", route => {
    statusReads += 1;
    const replaced = statusReads >= 3;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, childGeneration: replaced ? 5 : 4, childPid: replaced ? 5678 : undefined }) });
  });
  await page.route("**/api/restart", route => route.fulfill({ status: 202, contentType: "application/json", body: '{"ok":true}' }));
  await page.goto("/");
  await openServerSettings(page);
  await page.locator("#restartServerButton").click();
  await page.getByRole("dialog", { name: "Restart pi-web server?" }).getByRole("button", { name: "Restart server" }).click();
  await expect(page.locator("#restartServerState")).toContainText("Waiting for the replacement server");
  await expect(page.locator("#restartServerState")).toContainText("Replacement server is ready");
});

for (const [status, message] of [[401, "authorization expired"], [403, "security policy"], [500, "Internal restart failure"]] as const) {
  test(`restart reports ${status} rejection`, async ({ page }) => {
    await mockSupervisor(page);
    await page.route("**/api/restart", route => route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ ok: false, error: status === 500 ? "Internal restart failure" : "Rejected" }) }));
    await page.goto("/");
    await openServerSettings(page);
    await page.locator("#restartServerButton").click();
    await page.getByRole("dialog").getByRole("button", { name: "Restart server" }).click();
    await expect(page.locator("#restartServerState")).toContainText(message);
    await expect(page.locator("#restartServerButton")).toBeEnabled();
  });
}

test("restart reports a network failure", async ({ page }) => {
  await mockSupervisor(page);
  await page.route("**/api/restart", route => route.abort("failed"));
  await page.goto("/");
  await openServerSettings(page);
  await page.locator("#restartServerButton").click();
  await page.getByRole("dialog").getByRole("button", { name: "Restart server" }).click();
  await expect(page.locator("#restartServerState")).toContainText("Failed to fetch");
});
