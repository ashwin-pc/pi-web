import { expect, test, type Page } from "@playwright/test";
import { openSessionDrawerFooterAction } from "./helpers/sessionDrawer.js";

async function openServerSettings(page: Page) {
  await openSessionDrawerFooterAction(page, "System");
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
  await openSessionDrawerFooterAction(page, "System");
  const serverNav = page.locator("#settingsNavServer");
  await expect(serverNav).toBeHidden();
  await expect(serverNav).toHaveJSProperty("hidden", true);
  await page.locator("#settingsSearchInput").fill("server");
  await expect(serverNav).toHaveJSProperty("hidden", true);
  await page.locator("#settingsCloseButton").click();
  await openSessionDrawerFooterAction(page, "Preferences");
  await page.locator("#settingsCloseButton").click();
  await openSessionDrawerFooterAction(page, "System");
  await expect(serverNav).toHaveJSProperty("hidden", true);
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

test("a new child PID is not ready until its authenticated app endpoint responds", async ({ page }) => {
  let restartAccepted = false;
  await page.route("**/__supervisor/status", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, childGeneration: restartAccepted ? 10 : 9, childPid: restartAccepted ? 5678 : 1234 }),
  }));
  let appProbes = 0;
  let appReady = false;
  await page.route("**/api/system-info", async route => {
    appProbes += 1;
    if (!appReady) return route.fulfill({ status: 503, body: "Child is starting" });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, system: { capturedAt: "now" } }) });
  });
  await page.route("**/api/restart", route => {
    restartAccepted = true;
    return route.fulfill({ status: 202, contentType: "application/json", body: '{"ok":true}' });
  });
  await page.goto("/");
  await openServerSettings(page);
  await page.locator("#restartServerButton").click();
  await page.getByRole("dialog").getByRole("button", { name: "Restart server" }).click();
  await expect.poll(() => appProbes).toBeGreaterThanOrEqual(1);
  await expect(page.locator("#restartServerState")).toContainText("Waiting for the replacement server");
  appReady = true;
  await expect(page.locator("#restartServerState")).toContainText("Replacement server is ready");
  expect(appProbes).toBeGreaterThanOrEqual(2);
});

test("repeated restart clicks open only one confirmation", async ({ page }) => {
  await mockSupervisor(page);
  await page.goto("/");
  await openServerSettings(page);
  await page.locator("#restartServerButton").dblclick();
  await expect(page.getByRole("dialog", { name: "Restart pi-web server?" })).toHaveCount(1);
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
  await expect(page.locator("#restartServerState")).toContainText("acceptance could not be confirmed");
});
