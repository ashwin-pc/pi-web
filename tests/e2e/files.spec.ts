import { expect, test } from "@playwright/test";
import { openLauncherAction } from "./helpers/actionLauncher.js";

const artifactRoot = ".pi/web/artifacts";
const files = {
  "README.md": { content: "# Test workspace\n", language: "markdown", revision: "readme-1" },
  "src/app.ts": { content: "export const answer = 42;\n", language: "typescript", revision: "app-1" },
  ".pi/web/artifacts/report.md": { content: "# Artifact report\n\nA **rendered** project artifact.\n", language: "markdown", revision: "report-1" },
};

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
  await page.route("**/api/files/tree**", async (route) => {
    const path = new URL(route.request().url()).searchParams.get("path") || "";
    const entries = path === "src"
      ? [{ name: "app.ts", path: "src/app.ts", kind: "file", size: 26 }]
      : path === artifactRoot
        ? [
            { name: ".DS_Store", path: `${artifactRoot}/.DS_Store`, kind: "file", size: 12 },
            { name: "runs", path: `${artifactRoot}/runs`, kind: "directory" },
            { name: "brief.pdf", path: `${artifactRoot}/brief.pdf`, kind: "file", size: 512 },
            { name: "concept.html", path: `${artifactRoot}/concept.html`, kind: "file", size: 320 },
            { name: "latest.png", path: `${artifactRoot}/latest.png`, kind: "file", size: 68 },
            { name: "report.md", path: `${artifactRoot}/report.md`, kind: "file", size: 49 },
            { name: "walkthrough.webm", path: `${artifactRoot}/walkthrough.webm`, kind: "file", size: 640 },
          ]
        : path === `${artifactRoot}/runs`
          ? [{ name: "output.png", path: `${artifactRoot}/runs/output.png`, kind: "file", size: 68 }]
          : [
              { name: "src", path: "src", kind: "directory" },
              { name: "preview.png", path: "preview.png", kind: "file", size: 68 },
              { name: "README.md", path: "README.md", kind: "file", size: 17 },
            ];
    await route.fulfill({ json: { ok: true, path, entries } });
  });
  await page.route("**/api/files/image**", (route) => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="gold"/></svg>' }));
  await page.route(/\/api\/(?:session-)?artifacts\//, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith(".html")) {
      await route.fulfill({ contentType: "text/html", body: '<!doctype html><button id="interactive">Ready</button><script>interactive.onclick=()=>interactive.textContent="Clicked"</script>' });
    } else if (path.endsWith(".webm")) {
      await route.fulfill({ contentType: "video/webm", body: Buffer.from([]) });
    } else if (path.endsWith(".pdf")) {
      await route.fulfill({ contentType: "application/pdf", body: Buffer.from("%PDF-1.4\n%%EOF") });
    } else {
      await route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#171923"/><circle cx="160" cy="90" r="48" fill="#e2b15f"/></svg>' });
    }
  });
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
  await page.locator(".fileTreeDirectory summary", { hasText: "src" }).click();
  await expect(page.locator('.fileTreeFile[title="src/app.ts"]')).toBeVisible();

  await page.goBack();
  await expect(page.locator("#filesPanel")).toBeHidden();
  await openLauncherAction(page, "File explorer");
  await expect(page.locator('.fileTreeFile[title="src/app.ts"]')).toBeVisible();
});

test("browser back returns an open file to the retained tree before closing the panel", async ({ page }) => {
  await page.goto("/");
  await openLauncherAction(page, "File explorer");
  await page.locator(".fileTreeDirectory summary", { hasText: "src" }).click();
  await expect(page.locator('.fileTreeFile[title="src/app.ts"]')).toBeVisible();
  await page.locator('.fileTreeFile[title="README.md"]').click();
  await expect(page.locator("#filesPanel")).toHaveAttribute("data-mobile-view", "editor");

  await page.goBack();
  await expect(page.locator("#filesPanel")).toBeVisible();
  await expect(page.locator("#filesPanel")).toHaveAttribute("data-mobile-view", "tree");
  await expect(page.locator('.fileTreeFile[title="src/app.ts"]')).toBeVisible();
  await page.goBack();
  await expect(page.locator("#filesPanel")).toBeHidden();
});

test("artifacts scope browses a visual gallery, folders, and a large preview", async ({ page }) => {
  await page.goto("/");
  await openLauncherAction(page, "File explorer");

  const panel = page.locator("#filesPanel");
  const workspace = page.locator("#filesWorkspaceScope");
  const artifacts = page.locator("#filesArtifactsScope");
  await expect(workspace).toHaveAttribute("aria-pressed", "true");
  await page.locator(".fileTreeDirectory summary", { hasText: "src" }).click();
  await expect(page.locator('.fileTreeFile[title="src/app.ts"]')).toBeVisible();

  await artifacts.click();
  await expect(panel).toHaveAttribute("data-files-scope", "artifacts");
  await expect(panel).toHaveAttribute("data-artifact-view", "gallery");
  await expect(panel).toHaveAttribute("aria-label", "Artifacts");
  await expect(page.locator("#filesPanelHeadingLabel")).toHaveText("Artifacts");
  await expect(artifacts).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(`.artifactGalleryCard[data-artifact-path="${artifactRoot}/latest.png"] img`)).toBeVisible();
  await expect(page.locator(`.artifactGalleryCard[data-artifact-path="${artifactRoot}/.DS_Store"]`)).toHaveCount(0);
  await expect(page.locator('.fileTreeFile[title="README.md"]')).not.toBeVisible();

  await page.getByRole("button", { name: "Open folder runs" }).click();
  await expect(page.locator(`.artifactGalleryCard[data-artifact-path="${artifactRoot}/runs/output.png"]`)).toBeVisible();
  await expect(page.locator("#artifactsGalleryBreadcrumb")).toContainText("runs");

  await workspace.click();
  await expect(page.locator('.fileTreeFile[title="src/app.ts"]')).toBeVisible();
  await artifacts.click();
  await expect(page.locator(`.artifactGalleryCard[data-artifact-path="${artifactRoot}/runs/output.png"]`)).toBeVisible();
  await expect(page.locator("#artifactsGalleryBreadcrumb")).toContainText("runs");
  await page.locator("#artifactsGalleryBreadcrumb").getByRole("button", { name: "Artifacts" }).click();

  await page.getByRole("button", { name: "Preview latest.png" }).click();
  await expect(panel).toHaveAttribute("data-artifact-view", "preview");
  await expect(page.locator("#artifactBrowserPreviewBody > img")).toBeVisible();
  await expect(page.locator("#artifactBrowserPreviewOpen")).toHaveAttribute("href", "/api/session-artifacts/mock-current/latest.png");
  await page.locator("#filesCloseButton").click();
  await openLauncherAction(page, "File explorer");
  await expect(panel).toHaveAttribute("data-files-scope", "artifacts");
  await expect(panel).toHaveAttribute("data-artifact-view", "preview");
  await expect(page.locator("#artifactBrowserPreviewBody > img")).toBeVisible();
  await page.locator("#artifactBrowserPreviewBack").click();
  await expect(panel).toHaveAttribute("data-artifact-view", "gallery");

  await workspace.click();
  await expect(panel).toHaveAttribute("data-files-scope", "workspace");
  await expect(panel).toHaveAttribute("aria-label", "Workspace files");
  await expect(page.locator("#filesPanelHeadingLabel")).toHaveText("Explorer");
  await expect(page.locator('.fileTreeFile[title="README.md"]')).toBeVisible();
});

test("large artifact preview renders interactive HTML, Markdown, and video", async ({ page }) => {
  await page.goto("/");
  await openLauncherAction(page, "File explorer");
  await page.locator("#filesArtifactsScope").click();

  const thumbnail = page.locator(`.artifactGalleryCard[data-artifact-path="${artifactRoot}/concept.html"] iframe`);
  await expect(thumbnail).toHaveAttribute("inert", "");
  await expect(thumbnail).toHaveAttribute("aria-hidden", "true");
  await page.getByRole("button", { name: "Preview concept.html" }).click();
  const htmlFrame = page.locator("#artifactBrowserPreviewBody iframe");
  await expect(htmlFrame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(htmlFrame.contentFrame().locator("#interactive")).toHaveText("Ready");
  await htmlFrame.contentFrame().locator("#interactive").click();
  await expect(htmlFrame.contentFrame().locator("#interactive")).toHaveText("Clicked");
  await page.goBack();
  await expect(page.locator("#filesPanel")).toBeVisible();
  await expect(page.locator("#filesPanel")).toHaveAttribute("data-artifact-view", "gallery");
  await expect(page.getByRole("button", { name: "Preview concept.html" })).toBeVisible();
  await expect(htmlFrame).toHaveCount(0);

  await page.goForward();
  await expect(page.locator("#filesPanel")).toHaveAttribute("data-artifact-view", "preview");
  await expect(htmlFrame.contentFrame().locator("#interactive")).toHaveText("Ready");
  await page.goBack();
  await expect(page.locator("#filesPanel")).toHaveAttribute("data-artifact-view", "gallery");
  await page.goBack();
  await expect(page.locator("#filesPanel")).toBeHidden();
  await openLauncherAction(page, "File explorer");
  await expect(page.locator("#filesPanel")).toHaveAttribute("data-artifact-view", "gallery");
  await page.getByRole("button", { name: "Preview report.md" }).click();
  await expect(page.locator("#artifactBrowserPreviewBody h1")).toHaveText("Artifact report");
  await expect(page.locator("#artifactBrowserPreviewBody strong")).toContainText("rendered");

  await page.locator("#artifactBrowserPreviewBack").click();
  await page.getByRole("button", { name: "Preview walkthrough.webm" }).click();
  await expect(page.locator("#artifactBrowserPreviewBody video")).toHaveAttribute("controls", "");
  await expect(page.locator("#artifactBrowserPreviewBody source")).toHaveAttribute("type", "video/webm");

  await page.locator("#artifactBrowserPreviewBack").click();
  await page.getByRole("button", { name: "Preview brief.pdf" }).click();
  await expect(page.locator("#artifactBrowserPreviewBody")).toHaveClass(/artifactBrowserPreviewBody--pdf/);
  await expect(page.locator("#artifactBrowserPreviewBody iframe")).toHaveAttribute("title", "Preview of brief.pdf");
  await page.keyboard.press("Escape");
  await expect(page.locator("#filesPanel")).toHaveAttribute("data-artifact-view", "gallery");
});

test("artifacts scope treats a missing artifact directory as an empty collection", async ({ page }) => {
  await page.unroute("**/api/files/tree**");
  await page.route("**/api/files/tree**", async (route) => {
    const path = new URL(route.request().url()).searchParams.get("path") || "";
    if (path === artifactRoot) {
      await route.fulfill({ status: 404, json: { ok: false, error: "File not found" } });
      return;
    }
    await route.fulfill({ json: { ok: true, path, entries: [{ name: "README.md", path: "README.md", kind: "file", size: 17 }] } });
  });

  await page.goto("/");
  await openLauncherAction(page, "File explorer");
  await page.locator("#filesArtifactsScope").click();
  const empty = page.locator(".artifactGalleryState--empty");
  await expect(empty).toContainText("No artifacts yet");
  await expect(empty).toContainText("Generated images, pages, reports, and videos will appear here.");
  await expect(page.locator("#artifactsTree")).not.toHaveAttribute("aria-busy", "true");
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
  const emptyEditorImage = page.locator(".fileEditorEmpty img");
  if (testInfo.project.name === "mobile") await expect(emptyEditorImage).toHaveCount(1);
  else await expect(emptyEditorImage).toBeVisible();
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
  await page.locator(".fileTreeDirectory summary", { hasText: "src" }).click();
  await expect(page.locator('.fileTreeFile[title="src/app.ts"]')).toBeVisible();
  await page.locator('.fileTreeFile[title="README.md"]').click();
  await expect(page.locator("#filesPanel")).toHaveAttribute("data-mobile-view", "editor");
  await expect(page.locator(".cm-content")).not.toBeFocused();
  await expect(page.locator("#fileBackButton")).toBeVisible();
  await page.locator("#fileBackButton").click();
  await expect(page.locator("#filesPanel")).toHaveAttribute("data-mobile-view", "tree");
  await expect(page.locator('.fileTreeFile[title="src/app.ts"]')).toBeVisible();
});
