import { expect, test } from "@playwright/test";
import { openSessionDrawerFooterAction } from "./helpers/sessionDrawer.js";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

test("every declared settings icon resolves, including supervised server", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.route("**/__supervisor/status", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, childGeneration: 1, childPid: 1234 }),
  }));
  await page.goto("/");
  await openSessionDrawerFooterAction(page, "Settings");

  const icons = page.locator("[data-settings-icon]");
  await expect.poll(async () => icons.count()).toBeGreaterThan(0);
  expect(await icons.evaluateAll(elements => elements
    .filter(element => element.querySelectorAll(":scope > svg").length !== 1)
    .map(element => element.getAttribute("data-settings-icon")))).toEqual([]);

  await expect(page.locator("#settingsNavServer")).toBeVisible();
  await expect(page.locator("#settingsNavServer [data-settings-icon='server'] > svg")).toHaveCount(1);
});

test("mobile nav keeps optional badge and chevron on one row at narrow widths", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile");
  await page.goto("/");

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await openSessionDrawerFooterAction(page, "Settings");
    const button = page.locator("#settingsNavExtensions");
    const badge = button.locator(".settingsNavBadge");
    const chevron = button.locator(".settingsNavChevron");
    await expect(badge).toBeVisible();

    const layout = await button.evaluate(element => {
      const box = element.getBoundingClientRect();
      const copy = element.querySelector(".settingsNavCopy")!.getBoundingClientRect();
      const badgeBox = element.querySelector(".settingsNavBadge")!.getBoundingClientRect();
      const chevronBox = element.querySelector(".settingsNavChevron")!.getBoundingClientRect();
      return { box, copy, badgeBox, chevronBox };
    });
    expect(Math.abs((layout.badgeBox.top + layout.badgeBox.bottom) / 2 - (layout.chevronBox.top + layout.chevronBox.bottom) / 2)).toBeLessThan(2);
    expect(layout.copy.right).toBeLessThanOrEqual(layout.badgeBox.left);
    expect(layout.chevronBox.right).toBeLessThanOrEqual(layout.box.right);
    expect(layout.chevronBox.bottom).toBeLessThanOrEqual(layout.box.bottom);

    await badge.evaluate(element => { (element as HTMLElement).hidden = true; });
    await expect(badge).toBeHidden();
    await expect(chevron).toBeVisible();
    const hiddenBadgeLayout = await chevron.boundingBox();
    const buttonBox = await button.boundingBox();
    expect(hiddenBadgeLayout!.y + hiddenBadgeLayout!.height).toBeLessThanOrEqual(buttonBox!.y + buttonBox!.height);
    await page.locator("#settingsCloseButton").click();
  }
});
