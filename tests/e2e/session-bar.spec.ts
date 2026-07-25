import { expect, test } from "@playwright/test";

async function seedServerSessionUiState(page: import("@playwright/test").Page, state: {
  pinnedSessions?: Array<{ id: string; cwd?: string }>;
  sessionMarkers?: Array<{ sessionId: string; color: string; updatedAt: string }>;
  sessionUnreadStates?: Array<{ sessionId: string; unreadAt: string; updatedAt: string }>;
}) {
  await page.request.patch("/api/session-ui-state", { data: state });
}

async function seedServerPinned(page: import("@playwright/test").Page, ...sessions: Array<{ id: string; cwd?: string }>) {
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

  test("renaming the current session updates its pinned tab", async ({ page }) => {
    await seedServerPinned(page, { id: "mock-current" });
    await page.goto("/");
    await expect(page.locator(".sessionBarTab.pinned")).toContainText("Current mock session");

    await page.locator("#statusTitle").click();
    await page.locator("#statusTitle input").fill("Renamed pinned session");
    await page.keyboard.press("Enter");

    await expect(page.locator("#statusTitle")).toHaveText("Renamed pinned session");
    await expect(page.locator(".sessionBarTab.pinned")).toContainText("Renamed pinned session");
  });

  test("renamed pinned tab keeps its new title after switching away and back", async ({ page }) => {
    await seedServerPinned(page, { id: "mock-current" }, { id: "mock-older" });
    await page.goto("/");

    await page.locator("#statusTitle").click();
    await page.locator("#statusTitle input").fill("Renamed current tab");
    await page.keyboard.press("Enter");
    await expect(page.locator(".sessionBarTab").filter({ hasText: "Renamed current tab" })).toHaveClass(/\bactive\b/);

    await page.locator(".sessionBarTab").filter({ hasText: "Older mock session" }).click();
    await expect(page.locator("#statusTitle")).toHaveText("Older mock session");
    await expect(page.locator(".sessionBarTab").filter({ hasText: "Renamed current tab" })).not.toHaveClass(/\bactive\b/);
    await expect(page.locator(".sessionBarTab").filter({ hasText: "Current mock session" })).toHaveCount(0);

    await page.locator(".sessionBarTab").filter({ hasText: "Renamed current tab" }).click();
    await expect(page.locator("#statusTitle")).toHaveText("Renamed current tab");
    await expect(page.locator(".sessionBarTab").filter({ hasText: "Renamed current tab" })).toHaveClass(/\bactive\b/);
  });

  test("renaming the current unpinned session updates its temporary tab", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".sessionBarTab.temporary")).toContainText("Current mock session");

    await page.locator("#statusTitle").click();
    await page.locator("#statusTitle input").fill("Renamed temporary session");
    await page.keyboard.press("Enter");

    await expect(page.locator("#statusTitle")).toHaveText("Renamed temporary session");
    await expect(page.locator(".sessionBarTab.temporary")).toContainText("Renamed temporary session");
  });

  test("unpinning the last pinned session leaves it as the current unpinned tab", async ({ page }) => {
    await seedServerPinned(page, { id: "mock-current" });

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
        { id: "mock-current" },
        { id: "mock-older" },
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
      { id: "mock-current" },
      { id: "mock-older" },
    );

    await page.goto("/");
    await expect(page.locator(".sessionBarTab").filter({ hasText: "Current mock session" })).toHaveClass(/\bactive\b/);
    await expect(page.locator(".sessionBarTab").filter({ hasText: "Older mock session" })).not.toHaveClass(/\bactive\b/);
  });

  test("mouse drag reorders pinned tabs and persists the order", async ({ page }) => {
    await seedServerPinned(
      page,
      { id: "mock-current" },
      { id: "mock-older" },
    );
    await page.goto("/");

    const tabs = page.locator(".sessionBarTab.pinned");
    const draggedTab = tabs.filter({ hasText: "Current mock session" });
    const targetTab = tabs.filter({ hasText: "Older mock session" });
    await expect(tabs).toHaveCount(2);
    await expect(draggedTab).toBeVisible();
    await expect(targetTab).toBeVisible();
    let firstBox = await draggedTab.boundingBox();
    let secondBox = await targetTab.boundingBox();
    await expect.poll(async () => {
      firstBox = await draggedTab.boundingBox();
      secondBox = await targetTab.boundingBox();
      return Boolean(firstBox && secondBox);
    }).toBe(true);

    await page.mouse.move(firstBox!.x + firstBox!.width / 2, firstBox!.y + firstBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(firstBox!.x + firstBox!.width / 2 + 12, firstBox!.y + firstBox!.height / 2, { steps: 2 });
    await expect(draggedTab).toHaveClass(/\bdragging\b/);
    await page.mouse.move(secondBox!.x + secondBox!.width * 0.75, secondBox!.y + secondBox!.height / 2, { steps: 6 });
    await page.mouse.up();

    await expect(tabs.nth(0)).toContainText("Older mock session");
    await expect(tabs.nth(1)).toContainText("Current mock session");
    await expect.poll(async () => {
      const uiState = await (await page.request.get("/api/session-ui-state")).json();
      return uiState.sessionUiState.pinnedSessions.map((entry: { id: string }) => entry.id);
    }).toEqual(["mock-older", "mock-current"]);
  });

  test("shows unread indicators in tabs and session drawer rows", async ({ page }) => {
    await seedServerSessionUiState(page, {
      pinnedSessions: [
        { id: "mock-current" },
        { id: "mock-older" },
      ],
      sessionUnreadStates: [{ sessionId: "mock-older", unreadAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
    });

    await page.goto("/");
    const olderTab = page.locator(".sessionBarTab").filter({ hasText: "Older mock session" });
    await expect(olderTab).toHaveClass(/\bunread\b/);
    await expect(olderTab.locator(".sessionBarUnreadDot")).toBeVisible();
    await expect(page.locator("#sessionButton")).toHaveClass(/\bunread\b/);

    await page.locator("#sessionButton").click();
    const olderRow = page.locator(".sessionItem").filter({ hasText: "Older mock session" });
    await expect(olderRow).toHaveClass(/\bunread\b/);
    await expect(olderRow.locator(".sessionItemUnreadDot")).toBeVisible();
  });

  test("opening an unread session clears it in other browser views", async ({ page, context }) => {
    await seedServerSessionUiState(page, {
      pinnedSessions: [
        { id: "mock-current" },
        { id: "mock-older" },
      ],
      sessionUnreadStates: [{ sessionId: "mock-older", unreadAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
    });

    await page.goto("/");
    const other = await context.newPage();
    await other.goto("/");

    const olderTab = page.locator(".sessionBarTab").filter({ hasText: "Older mock session" });
    const otherOlderTab = other.locator(".sessionBarTab").filter({ hasText: "Older mock session" });
    await expect(olderTab).toHaveClass(/\bunread\b/);
    await expect(otherOlderTab).toHaveClass(/\bunread\b/);

    await olderTab.locator(".sessionBarTabOpen").click();
    await expect(olderTab).toHaveClass(/\bactive\b/);
    await expect(olderTab).not.toHaveClass(/\bunread\b/);
    await expect(otherOlderTab).not.toHaveClass(/\bunread\b/);

    const uiState = await (await page.request.get("/api/session-ui-state")).json();
    expect(uiState.sessionUiState.sessionUnreadStates).toEqual([]);
    await other.close();
  });

  test("/clear returns to the new-session animation and current folder picker", async ({ page }) => {
    await page.goto("/");
    const statusPath = page.locator("#statusPath");
    await expect(statusPath).not.toHaveText("");
    const currentCwd = await statusPath.innerText();

    await page.locator("#prompt").fill("/clear");
    await page.locator("#primaryButton").click();

    await expect(page.locator("#statusTitle")).toHaveText("New session");
    await expect(page.getByText("Cleared tab. Previous session remains in history.")).toHaveCount(0);
    const emptyState = page.locator("#emptyCwdChooser");
    await expect(emptyState).toBeVisible();
    const animation = emptyState.locator(".newChatLoadingAnimation");
    await expect(animation).toBeVisible();
    await expect(animation).not.toHaveClass(/resetting/);
    await expect.poll(() => animation.evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0);

    const folderButton = emptyState.getByRole("button", { name: "Change working directory" });
    await expect(folderButton.locator(".emptyCwdPath")).toHaveText(currentCwd);
    await folderButton.click();
    await expect(page.locator(".folderPickerInput")).toHaveValue(currentCwd);
  });

  test("/clear reuses the current tab pin and marker while releasing the old session", async ({ page }) => {
    await seedServerSessionUiState(page, {
      pinnedSessions: [
        { id: "mock-older" },
        { id: "mock-current" },
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

    const activeAfter = page.locator(".sessionBarTab.active");
    await expect(activeAfter).toContainText("New session");
    await expect(activeAfter).toHaveClass(/\bpinned\b/);
    await expect(activeAfter).toHaveClass(/marker-green/);
    await expect(page.locator(".sessionBarTab").filter({ hasText: "Current mock session" })).toHaveCount(0);

    const uiState = await (await page.request.get("/api/session-ui-state")).json();
    expect(uiState.sessionUiState.pinnedSessions).toEqual([
      expect.objectContaining({ id: "mock-older" }),
      expect.objectContaining({ cwd: expect.any(String) }),
    ]);
    expect(uiState.sessionUiState.pinnedSessions[1].id).not.toBe("mock-current");
    expect(uiState.sessionUiState.sessionMarkers).toEqual([
      expect.objectContaining({ sessionId: uiState.sessionUiState.pinnedSessions[1].id, color: "green" }),
    ]);
  });

  test("pinned tab context menu sets and unsets session colors", async ({ page }) => {
    await seedServerPinned(page, { id: "mock-current" });
    await page.goto("/");

    await expect(page.locator("#currentSessionBucketButton")).toBeHidden();
    const tab = page.locator(".sessionBarTab.pinned").filter({ hasText: "Current mock session" });
    await tab.click({ button: "right" });
    const menu = page.locator(".sessionBucketMenu");
    await expect(menu).toBeVisible();
    await expect(menu).toContainText("Session color");
    await expect(menu.locator(".sessionColorFilterMenuItem")).toHaveCount(6);

    await menu.locator(".sessionColorFilterMenuItem.marker-green").click();
    await expect(tab).toHaveClass(/\bmarked\b/);
    await expect(tab).toHaveClass(/marker-green/);

    let uiState = await (await page.request.get("/api/session-ui-state")).json();
    expect(uiState.sessionUiState.sessionMarkers).toEqual([
      expect.objectContaining({ sessionId: "mock-current", color: "green" }),
    ]);

    await tab.click({ button: "right" });
    await page.locator(".sessionBucketMenu .sessionColorFilterMenuItem", { hasText: "No bucket" }).click();
    await expect(tab).not.toHaveClass(/\bmarked\b/);

    uiState = await (await page.request.get("/api/session-ui-state")).json();
    expect(uiState.sessionUiState.sessionMarkers).toEqual([]);
  });

  test("clicking a tab switches sessions and moves the active marker", async ({ page }) => {
    await seedServerPinned(
      page,
      { id: "mock-current" },
      { id: "mock-older" },
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

  test("new session preserves the drawer state on wide viewports and closes on mobile", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#sessionDrawer")).toBeHidden();

    await page.locator("#newSessionHeaderButton").click();

    await expect(page.locator("#statusTitle")).toHaveText("New session");
    await expect(page.locator("#sessionDrawer")).toBeHidden();

    const width = page.viewportSize()?.width || 0;
    if (width > 700) {
      await page.locator("#sessionButton").click();
      await expect(page.locator("#sessionDrawer")).toBeVisible();
      await page.locator("#newSessionHeaderButton").click();
      await expect(page.locator("#statusTitle")).toHaveText("New session");
      await expect(page.locator("#sessionDrawer")).toBeVisible();
    }
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
      { id: "mock-current" },
      { id: "mock-older" },
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
      { id: "mock-current" },
      { id: "mock-older" },
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

    // The highlight and active tab title should switch immediately — the gate is still blocking /api/sessions/open.
    const activeTab = page.locator(".sessionBarTab.active");
    await expect(page.locator(".sessionBarTab").filter({ hasText: "Older mock session" })).toHaveClass(/\bactive\b/);
    await expect(activeTab).toContainText("Older mock session");
    await expect(activeTab).not.toContainText("Current mock session");
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
    await seedServerPinned(page, { id: "mock-current" });

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

  async function switchToOlder(page: import("@playwright/test").Page) {
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
  }

  async function promptCurrentInBackground(page: import("@playwright/test").Page, message: string) {
    await page.evaluate(async (promptMessage) => {
      const token = document.querySelector<HTMLInputElement>("#tokenInput")?.value || "";
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (token) headers["authorization"] = `Bearer ${token}`;
      // Open mock-current session in background then fire a prompt at it.
      const openRes = await fetch("/api/sessions/open", { method: "POST", headers, body: JSON.stringify({ sessionId: "mock-current", cwd: "." }) });
      await openRes.json();
      await fetch("/api/prompt", { method: "POST", headers, body: JSON.stringify({ sessionId: "mock-current", message: promptMessage }) });
    }, message);
  }

  async function switchToOlderAndPromptCurrent(page: import("@playwright/test").Page, message: string) {
    await switchToOlder(page);
    await promptCurrentInBackground(page, message);
  }

  test("running class appears on a background session without opening the drawer", async ({ page }) => {
    // Regression: running state for any pinned session must appear via
    // session_runtime_changed WebSocket events, not just when refreshSessions() fires.
    await seedServerPinned(
      page,
      { id: "mock-current" },
      { id: "mock-older" },
    );

    await page.goto("/");
    await switchToOlder(page);
    const currentTab = page.locator(".sessionBarTab").filter({ hasText: "Current mock session" });
    await seedServerSessionUiState(page, {
      sessionUnreadStates: [{ sessionId: "mock-current", unreadAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
    });
    await expect(currentTab).toHaveClass(/\bunread\b/);

    await promptCurrentInBackground(page, "slow background task");

    await expect(currentTab).toHaveClass(/\brunning\b/, { timeout: 4000 });
    await expect(currentTab).not.toHaveClass(/\bunread\b/);
    await expect(currentTab).not.toHaveClass(/\brunning\b/, { timeout: 6000 });
    await expect(currentTab).toHaveClass(/\bunread\b/);
  });

  test("background completion recovers unread state when agent_end is missed", async ({ page }) => {
    await seedServerPinned(
      page,
      { id: "mock-current" },
      { id: "mock-older" },
    );

    await page.goto("/");
    const currentTab = page.locator(".sessionBarTab").filter({ hasText: "Current mock session" });

    await switchToOlderAndPromptCurrent(page, "slow missing agent end");

    await expect(currentTab).toHaveClass(/\brunning\b/, { timeout: 4000 });
    await expect(currentTab).not.toHaveClass(/\bunread\b/);
    await expect(currentTab).not.toHaveClass(/\brunning\b/, { timeout: 6000 });
    await expect(currentTab).toHaveClass(/\bunread\b/);
  });
});
