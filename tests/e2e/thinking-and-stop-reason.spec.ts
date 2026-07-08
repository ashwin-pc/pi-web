import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

test("streams assistant thinking parts as separate cards", async ({ page }) => {
  await page.goto("/");
  await page.locator("#prompt").fill("please show a thinking card");
  await page.locator("#primaryButton").click();

  const card = page.locator(".toolCard.toolCard--thinking").last();
  await expect(card.locator(".toolCardName")).toHaveText("thinking");
  await expect(card).toHaveClass(/toolCard--thinkingStreaming/);
  await expect(card.locator(".toolCardBody")).toContainText("First I will inspect the request");
  await expect(card.locator(".toolCardThinkingHeading")).toHaveText("Inspecting request");
  await expect(card.locator(".toolCardThinkingHeading")).toHaveCSS("font-weight", "800");
  await expect(card.locator(".toolCardBody")).not.toContainText("**Inspecting request**");
  await expect(page.locator(".message.assistant", { hasText: "Final answer after thinking." })).toHaveCount(0);

  await expect(page.locator(".message.assistant").last()).toContainText("Final answer after thinking.");
  await expect(page.locator(".message.assistant").last()).not.toContainText("First I will inspect");
});