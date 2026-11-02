import { expect, test } from "@playwright/test";
import { ensurePreviewArtifact } from "./helpers/artifacts.js";

test.beforeAll(ensurePreviewArtifact);

test("top-level artifact scripts run only in an opaque sandbox", async ({ page }) => {
  const response = await page.request.get("/api/artifacts/preview.html");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-security-policy"]).toBe("sandbox allow-scripts");
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");

  await page.goto("/api/artifacts/preview.html");
  await expect(page.locator("#script-status")).toHaveText("script ran");
  await expect(page.locator("#sandbox-status")).toContainText("localStorage blocked");
  await expect(page.locator("#sandbox-status")).toContainText(/cookies (empty|blocked)/);
});

test("existing srcdoc artifact previews still run scripts without same-origin access", async ({ page }) => {
  await page.goto("/");
  await page.locator("#prompt").fill("show html artifact");
  await page.locator("#promptForm").evaluate((form: HTMLFormElement) => form.requestSubmit());

  const frame = page.locator(".artifactPreview--html iframe.artifactPreviewFrame").last();
  await expect(frame).toHaveAttribute("srcdoc", /HTML artifact/);
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(frame).not.toHaveAttribute("sandbox", /allow-same-origin/);
  await expect(frame.contentFrame().locator("#script-status")).toHaveText("script ran");
  await expect(frame.contentFrame().locator("#sandbox-status")).toContainText("localStorage blocked");
});
