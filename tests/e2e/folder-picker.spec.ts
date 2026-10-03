import { expect, test } from "@playwright/test";

async function openPicker(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.locator("#prompt").fill("/clear");
  await page.locator("#primaryButton").click();
  const trigger = page.getByRole("button", { name: "Change working directory" });
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(page.getByRole("dialog", { name: "Folder" })).toBeVisible();
  return trigger;
}

test.describe("folder picker", () => {
  test("supports keyboard browse, favorites, recents, and successful selection", async ({ page }) => {
    await page.request.patch("/api/session-ui-state", { data: { favoriteFolders: [] } });
    const trigger = await openPicker(page);
    const search = page.getByRole("searchbox", { name: "Search saved folders" });
    if ((page.viewportSize()?.width || 0) > 640) await expect(search).toBeFocused();
    else await expect(search).not.toBeFocused();
    await page.getByRole("button", { name: "Browse folders" }).click();
    const use = page.locator(".folderPickerSelect");
    const currentPath = (await use.getAttribute("aria-label"))!.replace(/^Use /, "");

    await page.getByRole("button", { name: "Add current folder to favorites" }).click();
    await expect(page.getByRole("button", { name: "Remove current folder from favorites" })).toBeVisible();
    await page.getByRole("button", { name: `Use ${currentPath}` }).click();
    await expect(page.getByRole("dialog", { name: "Folder" })).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await trigger.click();
    await expect(page.getByRole("button", { name: `Use ${currentPath.split("/").filter(Boolean).at(-1) || currentPath}` }).first()).toBeVisible();
    await expect(page.locator(".folderPickerFavorite")).toHaveCount(1);
  });

  test("navigates folders, edits paths, and reports inline create failures", async ({ page }) => {
    await page.route("**/api/fs/dirs", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Folder cannot be created" }) });
      } else await route.fallback();
    });
    await openPicker(page);
    await page.getByRole("button", { name: "Browse folders" }).click();
    await expect(page.locator(".folderPickerFile").first()).toBeVisible();
    await page.locator(".folderPickerFile").first().click();
    await expect(page.locator(".folderPickerCrumb[aria-current]")).toBeVisible();

    await page.getByRole("button", { name: "Edit folder path" }).click();
    const path = page.getByRole("textbox", { name: "Folder path" });
    await expect(path).toBeFocused();
    await path.press("Escape");
    await expect(page.getByRole("button", { name: "Edit folder path" })).toBeFocused();

    await page.getByRole("button", { name: "Create new folder" }).click();
    await page.getByRole("textbox", { name: "New folder name" }).fill("blocked");
    await page.getByRole("button", { name: "Create folder" }).click();
    await expect(page.getByRole("alert")).toHaveText("Folder cannot be created");
    await expect(page.getByRole("textbox", { name: "New folder name" })).toBeFocused();
  });

  test("keeps quick mode stable when an obsolete browse request completes", async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/fs/dirs?*", async (route) => {
      await held;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, path: "/held", parent: "/", dirs: [] }) });
    });
    await openPicker(page);
    await page.getByRole("button", { name: "Browse folders" }).click();
    await page.getByRole("button", { name: "Back to saved folders" }).click();
    release();
    await page.waitForTimeout(100);
    await expect(page.getByRole("searchbox", { name: "Search saved folders" })).toBeVisible();
    await expect(page.locator(".folderPickerBrowse")).toHaveCount(0);
  });

  test("shows quick-select errors and commits only one selection", async ({ page }) => {
    await page.request.patch("/api/session-ui-state", { data: { favoriteFolders: ["/saved/favorite"] } });
    let requests = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/session/cwd", async (route) => {
      requests += 1;
      await held;
      await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Favorite is unavailable" }) });
    });
    await openPicker(page);
    const favorite = page.getByRole("button", { name: "Use favorite" });
    await favorite.click();
    await expect(favorite).toBeDisabled();
    await favorite.click({ force: true });
    release();
    await expect(page.getByRole("alert")).toHaveText("Favorite is unavailable");
    expect(requests).toBe(1);
  });

  test("Escape closes and restores focus", async ({ page }) => {
    const trigger = await openPicker(page);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Folder" })).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
});
