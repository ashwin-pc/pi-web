import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

test("shows retryable model errors live and terminal retry affordances", async ({ page }) => {
  await page.goto("/");
  await page.locator("#prompt").fill("retry failure");
  await page.locator("#primaryButton").click();

  const retryCard = page.locator(".runtimeErrorCard").last();
  await expect(retryCard.locator(".toolCardName")).toHaveText("retrying assistant request");
  await expect(retryCard.locator(".toolCardSubtitle")).toContainText("Throttling error (429)");
  await expect(retryCard.locator(".toolCardSubtitle")).toContainText("attempt 1/3");
  await expect(page.locator("#runtimeStatus")).toContainText("retrying");
  await expect(retryCard).not.toContainText("_readableState");

  const terminalCard = page.locator(".runtimeErrorCard", { hasText: "response failed" }).last();
  await expect(terminalCard).toBeVisible();
  await expect(terminalCard.locator(".toolCardSubtitle")).toContainText("Service unavailable (503)");
  await expect(terminalCard.locator(".runtimeErrorAction", { hasText: "Retry" })).toBeVisible();
  await expect(terminalCard.locator(".runtimeErrorAction", { hasText: "Switch model" })).toBeVisible();
  await expect(page.locator(".runtimeErrorCard", { hasText: "_readableState" })).toHaveCount(0);

  await terminalCard.locator(".runtimeErrorAction", { hasText: "Retry" }).click();
  await expect(page.locator(".message.assistant", { hasText: "Recovered after manual continue." }).last()).toBeVisible();
  await expect(page.locator(".message.user", { hasText: "Please retry the previous request." })).toHaveCount(0);
});
