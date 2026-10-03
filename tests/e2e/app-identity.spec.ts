import { expect, test } from "@playwright/test";
import { openSessionDrawerFooterAction } from "./helpers/sessionDrawer.js";
import { avatarPresetIds } from "../../server/shared/appIdentity.js";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
  await page.request.patch("/api/settings", { data: { identity: { name: "Pi Web", shortName: "Pi", avatar: { type: "preset", id: "current-pi" } } } });
});

test.afterEach(async ({ page }) => {
  await page.request.patch("/api/settings", { data: { identity: { name: "Pi Web", shortName: "Pi", avatar: { type: "preset", id: "current-pi" } } } });
});

test("sign-in HTML starts with the selected avatar and never requests default Pi", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Public sign-in artwork regression");
  await page.request.patch("/api/settings", { data: { identity: { name: "Fox Workspace", avatar: { type: "preset", id: "fox" } } } });
  const requested: string[] = [];
  page.on("request", request => requested.push(new URL(request.url()).pathname));
  const login = await page.goto("/api/auth/login");
  expect(login?.status()).toBe(200);
  await expect(page).toHaveTitle("Fox Workspace");
  await expect(page.locator(".avatarAnimation")).toHaveAttribute("src", "/avatars/fox/new-session.apng");
  await expect.poll(() => page.locator(".avatarAnimation").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  expect(requested.filter(path => path.startsWith("/avatars/current-pi/"))).toEqual([]);
  expect(requested).not.toContain("/identity/config.json");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".avatarAnimation")).toBeHidden();
  await expect(page.locator(".avatarStill")).toBeVisible();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(page.locator(".avatarAnimation")).toBeVisible();
  await page.request.post("/api/identity/avatar", {
    data: await import("node:fs/promises").then(fs => fs.readFile("public/avatars/current-pi/still.png")),
    headers: { "content-type": "image/png" },
  });
  requested.length = 0;
  await page.reload();
  await expect(page.locator(".avatarAnimation")).toHaveCount(0);
  await expect.poll(() => page.locator(".avatarStill").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  expect(requested).not.toContain("/avatars/current-pi/new-session.apng");
});

test("public identity artwork follows every preset and an existing custom upload", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Public identity route regression");
  for (const id of avatarPresetIds) {
    const saved = await page.request.patch("/api/settings", { data: { identity: { avatar: { type: "preset", id } } } });
    expect(saved.ok()).toBe(true);
    const config = await (await page.request.get("/identity/config.json")).json();
    expect(config.assets.still).toBe(`/avatars/${id}/still.png`);
    expect(config.assets.newSession.apng).toBe(`/avatars/${id}/new-session.apng`);
    const icon = await page.request.get("/identity/icon.png", { maxRedirects: 0 });
    expect(icon.status()).toBe(302);
    expect(icon.headers().location).toBe(`/avatars/${id}/icon.png`);
  }
  const upload = await page.request.post("/api/identity/avatar", {
    data: await import("node:fs/promises").then(fs => fs.readFile("public/avatars/current-pi/still.png")),
    headers: { "content-type": "image/png" },
  });
  expect(upload.ok()).toBe(true);
  const config = await (await page.request.get("/identity/config.json")).json();
  expect(config.assets.still).toMatch(/^\/identity\/avatar\.png\?v=\d+$/);
  expect(config.assets.newSession).toBeUndefined();
  expect((await page.request.get("/identity/icon.png", { maxRedirects: 0 })).status()).toBe(200);
});

test("reset confirms removal, preserves drafts on cancel, and rejects stale cleanup", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Identity reset lifecycle regression");
  const { readFile } = await import("node:fs/promises");
  const fox = await readFile("public/avatars/fox/still.png");
  const cat = await readFile("public/avatars/cat/still.png");
  expect((await page.request.post("/api/identity/avatar", { data: fox, headers: { "content-type": "image/png" } })).ok()).toBe(true);
  await page.request.patch("/api/settings", { data: { identity: { avatar: { type: "preset", id: "fox" } } } });
  await page.request.patch("/api/settings", { data: { identity: { avatar: { type: "custom" } } } });
  expect(await (await page.request.get("/identity/avatar.png")).body()).toEqual(fox);
  await page.goto("/");
  await openSessionDrawerFooterAction(page, "Preferences");
  await page.locator("#settingsNavIdentity").click();
  await page.locator("#identityName").fill("Unsaved draft");
  page.once("dialog", dialog => dialog.dismiss());
  await page.locator("#identityReset").click();
  await expect(page.locator("#identityName")).toHaveValue("Unsaved draft");
  expect((await (await page.request.get("/api/settings")).json()).settings.identity.avatar).toEqual({ type: "custom" });
  page.once("dialog", dialog => {
    expect(dialog.message()).toContain("permanently removes your uploaded custom avatar file");
    void dialog.accept();
  });
  await page.locator("#identityReset").click();
  await expect(page.locator("#settingsStatus")).toContainText("uploaded custom avatar removed");
  await expect(page.locator("#identityName")).toHaveValue("Pi Web");
  // Explicitly re-selecting custom without a new upload must use the fallback:
  // reset removed the old bytes, unlike merely saving a preset selection.
  await page.request.patch("/api/settings", { data: { identity: { avatar: { type: "custom" } } } });
  expect((await (await page.request.get("/identity/config.json")).json()).assets.still).toBe("/avatars/current-pi/still.png");
  const reset = await page.request.patch("/api/settings", { data: { identity: { avatar: { type: "preset", id: "current-pi" } } } });
  const revision = (await reset.json()).settings.identity.revision;
  expect((await page.request.post("/api/identity/avatar", { data: cat, headers: { "content-type": "image/png" } })).ok()).toBe(true);
  const stale = await page.request.delete(`/api/identity/avatar?revision=${revision}`);
  expect(stale.status()).toBe(409);
  expect(await (await page.request.get("/identity/avatar.png")).body()).toEqual(cat);
});

test("in-flight save rejects concurrent upload explicitly and allows retry", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Upload concurrency regression");
  await page.goto("/");
  await openSessionDrawerFooterAction(page, "Preferences");
  await page.locator("#settingsNavIdentity").click();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/settings", async route => {
    if (route.request().method() === "PATCH") await held;
    await route.continue();
  });
  let uploads = 0;
  page.on("request", request => { if (request.url().endsWith("/api/identity/avatar")) uploads++; });
  await page.locator("#identityName").fill("Pending Save");
  await page.locator("#identitySave").click();
  await expect(page.locator("#identityUpload")).toBeDisabled();
  // A programmatic change must report the conflict, not silently lose the file.
  await page.locator("#identityUpload").setInputFiles("public/avatars/current-pi/still.png");
  await expect(page.locator("#settingsStatus")).toContainText("Wait for the current identity update");
  expect(uploads).toBe(0);
  release();
  await expect(page.locator("#identityUpload")).toBeEnabled();
  await page.locator("#identityUpload").setInputFiles("public/avatars/current-pi/still.png");
  await expect.poll(() => uploads).toBe(1);
  await expect(page.locator("button.identityChoiceCustom")).toHaveAttribute("aria-pressed", "true");
});

test("upload preprocessing blocks concurrent saves without dropping the upload", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Upload concurrency regression");
  await page.goto("/");
  await openSessionDrawerFooterAction(page, "Preferences");
  await page.locator("#settingsNavIdentity").click();
  await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
      return original.call(this, blob => setTimeout(() => callback(blob), 500), ...args);
    };
  });
  let uploads = 0;
  page.on("request", request => { if (request.url().endsWith("/api/identity/avatar")) uploads++; });
  await page.locator("#identityName").fill("Unsent Draft");
  await page.locator("#identityUpload").setInputFiles("public/avatars/current-pi/still.png");
  await expect(page.locator("#identitySave")).toBeDisabled();
  await expect(page.locator("#identityUpload")).toBeDisabled();
  await expect.poll(() => uploads).toBe(1);
  await expect(page.locator("#identitySave")).toBeEnabled();
  await expect(page.locator("#identityName")).toHaveValue("Unsent Draft");
  await expect(page.locator("button.identityChoiceCustom")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#settingsStatus")).toContainText("Custom avatar applied immediately");
  const custom = await (await page.request.get("/identity/avatar.png")).body();
  expect([custom.readUInt32BE(16), custom.readUInt32BE(20)]).toEqual([512, 512]);
  const manifest = await (await page.request.get("/manifest.webmanifest")).json();
  expect(manifest.icons).toEqual([{ src: expect.stringMatching(/^\/identity\/icon\.png\?v=\d+$/), sizes: "512x512", type: "image/png", purpose: "any" }]);
});

test("unsaved identity drafts survive settings broadcasts and custom upload", async ({ page }) => {
  await page.goto("/");
  await openSessionDrawerFooterAction(page, "Preferences");
  await page.locator("#settingsNavIdentity").click();
  await page.locator("#identityName").fill("Draft Brand");
  await page.locator("#identityShortName").fill("Draft");
  await page.request.patch("/api/settings", { data: { completionVibration: false } });
  await expect(page.locator("#identityName")).toHaveValue("Draft Brand");
  await expect(page.locator("#identityShortName")).toHaveValue("Draft");
  await page.locator("#identityUpload").setInputFiles("public/avatars/current-pi/still.png");
  await expect(page.locator("button.identityChoiceCustom")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#identityName")).toHaveValue("Draft Brand");
  await expect(page.locator("#identityShortName")).toHaveValue("Draft");
  await page.locator("#identitySave").click();
  await expect.poll(async () => (await (await page.request.get("/identity/config.json")).json()).name).toBe("Draft Brand");
});

test("app identity presets drive both live previews and runtime avatar surfaces", async ({ page }) => {
  await page.goto("/");
  await openSessionDrawerFooterAction(page, "Preferences");
  await page.locator("#settingsNavIdentity").click();

  const gallery = page.locator("#identityGallery");
  await expect(gallery.locator(".identityChoice")).toHaveCount(9);
  await expect(page.locator("button.identityChoiceCustom")).toBeVisible();
  for (const choice of await gallery.locator(".identityChoice").all()) {
    await choice.scrollIntoViewIfNeeded();
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
