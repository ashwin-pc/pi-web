import type { Page } from "@playwright/test";

export async function openSessionDrawerFooterAction(page: Page, label: "Preferences" | "System") {
  const drawer = page.locator("#sessionDrawer");
  if (!await drawer.isVisible()) await page.locator("#sessionButton").click();
  const button = label === "System"
    ? drawer.locator("#sessionDrawerInfoButton")
    : drawer.getByRole("button", { name: label, exact: true });
  await button.click();
}
