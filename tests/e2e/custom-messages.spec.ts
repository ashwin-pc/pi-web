import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

test("renders custom, bash, and compaction messages live without relying on agent_end", async ({ page }) => {
  await page.goto("/");
  await page.locator("#prompt").fill("slow live message kinds");
  await page.locator("#primaryButton").click();

  const visibleCustom = page.locator(".message.custom--probe", { hasText: "hello from an extension" });
  await expect(page.locator("#stopButton")).toBeVisible();
  await expect(visibleCustom).toHaveCount(1);
  await expect(page.getByText("hidden extension message", { exact: true })).toHaveCount(0);
  await expect(page.locator(".toolCard", { hasText: "live bash output" })).toHaveCount(1);
  await expect(page.locator(".message.compaction", { hasText: "live compaction summary" })).toHaveCount(1);

  await expect(page.locator("#stopButton")).toBeHidden();
  await expect(visibleCustom).toHaveCount(1);
  await expect(page.getByText("hidden extension message", { exact: true })).toHaveCount(0);
});
