import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { unzipSync, zipSync } from "fflate";
import { openSessionDrawerFooterAction } from "./helpers/sessionDrawer.js";

const endpoint = "/api/identity/avatar/package";
async function avatarPackage() {
  const asset = async (path: string) => ({ mediaType: "image/png", base64: (await readFile(path)).toString("base64") });
  return { format: "pi-web-avatar", version: 1, label: "Bleckbeard", assets: {
    still: await asset("public/avatars/fox/still.png"),
    icon: await asset("public/avatars/cat/icon.png"),
  } };
}
async function openIdentity(page: import("@playwright/test").Page) {
  await page.goto("/");
  await openSessionDrawerFooterAction(page, "Preferences");
  await page.locator("#settingsNavIdentity").click();
}

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
  const reset = await page.request.patch("/api/settings", { data: { identity: { name: "Pi Web", shortName: "Pi", avatar: { type: "preset", id: "current-pi" } } } });
  const revision = (await reset.json()).settings.identity.revision;
  await page.request.delete(`/api/identity/avatar?revision=${revision}`);
});

test("portable package preserves drafts, separate previews and static export/import roundtrip", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Portable avatar lifecycle");
  const value = await avatarPackage();
  await openIdentity(page);
  await expect(page.locator("#identityPackageExport")).toBeDisabled();
  await page.locator("#identityName").fill("Unsaved workspace");
  await page.locator("#identityShortName").fill("Draft");
  await page.locator("#identityPackageUpload").setInputFiles({ name: "bleckbeard.pi-avatar.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(value)) });
  await expect(page.locator("#settingsStatus")).toContainText("Custom avatar applied immediately");
  await expect(page.locator("#identityName")).toHaveValue("Unsaved workspace");
  await expect(page.locator("#identityShortName")).toHaveValue("Draft");
  const settings = (await (await page.request.get("/api/settings")).json()).settings;
  expect(settings.identity.name).toBe("Pi Web");
  expect(settings.identity.avatar.assetId).toEqual(expect.any(String));
  await expect(page.locator("#identityPreview .identityPhoneIcon")).toHaveAttribute("src", /\/identity\/icon\.png\?v=/);
  await page.locator('[data-identity-preview="new"]').click();
  await expect(page.locator("#identityPreview .avatarMediaStill")).toHaveAttribute("src", /\/identity\/avatar\.png\?v=/);
  await expect(page.locator("#identityPreview .avatarMediaVideo")).toHaveCount(0);
  expect(await (await page.request.get("/identity/avatar.png")).body()).toEqual(Buffer.from(value.assets.still.base64, "base64"));
  expect(await (await page.request.get("/identity/icon.png")).body()).toEqual(Buffer.from(value.assets.icon.base64, "base64"));
  expect(await (await page.request.get("/identity/fab.png")).body()).toEqual(Buffer.from(value.assets.still.base64, "base64"));
  const download = page.waitForEvent("download");
  await page.locator("#identityPackageExport").click();
  const exported = await download;
  expect(exported.suggestedFilename()).toBe("custom-avatar.pi-avatar.zip");
  const portable = await readFile((await exported.path())!);
  const files = unzipSync(portable);
  expect(Object.keys(files).sort()).toEqual(["icon.png", "manifest.json", "still.png"]);
  expect(Buffer.from(files["still.png"]).equals(Buffer.from(value.assets.still.base64, "base64"))).toBe(true);
  expect(Buffer.from(files["icon.png"]).equals(Buffer.from(value.assets.icon.base64, "base64"))).toBe(true);
  const legacy = await page.request.get(`${endpoint}?format=json`);
  expect(await legacy.json()).toEqual(value);
  // Remove the source custom assets, then import only the downloaded file.
  // No source paths, settings refs or original server files are needed.
  const reset = await page.request.patch("/api/settings", { data: { identity: { avatar: { type: "preset", id: "current-pi" } } } });
  await page.request.delete(`/api/identity/avatar?revision=${(await reset.json()).settings.identity.revision}`);
  await page.reload();
  await openSessionDrawerFooterAction(page, "Preferences");
  await page.locator("#settingsNavIdentity").click();
  await page.locator("#identityPackageUpload").setInputFiles({ name: exported.suggestedFilename(), mimeType: "application/zip", buffer: portable });
  await expect(page.locator("#identityPackageExport")).toBeEnabled();
  expect(await (await page.request.get("/identity/icon.png")).body()).toEqual(Buffer.from(value.assets.icon.base64, "base64"));
  await page.locator("#identityName").fill("ZIP draft");
  await page.locator("#identityShortName").fill("ZIP");
  const zipImport = page.waitForRequest(request => request.url().endsWith(endpoint) && request.method() === "POST");
  await page.locator("#identityPackageUpload").setInputFiles({ name: "UPPER.PI-AVATAR.ZIP", mimeType: "application/octet-stream", buffer: portable });
  expect((await zipImport).headers()["content-type"]).toBe("application/zip");
  await expect(page.locator("#identityPackageExport")).toBeEnabled();
  await expect(page.locator("#identityName")).toHaveValue("ZIP draft");
  await expect(page.locator("#identityShortName")).toHaveValue("ZIP");
  expect((await (await page.request.get("/api/settings")).json()).settings.identity.name).toBe("Pi Web");
});

test("animated custom package reuses APNG playback, still fallback and reduced motion", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Animated package lifecycle");
  const value = await avatarPackage();
  const animation = await readFile("public/avatars/fox/new-session.apng");
  const fab = await readFile("public/avatars/cat/still.png");
  const response = await page.request.post(endpoint, { data: { ...value, assets: { ...value.assets, fab: { mediaType: "image/png", base64: fab.toString("base64") }, newSession: { mediaType: "image/apng", base64: animation.toString("base64") } } } });
  expect(response.ok()).toBe(true);
  expect((await response.json()).settings.identity.avatar.animated).toBe(true);
  expect(await (await page.request.get("/identity/new-session.apng")).body()).toEqual(animation);
  expect(await (await page.request.get("/identity/fab.png")).body()).toEqual(fab);
  expect(await (await page.request.get("/identity/avatar.png")).body()).toEqual(Buffer.from(value.assets.still.base64, "base64"));
  const config = await (await page.request.get("/identity/config.json")).json();
  expect(config.assets.fab).toMatch(/^\/identity\/fab\.png\?v=/);
  expect(config.name).toBe("Pi Web");
  await openIdentity(page);
  await page.locator('[data-identity-preview="new"]').click();
  await expect(page.locator("#identityPreview .avatarMediaVideo")).toHaveAttribute("src", /\/identity\/new-session\.apng\?v=/);
  await expect(page.locator("#identityPreview .avatarMediaPlaying")).toHaveCount(1);
  const files = unzipSync(await (await page.request.get(endpoint)).body());
  expect(Buffer.from(files["new-session.apng"])).toEqual(animation);
  expect(Buffer.from(files["fab.png"])).toEqual(fab);
  const json = await (await page.request.get(`${endpoint}?format=json`)).json();
  expect(Buffer.from(json.assets.fab.base64, "base64")).toEqual(fab);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await openSessionDrawerFooterAction(page, "Preferences");
  await page.locator("#settingsNavIdentity").click();
  await page.locator('[data-identity-preview="new"]').click();
  await expect(page.locator("#identityPreview .avatarMediaVideo")).toHaveCount(0);
  await expect(page.locator("#identityPreview .avatarMediaStill")).toHaveAttribute("src", /\/identity\/avatar\.png/);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.route("**/identity/new-session.apng?*", route => route.abort());
  await page.reload();
  await openSessionDrawerFooterAction(page, "Preferences");
  await page.locator("#settingsNavIdentity").click();
  await page.locator('[data-identity-preview="new"]').click();
  await expect(page.locator("#identityPreview .avatarMediaPlaying")).toHaveCount(0);
  await expect(page.locator("#identityPreview .avatarMediaStill")).toBeVisible();
});

test("malformed and traversal ZIP imports leave existing assets and names untouched", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Portable avatar rejection");
  const value = await avatarPackage();
  expect((await page.request.post(endpoint, { data: value })).ok()).toBe(true);
  const original = (await (await page.request.get("/api/settings")).json()).settings.identity;
  const valid = unzipSync(await (await page.request.get(endpoint)).body());
  await openIdentity(page);
  await page.locator("#identityName").fill("Unsent ZIP draft");
  const invalidFiles = [Buffer.from("not a ZIP"), Buffer.from(zipSync({ ...valid, "../outside.png": valid["still.png"] }))];
  for (const buffer of invalidFiles) {
    const rejected = page.waitForResponse(response => response.url().endsWith(endpoint) && response.request().method() === "POST");
    await page.locator("#identityPackageUpload").setInputFiles({ name: "invalid.pi-avatar.zip", mimeType: "application/zip", buffer });
    expect((await rejected).status()).toBe(400);
    await expect(page.locator("#identityPackageImport")).toBeEnabled();
    await expect(page.locator("#identityName")).toHaveValue("Unsent ZIP draft");
    expect((await (await page.request.get("/api/settings")).json()).settings.identity).toEqual(original);
    expect((await (await page.request.get("/identity/avatar.png")).body()).equals(Buffer.from(value.assets.still.base64, "base64"))).toBe(true);
    expect((await (await page.request.get("/identity/icon.png")).body()).equals(Buffer.from(value.assets.icon.base64, "base64"))).toBe(true);
  }
});

test("package errors preserve drafts and processing blocks every mutation", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Portable avatar concurrency");
  await openIdentity(page);
  await page.locator("#identityName").fill("Kept draft");
  await page.locator("#identityPackageUpload").setInputFiles({ name: "bad.pi-avatar.json", mimeType: "application/json", buffer: Buffer.from("{not JSON") });
  await expect(page.locator("#settingsStatus")).toContainText(/invalid|JSON/i);
  await expect(page.locator("#identityName")).toHaveValue("Kept draft");
  await expect(page.locator("#identityPackageImport")).toBeEnabled();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**${endpoint}`, async route => { if (route.request().method() === "POST") await held; await route.continue(); });
  await page.locator("#identityPackageUpload").setInputFiles({ name: "valid.pi-avatar.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(await avatarPackage())) });
  for (const selector of ["#identitySave", "#identityReset", "#identityUpload", "#identityPackageImport", "#identityPackageExport", "#identityGallery button"]) {
    await expect(page.locator(selector).first()).toBeDisabled();
  }
  await page.locator("#identityUpload").setInputFiles("public/avatars/current-pi/still.png");
  await expect(page.locator("#settingsStatus")).toContainText("Wait for the current identity update");
  release();
  await expect(page.locator("#identityPackageExport")).toBeEnabled();
  await expect(page.locator("#identityName")).toHaveValue("Kept draft");
  await page.route(`**${endpoint}`, route => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Export unavailable" }) }));
  await page.locator("#identityPackageExport").click();
  await expect(page.locator("#settingsStatus")).toContainText("Export unavailable");
  await expect(page.locator("#identityPackageExport")).toBeEnabled();
});
