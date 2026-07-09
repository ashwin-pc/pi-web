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
  await expect(page.locator("#stopButton")).toBeVisible();
  await expect(retryCard).not.toContainText("_readableState");

  const terminalCard = page.locator(".runtimeErrorCard", { hasText: "response failed" }).last();
  await expect(terminalCard).toBeVisible();
  await expect(terminalCard.locator(".toolCardSubtitle")).toContainText("Service unavailable (503)");
  await expect(terminalCard.locator(".runtimeErrorAction", { hasText: "Retry" })).toBeVisible();
  await expect(terminalCard.locator(".runtimeErrorAction", { hasText: "Switch model" })).toBeVisible();
  await expect(page.locator(".runtimeErrorCard", { hasText: "_readableState" })).toHaveCount(0);
  await expect(page.locator("#stopButton")).toBeHidden();

  await page.reload();
  const reloadedTerminalCard = page.locator(".runtimeErrorCard", { hasText: "response failed" }).last();
  await expect(reloadedTerminalCard).toBeVisible();
  await expect(reloadedTerminalCard.locator(".toolCardSubtitle")).toContainText(/failed after \d+ attempts/);
  await expect(reloadedTerminalCard.locator(".runtimeErrorAction", { hasText: "Retry" })).toBeVisible();
  await expect(page.locator(".runtimeErrorCard", { hasText: "assistant error" })).toHaveCount(0);

  await reloadedTerminalCard.locator(".runtimeErrorAction", { hasText: "Retry" }).click();
  await expect(page.locator(".message.assistant", { hasText: "Recovered after manual continue." }).last()).toBeVisible();
  await expect(page.locator(".message.user", { hasText: "Please retry the previous request." })).toHaveCount(0);
});

test("continues an incomplete tool-result turn without adding a user message", async ({ page }) => {
  await page.goto("/");
  await page.locator("#prompt").fill("incomplete tool result");
  await page.locator("#primaryButton").click();

  const incompleteCard = page.locator(".runtimeErrorCard", { hasText: "response incomplete" }).last();
  await expect(incompleteCard).toBeVisible();
  await expect(incompleteCard.locator(".runtimeErrorAction", { hasText: "Continue" })).toBeVisible();
  await expect(incompleteCard.locator(".runtimeErrorAction", { hasText: "Switch model" })).toBeVisible();

  await page.reload();
  const reloadedIncompleteCard = page.locator(".runtimeErrorCard", { hasText: "response incomplete" }).last();
  await expect(reloadedIncompleteCard).toBeVisible();
  await reloadedIncompleteCard.locator(".runtimeErrorAction", { hasText: "Continue" }).click();
  await expect(page.locator(".message.assistant", { hasText: "Completed after manual continue." }).last()).toBeVisible();
  await expect(page.locator(".message.user", { hasText: "Please retry the previous request." })).toHaveCount(0);
});
