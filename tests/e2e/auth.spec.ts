import { expect, test, type Page } from "@playwright/test";
import { openSessionDrawerFooterAction } from "./helpers/sessionDrawer.js";

test.beforeEach(async ({ context }) => {
  await context.clearCookies();
  await context.request.post("/api/mock/reset", { data: {} });
});

async function openSecurity(page: Page) {
  await page.goto("/");
  await expect(page.locator("#statusTitle")).toHaveText("Current mock session");
  await page.locator("#sessionButton").click();
  await openSessionDrawerFooterAction(page, "System");
  await page.locator("#settingsNavAccess").click();
  return page.locator("#securitySettings");
}

test("public sign-in reuses the entry video and respects reduced motion", async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL as string,
    serviceWorkers: "block",
    extraHTTPHeaders: {},
  });
  const page = await context.newPage();
  try {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/api/auth/login");
    await expect(page).toHaveTitle("Pi Web");
    await expect(page.getByRole("heading", { name: "Pi Web", exact: true })).toBeVisible();
    const animation = page.locator(".avatarAnimation");
    await expect(animation).toBeVisible();
    await expect.poll(() => animation.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload();
    await expect(animation).toBeHidden();
    await expect(page.locator(".avatarStill")).toBeVisible();
    expect((await context.request.get("/api/state")).status()).toBe(401);
  } finally {
    await context.close();
  }
});

test("old saved and query tokens are purged and never replayed", async ({ page }) => {
  const authorizations: Array<string | undefined> = [];
  page.on("request", request => authorizations.push(request.headers().authorization));
  await page.addInitScript(() => localStorage.setItem("pi-web-token", "piw_old_saved_secret"));
  await page.goto("/?token=https%3A%2F%2Fqr-content.example%2Fclaim");
  await expect(page.locator("#prompt")).toBeVisible();
  expect(new URL(page.url()).hostname).toBe("127.0.0.1");
  expect(await page.evaluate(() => localStorage.getItem("pi-web-token"))).toBeNull();
  expect(authorizations.filter(Boolean)).toEqual([]);
  await expect(page.locator("#tokenOverlay, #tokenScanButton, #tokenInput")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /set token/i })).toHaveCount(0);
});

test("security keeps open-policy warning, responsive focus, and native confirmation styling", async ({ page }) => {
  const security = await openSecurity(page);
  await page.route("**/api/auth/security", async route => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...await response.json(), policy: "open" } });
  });
  await openSecurity(page);
  await expect(security.locator(".securityBanner")).toContainText("Authentication is off");
  await page.unroute("**/api/auth/security");
  await openSecurity(page);
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--accent", "#8fb6ff");
    document.documentElement.style.setProperty("--panel", "#141820");
  });
  await expect(security.getByRole("link", { name: "Sign in again for security changes" })).toHaveCSS("color", "rgb(143, 182, 255)");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    if (width <= 640) await page.locator("#settingsNavAccess").click();
    await security.getByRole("button", { name: "Authentication policy & reauthentication", exact: true }).click();
    await security.getByRole("button", { name: "‹ Security", exact: true }).click();
    await expect(page.locator(width > 640 ? "#settingsPageAccessTitle" : "#settingsMobileTitle")).toBeFocused();
  }
  await security.getByRole("button", { name: "Sign out all devices", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toHaveCSS("background-color", "rgb(20, 24, 32)");
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

for (const failure of ["http", "network"] as const) {
  test(`logout reports ${failure} failure without claiming revocation`, async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#prompt")).toBeVisible();
    await page.route("**/api/auth/logout", route =>
      failure === "http"
        ? route.fulfill({ status: 500, json: { error: "store unavailable" } })
        : route.abort("failed"));
    await page.locator("#prompt").fill("/logout");
    await page.locator("#promptForm").evaluate((form: HTMLFormElement) => form.requestSubmit());
    await expect(page.getByText(/Logout failed; your server session may still be active/)).toBeVisible();
    expect((await page.context().cookies()).some(cookie => cookie.name === "pi_web_session")).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem("pi-web-token"))).toBeNull();
  });
}

test("mobile Security confirms revocation, reports failure, and returns to explicit login", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const security = await openSecurity(page);
  await expect(page.locator("#settingsMobileTitle")).toHaveText("Security");
  let requests = 0;
  let fail = true;
  await page.route("**/api/auth/sessions", async route => {
    if (route.request().method() !== "DELETE") return route.continue();
    requests++;
    expect(route.request().postDataJSON()).toEqual({ revokeApiTokens: !fail });
    if (fail) await route.fulfill({ status: 503, json: { error: "Temporary store unavailable" } });
    else await route.continue();
  });
  const revoke = security.getByRole("button", { name: "Sign out all devices", exact: true });
  await revoke.click();
  const dialog = page.getByRole("dialog");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(requests).toBe(0);
  await revoke.click();
  await dialog.getByRole("checkbox").uncheck();
  await dialog.getByRole("button", { name: "Confirm and sign out", exact: true }).click();
  await expect(security.locator(".securityFeedback")).toHaveText("Temporary store unavailable");
  fail = false;
  await revoke.click();
  await expect(dialog.getByRole("checkbox")).toBeChecked();
  await dialog.getByRole("button", { name: "Confirm and sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/api\/auth\/login$/);
  expect(requests).toBe(2);
  expect((await page.request.get("/api/state", { headers: { "x-test-user": "" } })).status()).toBe(401);
  await page.getByText("Other ways to sign in").click();
  await page.getByRole("button", { name: "Continue with trusted proxy" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("#prompt")).toBeVisible();
});

test("API-token access is read-only for security and secrets are shown once and revocable", async ({ page, browser }) => {
  const security = await openSecurity(page);
  const tokenName = `Playwright ${Date.now()}`;
  await security.locator(".securityRow", { hasText: "API tokens" }).getByRole("button", { name: "Manage" }).click();
  await security.getByPlaceholder("Token name").fill(tokenName);
  await security.getByRole("button", { name: "Create API token" }).click();
  const secret = await security.locator(".securitySecret code").innerText();
  expect(secret).toMatch(/^piw_/);
  await expect(security.getByText("shown once", { exact: false })).toBeVisible();

  const bearer = await browser.newContext({ baseURL: page.url(), extraHTTPHeaders: { authorization: `Bearer ${secret}` } });
  try {
    expect((await bearer.request.get("/api/auth/security")).status()).toBe(200);
    expect((await bearer.request.post("/api/auth/tokens", { data: {} })).status()).toBe(403);
  } finally {
    await bearer.close();
  }

  await security.getByRole("button", { name: "‹ Security", exact: true }).click();
  await security.locator(".securityRow", { hasText: "API tokens" }).getByRole("button", { name: "Manage" }).click();
  await expect(security.locator(".securitySecret code")).toHaveCount(0);
  const tokenRow = security.locator(".securityRow", { hasText: tokenName });
  await tokenRow.getByRole("button", { name: "Revoke" }).click();
  await expect(tokenRow).toHaveCount(0);
});

test("add-device grants support cancellation and one-time redemption", async ({ page, browser }) => {
  const security = await openSecurity(page);
  await security.getByRole("button", { name: "＋ Connect a device", exact: true }).click();
  await security.getByRole("button", { name: "Create add-device link" }).click();
  const link = security.getByLabel("Add-device link");
  await expect(link).toHaveValue(/\/api\/auth\/device\?grant=/);
  await expect(link).not.toHaveValue(/[?&]token=/);
  await expect(security.getByRole("img", { name: "Add device QR code" })).toBeVisible();
  await security.locator(".deviceGrantOutput").getByRole("button", { name: "Cancel grant" }).click();
  await expect(link).toHaveCount(0);

  await security.getByRole("button", { name: "Create add-device link" }).click();
  const redeemUrl = await security.getByLabel("Add-device link").inputValue();
  const added = await browser.newContext();
  const addedPage = await added.newPage();
  try {
    await addedPage.goto(redeemUrl);
    await addedPage.getByRole("button", { name: "Continue" }).click();
    await expect(addedPage).toHaveURL(/\/$/);
    await expect(addedPage.locator("#prompt")).toBeVisible();
  } finally {
    await added.close();
  }
});
