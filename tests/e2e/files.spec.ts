import { expect, test } from "@playwright/test";
import { openLauncherAction } from "./helpers/actionLauncher.js";

const files = {
  "README.md": { content: "# Test workspace\n", language: "markdown", revision: "readme-1" },
  "src/app.ts": { content: "export const answer = 42;\n", language: "typescript", revision: "app-1" },
};

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
  await page.route("**/api/files/tree**", async (route) => {
    const path = new URL(route.request().url()).searchParams.get("path") || "";
    await route.fulfill({ json: path === "src" ? {
      ok: true, path, entries: [{ name: "app.ts", path: "src/app.ts", kind: "file", size: 26 }],
    } : {
      ok: true, path: "", entries: [
        { name: "src", path: "src", kind: "directory" },
        { name: "preview.png", path: "preview.png", kind: "file", size: 68 },
        { name: "README.md", path: "README.md", kind: "file", size: 17 },
      ],
    } });
  });
  await page.route("**/api/files/image**", (route) => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="gold"/></svg>' }));
  await page.route("**/api/files/read**", async (route) => {
    const path = new URL(route.request().url()).searchParams.get("path") as keyof typeof files;
    const file = files[path];
    await route.fulfill({ status: file ? 200 : 404, json: file ? { ok: true, path, size: file.content.length, readOnly: false, ...file } : { ok: false, error: "Not found" } });
  });
});

test("browser back closes an open panel", async ({ page }) => {
  await page.goto("/");
  await page.locator("#filesButton").evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.locator("#filesPanel")).toBeVisible();

  await page.goBack();
  await expect(page.locator("#filesPanel")).toBeHidden();
});

test("explorer opens, edits, saves, wraps, resizes text, and closes tabs", async ({ page }, testInfo) => {
  let savedBody: Record<string, unknown> | undefined;
  await page.route("**/api/files/write", async (route) => {
    savedBody = route.request().postDataJSON();
    await route.fulfill({ json: { ok: true, path: savedBody?.path, size: String(savedBody?.content || "").length, revision: "readme-2" } });
  });
  await page.goto("/");
  await openLauncherAction(page, "File explorer");
  await expect(page.locator("#filesPanel")).toBeVisible();
  await expect(page.locator(".filesPanelHeading h2")).toHaveText("Explorer");
  if (testInfo.project.name === "desktop") await expect(page.locator(".fileEditorEmpty img")).toBeVisible();

  await page.locator('.fileTreeFile[title="README.md"]').click();
  await expect(page.locator(".fileTab.active")).toContainText("README.md");
  await expect(page.locator(".fileEditorStatusBar")).toBeVisible();
  const editorContent = page.locator(".cm-content");
  await editorContent.selectText();
  await page.keyboard.insertText("# Updated workspace\n");
  await expect(page.locator("#fileSaveButton")).toBeEnabled();
  await page.locator("#fileSaveButton").click();
  await expect.poll(() => savedBody).toMatchObject({ path: "README.md", expectedRevision: "readme-1", content: "# Updated workspace\n" });

  const wrap = page.locator("#fileWrapToggle");
  const initialWrap = await wrap.getAttribute("aria-pressed");
  await wrap.click();
  await expect(wrap).toHaveAttribute("aria-pressed", initialWrap === "true" ? "false" : "true");
  await page.locator("#fileFontSlider").fill("12.5");
  await expect(page.locator("#fileFontValue")).toHaveText("12.5px");
  await expect(page.locator(".cm-editor")).toHaveCSS("font-size", "12.5px");

  await page.locator(".fileTabClose").click();
  await expect(page.locator(".fileTab")).toHaveCount(0);
  await expect(page.locator(".fileEditorEmpty img")).toBeVisible();
  await expect(page.locator(".fileEditorStatusBar")).toBeHidden();

  if (testInfo.project.name === "desktop") {
    await page.locator('.fileTreeFile[title="preview.png"]').click();
    await expect(page.locator(".fileImagePreview img")).toBeVisible();
    await expect(page.locator(".fileTab.active")).toContainText("preview.png");
    await expect(page.locator(".fileEditorStatusBar")).toBeHidden();
  }
});

test("image preview failures render inside the file pane", async ({ page }) => {
  await page.unroute("**/api/files/image**");
  await page.route("**/api/files/image**", (route) => route.fulfill({ status: 415, json: { ok: false, error: "File does not contain valid image data" } }));
  await page.goto("/");
  await openLauncherAction(page, "File explorer");
  await page.locator('.fileTreeFile[title="preview.png"]').click();
  await expect(page.locator(".fileEditorError")).toBeVisible();
  await expect(page.locator(".fileEditorError")).toContainText("valid image data");
  await expect(page.locator("#fileStatus")).toBeEmpty();
  await expect(page.locator("#messages")).not.toContainText("valid image data");
});

test("desktop tree can be resized and collapsed", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop split-pane behavior");
  await page.goto("/");
  await openLauncherAction(page, "File explorer");
  const explorer = page.locator(".filesExplorer");
  const before = (await explorer.boundingBox())!.width;
  const handle = page.locator("#filesTreeResize");
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 80);
  await page.mouse.down(); await page.mouse.move(box.x + 80, box.y + 80); await page.mouse.up();
  expect((await explorer.boundingBox())!.width).toBeGreaterThan(before + 40);
  await page.locator("#filesTreeCollapse").click();
  await expect(page.locator("#filesPanel")).toHaveClass(/filesPanel--treeCollapsed/);
  expect((await explorer.boundingBox())!.width).toBeLessThanOrEqual(1);
  await page.locator("#filesTreeCollapse").click();
  await expect(page.locator("#filesPanel")).not.toHaveClass(/filesPanel--treeCollapsed/);
});

test("touch-first mobile file opening does not focus the editor", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Mobile keyboard behavior");
  await page.goto("/");
  await openLauncherAction(page, "File explorer");
  await page.locator('.fileTreeFile[title="README.md"]').click();
  await expect(page.locator("#filesPanel")).toHaveAttribute("data-mobile-view", "editor");
  await expect(page.locator(".cm-content")).not.toBeFocused();
  await expect(page.locator("#fileBackButton")).toBeVisible();
  await page.locator("#fileBackButton").click();
  await expect(page.locator("#filesPanel")).toHaveAttribute("data-mobile-view", "tree");
});
