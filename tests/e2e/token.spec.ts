import { expect, test } from "@playwright/test";
import { openSessionDrawerFooterAction } from "./helpers/sessionDrawer.js";

// These tests run against the auth-enabled server (PI_WEB_TOKEN=test-secret).
// The "auth" playwright project sets baseURL to the auth port.

const CORRECT_TOKEN = "test-secret";
const WRONG_TOKEN = "wrong";

test.beforeEach(async ({ page, context }) => {
  // Clear stored token before each test
  await context.clearCookies();
  await context.addInitScript(() => localStorage.removeItem("pi-web-token"));
});

test.describe("token overlay", () => {
  test("shows overlay on page load when no token stored", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#tokenOverlay")).toBeVisible();
    await expect(page.locator("#tokenInput")).toBeVisible();
    await expect(page.locator("#tokenScanButton")).toBeVisible();
  });

  test("main UI is behind the overlay when token required", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#tokenOverlay")).toBeVisible();
    // prompt should exist in DOM but not be interactable (overlay covers it)
    const overlayBox = await page.locator("#tokenOverlay").boundingBox();
    const promptBox = await page.locator("#prompt").boundingBox();
    expect(overlayBox).toBeTruthy();
    expect(promptBox).toBeTruthy();
    // overlay covers full viewport
    expect(overlayBox!.width).toBeGreaterThan(500);
    expect(overlayBox!.height).toBeGreaterThan(400);
  });

  test("wrong token keeps overlay visible", async ({ page }) => {
    await page.goto("/");
    await page.locator("#tokenInput").fill(WRONG_TOKEN);
    await page.locator("#tokenForm button[type=submit]").click();
    await expect(page.locator("#tokenOverlay")).toBeVisible();
  });

  test("correct token dismisses overlay and loads messages", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#tokenOverlay")).toBeVisible();
    await page.locator("#tokenInput").fill(CORRECT_TOKEN);
    await page.locator("#tokenForm button[type=submit]").click();
    await expect(page.locator("#tokenOverlay")).toBeHidden({ timeout: 5000 });
    await expect(page.locator("#prompt")).toBeVisible();
    await expect(page.locator("#messages")).toBeVisible();
  });

  test("mints a session cookie and renders a sandboxed HTML artifact through srcdoc", async ({ page }) => {
    await page.goto("/");
    await page.locator("#tokenInput").fill(CORRECT_TOKEN);
    await page.locator("#tokenForm button[type=submit]").click();
    await expect(page.locator("#tokenOverlay")).toBeHidden({ timeout: 5000 });
    expect((await page.context().cookies()).some(cookie => cookie.name === "pi_web_session")).toBe(true);

    await expect(page.locator("#prompt")).toBeEnabled();
    await page.waitForTimeout(500);
    await page.locator("#prompt").fill("show html artifact");
    await page.locator("#promptForm").evaluate((form: HTMLFormElement) => form.requestSubmit());
    const frame = page.locator(".artifactPreview--html iframe.artifactPreviewFrame").last();
    await expect(frame).toHaveAttribute("srcdoc", /HTML artifact/);
    await expect(frame.contentFrame().locator("#script-status")).toHaveText("script ran");
  });

  test("sensitive security management is session-only and missing deletes return 404", async ({ page }) => {
    await page.goto("/");
    await page.locator("#tokenInput").fill(CORRECT_TOKEN);
    await page.locator("#tokenForm button[type=submit]").click();
    await expect(page.locator("#tokenOverlay")).toBeHidden({ timeout: 5000 });

    const created = await page.evaluate(async () => {
      const headers = { "content-type": "application/json", "x-pi-web-client-id": "security-test" };
      const response = await fetch("/api/auth/tokens", { method: "POST", headers, body: JSON.stringify({ name: "delegation check" }) });
      return response.json() as Promise<{ id: string; secret: string }>;
    });
    const tokenContext = await page.context().browser()!.newContext({ baseURL: page.url() });
    const bearerHeaders = { "content-type": "application/json", authorization: `Bearer ${created.secret}` };
    const bearerResults = await Promise.all([
      tokenContext.request.get("/api/auth/security", { headers: bearerHeaders }).then(r => r.status()),
      tokenContext.request.post("/api/auth/tokens", { headers: bearerHeaders, data: {} }).then(r => r.status()),
      tokenContext.request.delete("/api/auth/tokens/missing", { headers: bearerHeaders }).then(r => r.status()),
    ]);
    await tokenContext.close();
    expect(bearerResults).toEqual([401, 401, 401]);

    const missingResults = await page.evaluate(async () => {
      const headers = { "content-type": "application/json", "x-pi-web-client-id": "security-test" };
      return Promise.all([
        fetch("/api/auth/tokens/missing", { method: "DELETE", headers }).then(r => r.status),
        fetch("/api/auth/sessions/missing", { method: "DELETE", headers }).then(r => r.status),
        fetch("/api/auth/passkeys/missing", { method: "DELETE", headers }).then(r => r.status),
        fetch("/api/auth/device-grants/missing", { method: "DELETE", headers }).then(r => r.status),
      ]);
    });
    expect(missingResults).toEqual([404, 404, 404, 404]);
  });

  test("token persisted in localStorage after login", async ({ page }) => {
    await page.goto("/");
    await page.locator("#tokenInput").fill(CORRECT_TOKEN);
    await page.locator("#tokenForm button[type=submit]").click();
    await expect(page.locator("#tokenOverlay")).toBeHidden({ timeout: 5000 });

    const stored = await page.evaluate(() => localStorage.getItem("pi-web-token"));
    expect(stored).toBe(CORRECT_TOKEN);
  });

  test("token in URL is accepted and cleaned from address bar", async ({ page }) => {
    await page.goto(`/?token=${CORRECT_TOKEN}`);
    await expect(page.locator("#tokenOverlay")).toBeHidden({ timeout: 5000 });
    await expect(page.locator("#prompt")).toBeVisible();
    expect(page.url()).not.toContain("token=");
  });

  test("Security settings uses revocable grants and one-time API-token secrets", async ({ page }) => {
    await page.goto("/");
    await page.locator("#tokenInput").fill(CORRECT_TOKEN);
    await page.locator("#tokenForm button[type=submit]").click();
    await expect(page.locator("#tokenOverlay")).toBeHidden({ timeout: 5000 });

    await page.locator("#sessionButton").click();
    await openSessionDrawerFooterAction(page, "Settings");
    await page.locator("#settingsNavAccess").click();
    const security = page.locator("#securitySettings");
    await expect(security.getByText("Authentication mode")).toBeVisible();
    await expect(security.getByText("legacy", { exact: true })).toBeVisible();
    await expect(security.getByText("Devices & sessions")).toBeVisible();
    await expect(page.locator("#tokenShareSection")).toHaveCount(0);

    const tokenName = `Playwright ${Date.now()}`;
    await security.getByPlaceholder("Token name").fill(tokenName);
    await security.getByRole("button", { name: "Create API token" }).click();
    await expect(security.locator(".securitySecret code")).toHaveText(/^piw_/);
    await expect(security.getByText("shown once", { exact: false })).toBeVisible();

    await security.getByRole("button", { name: "Create add-device link" }).click();
    const link = security.getByLabel("Add-device link");
    await expect(link).toHaveValue(/\/api\/auth\/device\?grant=/);
    await expect(link).not.toHaveValue(/token=test-secret/);
    await expect(security.getByRole("img", { name: "Add device QR code" })).toBeVisible();
    await security.locator(".deviceGrantOutput").getByRole("button", { name: "Cancel grant" }).click();
    await expect(security.getByLabel("Add-device link")).toHaveCount(0);

    await security.getByRole("button", { name: "Create add-device link" }).click();
    const redeemUrl = await security.getByLabel("Add-device link").inputValue();
    const addedContext = await page.context().browser()!.newContext();
    const addedPage = await addedContext.newPage();
    await addedPage.goto(redeemUrl);
    await addedPage.getByRole("button", { name: "Continue" }).click();
    await expect(addedPage).toHaveURL(/\/$/);
    await expect(addedPage.locator("#prompt")).toBeVisible();
    await addedContext.close();

    await page.locator("#settingsCloseButton").click();
    await page.locator("#sessionButton").click();
    await openSessionDrawerFooterAction(page, "Settings");
    await page.locator("#settingsNavAccess").click();
    await expect(security.locator(".securitySecret code")).toHaveCount(0);
    const tokenRow = security.locator(".securityRow", { hasText: tokenName });
    await expect(tokenRow).toBeVisible();
    await tokenRow.getByRole("button", { name: "Revoke" }).click();
    await expect(tokenRow).toHaveCount(0);
  });
});

test.describe("/logout slash command", () => {
  test("clears token and shows overlay again", async ({ page }) => {
    // Log in first
    await page.goto("/");
    await page.locator("#tokenInput").fill(CORRECT_TOKEN);
    await page.locator("#tokenForm button[type=submit]").click();
    await expect(page.locator("#tokenOverlay")).toBeHidden({ timeout: 5000 });

    // Now logout
    await page.locator("#prompt").fill("/logout");
    await page.locator("#primaryButton").click();

    await expect(page.locator("#tokenOverlay")).toBeVisible();

    const stored = await page.evaluate(() => localStorage.getItem("pi-web-token"));
    expect(stored).toBeNull();
  });

  test("can log back in after logout", async ({ page }) => {
    await page.goto("/");
    await page.locator("#tokenInput").fill(CORRECT_TOKEN);
    await page.locator("#tokenForm button[type=submit]").click();
    await expect(page.locator("#tokenOverlay")).toBeHidden({ timeout: 5000 });

    await page.locator("#prompt").fill("/logout");
    await page.locator("#primaryButton").click();
    await expect(page.locator("#tokenOverlay")).toBeVisible();

    await page.locator("#tokenInput").fill(CORRECT_TOKEN);
    await page.locator("#tokenForm button[type=submit]").click();
    await expect(page.locator("#tokenOverlay")).toBeHidden({ timeout: 5000 });
    await expect(page.locator("#prompt")).toBeVisible();
  });
});
