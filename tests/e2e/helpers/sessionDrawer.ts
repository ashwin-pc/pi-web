import type { Page } from "@playwright/test";

export async function openSessionDrawerFooterAction(page: Page, label: "Settings" | "System info") {
  const drawer = page.locator("#sessionDrawer");
  if (!await drawer.isVisible()) await page.locator("#sessionButton").click();
  await drawer.getByRole("button", { name: label, exact: true }).click();
}
