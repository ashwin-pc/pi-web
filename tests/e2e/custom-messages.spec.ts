import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

test("renders custom and unknown committed messages without disrupting the live stream", async ({ page }) => {
  await page.goto("/");
  await page.locator("#prompt").fill("slow live message kinds");
  await page.locator("#primaryButton").click();

  const visibleCustom = page.locator(".message.custom--probe", { hasText: "hello from an extension" });
  await expect(page.locator("#stopButton")).toBeVisible();
  await expect(visibleCustom).toHaveCount(1, { timeout: 2_000 });
  const streamedAssistant = page.locator(".message.assistant", { hasText: "streamed prefix" });
  await expect(streamedAssistant).toHaveCount(1);
  await expect(page.getByText("hidden extension message", { exact: true })).toHaveCount(0);
  await expect(page.locator(".message.system", { hasText: "future message content" })).toHaveCount(1, { timeout: 2_000 });
  await expect(streamedAssistant).toHaveCount(1);
  await expect(streamedAssistant).toContainText("streamed prefixstreamed suffix");
  await expect(page.locator("#stopButton")).toBeVisible();

  await page.locator("#stopButton").click();
  await expect(page.locator("#stopButton")).toBeHidden();
});
