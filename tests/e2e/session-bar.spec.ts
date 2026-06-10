import { expect, test } from "@playwright/test";

async function seedServerSessionUiState(page: import("@playwright/test").Page, state: {
  pinnedSessions?: Array<{ id: string; label: string; cwd?: string }>;
  pinnedFolders?: string[];
  sessionMarkers?: Array<{ sessionId: string; color: string; updatedAt: string }>;
}) {
  await page.request.patch("/api/session-ui-state", { data: state });
}

async function seedServerPinned(page: import("@playwright/test").Page, ...sessions: Array<{ id: string; label: string; cwd?: string }>) {
  await seedServerSessionUiState(page, { pinnedSessions: sessions });
}

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

test.describe("session quick bar", () => {
  test("shows the current session as an unpinned tab when none are pinned", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#sessionBar")).toBeVisible();
    await expect(page.locator(".sessionBarTab.temporary")).toContainText("Current mock session");
  });

  test("pinning the current session from the header makes the tab pinned", async ({ page }) => {
    await page.goto("/");

    await page.locator(".sessionBarTab.temporary .sessionBarTabAction").click();

    await expect(page.locator("#sessionBar")).toBeVisible();
    await expect(page.locator(".sessionBarTab.pinned")).toHaveCount(1);
    await expect(page.locator(".sessionBarTab.pinned").nth(0)).toContainText("Current mock session");
  });

  test("unpinning the last pinned session leaves it as the current unpinned tab", async ({ page }) => {
    await seedServerPinned(page, { id: "mock-current", label: "Current mock session" });

    await page.goto("/");
    await expect(page.locator("#sessionBar")).toBeVisible();

    page.on("dialog", (dialog) => dialog.accept());
    await page.locator(".sessionBarTab.pinned .sessionBarTabAction").click();

    await expect(page.locator("#sessionBar")).toBeVisible();
    await expect(page.locator(".sessionBarTab.temporary")).toContainText("Current mock session");
  });

  test("bar is restored from server storage and marked tabs use marker color backgrounds", async ({ page }) => {
    await seedServerSessionUiState(page, {
      pinnedSessions: [
        { id: "mock-current", label: "Current mock session" },
        { id: "mock-older", label: "Older mock session" },
      ],
      sessionMarkers: [{ sessionId: "mock-older", color: "green", updatedAt: "2026-01-01T00:00:00.000Z" }],
    });

    await page.goto("/");
    // Drawer never opened — bar should still render from server-stored labels
    await expect(page.locator("#sessionBar")).toBeVisible();
    await expect(page.locator(".sessionBarTab")).toHaveCount(2);
    const olderTab = page.locator(".sessionBarTab").filter({ hasText: "Older mock session" });
    await expect(olderTab).toHaveClass(/\bmarked\b/);
    await expect(olderTab).toHaveClass(/marker-green/);
  });

  test("current session tab is marked active", async ({ page }) => {
    await seedServerPinned(
      page,
      { id: "mock-current", label: "Current mock session" },
      { id: "mock-older", label: "Older mock session" },
    );

    await page.goto("/");
    await expect(page.locator(".sessionBarTab").filter({ hasText: "Current mock session" })).toHaveClass(/\bactive\b/);
    await expect(page.locator(".sessionBarTab").filter({ hasText: "Older mock session" })).not.toHaveClass(/\bactive\b/);
  });

  test("/clear reuses the current tab pin and marker while releasing the old session", async ({ page }) => {
    await seedServerSessionUiState(page, {
      pinnedSessions: [
        { id: "mock-older", label: "Older mock session" },
        { id: "mock-current", label: "Current mock session" },
      ],
      sessionMarkers: [{ sessionId: "mock-current", color: "green", updatedAt: "2026-01-01T00:00:00.000Z" }],
    });

    await page.goto("/");
    const activeBefore = page.locator(".sessionBarTab.active");
    await expect(activeBefore).toContainText("Current mock session");
    await expect(activeBefore).toHaveClass(/\bpinned\b/);
    await expect(activeBefore).toHaveClass(/marker-green/);

    await page.locator("#prompt").fill("/clear");
    await page.locator("#primaryButton").click();

    await expect(page.locator("#statusTitle")).toHaveText("New session");
    await expect(page.getByText("Cleared tab. Previous session remains in history.")).toBeVisible();

    const activeAfter = page.locator(".sessionBarTab.active");
    await expect(activeAfter).toContainText("New session");
    await expect(activeAfter).toHaveClass(/\bpinned\b/);
    await expect(activeAfter).toHaveClass(/marker-green/);
    await expect(page.locator(".sessionBarTab").filter({ hasText: "Current mock session" })).toHaveCount(0);

    const uiState = await (await page.request.get("/api/session-ui-state")).json();
    expect(uiState.sessionUiState.pinnedSessions).toEqual([
      expect.objectContaining({ id: "mock-older", label: "Older mock session" }),
      expect.objectContaining({ label: "New session" }),
    ]);
    expect(uiState.sessionUiState.pinnedSessions[1].id).not.toBe("mock-current");
    expect(uiState.sessionUiState.sessionMarkers).toEqual([
      expect.objectContaining({ sessionId: uiState.sessionUiState.pinnedSessions[1].id, color: "green" }),
    ]);
  });

  test("current session bucket menu sets and unsets marker colors", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#statusTitle")).toHaveText("Current mock session");

    const bucketButton = page.locator("#currentSessionBucketButton");
    await expect(bucketButton).toHaveAttribute("title", "Set current session bucket");

    await bucketButton.click();
    const menu = page.locator(".sessionBucketMenu");
    await expect(menu).toBeVisible();
    await expect(menu).toContainText("Session bucket");
    await expect(menu.locator(".sessionColorFilterMenuItem")).toHaveCount(6);

    await menu.locator(".sessionColorFilterMenuItem.marker-green").click();
    await expect(bucketButton).toHaveClass(/\bmarked\b/);
    await expect(bucketButton).toHaveClass(/marker-green/);
    await expect(bucketButton).toHaveAttribute("title", /Green/);

    let uiState = await (await page.request.get("/api/session-ui-state")).json();
    expect(uiState.sessionUiState.sessionMarkers).toEqual([
      expect.objectContaining({ sessionId: "mock-current", color: "green" }),
    ]);

    await bucketButton.click();
    await page.locator(".sessionBucketMenu .sessionColorFilterMenuItem", { hasText: "No bucket" }).click();
    await expect(bucketButton).not.toHaveClass(/\bmarked\b/);
    await expect(bucketButton).toHaveAttribute("title", "Set current session bucket");

    uiState = await (await page.request.get("/api/session-ui-state")).json();
    expect(uiState.sessionUiState.sessionMarkers).toEqual([]);
  });

  test("clicking a tab switches sessions and moves the active marker", async ({ page }) => {
    await seedServerPinned(
      page,
      { id: "mock-current", label: "Current mock session" },
      { id: "mock-older", label: "Older mock session" },
    );

    await page.goto("/");
    // Load sessions so the bar knows which session to switch to
    await page.locator("#sessionButton").click();
    await expect(page.locator("#sessionDrawer")).toBeVisible();
    await page.locator("#sessionCloseButton").click();

    await page.locator(".sessionBarTab").filter({ hasText: "Older mock session" }).click();

    await expect(page.locator("#statusTitle")).toHaveText("Older mock session");
    await expect(page.locator(".sessionBarTab").filter({ hasText: "Older mock session" })).toHaveClass(/\bactive\b/);
    await expect(page.locator(".sessionBarTab").filter({ hasText: "Current mock session" })).not.toHaveClass(/\bactive\b/);
  });

  test("session drawer open state persists across refreshes", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#sessionDrawer")).toBeHidden();

    await page.locator("#sessionButton").click();
    await expect(page.locator("#sessionDrawer")).toBeVisible();

    await page.reload();
    await expect(page.locator("#sessionDrawer")).toBeVisible();

    await page.locator("#sessionCloseButton").click();
    await expect(page.locator("#sessionDrawer")).toBeHidden();

    await page.reload();
    await expect(page.locator("#sessionDrawer")).toBeHidden();
  });

  test("new session opens the drawer on wide viewports and preserves mobile close behavior", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#sessionDrawer")).toBeHidden();

    await page.locator("#newSessionHeaderButton").click();

    await expect(page.locator("#statusTitle")).toHaveText("New session");
    const width = page.viewportSize()?.width || 0;
    if (width <= 700) await expect(page.locator("#sessionDrawer")).toBeHidden();
    else await expect(page.locator("#sessionDrawer")).toBeVisible();
  });

  test("session drawer keeps folder headers visible when filters hide their sessions", async ({ page }) => {
    await seedServerSessionUiState(page, {
      sessionMarkers: [{ sessionId: "mock-older", color: "green", updatedAt: "2026-01-01T00:00:00.000Z" }],
    });
    await page.route("**/api/sessions**", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ sessions: [
          {
            id: "mock-current",
            name: "Current mock session",
            firstMessage: "Can you add image attachments?",
            modified: "2026-05-07T10:00:00.000Z",
            messageCount: 2,
            cwd: "/workspace/folder-a",
            isCurrent: true,
          },
          {
            id: "mock-older",
            name: "Older mock session",
            firstMessage: "Review the mobile composer layout",
            modified: "2026-05-06T09:00:00.000Z",
            messageCount: 4,
            cwd: "/workspace/folder-b",
            isCurrent: false,
          },
          {
            id: "mock-third",
            name: "Unmarked third session",
            firstMessage: "No selected marker here",
            modified: "2026-05-05T09:00:00.000Z",
            messageCount: 1,
            cwd: "/workspace/folder-c",
            isCurrent: false,
          },
        ] }),
      });
    });

    await page.goto("/");
    await page.locator("#sessionButton").click();
    await expect(page.locator(".sessionFolderGroup")).toHaveCount(3);

    await page.locator(".sessionColorFilterButton").click();
    await page.locator(".sessionColorFilterMenuItem.marker-green").click();

    await expect(page.locator(".sessionFolderGroup")).toHaveCount(3);
    await expect(page.locator(".sessionFolderName")).toContainText(["folder-a", "folder-b", "folder-c"]);
    await expect(page.locator(".sessionItem")).toHaveCount(1);
    await expect(page.locator(".sessionItem")).toContainText("Older mock session");
    await expect(page.locator(".sessionFolderGroup .sessionEmpty")).toHaveCount(2);
  });

  test("session drawer pins folders to the top regardless of session activity order", async ({ page }) => {
    await page.route("**/api/sessions**", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ sessions: [
          {
            id: "mock-current",
            name: "Current mock session",
            firstMessage: "Latest activity is in folder-a",
            modified: "2026-05-07T10:00:00.000Z",
            messageCount: 2,
            cwd: "/workspace/folder-a",
            isCurrent: true,
          },
          {
            id: "mock-older",
            name: "Older mock session",
            firstMessage: "Older activity in folder-b",
            modified: "2026-05-06T09:00:00.000Z",
            messageCount: 4,
            cwd: "/workspace/folder-b",
            isCurrent: false,
          },
          {
            id: "mock-third",
            name: "Third session",
            firstMessage: "Even older folder-c",
            modified: "2026-05-05T09:00:00.000Z",
            messageCount: 1,
            cwd: "/workspace/folder-c",
            isCurrent: false,
          },
        ] }),
      });
    });

    await page.goto("/");
    await page.locator("#sessionButton").click();

    // Default order is by recency: folder-a, folder-b, folder-c.
    await expect(page.locator(".sessionFolderName")).toContainText(["folder-a", "folder-b", "folder-c"]);

    // Pin folder-c. It should jump to the top and stay there.
    const folderCGroup = page.locator(".sessionFolderGroup", { has: page.locator(".sessionFolderName", { hasText: "folder-c" }) });
    await folderCGroup.locator(".sessionFolderPinButton").click();
    await expect(folderCGroup).toHaveClass(/\bpinned\b/);
    await expect(page.locator(".sessionFolderName")).toContainText(["folder-c", "folder-a", "folder-b"]);

    // Pin folder-b too — pinned region appends in pin order.
    const folderBGroup = page.locator(".sessionFolderGroup", { has: page.locator(".sessionFolderName", { hasText: "folder-b" }) });
    await folderBGroup.locator(".sessionFolderPinButton").click();
    await expect(page.locator(".sessionFolderName")).toContainText(["folder-c", "folder-b", "folder-a"]);

    // Persisted server-side.
    const stored = await (await page.request.get("/api/session-ui-state")).json();
    expect(stored.sessionUiState.pinnedFolders).toEqual(["/workspace/folder-c", "/workspace/folder-b"]);

    // Pin survives a marker-color filter that hides every session in the pinned folder.
    await seedServerSessionUiState(page, {
      sessionMarkers: [{ sessionId: "mock-current", color: "green", updatedAt: "2026-01-01T00:00:00.000Z" }],
    });
    await page.locator(".sessionColorFilterButton").click();
    await page.locator(".sessionColorFilterMenuItem.marker-green").click();
    await expect(page.locator(".sessionFolderName")).toContainText(["folder-c", "folder-b", "folder-a"]);

    // Unpin folder-c, ordering reverts to recency for that folder.
    await page.locator(".sessionColorFilterButton").click();
    await page.locator(".sessionColorFilterMenuItem.all").click();
    await page.locator(".sessionColorFilterButton").click({ force: true });
    // Close any lingering menu by pressing Escape.
    await page.keyboard.press("Escape");
    await folderCGroup.locator(".sessionFolderPinButton").click();
    await expect(page.locator(".sessionFolderName")).toContainText(["folder-b", "folder-a", "folder-c"]);
  });

  test("session drawer uses selected marker colors and one-line marker actions", async ({ page }) => {
    await page.goto("/");
    await page.locator("#sessionButton").click();

    await expect(page.locator(".sessionMarkerColorButton.selected")).toContainText("Blue");

    const olderItem = page.locator(".sessionItem").filter({ hasText: "Older mock session" });
    const markerButton = olderItem.locator(".sessionItemMarkerBtn");

    await markerButton.click();
    await expect(olderItem).toHaveClass(/\bmarked\b/);
    await expect(olderItem).toHaveClass(/marker-blue/);
    await expect(olderItem.locator(".sessionMarkerChip")).toHaveCount(0);

    await markerButton.click();
    await expect(olderItem).not.toHaveClass(/\bmarked\b/);

    await page.locator(".sessionMarkerColorButton.marker-green").click();
    await expect(page.locator(".sessionMarkerColorButton.selected")).toContainText("Green");
    await markerButton.click();

    await expect(olderItem).toHaveClass(/marker-green/);
    await expect(olderItem.locator(".sessionMarkerChip")).toHaveCount(0);

    await olderItem.locator(".sessionItemActionsBtn").click();
    await expect(page.locator(".sessionActionsMarkerRow")).toBeVisible();
    await expect(page.locator(".sessionActionsMarkerRow")).toContainText("Marker");
    await expect(page.locator(".sessionActionsMarkerButton")).toHaveCount(6);
    await page.locator(".sessionActionsMarkerButton.marker-red").click();
    await expect(olderItem).toHaveClass(/marker-red/);

    const currentItem = page.locator(".sessionItem").filter({ hasText: "Current mock session" });
    await page.locator(".sessionMarkerColorButton.marker-blue").click();
    await currentItem.locator(".sessionItemMarkerBtn").click();
    await expect(currentItem).toHaveClass(/marker-blue/);

    await page.locator(".sessionColorFilterButton").click();
    await expect(page.locator(".sessionColorFilterMenu")).toBeVisible();
    await page.locator(".sessionColorFilterMenuItem.marker-red").click();
    await expect(page.locator(".sessionItem")).toHaveCount(1);
    await expect(page.locator(".sessionItem")).toContainText("Older mock session");

    await page.locator(".sessionColorFilterMenuItem.marker-blue").click();
    await expect(page.locator(".sessionItem")).toHaveCount(2);
    await page.locator(".sessionColorFilterMenuItem.marker-red").click();
    await expect(page.locator(".sessionItem")).toHaveCount(1);
    await expect(page.locator(".sessionItem")).toContainText("Current mock session");
  });

  test("session drawer recolors marked rows directly while color filters are active", async ({ page }) => {
    await seedServerSessionUiState(page, {
      sessionMarkers: [
        { sessionId: "mock-current", color: "blue", updatedAt: "2026-01-01T00:00:00.000Z" },
        { sessionId: "mock-older", color: "red", updatedAt: "2026-01-01T00:00:00.000Z" },
      ],
    });

    await page.goto("/");
    await page.locator("#sessionButton").click();
    await expect(page.locator("#sessionDrawer")).toBeVisible();

    const currentItem = page.locator(".sessionItem").filter({ hasText: "Current mock session" });
    const olderItem = page.locator(".sessionItem").filter({ hasText: "Older mock session" });
    await expect(currentItem).toHaveClass(/marker-blue/);
    await expect(olderItem).toHaveClass(/marker-red/);

    await page.locator(".sessionColorFilterButton").click();
    const filterMenu = page.locator(".sessionColorFilterMenu");
    await filterMenu.locator(".sessionColorFilterMenuItem.marker-red").click();
    await filterMenu.locator(".sessionColorFilterMenuItem.marker-blue").click();
    await expect(page.locator(".sessionItem")).toHaveCount(2);

    await page.locator(".sessionMarkerColorButton.marker-blue").click();
    await olderItem.locator(".sessionItemMarkerBtn").click();

    await expect(page.locator(".sessionItem")).toHaveCount(2);
    await expect(olderItem).toBeVisible();
    await expect(olderItem).toHaveClass(/marker-blue/);
    await expect(olderItem).not.toHaveClass(/marker-red/);

    const uiState = await (await page.request.get("/api/session-ui-state")).json();
    expect(uiState.sessionUiState.sessionMarkers).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: "mock-older", color: "blue" }),
    ]));
  });

  test("session drawer Tabs tool pins and unpins rows with the single status button", async ({ page }) => {
    await page.goto("/");
    await page.locator("#sessionButton").click();
    await expect(page.locator("#sessionDrawer")).toBeVisible();

    const olderItem = page.locator(".sessionItem").filter({ hasText: "Older mock session" });
    const statusButton = olderItem.locator(".sessionItemMarkerBtn");

    await expect(page.locator(".sessionMarkerPinTool")).not.toHaveClass(/\bselected\b/);
    await page.locator(".sessionMarkerPinTool").click();
    await expect(page.locator(".sessionMarkerPinTool")).toHaveClass(/\bselected\b/);
    await expect(statusButton).toHaveClass(/\btoolPin\b/);
    await expect(statusButton).toHaveAttribute("aria-pressed", "false");

    await statusButton.click();
    await expect(olderItem).toHaveClass(/\bpinned\b/);
    await expect(statusButton).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".sessionBarTab.pinned").filter({ hasText: "Older mock session" })).toBeVisible();

    await statusButton.click();
    await expect(olderItem).not.toHaveClass(/\bpinned\b/);
    await expect(statusButton).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(".sessionBarTab.pinned").filter({ hasText: "Older mock session" })).toHaveCount(0);
  });

  test("session drawer row status shows both marker and pinned state", async ({ page }) => {
    await page.goto("/");
    await page.locator("#sessionButton").click();
    await expect(page.locator("#sessionDrawer")).toBeVisible();

    const olderItem = page.locator(".sessionItem").filter({ hasText: "Older mock session" });
    const statusButton = olderItem.locator(".sessionItemMarkerBtn");

    await page.locator(".sessionMarkerColorButton.marker-green").click();
    await statusButton.click();
    await expect(olderItem).toHaveClass(/\bmarked\b/);
    await expect(olderItem).toHaveClass(/marker-green/);

    await page.locator(".sessionMarkerPinTool").click();
    await expect(statusButton).toHaveClass(/\btoolPin\b/);
    await expect(statusButton.locator(".sessionItemMarkerDot")).toHaveCount(1);

    await statusButton.click();
    await expect(olderItem).toHaveClass(/\bpinned\b/);
    await expect(statusButton).toHaveClass(/\bpinned\b/);
    await expect(statusButton.locator(".sessionItemMarkerDot")).toHaveCount(1);

    await page.locator(".sessionMarkerColorButton.marker-green").click();
    await expect(statusButton).toHaveClass(/\btoolMarker\b/);
    await expect(statusButton.locator(".sessionItemPinBadge")).toHaveCount(1);
    await expect(olderItem).toHaveClass(/\bmarked\b/);
    await expect(olderItem).toHaveClass(/\bpinned\b/);
  });

  test("session actions menu can pin and unpin a session", async ({ page }) => {
    await page.goto("/");
    await page.locator("#sessionButton").click();
    await expect(page.locator("#sessionDrawer")).toBeVisible();

    const olderItem = page.locator(".sessionItem").filter({ hasText: "Older mock session" });
    await olderItem.locator(".sessionItemActionsBtn").click();
    await page.locator(".sessionActionsMenuItem", { hasText: "Pin to tab bar" }).click();

    await expect(olderItem).toHaveClass(/\bpinned\b/);
    await expect(page.locator(".sessionBarTab.pinned").filter({ hasText: "Older mock session" })).toBeVisible();

    await olderItem.locator(".sessionItemActionsBtn").click();
    await page.locator(".sessionActionsMenuItem", { hasText: "Unpin from tab bar" }).click();

    await expect(olderItem).not.toHaveClass(/\bpinned\b/);
    await expect(page.locator(".sessionBarTab.pinned").filter({ hasText: "Older mock session" })).toHaveCount(0);
  });

  test("clicking a tab switches sessions without needing to open the drawer first", async ({ page }) => {
    // Regression test: pinned session tabs must work even if the drawer was never opened.
    // Previously cachedSessions was empty until the drawer was opened, so click handlers
    // were never attached.
    await seedServerPinned(
      page,
      { id: "mock-current", label: "Current mock session" },
      { id: "mock-older", label: "Older mock session" },
    );

    await page.goto("/");
    // Do NOT open the drawer — the background refresh should wire up handlers automatically.
    await expect(page.locator("#sessionDrawer")).toBeHidden();

    await page.locator(".sessionBarTab").filter({ hasText: "Older mock session" }).click();

    await expect(page.locator("#statusTitle")).toHaveText("Older mock session");
    await expect(page.locator(".sessionBarTab").filter({ hasText: "Older mock session" })).toHaveClass(/\bactive\b/);
    await expect(page.locator(".sessionBarTab").filter({ hasText: "Current mock session" })).not.toHaveClass(/\bactive\b/);
  });

  test("clicked tab highlights immediately before the server responds", async ({ page }) => {
    // Regression test: the active-tab highlight must switch optimistically on click,
    // not wait for the POST /api/sessions/open round-trip to complete.
    await seedServerPinned(
      page,
      { id: "mock-current", label: "Current mock session" },
      { id: "mock-older", label: "Older mock session" },
    );

    // Delay the sessions/open response so we can observe the pre-response state.
    let resolveOpen!: () => void;
    const openGate = new Promise<void>((resolve) => { resolveOpen = resolve; });
    await page.route("**/api/sessions/open", async (route) => {
      await openGate;
      await route.continue();
    });

    await page.goto("/");
    // Open the drawer to populate cachedSessions (the gate intercept only affects /open).
    await page.locator("#sessionButton").click();
    await expect(page.locator("#sessionDrawer")).toBeVisible();
    await page.locator("#sessionCloseButton").click();

    await page.locator(".sessionBarTab").filter({ hasText: "Older mock session" }).click();

    // The highlight should switch immediately — the gate is still blocking /api/sessions/open.
    await expect(page.locator(".sessionBarTab").filter({ hasText: "Older mock session" })).toHaveClass(/\bactive\b/);
    await expect(page.locator(".sessionBarTab").filter({ hasText: "Current mock session" })).not.toHaveClass(/\bactive\b/);

    // The old session messages should not remain visible under the newly active tab
    // while the new session is still loading.
    await expect(page.locator("#messages")).not.toContainText("Can you add image attachments?");
    await expect(page.locator("#messages .message, #messages .toolCard")).toHaveCount(0);

    // Release the gate and let the rest of the switch complete.
    resolveOpen();
    await expect(page.locator("#statusTitle")).toHaveText("Older mock session");
    await expect(page.locator("#messages")).toContainText("Review the mobile composer layout");
  });

  test("running session tab gets the running class and loses it after the session ends", async ({ page }) => {
    await seedServerPinned(page, { id: "mock-current", label: "Current mock session" });

    await page.goto("/");
    await expect(page.locator("#sessionBar")).toBeVisible();

    // Start a slow task so the session is running while we can check.
    await page.locator("#prompt").fill("slow background task");
    await page.locator("#primaryButton").click();

    // The running tab should get the .running class without needing to open the
    // drawer — session_runtime_changed events now drive the bar directly.
    const tab = page.locator(".sessionBarTab").filter({ hasText: "Current mock session" });
    await expect(tab).toHaveClass(/\brunning\b/, { timeout: 3000 });

    // After the task completes, the running class should be cleared.
    await expect(tab).not.toHaveClass(/\brunning\b/, { timeout: 5000 });
  });

  test("running class appears on a background session without opening the drawer", async ({ page }) => {
    // Regression: running state for any pinned session must appear via
    // session_runtime_changed WebSocket events, not just when refreshSessions() fires.
    await seedServerPinned(
      page,
      { id: "mock-current", label: "Current mock session" },
      { id: "mock-older", label: "Older mock session" },
    );

    await page.goto("/");
    // Switch to the older session so mock-current is a background tab.
    await page.locator("#sessionButton").click();
    await expect(page.locator("#sessionDrawer")).toBeVisible();
    await page.locator(".sessionItem").filter({ hasText: "Older mock session" }).locator(".sessionItemNavBtn").click();
    await expect(page.locator("#statusTitle")).toHaveText("Older mock session");
    // Drawer auto-closes on narrow viewports after a session switch; only close manually if still open.
    if (await page.locator("#sessionDrawer").isVisible()) {
      await page.locator("#sessionCloseButton").click();
      await expect(page.locator("#sessionDrawer")).toBeHidden();
    }

    // Send a message to the background session (mock-current is still live).
    // Use the sessions/open API directly to prompt without switching the UI.
    await page.evaluate(async () => {
      const token = document.querySelector<HTMLInputElement>("#tokenInput")?.value || "";
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (token) headers["authorization"] = `Bearer ${token}`;
      // Open mock-current session in background then fire a prompt at it.
      const openRes = await fetch("/api/sessions/open", { method: "POST", headers, body: JSON.stringify({ sessionId: "mock-current", cwd: "." }) });
      await openRes.json();
      await fetch("/api/prompt", { method: "POST", headers, body: JSON.stringify({ sessionId: "mock-current", message: "slow background task" }) });
    });

    const currentTab = page.locator(".sessionBarTab").filter({ hasText: "Current mock session" });
    await expect(currentTab).toHaveClass(/\brunning\b/, { timeout: 4000 });
    await expect(currentTab).not.toHaveClass(/\brunning\b/, { timeout: 6000 });
  });
});
