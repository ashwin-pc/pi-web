import { expect, test, type Locator } from "@playwright/test";

async function expectWidthOrder(items: Locator) {
  const measurements = await items.evaluateAll((buttons) => buttons.map((button) => ({
    label: button.textContent,
    width: button.getBoundingClientRect().width,
  })));
  expect(measurements).toEqual([...measurements].sort((a, b) => a.width - b.width));
}

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
  // Assert final button widths, not the staggered fan-out's transient scale.
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test("FAB orders built-in actions by their rendered widths", async ({ page }) => {
  await page.goto("/");
  await page.locator(".actionLauncherToggle").click();
  const items = page.locator(".actionLauncherMenu").getByRole("menuitem");
  await expect(items).toHaveCount(5);
  await expect(items.first()).toBeVisible();
  await expectWidthOrder(items);
});

test("FAB uses the styled font for extension labels and preserves equal-width registration order", async ({ page }) => {
  await page.goto("/");
  await page.addStyleTag({ content: ".actionLauncherItem { font: 400 14px monospace; }" });

  // Equal-width monospace labels have different widths in proportional fonts.
  // Update while hidden as well as open: both paths must use the live styles.
  const launcher = page.locator(".actionLauncherMenu");
  for (const labels of [["WWW", "iii"], ["iii", "WWW"]]) {
    await page.request.post("/api/mock/state", { data: {
      webContributions: [
        { version: 1, key: "notes", slot: "panel", kind: "rendered", title: "Notes" },
        ...labels.map((label, index) => ({
          version: 1, key: `label-${index}`, slot: "fab", kind: "static",
          title: label, label, icon: "notebook-pen", opens: "notes",
        })),
      ],
    } });
    const buttons = launcher.locator(".actionLauncherItem");
    await expect(buttons).toHaveCount(7);
    await expect(buttons.filter({ hasText: /^(WWW|iii)$/ })).toHaveText(labels);
    if (await launcher.isHidden()) await page.locator(".actionLauncherToggle").click();
    const items = launcher.getByRole("menuitem");
    await expect(items).toHaveCount(7);
    await expect(items.first()).toBeVisible();
    await expectWidthOrder(items);
  }
});
