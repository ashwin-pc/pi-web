import type { Page } from "@playwright/test";

export async function openLauncherAction(page: Page, label: string) {
  await page.locator("#prompt").blur();
  await page.locator(".actionLauncherToggle").click();
  await page.locator(".actionLauncherItem", { hasText: label }).click();
}
