import { expect, test, type Page } from "@playwright/test";
import { openSessionDrawerFooterAction } from "./helpers/sessionDrawer.js";

type TrustState = {
  desiredTrusted: boolean;
  appliedTrusted: boolean;
  busy: boolean;
  resources: Array<{ kind: "extension" | "package"; path: string }>;
  trustedWorkspaces: string[];
};

async function mockWorkspaceTrust(page: Page): Promise<TrustState> {
  const state: TrustState = {
    desiredTrusted: false,
    appliedTrusted: false,
    busy: false,
    resources: [
      { kind: "extension", path: ".pi/web/extensions/notes.ts" },
      { kind: "package", path: "npm:@example/dashboard" },
    ],
    trustedWorkspaces: [],
  };
  await page.route("**/api/extensions/reload", async (route) => {
    state.appliedTrusted = state.desiredTrusted;
    await route.fulfill({ json: { ok: true, status: { state: "ready" } } });
  });
  await page.route("**/api/extensions/workspace-trust**", async (route) => {
    const method = route.request().method();
    if (method === "POST") {
      expect(route.request().postDataJSON()).toEqual({
        sessionId: "mock-current",
        workspace: "/workspaces/demo",
      });
      state.desiredTrusted = true;
      state.appliedTrusted = true;
      state.trustedWorkspaces = ["/workspaces/demo"];
    } else if (method === "DELETE") {
      expect(route.request().postDataJSON()).toEqual({
        sessionId: "mock-current",
        workspace: "/workspaces/demo",
      });
      state.desiredTrusted = false;
      state.trustedWorkspaces = [];
    }
    await route.fulfill({
      json: {
        ok: true,
        workspace: "/workspaces/demo",
        trusted: state.desiredTrusted,
        desiredTrusted: state.desiredTrusted,
        appliedTrusted: state.appliedTrusted,
        pendingReload: state.desiredTrusted !== state.appliedTrusted,
        busy: state.busy,
        resources: state.resources,
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
  const state = await mockWorkspaceTrust(page);
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
  state.busy = true;
  await trustSettings.getByRole("button", { name: "Revoke workspace extension trust for /workspaces/demo" }).click();
  await expect(trustSettings).toContainText("No workspaces are trusted.");
  await expect(trustSettings).toContainText("Loaded sessions must be reloaded");

  await expect(notice).toBeVisible();
  await expect(notice.getByRole("heading", { name: "Workspace resources must be unloaded" })).toBeVisible();
  await expect(notice).toContainText("Workspace trust was revoked. Reload this session to unload them.");
  await expect(notice.getByRole("button", { name: "Reload" })).toBeVisible();
  await expect(notice.getByRole("button", { name: "Reload" })).toBeDisabled();
  await expect(notice).toContainText("Wait for the current response or compaction");
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
        desiredTrusted: method === "POST",
        appliedTrusted: method === "POST",
        pendingReload: false,
        busy: false,
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

test("a delayed trust response cannot overwrite the workspace shown after a session switch", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  let releasePost!: () => void;
  let markPostStarted!: () => void;
  const postGate = new Promise<void>((resolve) => { releasePost = resolve; });
  const postStarted = new Promise<void>((resolve) => { markPostStarted = resolve; });

  await page.route("**/api/extensions/workspace-trust**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const posted = method === "POST" ? request.postDataJSON() : undefined;
    const sessionId = method === "POST" ? posted.sessionId : url.searchParams.get("sessionId");
    const older = sessionId === "mock-older";
    const workspace = older ? "/workspaces/older-realpath" : "/workspaces/current-realpath";
    if (method === "POST") {
      markPostStarted();
      await postGate;
    }
    await route.fulfill({
      json: {
        ok: true,
        workspace,
        trusted: method === "POST",
        desiredTrusted: method === "POST",
        appliedTrusted: method === "POST",
        pendingReload: false,
        busy: false,
        resources: [{
          kind: "extension",
          path: older ? ".pi/web/extensions/older.ts" : ".pi/web/extensions/current.ts",
        }],
        trustedWorkspaces: method === "POST" ? [workspace] : [],
      },
    });
  });

  await page.goto("/");
  const notice = page.locator("#workspaceExtensionTrustNotice");
  await notice.getByRole("button", { name: "Trust and load" }).click();
  await postStarted;

  await page.locator("#sessionButton").click();
  await page.locator('#sessionDrawer .sessionItem[data-session-id="mock-older"] .sessionItemNavBtn').click();
  await expect(page.locator("#workspaceExtensionTrustWorkspace")).toHaveText("/workspaces/older-realpath");
  await expect(page.locator("#workspaceExtensionTrustList code")).toHaveText("Extension: .pi/web/extensions/older.ts");

  releasePost();
  await expect(page.locator("#workspaceExtensionTrustWorkspace")).toHaveText("/workspaces/older-realpath");
  await expect(notice.getByRole("heading", { name: "Trust this workspace’s resources?" })).toBeVisible();
});

test("pending trust changes stay visible, explain busy sessions, and reload explicitly", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  const state = await mockWorkspaceTrust(page);
  await page.goto("/");
  const notice = page.locator("#workspaceExtensionTrustNotice");
  state.busy = true;
  await page.evaluate(() => document.dispatchEvent(new CustomEvent("pi-web-workspace-trust-changed")));
  await expect(notice.getByRole("button", { name: "Trust and load" })).toBeDisabled();
  await expect(notice).toContainText("Wait for the current response or compaction to finish");
  state.busy = false;
  await page.evaluate(() => document.dispatchEvent(new CustomEvent("pi-web-workspace-trust-changed")));
  await expect(notice.getByRole("button", { name: "Trust and load" })).toBeEnabled();
  await notice.getByRole("button", { name: "Not now" }).click();

  state.desiredTrusted = true;
  await page.evaluate(() => document.dispatchEvent(new CustomEvent("pi-web-workspace-trust-changed")));
  await expect(notice).toBeVisible();
  await expect(notice.getByRole("heading", { name: "Workspace resources are ready to load" })).toBeVisible();
  await expect(notice).toContainText("Workspace resources were trusted. Reload this session to load them.");
  await expect(page.locator("#workspaceExtensionTrustWorkspace")).toHaveText("/workspaces/demo");
  await expect(page.locator("#workspaceExtensionTrustList code")).toContainText(["notes.ts", "dashboard"]);
  await notice.getByRole("button", { name: "Reload" }).click();
  await expect(notice).toBeHidden();

  state.desiredTrusted = false;
  state.busy = true;
  await page.request.post("/api/mock/state", { data: { isStreaming: true } });
  await page.evaluate(() => document.dispatchEvent(new CustomEvent("pi-web-workspace-trust-changed")));
  await expect(notice).toBeVisible();
  await expect(notice.getByRole("heading", { name: "Workspace resources must be unloaded" })).toBeVisible();
  await expect(notice.getByRole("button", { name: "Reload" })).toBeDisabled();
  await expect(notice).toContainText("Wait for the current response or compaction to finish");

  state.busy = false;
  await page.request.post("/api/mock/state", { data: { isStreaming: false, isCompacting: false } });
  await expect(notice.getByRole("button", { name: "Reload" })).toBeEnabled();
  await notice.getByRole("button", { name: "Reload" }).click();
  await expect(notice).toBeHidden();
});

test("pending revoke remains visible after project resources are deleted", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  const state = await mockWorkspaceTrust(page);
  state.desiredTrusted = false;
  state.appliedTrusted = true;
  state.resources = [];
  await page.goto("/");

  const notice = page.locator("#workspaceExtensionTrustNotice");
  await expect(notice).toBeVisible();
  await expect(notice.getByRole("heading", { name: "Workspace resources must be unloaded" })).toBeVisible();
  await expect(page.locator("#workspaceExtensionTrustWorkspace")).toHaveText("/workspaces/demo");
  await expect(page.locator("#workspaceExtensionTrustList")).toBeEmpty();
  await expect(notice.getByRole("button", { name: "Reload" })).toBeVisible();
});

test("workspace trust and pending notices stay contained with reachable touch controls", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  const state = await mockWorkspaceTrust(page);
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

    for (const desiredTrusted of [true, false]) {
      state.desiredTrusted = desiredTrusted;
      state.appliedTrusted = !desiredTrusted;
      await page.evaluate(() => document.dispatchEvent(new CustomEvent("pi-web-workspace-trust-changed")));
      await expect(notice).toBeVisible();
      await expect(page.locator("#workspaceExtensionTrustWorkspace")).toHaveText("/workspaces/demo");
      await expect(page.locator("#workspaceExtensionTrustList code")).toContainText(["notes.ts", "dashboard"]);
      const pendingBox = await notice.boundingBox();
      expect(pendingBox).not.toBeNull();
      expect(pendingBox!.x).toBeGreaterThanOrEqual(0);
      expect(pendingBox!.y).toBeGreaterThanOrEqual(0);
      expect(pendingBox!.x + pendingBox!.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(pendingBox!.y + pendingBox!.height).toBeLessThanOrEqual(viewport.height + 1);
      const reload = notice.getByRole("button", { name: "Reload" });
      await expect(reload).toBeInViewport();
      expect((await reload.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    }
    state.desiredTrusted = false;
    state.appliedTrusted = false;
  }
});
