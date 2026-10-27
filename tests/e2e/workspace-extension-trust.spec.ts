import { expect, test, type Page } from "@playwright/test";
import { openSessionDrawerFooterAction } from "./helpers/sessionDrawer.js";

type TrustState = {
  trusted: boolean;
  trustedWorkspaces: string[];
};

async function mockWorkspaceTrust(page: Page): Promise<TrustState> {
  const state: TrustState = { trusted: false, trustedWorkspaces: [] };
  await page.route("**/api/extensions/workspace-trust**", async (route) => {
    const method = route.request().method();
    if (method === "POST") {
      state.trusted = true;
      state.trustedWorkspaces = ["/workspaces/demo"];
    } else if (method === "DELETE") {
      state.trusted = false;
      state.trustedWorkspaces = [];
    }
    await route.fulfill({
      json: {
        ok: true,
        workspace: "/workspaces/demo",
        trusted: state.trusted,
        extensions: [
          { path: ".pi/web/extensions/notes.ts" },
          { path: ".pi/web/extensions/dashboard/index.ts" },
        ],
        trustedWorkspaces: state.trustedWorkspaces,
        ...(method === "POST" ? { reloadStatus: { state: "ready" } } : {}),
      },
    });
  });
  return state;
}

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

test("workspace extension notice supports review, dismiss, trust, and Settings revoke", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await mockWorkspaceTrust(page);
  await page.goto("/");

  const notice = page.locator("#workspaceExtensionTrustNotice");
  await expect(notice).toBeVisible();
  await expect(notice.getByRole("heading", { name: "Trust this workspace’s extensions?" })).toBeVisible();
  await expect(page.locator("#workspaceExtensionTrustList code")).toHaveText([
    ".pi/web/extensions/notes.ts",
    ".pi/web/extensions/dashboard/index.ts",
  ]);

  await notice.getByRole("button", { name: "Not now" }).click();
  await expect(notice).toBeHidden();
  await page.reload();
  await expect(notice).toBeVisible();

  await notice.getByRole("button", { name: "Trust and load" }).click();
  await expect(notice).toBeHidden();

  await page.locator("#sessionButton").click();
  await openSessionDrawerFooterAction(page, "Preferences");
  await page.locator("#settingsNavExtensions").click();
  const trustSettings = page.locator("#workspaceExtensionTrustSettings");
  await expect(trustSettings.getByText("/workspaces/demo", { exact: true })).toBeVisible();
  await trustSettings.getByRole("button", { name: "Revoke workspace extension trust for /workspaces/demo" }).click();
  await expect(trustSettings).toContainText("No workspace extensions are trusted.");
  await expect(trustSettings).toContainText("Existing sessions change on their next extension load.");

  await page.reload();
  await expect(notice).toBeVisible();
});

test("workspace extension notice stays contained with reachable touch controls", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await mockWorkspaceTrust(page);
  const viewports = [
    { width: 1440, height: 900 },
    { width: 728, height: 656 },
    { width: 656, height: 728 },
    { width: 360, height: 840 },
    { width: 840, height: 360 },
  ];

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    const notice = page.locator("#workspaceExtensionTrustNotice");
    await expect(notice).toBeVisible();
    const box = await notice.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
    for (const button of [
      notice.getByRole("button", { name: "Not now" }),
      notice.getByRole("button", { name: "Trust and load" }),
    ]) {
      await expect(button).toBeInViewport();
      const buttonBox = await button.boundingBox();
      expect(buttonBox?.height).toBeGreaterThanOrEqual(44);
    }
  }
});
