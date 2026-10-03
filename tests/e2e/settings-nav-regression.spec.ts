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
  await openSessionDrawerFooterAction(page, "Preferences");

  const icons = page.locator("[data-settings-icon]");
  await expect.poll(async () => icons.count()).toBeGreaterThan(0);
  expect(await icons.evaluateAll(elements => elements
    .filter(element => element.querySelectorAll(":scope > svg").length !== 1)
    .map(element => element.getAttribute("data-settings-icon")))).toEqual([]);

  await page.locator("#settingsCloseButton").click();
  await openSessionDrawerFooterAction(page, "System");
  await expect(page.locator("#settingsNavServer")).toBeVisible();
  await expect(page.locator("#settingsNavServer [data-settings-icon='server'] > svg")).toHaveCount(1);
});

test("mobile nav aligns every chevron with or without an optional badge", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile");
  await page.goto("/");

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await openSessionDrawerFooterAction(page, "System");
    const extensionButton = page.locator("#settingsNavExtensionHealth");
    const badge = extensionButton.locator(".settingsNavBadge");
    await expect(badge).toBeVisible();

    const rightEdges = await page.locator(".settingsNavButton:visible .settingsNavChevron").evaluateAll(elements =>
      elements.map(element => element.getBoundingClientRect().right));
    expect(rightEdges.length).toBeGreaterThan(1);
    expect(Math.max(...rightEdges) - Math.min(...rightEdges)).toBeLessThan(0.5);

    const layout = await extensionButton.evaluate(element => {
      const copy = element.querySelector(".settingsNavCopy")!.getBoundingClientRect();
      const badgeBox = element.querySelector(".settingsNavBadge")!.getBoundingClientRect();
      const chevronBox = element.querySelector(".settingsNavChevron")!.getBoundingClientRect();
      return { copy, badgeBox, chevronBox };
    });
    expect(Math.abs((layout.badgeBox.top + layout.badgeBox.bottom) / 2 - (layout.chevronBox.top + layout.chevronBox.bottom) / 2)).toBeLessThan(2);
    expect(layout.copy.right).toBeLessThanOrEqual(layout.badgeBox.left);

    await badge.evaluate(element => { (element as HTMLElement).hidden = true; });
    const hiddenBadgeRight = await extensionButton.locator(".settingsNavChevron").evaluate(element => element.getBoundingClientRect().right);
    expect(hiddenBadgeRight).toBeCloseTo(rightEdges[0], 1);
    await page.locator("#settingsCloseButton").click();
  }
});

test("standalone controls keep four borders while composer footer keeps its seam", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.route("**/__supervisor/status", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, childGeneration: 1, childPid: 1234 }),
  }));
  await page.goto("/");
  await openSessionDrawerFooterAction(page, "Preferences");

  for (const selector of ["#settingRunNotificationsTestButton", "#settingSaveModelDefaultsButton", "#restartServerButton"]) {
    const target = page.locator(selector);
    if (selector.includes("Notifications")) await page.locator("#settingsNavNotifications").click();
    if (selector.includes("ModelDefaults")) await page.locator("#settingsNavNewSessions").click();
    if (selector.includes("restart")) {
      await page.locator("#settingsCloseButton").click();
      await openSessionDrawerFooterAction(page, "System");
      await page.locator("#settingsNavServer").click();
    }
    await expect(target).toBeVisible();
    expect(await target.evaluate(element => {
      const style = getComputedStyle(element);
      return [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth];
    })).toEqual(["1px", "1px", "1px", "1px"]);
  }

  await page.locator("#settingsCloseButton").click();
  await page.locator("#prompt").focus();
  expect(await page.locator("#modelSettingsButton").evaluate(element => getComputedStyle(element).borderTopWidth)).toBe("0px");
  expect(await page.locator("#primaryButton").evaluate(element => getComputedStyle(element).borderTopWidth)).toBe("0px");
  await page.locator("#modelSettingsButton").click();
  expect(await page.locator("#modelSelect").evaluate(element => getComputedStyle(element).borderTopWidth)).toBe("1px");
});
