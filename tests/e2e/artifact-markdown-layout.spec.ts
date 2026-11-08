import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";

test("artifact markdown shares one centered responsive column across preview surfaces", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Explicit viewport coverage below");
  const bundle = await build({
    stdin: { contents: `import { renderArtifactMarkdown } from './src/markdown/artifact.ts';
      for (const body of document.querySelectorAll('.fixture')) renderArtifactMarkdown(body, '# Heading\\n\\nParagraph\\n\\n- List item\\n\\n> Quote\\n\\n~~~txt\\nCode\\n~~~');`, resolveDir: process.cwd() },
    bundle: true, write: false, format: "iife", platform: "browser",
  });
  const css = (await Promise.all(["src/styles/messages.css", "src/files/artifacts.css"].map((path) => readFile(path, "utf8")))).join("\n");
  await page.route("**/artifact-markdown-layout-fixture", (route) => route.fulfill({
    contentType: "text/html", body: `<style>*{box-sizing:border-box}body{margin:0}${css}</style><article class="fixture artifactBrowserPreviewBody--markdown"></article><article class="fixture artifactPreviewPageBody"></article>`,
  }));
  await page.goto("/artifact-markdown-layout-fixture");
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await expect(page.locator(".artifactMarkdownContent")).toHaveCount(2);
  for (const width of [1600, 1000, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const columns = await page.locator(".artifactMarkdownContent").evaluateAll((nodes) => nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      const parent = node.parentElement!.getBoundingClientRect();
      return { width: rect.width, center: rect.x + rect.width / 2, parentCenter: parent.x + parent.width / 2,
        blocks: Array.from(node.children).map((child) => child.getBoundingClientRect().x), scroll: node.scrollWidth };
    }));
    for (const column of columns) {
      expect(column.width).toBeLessThanOrEqual(1200);
      if (width === 1600) expect(column.width).toBe(1200);
      expect(column.center).toBeCloseTo(column.parentCenter, 1);
      expect(new Set(column.blocks).size).toBe(1);
      expect(column.scroll).toBeLessThanOrEqual(Math.ceil(column.width));
    }
  }
});
