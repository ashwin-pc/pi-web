import { expect, test, type Page } from "@playwright/test";
import { seedSessionUiState } from "./helpers/sessionUiState.js";

const now = "2026-01-01T00:00:00.000Z";

async function snapshot(page: Page) {
  const response = await page.request.get("/api/session-ui-state");
  expect(response.ok()).toBe(true);
  return (await response.json()).sessionUiState as {
    revision: number;
    initialized: boolean;
    lanes: Array<{ sessionId: string; lane: string }>;
    sessionMarkers: Array<{ sessionId: string; color: string }>;
    sessionUnreadStates: Array<{ sessionId: string }>;
    bucketLabels: Record<string, string>;
  };
}

test.beforeEach(async ({ page }) => {
  const response = await page.request.post("/api/mock/reset");
  expect(response.ok()).toBe(true);
});

test("two live tabs preserve unrelated pins, markers, unread and preferences through explicit unpin and clear", async ({ page, context }) => {
  await seedSessionUiState(page, {
    lanes: [{ sessionId: "mock-current", lane: "pinned", since: now }],
    sessionMarkers: [{ sessionId: "mock-current", color: "green", updatedAt: now }],
    sessionUnreadStates: [{ sessionId: "mock-older", unreadAt: now, updatedAt: now }],
    bucketLabels: { green: "Review" },
  });
  await page.goto("/");
  const other = await context.newPage();
  await other.goto("/");
  await expect(page.locator('.sessionBarTab.pinned[data-session-id="mock-current"]')).toHaveCount(1);
  await expect(other.locator('.sessionBarTab.pinned[data-session-id="mock-current"]')).toHaveCount(1);

  // Two independently loaded tabs perform different replacement intents. Both
  // changes must survive, including server-origin unread and color preferences.
  await other.locator('.sessionBarTab[data-session-id="mock-current"]').click({ button: "right" });
  await other.locator(".sessionInspectorBuckets .marker-blue").click();
  await page.locator('.sessionBarTab[data-session-id="mock-current"] .sessionBarTabAction').click();
  await expect.poll(async () => (await snapshot(page)).lanes.some((lane) => lane.sessionId === "mock-current")).toBe(false);
  await expect.poll(async () => (await snapshot(page)).sessionMarkers.find((marker) => marker.sessionId === "mock-current")?.color).toBe("blue");
  const state = await snapshot(page);
  expect(state.sessionUnreadStates.map((entry) => entry.sessionId)).toContain("mock-older");
  expect(state.bucketLabels.green).toBe("Review");
  await expect(other.locator('.sessionBarTab.pinned[data-session-id="mock-current"]')).toHaveCount(0);
  await other.close();
});

test("a failed authoritative read cannot import browser legacy data over initialized empty state", async ({ page }) => {
  await seedSessionUiState(page, { lanes: [] });
  const before = await snapshot(page);
  expect(before.initialized).toBe(true);
  await page.addInitScript(() => {
    localStorage.setItem("pi-web-pinned-sessions", JSON.stringify([{ id: "mock-older" }]));
  });
  await page.route("**/api/session-ui-state", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ status: 503, json: { ok: false, error: "Unavailable" } });
    return route.continue();
  });
  await page.goto("/");
  await expect(page.locator("#statusTitle")).toBeVisible();
  const after = await snapshot(page);
  expect(after.revision).toBe(before.revision);
  expect(after.lanes).toEqual([]);
});
