import { expect, test } from "@playwright/test";
import { openSessionDrawerFooterAction } from "./helpers/sessionDrawer.js";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
  await page.request.patch("/api/settings", { data: { identity: { name: "Pi Web", shortName: "Pi", avatar: { type: "preset", id: "current-pi" } } } });
});

test.afterEach(async ({ page }) => {
  await page.request.patch("/api/settings", { data: { identity: { name: "Pi Web", shortName: "Pi", avatar: { type: "preset", id: "current-pi" } } } });
});

test("app identity presets drive both live previews and runtime avatar surfaces", async ({ page }) => {
  await page.goto("/");
  await openSessionDrawerFooterAction(page, "Preferences");
  await page.locator("#settingsNavIdentity").click();

  const gallery = page.locator("#identityGallery");
  await expect(gallery.locator(".identityChoice")).toHaveCount(9);
  await expect(page.locator("button.identityChoiceCustom")).toBeVisible();
  for (const choice of await gallery.locator(".identityChoice").all()) {
    await expect(choice.locator("img.avatarMediaVideo")).toHaveAttribute("src", /\/avatars\/.*\.apng/);
    expect(await choice.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(100);
  }
  await expect(gallery.getByRole("button", { name: "Current Pi" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#identityPreview .identityPhone")).toBeVisible();

  await page.locator('[data-identity-preview="new"]').click();
  await expect(page.locator("#identityPreview .identitySessionShell")).toBeVisible();

  await gallery.getByRole("button", { name: "Fox", exact: true }).click();
  const sessionAvatar = page.locator("#identityPreview .identitySessionAvatar");
  const previewFab = page.locator("#identityPreview .identityPreviewFab");
  await expect(sessionAvatar.locator("img.avatarMediaStill")).toHaveAttribute("src", "/avatars/fox/still.png");
  await expect(sessionAvatar.locator("img.avatarMediaVideo")).toHaveAttribute("src", "/avatars/fox/new-session.apng");
  await expect.poll(() => sessionAvatar.locator("img.avatarMediaVideo").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await expect(previewFab).toHaveAttribute("src", "/avatars/fox/still.png");
  await expect(previewFab).toBeVisible();
  await expect.poll(() => previewFab.evaluate((image: HTMLImageElement) => {
    const rect = image.getBoundingClientRect();
    const preview = image.closest("#identityPreview")!.getBoundingClientRect();
    return image.complete && image.naturalWidth > 0 && rect.width > 0 && rect.height > 0
      && rect.left < preview.right && rect.right > preview.left
      && rect.top < preview.bottom && rect.bottom > preview.top
      && getComputedStyle(image).visibility === "visible" && Number(getComputedStyle(image).opacity) >= .99;
  })).toBe(true);

  const saved = page.waitForResponse(response => response.url().endsWith("/api/settings") && response.request().method() === "PATCH");
  await page.locator("#identitySave").click();
  await saved;
  await expect(page.locator(".actionLauncherToggle img")).toHaveAttribute("src", "/avatars/fox/still.png");
  await expect(page.locator("#identityNewSessionStill")).toHaveAttribute("src", "/avatars/fox/still.png");
  await expect(page.locator("#identityNewSessionAnimation").first()).toHaveAttribute("src", "/avatars/fox/new-session.apng");
});
