import { expect, test } from "@playwright/test";
import { openLauncherAction } from "./helpers/actionLauncher.js";

async function seedServerSessionUiState(page: import("@playwright/test").Page, state: {
  pinnedSessions?: Array<{ id: string; cwd?: string }>;
  lanes?: Array<{ sessionId: string; lane: "pinned" | "parked" | "bookmarks"; cwd?: string; note?: string; since: string }>;
  sessionMarkers?: Array<{ sessionId: string; color: string; updatedAt: string }>;
  sessionUnreadStates?: Array<{ sessionId: string; unreadAt: string; updatedAt: string }>;
  sessionOrigins?: Array<{ sessionId: string; originSessionId: string; kind: string; updatedAt: string }>;
  bucketLabels?: Record<string, string>;
}) {
  await page.request.patch("/api/session-ui-state", { data: state });
}

async function seedServerPinned(page: import("@playwright/test").Page, ...sessions: Array<{ id: string; cwd?: string }>) {
  await seedServerSessionUiState(page, { pinnedSessions: sessions });
}

async function holdSessionReadSnapshot(page: import("@playwright/test").Page, sessionId: string) {
  let release!: () => void;
  let captured!: () => void;
  let delivered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const seen = new Promise<void>((resolve) => { captured = resolve; });
  const delivery = new Promise<void>((resolve) => { delivered = resolve; });
  await page.route("**/api/session-ui-state/read", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    if (body.sessionId !== sessionId) return route.continue();
    const response = await route.fetch();
    captured();
    await gate;
    await route.fulfill({ response });
    delivered();
  });
  return { release, seen, delivery };
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

  test("a stale mark-read response cannot repin an active session", async ({ page }) => {
    await seedServerPinned(page, { id: "mock-current" }, { id: "mock-older" });
    const held = await holdSessionReadSnapshot(page, "mock-older");
    await page.goto("/");

    const older = page.locator(".sessionBarTab").filter({ hasText: "Older mock session" });
    await older.click();
    await held.seen;
    await older.locator(".sessionBarTabAction").click();
    await expect.poll(async () => {
      const value = await (await page.request.get("/api/session-ui-state")).json();
      return value.sessionUiState.lanes.some((entry: { sessionId: string }) => entry.sessionId === "mock-older");
    }).toBe(false);

    held.release();
    await held.delivery;
    await expect(page.locator(".sessionBarTab.pinned").filter({ hasText: "Older mock session" })).toHaveCount(0);
  });

  test("a stale mark-read response cannot unpin a newly pinned active session", async ({ page }) => {
    const held = await holdSessionReadSnapshot(page, "mock-older");
    await page.goto("/");
    await page.locator("#sessionButton").click();
    await page.locator(".sessionItem").filter({ hasText: "Older mock session" }).locator(".sessionItemNavBtn").click();
    await held.seen;
    await page.locator(".sessionBarTab.temporary .sessionBarTabAction").click();
    await expect.poll(async () => {
      const value = await (await page.request.get("/api/session-ui-state")).json();
      return value.sessionUiState.lanes.some((entry: { sessionId: string; lane: string }) => entry.sessionId === "mock-older" && entry.lane === "pinned");
    }).toBe(true);

    held.release();
    await held.delivery;
    await expect(page.locator(".sessionBarTab.pinned").filter({ hasText: "Older mock session" })).toHaveCount(1);
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
      return uiState.sessionUiState.lanes.filter((entry: { lane: string }) => entry.lane === "pinned").map((entry: { sessionId: string }) => entry.sessionId);
    }).toEqual(["mock-older", "mock-current"]);
  });

  test("touch hold and drag reorders pinned tabs", async ({ page }) => {
    await seedServerPinned(
      page,
      { id: "mock-current" },
      { id: "mock-older" },
    );
    await page.goto("/");

    const tabs = page.locator(".sessionBarTab.pinned");
    const draggedTab = tabs.filter({ hasText: "Current mock session" });
    const targetTab = tabs.filter({ hasText: "Older mock session" });
    await expect(draggedTab).toBeVisible();
    await expect(targetTab).toBeVisible();
    let firstBox = await draggedTab.boundingBox();
    let secondBox = await targetTab.boundingBox();
    await expect.poll(async () => {
      firstBox = await draggedTab.boundingBox();
      secondBox = await targetTab.boundingBox();
      return Boolean(firstBox && secondBox);
    }).toBe(true);

    const start = { clientX: firstBox!.x + firstBox!.width / 2, clientY: firstBox!.y + firstBox!.height / 2 };
    const end = { clientX: secondBox!.x + secondBox!.width * 0.75, clientY: start.clientY };
    // Run the timed gesture in one browser task sequence. Crossing the
    // Playwright boundary between hold and move lets a loaded CI worker delay
    // the move until the Inspector's later long-press timer has won.
    await draggedTab.evaluate(async (tab, points) => {
      const pointer = { pointerId: 7, pointerType: "touch", isPrimary: true, bubbles: true };
      tab.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, ...points.start, button: 0 }));
      await new Promise((resolve) => window.setTimeout(resolve, 350));
      tab.dispatchEvent(new PointerEvent("pointermove", { ...pointer, ...points.end }));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      tab.dispatchEvent(new PointerEvent("pointerup", { ...pointer, ...points.end }));
    }, { start, end });

    await expect(tabs.nth(0)).toContainText("Older mock session");
    await expect(tabs.nth(1)).toContainText("Current mock session");
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

  test("marks a read session unread from the drawer and tab inspector", async ({ page }) => {
    await seedServerSessionUiState(page, {
      pinnedSessions: [
        { id: "mock-current" },
        { id: "mock-older" },
      ],
    });
    await page.goto("/");

    const olderTab = page.locator(".sessionBarTab").filter({ hasText: "Older mock session" });
    await page.locator("#sessionButton").click();
    const olderRow = page.locator(".sessionItem").filter({ hasText: "Older mock session" });
    await olderRow.locator(".sessionItemActionsBtn").click();
    await page.getByRole("menuitem", { name: "Mark as unread" }).click();
    await expect(olderRow).toHaveClass(/\bunread\b/);
    await expect(olderTab).toHaveClass(/\bunread\b/);

    await olderRow.locator(".sessionItemActionsBtn").click();
    await page.getByRole("menuitem", { name: "Mark as read" }).click();
    await expect(olderTab).not.toHaveClass(/\bunread\b/);

    // On mobile the open drawer overlays the tab bar; close it before opening
    // the tab inspector.
    await page.keyboard.press("Escape");
    await expect(page.locator("#sessionButton")).toHaveAttribute("aria-expanded", "false");
    await olderTab.click({ button: "right" });
    await page.getByRole("button", { name: "Mark as unread" }).click();
    await expect(olderTab).toHaveClass(/\bunread\b/);
    await page.locator("#sessionButton").click();
    await expect(olderRow).toHaveClass(/\bunread\b/);

    const uiState = await (await page.request.get("/api/session-ui-state")).json();
    expect(uiState.sessionUiState.sessionUnreadStates).toEqual([
      expect.objectContaining({ sessionId: "mock-older", unreadAt: expect.any(String) }),
    ]);
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
    const pinnedLanes = uiState.sessionUiState.lanes.filter((entry: { lane: string }) => entry.lane === "pinned");
    expect(pinnedLanes).toEqual([
      expect.objectContaining({ sessionId: "mock-older" }),
      expect.objectContaining({ cwd: expect.any(String) }),
    ]);
    expect(pinnedLanes[1].sessionId).not.toBe("mock-current");
    expect(uiState.sessionUiState.sessionMarkers).toEqual([
      expect.objectContaining({ sessionId: pinnedLanes[1].sessionId, color: "green" }),
    ]);
  });

  test("pinned tab inspector sets a session bucket", async ({ page }) => {
    await seedServerPinned(page, { id: "mock-current" }); await page.goto("/");
    const tab = page.locator(".sessionBarTab.pinned").filter({ hasText: "Current mock session" });
    await tab.click({ button: "right" }); await expect(page.locator(".sessionInspector")).toBeVisible();
    await page.locator(".sessionInspectorBuckets .marker-green").click(); await expect(tab).toHaveClass(/marker-green/);
    const uiState = await (await page.request.get("/api/session-ui-state")).json();
    expect(uiState.sessionUiState.sessionMarkers).toEqual([expect.objectContaining({ sessionId: "mock-current", color: "green" })]);
  });

  test("mobile inspector omits Open for tabs and keeps lane footer actions on one row", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "Mobile footer layout coverage");
    await seedServerPinned(page, { id: "mock-current" });
    await page.goto("/");

    const tab = page.locator('.sessionBarTab[data-session-id="mock-current"]');
    await tab.click({ button: "right" });
    let footer = page.locator(".sessionInspector > footer");
    await expect(footer.getByRole("button")).toHaveCount(2);
    await expect(footer.getByRole("button", { name: "↗ Open" })).toHaveCount(0);
    let boxes = await footer.getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().toJSON()));
    expect(new Set(boxes.map((box) => box.y)).size).toBe(1);

    await page.keyboard.press("Escape");
    await page.locator(".sessionLayersButton").click();
    await page.locator('.sessionLaneDrawerCard[data-session-id="mock-current"] .sessionLaneDrawerActions').click();
    footer = page.locator(".sessionInspector > footer");
    await expect(footer.getByRole("button")).toHaveCount(3);
    await expect(footer.getByRole("button", { name: "↗ Open" })).toBeVisible();
    boxes = await footer.getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().toJSON()));
    expect(new Set(boxes.map((box) => box.y)).size).toBe(1);
    const footerBox = await footer.boundingBox();
    expect(Math.max(...boxes.map((box) => box.right))).toBeLessThanOrEqual(footerBox!.x + footerBox!.width + 0.5);
  });

  test("parking commits immediately and offers a non-blocking optional note", async ({ page }) => {
    await seedServerPinned(page, { id: "mock-current" });
    await page.goto("/");
    await page.locator('.sessionBarTab[data-session-id="mock-current"]').click({ button: "right" });
    await page.getByRole("button", { name: "Move to Parked" }).click();

    await expect.poll(async () => {
      const value = await (await page.request.get("/api/session-ui-state")).json();
      return value.sessionUiState.lanes.find((entry: { sessionId: string }) => entry.sessionId === "mock-current");
    }).toMatchObject({ lane: "parked" });
    await expect(page.locator(".sessionLaneNotePromptBackdrop")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".sessionLaneNotePromptBackdrop")).toHaveCount(0);
    const value = await (await page.request.get("/api/session-ui-state")).json();
    expect(value.sessionUiState.lanes.find((entry: { sessionId: string }) => entry.sessionId === "mock-current")).toEqual(expect.not.objectContaining({ note: expect.anything() }));
  });

  test("session notes can be edited in every lane and survive moves and reloads", async ({ page }) => {
    await seedServerPinned(page, { id: "mock-current" });
    await page.goto("/");

    const openTabInspector = async () => {
      await page.locator('.sessionBarTab[data-session-id="mock-current"]').click({ button: "right" });
      await expect(page.locator(".sessionInspector")).toBeVisible();
    };
    const expectStoredLane = async (lane: string, note: string) => {
      await expect.poll(async () => {
        const value = await (await page.request.get("/api/session-ui-state")).json();
        const entry = value.sessionUiState.lanes.find((item: { sessionId: string }) => item.sessionId === "mock-current");
        return entry ? { lane: entry.lane, note: entry.note } : undefined;
      }).toEqual({ lane, note });
    };

    await openTabInspector();
    await page.locator(".sessionInspectorNote").fill("Pinned note");
    await page.locator(".sessionInspectorNote").press("Enter");
    await expectStoredLane("pinned", "Pinned note");

    await openTabInspector();
    await expect(page.locator(".sessionInspectorNote")).toHaveValue("Pinned note");
    await page.getByRole("button", { name: "Move to Parked" }).click();
    // The move commits immediately; the follow-up prompt is optional and may be dismissed.
    await expectStoredLane("parked", "Pinned note");
    await expect(page.locator(".sessionLaneNotePromptBackdrop")).toHaveCount(0);

    await openTabInspector();
    await page.locator(".sessionInspectorNote").fill("Parked note");
    await page.locator(".sessionInspectorNote").press("Enter");
    await expectStoredLane("parked", "Parked note");

    await openTabInspector();
    await page.getByRole("button", { name: "Move to Bookmarks" }).click();
    await expectStoredLane("bookmarks", "Parked note");
    await openTabInspector();
    await page.locator(".sessionInspectorNote").fill("Bookmark note");
    await page.locator(".sessionInspectorNote").press("Enter");
    await expectStoredLane("bookmarks", "Bookmark note");

    await page.reload();
    await page.locator(".sessionLayersButton").click();
    const row = page.locator('.sessionLaneDrawerCard[data-session-id="mock-current"]');
    await expect(row.locator(".sessionLaneDrawerItemNote")).toHaveText("Bookmark note");
    await row.locator(".sessionLaneDrawerActions").click();
    await expect(page.locator(".sessionInspectorNote")).toHaveValue("Bookmark note");
    await page.locator(".sessionInspectorNote").fill("");
    await page.locator(".sessionInspectorNote").press("Enter");
    await expect.poll(async () => {
      const value = await (await page.request.get("/api/session-ui-state")).json();
      return value.sessionUiState.lanes.find((item: { sessionId: string }) => item.sessionId === "mock-current")?.note ?? null;
    }).toBeNull();
  });

  test("lane drawer filters all lanes by custom bucket names", async ({ page }) => {
    const since = "2026-01-01T00:00:00.000Z";
    await seedServerSessionUiState(page, {
      lanes: [
        { sessionId: "mock-current", lane: "pinned", since },
        { sessionId: "mock-older", lane: "bookmarks", since },
      ],
      sessionMarkers: [
        { sessionId: "mock-current", color: "cyan", updatedAt: since },
        { sessionId: "mock-older", color: "pink", updatedAt: since },
      ],
      bucketLabels: { cyan: "Builds" },
    });
    await page.goto("/");
    await page.locator(".sessionLayersButton").click();

    const filters = page.getByRole("group", { name: "Filter lanes by bucket" });
    await expect(filters.getByRole("button")).toHaveCount(9);
    await filters.getByRole("button", { name: "Show Builds bucket" }).click();
    await expect(page.locator('.sessionLaneDrawerCard[data-session-id="mock-current"]')).toBeVisible();
    await expect(page.locator('.sessionLaneDrawerCard[data-session-id="mock-older"]')).toHaveCount(0);
    await expect(page.locator(".sessionLaneDragHandle")).toBeDisabled();
    await expect(page.locator(".sessionLaneDrawerSummary")).toHaveText("1 of 2 sessions");

    await filters.getByRole("button", { name: "All" }).click();
    await expect(page.locator(".sessionLaneDrawerCard")).toHaveCount(2);
  });

  test("a stale mark-read response cannot revert a lane drawer move", async ({ page }) => {
    await seedServerPinned(page, { id: "mock-current" }, { id: "mock-older" });
    const held = await holdSessionReadSnapshot(page, "mock-older");
    await page.goto("/");
    await page.locator(".sessionBarTab").filter({ hasText: "Older mock session" }).click();
    await held.seen;

    await page.locator(".sessionLayersButton").click();
    const row = page.locator('.sessionLaneDrawerCard[data-session-id="mock-older"]');
    await row.locator(".sessionLaneDrawerActions").click();
    await page.getByRole("button", { name: "Move to Bookmarks" }).click();
    await expect.poll(async () => {
      const value = await (await page.request.get("/api/session-ui-state")).json();
      return value.sessionUiState.lanes.find((entry: { sessionId: string; lane: string }) => entry.sessionId === "mock-older")?.lane;
    }).toBe("bookmarks");

    held.release();
    await held.delivery;
    await page.keyboard.press("Escape");
    await page.locator(".sessionLayersButton").click();
    await expect(page.locator('.sessionLaneDrawerSection[data-lane="bookmarks"] [data-session-id="mock-older"]')).toHaveCount(1);
  });

  test("the lane drag handle does not trigger the inspector and moves between lanes", async ({ page }) => {
    await seedServerPinned(page, { id: "mock-current" });
    await page.goto("/");
    await page.locator(".sessionLayersButton").click();

    const handle = page.locator('.sessionLaneDrawerCard[data-session-id="mock-current"] .sessionLaneDragHandle');
    const bookmarkLane = page.locator('.sessionLaneDrawerSection[data-lane="bookmarks"]');
    const handleBox = await handle.boundingBox();
    const laneBox = await bookmarkLane.boundingBox();
    expect(handleBox).not.toBeNull();
    expect(laneBox).not.toBeNull();
    const pointer = { pointerId: 19, pointerType: "touch", isPrimary: true };
    await handle.dispatchEvent("pointerdown", { ...pointer, button: 0, clientX: handleBox!.x + handleBox!.width / 2, clientY: handleBox!.y + handleBox!.height / 2 });
    await page.waitForTimeout(400);
    await expect(page.locator(".sessionInspector")).toHaveCount(0);
    await page.locator("body").dispatchEvent("pointermove", { ...pointer, clientX: laneBox!.x + laneBox!.width / 2, clientY: laneBox!.y + laneBox!.height / 2 });
    await page.locator("body").dispatchEvent("pointerup", { ...pointer, clientX: laneBox!.x + laneBox!.width / 2, clientY: laneBox!.y + laneBox!.height / 2 });

    await expect.poll(async () => {
      const value = await (await page.request.get("/api/session-ui-state")).json();
      return value.sessionUiState.lanes.find((entry: { sessionId: string; lane: string }) => entry.sessionId === "mock-current")?.lane;
    }).toBe("bookmarks");
  });

  test("removing the active lane entry keeps it visible as a temporary tab", async ({ page }) => {
    await seedServerSessionUiState(page, { lanes: [{ sessionId: "mock-current", lane: "bookmarks", since: "2026-01-01T00:00:00.000Z" }] });
    await page.goto("/");
    await page.locator(".sessionLayersButton").click();
    await page.locator('.sessionLaneDrawerCard[data-session-id="mock-current"] .sessionLaneDrawerItem').click();
    await page.locator('.sessionBarTab[data-session-id="mock-current"] .sessionBarTabAction').click();

    await expect(page.locator('.sessionBarTab.temporary[data-session-id="mock-current"]')).toHaveClass(/\bactive\b/);
  });

  test("lane inspector preserves saved cross-workspace cwd for move and open", async ({ page }) => {
    await seedServerSessionUiState(page, { lanes: [{ sessionId: "remote-session", lane: "parked", cwd: "/saved/workspace", since: "2026-01-01T00:00:00.000Z" }] });
    await page.goto("/");
    await page.locator(".sessionLayersButton").click();
    let row = page.locator('.sessionLaneDrawerCard[data-session-id="remote-session"]');
    await row.click({ button: "right" });
    await page.getByRole("button", { name: "Move to Bookmarks" }).click();
    await expect.poll(async () => {
      const value = await (await page.request.get("/api/session-ui-state")).json();
      return value.sessionUiState.lanes.find((entry: { sessionId: string }) => entry.sessionId === "remote-session");
    }).toMatchObject({ lane: "bookmarks", cwd: "/saved/workspace" });

    let openedCwd = "";
    await page.route("**/api/sessions/open", async (route) => {
      openedCwd = JSON.parse(route.request().postData() || "{}").cwd;
      await route.abort();
    });
    row = page.locator('.sessionLaneDrawerCard[data-session-id="remote-session"]');
    await row.click({ button: "right" });
    await page.getByRole("button", { name: "↗ Open" }).click();
    await expect.poll(() => openedCwd).toBe("/saved/workspace");
  });

  test("clicking a lane drawer header does not change the active tab lane", async ({ page }) => {
    await seedServerSessionUiState(page, { lanes: [
      { sessionId: "mock-current", lane: "pinned", since: "2026-01-01T00:00:00.000Z" },
      { sessionId: "mock-older", lane: "bookmarks", since: "2026-01-01T00:00:00.000Z" },
    ] });
    await page.goto("/");
    await page.locator(".sessionLayersButton").click();
    await page.locator('.sessionLaneDrawerSection[data-lane="bookmarks"] .sessionLaneDrawerHeading').click();

    await expect(page.locator(".sessionLaneDrawer")).toBeVisible();
    await expect(page.locator('.sessionBarTab.pinned[data-session-id="mock-current"]')).toHaveClass(/\bactive\b/);
    await expect(page.locator('.sessionBarTab[data-session-id="mock-older"]')).toHaveCount(0);
  });

  test("opening a session from the lane drawer focuses that session's lane tabs", async ({ page }) => {
    await seedServerSessionUiState(page, { lanes: [
      { sessionId: "mock-current", lane: "pinned", since: "2026-01-01T00:00:00.000Z" },
      { sessionId: "mock-older", lane: "bookmarks", since: "2026-01-01T00:00:00.000Z" },
    ] });
    await page.goto("/");
    await page.locator(".sessionLayersButton").click();
    await page.locator('.sessionLaneDrawerCard[data-session-id="mock-older"] .sessionLaneDrawerItem').click();

    await expect(page.locator("#statusTitle")).toHaveText("Older mock session");
    await expect(page.locator(".sessionBarTab.laned")).toHaveCount(1);
    await expect(page.locator('.sessionBarTab.laned[data-session-id="mock-older"]')).toHaveClass(/\bactive\b/);
    await expect(page.locator('.sessionBarTab[data-session-id="mock-current"]')).toHaveCount(0);
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

    await openLauncherAction(page, "New session");

    await expect(page.locator("#statusTitle")).toHaveText("New session");
    await expect(page.locator("#sessionDrawer")).toBeHidden();

    const width = page.viewportSize()?.width || 0;
    if (width > 700) {
      await page.locator("#sessionButton").click();
      await expect(page.locator("#sessionDrawer")).toBeVisible();
      await openLauncherAction(page, "New session");
      await expect(page.locator("#statusTitle")).toHaveText("New session");
      await expect(page.locator("#sessionDrawer")).toBeVisible();
    }
  });

  test("session drawer drops folders with no filter matches", async ({ page }) => {
    await seedServerSessionUiState(page, { sessionMarkers: [{ sessionId: "mock-older", color: "green", updatedAt: "2026-01-01T00:00:00.000Z" }] });
    await page.goto("/"); await page.locator("#sessionButton").click();
    await page.locator(".sessionColorFilterButton").click();
    await page.getByRole("menuitemcheckbox", { name: "Green" }).click();
    await expect(page.locator(".sessionFolderGroup")).toHaveCount(1);
    await expect(page.locator(".sessionItem")).toContainText("Older mock session");
  });

  test("session drawer assigns buckets from the row menu and filters by bucket", async ({ page }) => {
    await page.goto("/"); await page.locator("#sessionButton").click();
    const older = page.locator(".sessionItem").filter({ hasText: "Older mock session" });
    await older.locator(".sessionItemActionsBtn").click(); await page.locator(".sessionActionsMarkerButton.marker-red").click();
    await expect(older).toHaveClass(/marker-red/); await expect(older.locator(".sessionItemMarkerDot")).toHaveCount(1);
    await page.locator(".sessionColorFilterButton").click(); await page.getByRole("menuitemcheckbox", { name: "Red" }).click();
    await expect(page.locator(".sessionItem")).toHaveCount(1); await expect(page.locator(".sessionItem")).toContainText("Older mock session");
  });

  test("session drawer recolors rows from the row menu while bucket filters are active", async ({ page }) => {
    await seedServerSessionUiState(page, { sessionMarkers: [{ sessionId: "mock-older", color: "red", updatedAt: "2026-01-01T00:00:00.000Z" }] });
    await page.goto("/"); await page.locator("#sessionButton").click(); await page.locator(".sessionColorFilterButton").click(); await page.getByRole("menuitemcheckbox", { name: "Red" }).click();
    const older = page.locator(".sessionItem").filter({ hasText: "Older mock session" }); await older.locator(".sessionItemActionsBtn").click(); await page.locator(".sessionActionsMarkerButton.marker-blue").click();
    await expect(page.locator(".sessionItem")).toHaveCount(0); const uiState = await (await page.request.get("/api/session-ui-state")).json(); expect(uiState.sessionUiState.sessionMarkers).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: "mock-older", color: "blue" })]));
  });

  test("session drawer row pin button pins and unpins", async ({ page }) => {
    await page.goto("/"); await page.locator("#sessionButton").click(); const older = page.locator(".sessionItem").filter({ hasText: "Older mock session" }); const pin = older.locator(".sessionItemMarkerBtn");
    await pin.click(); await expect(older).toHaveClass(/pinned/); await expect(pin).toHaveAttribute("aria-pressed", "true");
    await pin.click(); await expect(older).not.toHaveClass(/pinned/); await expect(pin).toHaveAttribute("aria-pressed", "false");
  });

  test("session drawer row pin control also displays its bucket dot", async ({ page }) => {
    await page.goto("/"); await page.locator("#sessionButton").click(); const older = page.locator(".sessionItem").filter({ hasText: "Older mock session" });
    await older.locator(".sessionItemActionsBtn").click(); await page.locator(".sessionActionsMarkerButton.marker-green").click(); await expect(older.locator(".sessionItemMarkerDot")).toHaveCount(1);
    await older.locator(".sessionItemMarkerBtn").click(); await expect(older).toHaveClass(/pinned/); await expect(older.locator(".sessionItemMarkerDot")).toHaveCount(1);
  });

  test("uses one filter menu, keeps quick buckets visible, and preserves row geometry", async ({ page }) => {
    await seedServerSessionUiState(page, {
      sessionMarkers: [{ sessionId: "mock-older", color: "green", updatedAt: "2026-01-01T00:00:00.000Z" }],
      sessionOrigins: [{ sessionId: "mock-older", originSessionId: "mock-current", kind: "spawn", updatedAt: "2026-01-01T00:00:00.000Z" }],
    });
    await page.goto("/");
    await page.locator("#sessionButton").click();

    const filters = page.locator(".sessionLaneFilters");
    await expect(filters.locator(".sessionColorFilterButton")).toHaveCount(1);
    await expect(filters.locator(".sessionBucketFilter")).toHaveCount(8);
    await expect(filters).toHaveCSS("overflow", "visible");
    const filterBox = await filters.boundingBox();
    const listBox = await page.locator("#sessionList").boundingBox();
    expect(Math.abs(filterBox!.y - listBox!.y)).toBeLessThanOrEqual(1);
    expect(filterBox!.height).toBeGreaterThanOrEqual(42);
    const filterButtonBox = await filters.locator(".sessionColorFilterButton").boundingBox();
    for (const bucket of await filters.locator(".sessionBucketFilter").all()) {
      const box = await bucket.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.y).toBeGreaterThanOrEqual(filterBox!.y);
      expect(box!.y + box!.height).toBeLessThanOrEqual(filterBox!.y + filterBox!.height);
    }
    expect(filterButtonBox!.y).toBeGreaterThanOrEqual(filterBox!.y);
    expect(filterButtonBox!.y + filterButtonBox!.height).toBeLessThanOrEqual(filterBox!.y + filterBox!.height);

    await filters.locator(".sessionColorFilterButton").click();
    await page.getByRole("menuitemradio", { name: "Pinned" }).click();
    await expect(page.locator(".sessionItem")).toHaveCount(0);
    await filters.locator(".sessionColorFilterButton").click();
    await page.getByRole("menuitemradio", { name: "All lanes" }).click();

    const parent = page.locator('.sessionItem[data-session-id="mock-current"]');
    const markerIcon = parent.locator(".sessionItemMarkerBtn svg");
    const chevron = parent.locator(".sessionWorkerBranchChevron");
    const nav = parent.locator(".sessionItemNavBtn");
    const markerBox = await markerIcon.boundingBox();
    const chevronBox = await chevron.boundingBox();
    const navBox = await nav.boundingBox();
    const leftGap = chevronBox!.x - (markerBox!.x + markerBox!.width);
    const rightGap = navBox!.x - (chevronBox!.x + chevronBox!.width);
    expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(1);

    await parent.locator(".sessionWorkerBranchToggle").click();
    const worker = page.locator('.sessionItem[data-session-id="mock-older"]');
    await expect(worker.locator(".sessionWorkerBranchSpacer")).toHaveCount(0);

    const quickBlue = filters.locator(".sessionBucketFilter.marker-blue");
    await quickBlue.click();
    await expect(quickBlue).toHaveAttribute("aria-pressed", "true");
    await parent.locator(".sessionItemMarkerBtn").click();
    await worker.locator(".sessionItemMarkerBtn").click();
    await expect(parent).toHaveClass(/marker-blue/);
    await expect(worker).toHaveClass(/marker-blue/);
    await expect(page.locator(".sessionItem")).toHaveCount(2);
    await quickBlue.click();
    await expect(parent.locator(".sessionItemMarkerBtn")).toHaveClass(/toolPin/);
  });

  test("collapses spawned workers under their parent and reveals filtered matches", async ({ page }) => {
    await seedServerSessionUiState(page, {
      sessionOrigins: [{ sessionId: "mock-older", originSessionId: "mock-current", kind: "spawn", updatedAt: "2026-01-01T00:00:00.000Z" }],
    });
    await page.goto("/");
    await page.locator("#sessionButton").click();

    const parent = page.locator('.sessionItem[data-session-id="mock-current"]');
    const worker = page.locator('.sessionItem[data-session-id="mock-older"]');
    await expect(parent).toContainText("1 worker");
    await expect(parent.locator(".sessionWorkerBranchToggle")).toHaveAttribute("aria-expanded", "false");
    await expect(worker).toHaveCount(0);

    await parent.locator(".sessionWorkerBranchToggle").click();
    await expect(worker).toBeVisible();
    await expect(worker).toHaveClass(/sessionItemWorker/);
    await expect(page.locator(".sessionWorkerCollapseAllButton")).toBeVisible();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("pi-web-expanded-worker-branches"))).toContain("mock-current");
    await page.reload();
    await expect(worker).toBeVisible();

    await page.locator(".sessionWorkerCollapseAllButton").click();
    await expect(worker).toHaveCount(0);
    await page.locator(".sessionDrawerSearch").fill("Older mock session");
    await expect(parent).toBeVisible();
    await expect(parent).toHaveClass(/sessionItemContext/);
    await expect(worker).toBeVisible();
  });

  test("groups workers whose parent is unavailable under Unattached workers", async ({ page }) => {
    await seedServerSessionUiState(page, {
      sessionOrigins: [{ sessionId: "mock-older", originSessionId: "missing-parent", kind: "spawn", updatedAt: "2026-01-01T00:00:00.000Z" }],
    });
    await page.goto("/");
    await page.locator("#sessionButton").click();

    const group = page.locator(".sessionUnattachedWorkerGroup");
    const worker = page.locator('.sessionItem[data-session-id="mock-older"]');
    await expect(group).toContainText("Unattached workers");
    await expect(worker).toHaveCount(0);
    await group.locator(".sessionFolderToggle").click();
    await expect(worker).toBeVisible();
  });

  test("worker branches do not consume folder preview slots", async ({ page }) => {
    const cwd = "/Users/ashwin/projects/pi-web";
    const now = "2026-01-01T00:00:00.000Z";
    await seedServerSessionUiState(page, {
      sessionOrigins: [
        { sessionId: "worker-a", originSessionId: "parent-0", kind: "spawn", updatedAt: now },
        { sessionId: "worker-b", originSessionId: "parent-0", kind: "spawn", updatedAt: now },
      ],
    });
    await page.route(/\/api\/sessions(?:\?.*)?$/, (route) => route.fulfill({ json: {
      ok: true,
      sessions: [
        ...Array.from({ length: 10 }, (_, index) => ({ id: `parent-${index}`, name: `Parent ${index}`, created: now, modified: now, messageCount: 1, cwd, isCurrent: false, unread: false })),
        { id: "worker-a", name: "Worker A", created: now, modified: now, messageCount: 1, cwd, isCurrent: false, unread: false },
        { id: "worker-b", name: "Worker B", created: now, modified: now, messageCount: 1, cwd, isCurrent: false, unread: false },
      ],
    } }));

    await page.goto("/");
    await page.locator("#sessionButton").click();
    await expect(page.locator(".sessionItem")).toHaveCount(8);
    await expect(page.locator('.sessionItem[data-session-id="parent-0"]')).toContainText("2 workers");
    await expect(page.locator(".sessionFolderMoreButton")).toHaveText("Show all 10 sessions");
  });

  test("runtime changes patch one drawer branch instead of rebuilding unrelated rows", async ({ page }) => {
    await seedServerPinned(page, { id: "mock-older" });
    await page.goto("/");
    await page.locator("#sessionButton").click();
    const unaffected = page.locator('.sessionItem[data-session-id="mock-current"]');
    await unaffected.evaluate((row) => { row.dataset.renderToken = "preserved"; });

    await page.request.post("/api/mock/event", { data: {
      type: "session_runtime_changed",
      sessionId: "mock-older",
      runtime: { loaded: true, isRunning: true, isStreaming: true, isRetrying: false, isCompacting: false, pendingMessageCount: 0 },
    } });

    await expect(page.locator('.sessionItem[data-session-id="mock-older"] .sessionSpinner')).toBeVisible();
    await expect(unaffected).toHaveAttribute("data-render-token", "preserved");
  });

  test("an open drawer refreshes the session index once after a pinned run settles", async ({ page }) => {
    await seedServerPinned(page, { id: "mock-older" });
    let sessionListRequests = 0;
    await page.route(/\/api\/sessions(?:\?.*)?$/, async (route) => {
      sessionListRequests += 1;
      await route.continue();
    });
    await page.goto("/");
    await page.locator("#sessionButton").click();
    await expect(page.locator(".sessionItem")).toHaveCount(2);
    sessionListRequests = 0;

    for (let index = 0; index < 5; index += 1) {
      await page.request.post("/api/mock/event", { data: {
        type: "agent_event",
        sessionId: "mock-older",
        event: { type: "message_end", message: { role: "assistant", content: `round ${index}` } },
      } });
    }
    await page.waitForTimeout(400);
    expect(sessionListRequests).toBe(0);

    await page.request.post("/api/mock/event", { data: {
      type: "agent_event",
      sessionId: "mock-older",
      event: { type: "agent_settled" },
    } });
    await expect.poll(() => sessionListRequests).toBe(1);
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
      await page.locator("#sessionCloseButton").click({ force: true }).catch(() => undefined);
    }
    await expect(page.locator("#sessionDrawer")).toBeHidden();
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
