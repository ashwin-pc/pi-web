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
      expect(route.request().postDataJSON()).toEqual({
        sessionId: "mock-current",
        workspace: "/workspaces/demo",
      });
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
        resources: [
          { kind: "extension", path: ".pi/web/extensions/notes.ts" },
          { kind: "package", path: "npm:@example/dashboard" },
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
  await expect(notice.getByRole("heading", { name: "Trust this workspace’s resources?" })).toBeVisible();
  await expect(page.locator("#workspaceExtensionTrustList code")).toHaveText([
    "Extension: .pi/web/extensions/notes.ts",
    "Project package: npm:@example/dashboard",
  ]);
  await expect(page.locator("#workspaceExtensionTrustWorkspace")).toHaveText("/workspaces/demo");

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
  await expect(trustSettings).toContainText("No workspaces are trusted.");
  await expect(trustSettings).toContainText("Existing sessions change on their next resource load.");

  await page.reload();
  await expect(notice).toBeVisible();
});

test("switching sessions hides stale consent and only trusts the newly reviewed workspace", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  const posts: unknown[] = [];
  let releaseOlderStatus!: () => void;
  let markOlderStatusRequested!: () => void;
  const olderStatusGate = new Promise<void>((resolve) => { releaseOlderStatus = resolve; });
  const olderStatusRequested = new Promise<void>((resolve) => { markOlderStatusRequested = resolve; });

  await page.route("**/api/extensions/workspace-trust**", async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const sessionId = url.searchParams.get("sessionId");
    if (method === "POST") posts.push(request.postDataJSON());
    if (method === "GET" && sessionId === "mock-older") {
      markOlderStatusRequested();
      await olderStatusGate;
    }
    const older = sessionId === "mock-older"
      || (method === "POST" && request.postDataJSON().sessionId === "mock-older");
    const workspace = older ? "/workspaces/older-realpath" : "/workspaces/current-realpath";
    await route.fulfill({
      json: {
        ok: true,
        workspace,
        trusted: method === "POST",
        resources: [{ kind: "extension", path: older ? ".pi/web/extensions/older.ts" : ".pi/web/extensions/current.ts" }],
        trustedWorkspaces: method === "POST" ? [workspace] : [],
        ...(method === "POST" ? { reloadStatus: { state: "ready" } } : {}),
      },
    });
  });

  await page.goto("/");
  const notice = page.locator("#workspaceExtensionTrustNotice");
  await expect(notice).toBeVisible();
  await expect(page.locator("#workspaceExtensionTrustList code")).toHaveText("Extension: .pi/web/extensions/current.ts");

  await page.locator("#sessionButton").click();
  const drawer = page.locator("#sessionDrawer");
  await drawer.locator('.sessionItem[data-session-id="mock-older"] .sessionItemNavBtn').click();
  await olderStatusRequested;
  await expect(notice).toBeHidden();
  await expect(page.locator("#workspaceExtensionTrustButton")).toBeDisabled();
  await page.locator("#workspaceExtensionTrustButton").evaluate((button: HTMLButtonElement) => button.click());
  expect(posts).toEqual([]);

  releaseOlderStatus();
  await expect(notice).toBeVisible();
  await expect(page.locator("#workspaceExtensionTrustWorkspace")).toHaveText("/workspaces/older-realpath");
  await expect(page.locator("#workspaceExtensionTrustList code")).toHaveText("Extension: .pi/web/extensions/older.ts");
  await notice.getByRole("button", { name: "Trust and load" }).click();
  await expect(notice).toBeHidden();
  expect(posts).toEqual([{
    sessionId: "mock-older",
    workspace: "/workspaces/older-realpath",
  }]);
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
