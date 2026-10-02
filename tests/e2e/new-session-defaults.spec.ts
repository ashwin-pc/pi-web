import { expect, test, type Page } from "@playwright/test";
import { openLauncherAction } from "./helpers/actionLauncher.js";

async function activeSessionId(page: Page) {
  const tab = page.locator(".sessionBarTab.active");
  await expect(tab).toHaveCount(1);
  const id = await tab.getAttribute("data-session-id");
  if (!id) throw new Error("The active session tab has no session id");
  return id;
}

/** Header New is deliberately invoked through the DOM: it is visually hidden on compact layouts. */
async function clickHeaderNew(page: Page) {
  await page.locator("#newSessionHeaderButton").evaluate((button: HTMLButtonElement) => button.click());
}

async function createNewSession(page: Page) {
  const before = await activeSessionId(page);
  const created = page.waitForResponse((response) => response.url().endsWith("/api/sessions/new") && response.request().method() === "POST" && response.ok());
  await clickHeaderNew(page);
  await created;
  await expect.poll(() => activeSessionId(page)).not.toBe(before);
  return activeSessionId(page);
}

async function reuseInactiveSession(page: Page, id: string) {
  const opened = page.waitForResponse((response) => response.url().endsWith("/api/sessions/open") && response.request().method() === "POST" && response.ok());
  await clickHeaderNew(page);
  await opened;
  await expect.poll(() => activeSessionId(page)).toBe(id);
}

async function openNewSessionSettings(page: Page) {
  await page.locator("#settingsButton").evaluate((button: HTMLButtonElement) => button.click());
  await page.locator("#settingsNavNewSessions").evaluate((button: HTMLButtonElement) => button.click());
  const checkbox = page.locator("#settingPinNewSessionsCheckbox");
  await expect(checkbox).toBeVisible();
  return checkbox;
}

async function setPinNewSessions(page: Page, enabled: boolean) {
  const checkbox = await openNewSessionSettings(page);
  if (await checkbox.isChecked() !== enabled) {
    const saved = page.waitForResponse((response) => response.url().endsWith("/api/settings") && response.request().method() === "PATCH" && response.ok());
    await checkbox.click();
    await saved;
  }
  await expect(checkbox).toBeChecked({ checked: enabled });
  await page.locator("#settingsCloseButton").evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.locator("#settingsPanel")).toBeHidden();
}

async function expectPinned(page: Page, sessionId: string, pinned = true) {
  const tab = page.locator(`.sessionBarTab[data-session-id="${sessionId}"]`);
  if (pinned) await expect(tab).toHaveClass(/\bpinned\b/);
  else await expect(tab).not.toHaveClass(/\bpinned\b/);
}

async function expectLane(page: Page, sessionId: string, lane: "pinned" | undefined) {
  await expect.poll(async () => {
    const value = await (await page.request.get("/api/session-ui-state")).json();
    return value.sessionUiState.lanes.find((entry: { sessionId: string }) => entry.sessionId === sessionId)?.lane;
  }).toBe(lane);
}

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
  await page.request.patch("/api/settings", { data: { defaults: { pinNewSessions: false } } });
  await page.goto("/");
  await expect(page.locator("#connectionStatus")).toBeHidden();
});

// Mock reset deliberately preserves global settings, so every outcome (including
// a failed assertion) must restore the suite's default preference.
test.afterEach(async ({ page }) => {
  await page.request.patch("/api/settings", { data: { defaults: { pinNewSessions: false } } });
});

test.describe("new-session defaults", () => {
  test("persists the opt-in preference and pins only newly created sessions", async ({ page }) => {
    await setPinNewSessions(page, true);
    await page.reload();
    await expect(await openNewSessionSettings(page)).toBeChecked();
    await page.locator("#settingsCloseButton").evaluate((button: HTMLButtonElement) => button.click());

    const pinnedId = await createNewSession(page);
    await expectPinned(page, pinnedId);
    await page.locator("#prompt").fill("leave the pinned tab nonempty");
    await page.locator("#primaryButton").click();
    await expect(page.locator(".message.user")).toContainText("leave the pinned tab nonempty");

    await setPinNewSessions(page, false);
    const unpinnedId = await createNewSession(page);
    await expectPinned(page, unpinnedId, false);
    await expectPinned(page, pinnedId);
  });

  test("coalesces a rapid mixed New burst and reuses an inactive empty pinned tab", async ({ page }) => {
    await setPinNewSessions(page, true);
    let release!: () => void;
    let firstRequest!: () => void;
    const firstSeen = new Promise<void>((resolve) => { firstRequest = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let newPosts = 0;
    await page.route("**/api/sessions/new", async (route) => {
      newPosts += 1;
      if (newPosts === 1) { firstRequest(); await gate; }
      await route.continue();
    });

    await clickHeaderNew(page);
    await firstSeen;
    await page.locator("#prompt").focus();
    await page.keyboard.press("Control+Shift+O");
    await openLauncherAction(page, "New session");
    await page.locator("#prompt").fill("/new");
    await page.locator("#primaryButton").click();
    release();

    await expect.poll(() => newPosts).toBe(1);
    await expect.poll(() => activeSessionId(page)).not.toBe("mock-current");
    const emptyId = await activeSessionId(page);
    await expectPinned(page, emptyId);

    // Switch through the drawer because mock-current is unpinned and therefore
    // absent from the quick bar after the created tab is pinned.
    await page.locator("#sessionButton").evaluate((button: HTMLButtonElement) => button.click());
    await page.locator('.sessionItem[data-session-id="mock-current"] .sessionItemNavBtn').click();
    await expect(page.locator("#statusTitle")).toHaveText("Current mock session");
    await reuseInactiveSession(page, emptyId);
  });

  test("keeps working tabs pinned while an empty latest tab is reused until explicitly unpinned", async ({ page }) => {
    await setPinNewSessions(page, true);
    const a = await createNewSession(page);
    await page.locator("#prompt").fill("A is now work in progress");
    await page.locator("#primaryButton").click();
    await expect(page.locator(".message.user")).toContainText("A is now work in progress");

    const b = await createNewSession(page);
    await expectPinned(page, a);
    await expectPinned(page, b);

    // Let the restored state/connection settle before proving empty B reuses
    // without another create request.
    await page.reload();
    await expect(page.locator("#connectionStatus")).toBeHidden();
    await expect.poll(() => activeSessionId(page)).toBe(b);
    let newPosts = 0;
    page.on("request", (request) => {
      if (request.url().endsWith("/api/sessions/new") && request.method() === "POST") newPosts += 1;
    });
    await clickHeaderNew(page);
    await expect.poll(() => activeSessionId(page)).toBe(b);
    await page.waitForTimeout(150);
    expect(newPosts).toBe(0);

    await page.locator(`.sessionBarTab[data-session-id="${b}"] .sessionBarTabAction`).click();
    await expectPinned(page, b, false);
    await page.locator("#prompt").fill("B is deliberately unpinned work");
    await page.locator("#primaryButton").click();
    await expect(page.locator(".message.user")).toContainText("B is deliberately unpinned work");

    const c = await createNewSession(page);
    await expectPinned(page, a);
    await expectLane(page, b, undefined);
    await expectPinned(page, c);
  });

  test("hydrates a cold pinned empty tab in the background before opening it", async ({ page }) => {
    await setPinNewSessions(page, true);
    const b = await createNewSession(page);
    await expectPinned(page, b);

    await page.locator("#sessionButton").evaluate((button: HTMLButtonElement) => button.click());
    await page.locator('.sessionItem[data-session-id="mock-current"] .sessionItemNavBtn').click();
    await expect.poll(() => activeSessionId(page)).toBe("mock-current");

    // Simulate a shallow/cold session listing that does not expose messageCount.
    await page.route("**/api/sessions**", async (route) => {
      if (new URL(route.request().url()).pathname !== "/api/sessions") return route.continue();
      const response = await route.fetch();
      const data = await response.json();
      for (const session of data.sessions || []) delete session.messageCount;
      await route.fulfill({ response, json: data });
    });
    // Session switching does not replace the URL; reload the selected session's
    // canonical URL to exercise cold startup with mock-current active.
    await page.goto("/?sessionId=mock-current");
    await expect.poll(() => activeSessionId(page)).toBe("mock-current");

    let stateReadClientId: string | undefined;
    let activeWhenRead: string | undefined;
    let resolveColdStateRead!: () => void;
    const coldStateRead = new Promise<void>((resolve) => { resolveColdStateRead = resolve; });
    await page.route("**/api/state**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === "GET" && url.searchParams.get("sessionId") === b) {
        stateReadClientId = request.headers()["x-pi-web-client-id"];
        activeWhenRead = await activeSessionId(page);
        resolveColdStateRead();
      }
      await route.continue();
    });
    const opened = page.waitForResponse((response) => response.url().includes("/api/sessions/open") && response.request().method() === "POST" && response.ok());
    let newPosts = 0;
    page.on("request", (request) => {
      if (request.url().endsWith("/api/sessions/new") && request.method() === "POST") newPosts += 1;
    });

    await clickHeaderNew(page);
    await coldStateRead;
    expect(activeWhenRead).toBe("mock-current");
    expect(stateReadClientId).toBeUndefined();
    await opened;
    await expect.poll(() => activeSessionId(page)).toBe(b);
    expect(newPosts).toBe(0);
  });

  test("drafts and worker/parked tabs are not reused; explicit unpin stays unpinned", async ({ page }) => {
    await setPinNewSessions(page, true);
    const firstId = await createNewSession(page);
    await page.locator("#prompt").fill("keep this draft");
    const draftSafeId = await createNewSession(page);
    await page.locator(`.sessionBarTab[data-session-id="${firstId}"]`).click();
    await expect(page.locator("#prompt")).toHaveValue("keep this draft");

    // A parked empty tab and an empty worker are both excluded candidates.
    await page.request.patch("/api/session-ui-state", { data: {
      lanes: [{ sessionId: draftSafeId, lane: "parked", since: "2026-01-01T00:00:00.000Z" }],
      sessionOrigins: [{ sessionId: firstId, originSessionId: "mock-current", kind: "spawn", updatedAt: "2026-01-01T00:00:00.000Z" }],
    } });
    await page.reload();
    const replacementId = await createNewSession(page);
    expect(replacementId).not.toBe(draftSafeId);
    expect(replacementId).not.toBe(firstId);

    await page.locator(`.sessionBarTab[data-session-id="${replacementId}"] .sessionBarTabAction`).click();
    await expectPinned(page, replacementId, false);
    await expect.poll(() => activeSessionId(page)).toBe(replacementId);
    await clickHeaderNew(page);
    await expect.poll(() => activeSessionId(page)).toBe(replacementId);
    await expectPinned(page, replacementId, false);
  });
});
