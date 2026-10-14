import { expect, test } from "@playwright/test";
import { nextRealtimeHello } from "./helpers/realtimeReady.js";

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

test("compact runtime retries keep one current body and terminal failures expand with details", async ({ page }) => {
  const hello = nextRealtimeHello(page);
  await page.goto("/");
  await hello;
  await page.locator("#settingDensitySelect").evaluate((select: HTMLSelectElement) => {
    select.value = "compact";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const publish = async (event: Record<string, unknown>) => {
    expect((await page.request.post("/api/mock/event", { data: { type: "agent_event", sessionId: "mock-current", event } })).ok()).toBe(true);
  };
  await publish({ type: "agent_start" });
  await publish({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: "Throttling error (429)" });
  const retry = page.locator(".runtimeErrorCard", { hasText: "retrying assistant request" }).last();
  await expect(retry.locator(".toolCardBody")).toHaveCount(1);
  await retry.locator(".toolCardExpandToggle").click();
  await expect(retry.locator(".toolCardBody")).toBeVisible();
  await expect(retry.locator(".toolCardBody")).toContainText("automatically");
  await retry.locator(".toolCardExpandToggle").click();
  await retry.locator(".toolCardExpandToggle").click();
  await expect(retry.locator(".toolCardBody")).toHaveCount(1);
  await publish({ type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 2000, errorMessage: "Throttling error (429)" });
  await expect(retry.locator(".toolCardBody")).toContainText("attempt 2/3");
  await publish({ type: "auto_retry_end", success: false, attempt: 3, maxAttempts: 3, finalError: "Service unavailable (503)" });
  await publish({ type: "agent_end", messages: [] });
  const terminal = page.locator(".runtimeErrorCard", { hasText: "response failed" }).last();
  await expect(terminal.locator(".toolCardBody")).toHaveCount(1);
  await expect(terminal.locator(".toolCardBody")).toBeVisible();
  await expect(terminal.locator(".toolCardBody")).toContainText("exhausted automatic retries");
});

test("shows summarization retries through the generic retry UI without invented metadata", async ({ page }) => {
  await page.request.post("/api/mock/reset");
  await page.goto("/");
  await page.locator("#prompt").fill("summary retry");
  await page.locator("#primaryButton").click();
  const card = page.locator(".toolCard.runtimeErrorCard").last();
  await expect(card).toContainText("retrying summary");
  await expect(card).toContainText("attempt 2/3");
  await expect(card).toContainText("retrying branch summary");
});

test("continues an incomplete tool-result turn without adding a user message", async ({ page }) => {
  await page.goto("/");
  await page.locator("#settingDensitySelect").evaluate((select: HTMLSelectElement) => {
    select.value = "compact";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.locator("#prompt").fill("incomplete tool result");
  await page.locator("#primaryButton").click();

  const incompleteCard = page.locator(".runtimeErrorCard", { hasText: "response incomplete" }).last();
  await expect(incompleteCard).toBeVisible();
  await expect(incompleteCard.locator(".toolCardBody")).toHaveCount(1);
  await expect(incompleteCard.locator(".toolCardBody")).toBeVisible();
  await expect(incompleteCard.locator(".toolCardBody")).toContainText("Continue from the current context");
  await expect(incompleteCard.locator(".runtimeErrorAction", { hasText: "Continue" })).toBeVisible();
  await expect(incompleteCard.locator(".runtimeErrorAction", { hasText: "Switch model" })).toBeVisible();

  await page.reload();
  const reloadedIncompleteCard = page.locator(".runtimeErrorCard", { hasText: "response incomplete" }).last();
  await expect(reloadedIncompleteCard).toBeVisible();
  await reloadedIncompleteCard.locator(".runtimeErrorAction", { hasText: "Continue" }).click();
  await expect(page.locator(".message.assistant", { hasText: "Completed after manual continue." }).last()).toBeVisible();
  await expect(page.locator(".message.user", { hasText: "Please retry the previous request." })).toHaveCount(0);
});
