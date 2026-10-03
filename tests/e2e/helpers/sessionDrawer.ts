import type { Page } from "@playwright/test";
import { sessionDrawerAutoCloseQuery } from "../../../src/layout/responsive.js";

export function shouldCloseSessionDrawerAfterSwitch(page: Page) {
  return page.evaluate((query) => window.matchMedia(query).matches, sessionDrawerAutoCloseQuery);
}

export async function openSessionDrawerFooterAction(page: Page, label: "Preferences" | "System") {
  const drawer = page.locator("#sessionDrawer");
  if (!await drawer.isVisible()) await page.locator("#sessionButton").click();
  const button = label === "System"
    ? drawer.locator("#sessionDrawerInfoButton")
    : drawer.getByRole("button", { name: label, exact: true });
  await button.click();
}
