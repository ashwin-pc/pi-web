import { expect, test } from "@playwright/test";
import { build } from "esbuild";

test("artifact actions receive normalized paths without queries or fragments", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "DOM contract only needs one browser viewport");
  const bundle = await build({
    stdin: {
      contents: `import { configureArtifactPreviewActions, renderStandaloneMarkdown, setArtifactPreviewActions } from './src/markdown/render.ts';
        globalThis.artifactFixture = { configureArtifactPreviewActions, renderStandaloneMarkdown, setArtifactPreviewActions };`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
  });
  const invocations: Array<Record<string, unknown>> = [];
  await page.route("**/artifact-link-scoping-fixture", (route) => route.fulfill({
    contentType: "text/html",
    body: '<main id="artifacts"></main>',
  }));
  await page.route("**/api/session-artifacts/mock-current/**", (route) => route.fulfill({
    contentType: "text/markdown",
    body: "# Scoped artifact",
  }));
  await page.route("**/api/web-contributions/invoke", async (route) => {
    invocations.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true, message: "inspected" } });
  });
  await page.goto("/artifact-link-scoping-fixture");
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(() => {
    const fixture = (window as typeof window & { artifactFixture: {
      configureArtifactPreviewActions: typeof import("../../src/markdown/render.js").configureArtifactPreviewActions;
      renderStandaloneMarkdown: typeof import("../../src/markdown/render.js").renderStandaloneMarkdown;
      setArtifactPreviewActions: typeof import("../../src/markdown/render.js").setArtifactPreviewActions;
    } }).artifactFixture;
    fixture.configureArtifactPreviewActions({ headers: () => ({ "content-type": "application/json" }), getSessionId: () => "mock-current" });
    fixture.setArtifactPreviewActions([{ key: "inspect", title: "Inspect", kinds: ["markdown"] }]);
    fixture.renderStandaloneMarkdown(
      document.querySelector<HTMLElement>("#artifacts")!,
      "[Query](/api/artifacts/query.md?sessionId=mock-current&v=2)\n\n[Fragment](/api/artifacts/fragment.md#section)",
      { artifactLinks: true, sessionId: "mock-current" },
    );
  });

  const actions = page.getByRole("button", { name: "Inspect" });
  await expect(actions).toHaveCount(2);
  await actions.nth(0).click();
  await actions.nth(1).click();
  expect(invocations.map((invocation: any) => invocation.event.context.path)).toEqual([
    "/api/session-artifacts/mock-current/query.md",
    "/api/session-artifacts/mock-current/fragment.md",
  ]);
});
