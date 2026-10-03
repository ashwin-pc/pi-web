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
  await page.request.patch("/api/settings", { data: { defaults: { pinNewSessions: false, model: null, thinkingLevel: null } } });
  await page.goto("/");
  await expect(page.locator("#connectionStatus")).toBeHidden();
});

// Mock reset deliberately preserves global settings, so every outcome (including
// a failed assertion) must restore the suite's default preference.
test.afterEach(async ({ page }) => {
  await page.request.patch("/api/settings", { data: { defaults: { pinNewSessions: false, model: null, thinkingLevel: null } } });
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

  test("keeps a reused pinned tab empty across sequential /new commands", async ({ page }) => {
    // These are the production-shaped saved defaults that add SDK metadata to
    // an otherwise blank snapshot; the exact conversational count must still win.
    await page.request.patch("/api/settings", { data: { defaults: {
      pinNewSessions: true,
      model: { provider: "mock", id: "model" },
      thinkingLevel: "low",
    } } });
    await setPinNewSessions(page, true);
    let newPosts = 0;
    page.on("request", (request) => {
      if (request.url().endsWith("/api/sessions/new") && request.method() === "POST") newPosts += 1;
    });

    await page.locator("#prompt").fill("/new");
    await page.locator("#primaryButton").click();
    await expect.poll(() => newPosts).toBe(1);
    await expect.poll(() => activeSessionId(page)).not.toBe("mock-current");
    const reusedId = await activeSessionId(page);

    // Reload through a cold listing, then inflate the SDK-wide total while
    // preserving its exact conversational count. New must use the latter.
    await page.locator("#sessionButton").evaluate((button: HTMLButtonElement) => button.click());
    await page.locator('.sessionItem[data-session-id="mock-current"] .sessionItemNavBtn').click();
    await expect.poll(() => activeSessionId(page)).toBe("mock-current");
    await page.route("**/api/sessions**", async (route) => {
      if (new URL(route.request().url()).pathname !== "/api/sessions") return route.continue();
      const response = await route.fetch();
      const data = await response.json();
      for (const session of data.sessions || []) delete session.messageCount;
      await route.fulfill({ response, json: data });
    });
    await page.goto("/?sessionId=mock-current");
    await expect.poll(() => activeSessionId(page)).toBe("mock-current");
    await page.route("**/api/state**", async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("sessionId") !== reusedId) return route.continue();
      const response = await route.fetch();
      const data = await response.json();
      data.stats = { ...(data.stats || {}), totalMessages: (data.stats?.totalMessages || 0) + 2, conversationMessages: 0 };
      await route.fulfill({ response, json: data });
    });
    const opened = page.waitForResponse((response) => response.url().includes("/api/sessions/open") && response.request().method() === "POST" && response.ok());
    await clickHeaderNew(page);
    await opened;
    await expect.poll(() => activeSessionId(page)).toBe(reusedId);
    await page.waitForTimeout(150);
    expect(newPosts).toBe(1);
    await expect(page.locator("#messages")).toBeEmpty();
    await expect(page.locator("#emptyCwdChooser")).toBeVisible();
  });

  test("refreshes an active empty reusable tab after local help output", async ({ page }) => {
    await setPinNewSessions(page, true);
    const emptyId = await createNewSession(page);
    await page.locator("#prompt").fill("/help");
    await page.locator("#primaryButton").click();
    await expect(page.locator("#messages")).not.toBeEmpty();
    let newPosts = 0;
    page.on("request", (request) => {
      if (request.url().endsWith("/api/sessions/new") && request.method() === "POST") newPosts += 1;
    });
    const opened = page.waitForResponse((response) => response.url().endsWith("/api/sessions/open") && response.request().postDataJSON()?.sessionId === emptyId && response.ok());
    await clickHeaderNew(page);
    await opened;
    await expect.poll(() => activeSessionId(page)).toBe(emptyId);
    await expect(page.locator("#messages")).toBeEmpty();
    await expect(page.locator("#emptyCwdChooser")).toBeVisible();
    expect(newPosts).toBe(0);
  });

  test("latest tab-open intent wins over a delayed earlier open", async ({ page }) => {
    await setPinNewSessions(page, true);
    const a = await createNewSession(page);
    await page.locator("#prompt").fill("keep A draft");
    let releaseB!: () => void;
    const bOpened = new Promise<void>((resolve) => { releaseB = resolve; });
    let bRequested!: () => void;
    const bRequest = new Promise<void>((resolve) => { bRequested = resolve; });
    let aRequested!: () => void;
    const aRequest = new Promise<void>((resolve) => { aRequested = resolve; });
    await page.route("**/api/sessions/open", async (route) => {
      const id = route.request().postDataJSON()?.sessionId;
      if (id === "mock-older") {
        bRequested();
        await bOpened;
      }
      if (id === a) aRequested();
      await route.continue();
    });
    await page.locator("#sessionButton").evaluate((button: HTMLButtonElement) => button.click());
    await page.locator('.sessionItem[data-session-id="mock-older"] .sessionItemNavBtn').click();
    await bRequest;
    await expect.poll(() => activeSessionId(page)).toBe("mock-older");
    await expect(page.locator("#messages .message")).toHaveCount(0);
    await page.locator(`.sessionBarTab[data-session-id="${a}"] .sessionBarTabOpen`).evaluate((button: HTMLButtonElement) => button.click());
    await aRequest;
    const finishedB = page.waitForResponse((response) => response.url().endsWith("/api/sessions/open") && response.request().postDataJSON()?.sessionId === "mock-older");
    releaseB();
    await finishedB;
    await expect(page.locator("#prompt")).toHaveValue("keep A draft");
    await expect.poll(() => activeSessionId(page)).toBe(a);
  });

  for (const failure of ["500", "transport"] as const) {
    test(`rolls overlapping opens back to stable history after ${failure}`, async ({ page }) => {
      await setPinNewSessions(page, true);
      const c = await createNewSession(page);
      await page.request.patch("/api/session-ui-state", { data: { lanes: ["mock-current", "mock-older", c].map((sessionId) => ({ sessionId, lane: "pinned", since: "2026-01-01T00:00:00.000Z" })) } });
      await page.goto("/?sessionId=mock-current");
      await expect(page.locator("#messages")).toContainText("Can you add image attachments?");
      await page.locator("#prompt").fill("stable A draft");
      const originalUser = await page.locator(".message.user").first().textContent();
      let releaseB!: () => void;
      const gateB = new Promise<void>((resolve) => { releaseB = resolve; });
      let acceptedB!: () => void;
      const serverAcceptedB = new Promise<void>((resolve) => { acceptedB = resolve; });
      let openPosts = 0;
      let newPosts = 0;
      let latestOpenSeq = 0;
      let repairSeq = 0;
      let repairClient: string | undefined;
      page.on("request", (request) => {
        if (request.url().endsWith("/api/sessions/open")) {
          openPosts++;
          latestOpenSeq = Number(request.headers()["x-pi-web-viewer-seq"]);
        }
        if (request.url().endsWith("/api/sessions/new")) newPosts++;
        const url = new URL(request.url());
        if (url.pathname === "/api/state" && url.searchParams.get("sessionId") === "mock-current") {
          repairSeq = Number(request.headers()["x-pi-web-viewer-seq"]);
          repairClient = request.headers()["x-pi-web-client-id"];
        }
      });
      await page.route("**/api/sessions/open", async (route) => {
        const id = route.request().postDataJSON()?.sessionId;
        if (id === "mock-older") {
          // Gate the response, not the request: B already owns the server lease.
          const response = await route.fetch();
          acceptedB();
          await gateB;
          await route.fulfill({ response });
        } else if (id === c) {
          if (failure === "500") await route.fulfill({ status: 500, body: "C open failed" });
          else await route.abort("failed");
        } else await route.continue();
      });
      const clickTab = (id: string) => page.locator(`.sessionBarTab[data-session-id="${id}"] .sessionBarTabOpen`).evaluate((button: HTMLButtonElement) => button.click());
      await clickTab("mock-older");
      await serverAcceptedB;
      await expect.poll(() => activeSessionId(page)).toBe("mock-older");
      await expect(page.locator("#messages .message")).toHaveCount(0);
      await clickTab(c);
      await expect.poll(() => activeSessionId(page)).toBe("mock-current");
      await expect(page.locator(".message.user").first()).toHaveText(originalUser || "");
      await expect(page.locator("#prompt")).toHaveValue("stable A draft");
      const finishedB = page.waitForResponse((response) => response.url().endsWith("/api/sessions/open") && response.request().postDataJSON()?.sessionId === "mock-older");
      releaseB();
      await finishedB;
      // A subsequent browser task observes the completed stale-open handler.
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      await expect.poll(() => activeSessionId(page)).toBe("mock-current");
      await expect(page.locator(".message.user").first()).toHaveText(originalUser || "");
      await expect(page.locator("#prompt")).toHaveValue("stable A draft");
      expect(openPosts).toBe(2);
      expect(newPosts).toBe(0);
      expect(repairClient).toBeTruthy();
      expect(repairSeq).toBeGreaterThan(latestOpenSeq);
    });
  }

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

  test("creates a replacement when a cached empty pinned tab was deleted elsewhere", async ({ page }) => {
    await setPinNewSessions(page, true);
    const vanishedId = await createNewSession(page);
    await expectPinned(page, vanishedId);

    await page.locator("#sessionButton").evaluate((button: HTMLButtonElement) => button.click());
    await page.locator('.sessionItem[data-session-id="mock-current"] .sessionItemNavBtn').click();
    await expect.poll(() => activeSessionId(page)).toBe("mock-current");

    // Keep the listing's stale pin, but make the authoritative open report the
    // external deletion just as the production endpoint does.
    await page.route("**/api/sessions/open", async (route) => {
      if (route.request().postDataJSON()?.sessionId === vanishedId) {
        await route.fulfill({ status: 404, contentType: "text/plain", body: "Session not found" });
      } else {
        await route.continue();
      }
    });
    const created = page.waitForResponse((response) => response.url().endsWith("/api/sessions/new") && response.request().method() === "POST" && response.ok());
    await clickHeaderNew(page);
    await created;
    await expect.poll(() => activeSessionId(page)).not.toBe("mock-current");
    const replacementId = await activeSessionId(page);
    expect(replacementId).not.toBe(vanishedId);
    await expectPinned(page, replacementId);
    await expect(page.locator(`.sessionBarTab[data-session-id="${vanishedId}"]`)).toHaveCount(0);
    await expectLane(page, vanishedId, undefined);
  });

  test("does not create a replacement when opening a reusable tab fails", async ({ page }) => {
    await setPinNewSessions(page, true);
    const reusableId = await createNewSession(page);
    await page.locator("#sessionButton").evaluate((button: HTMLButtonElement) => button.click());
    await page.locator('.sessionItem[data-session-id="mock-current"] .sessionItemNavBtn').click();
    await expect.poll(() => activeSessionId(page)).toBe("mock-current");
    const originalUser = await page.locator(".message.user").first().textContent();
    const originalAssistant = await page.locator(".message.assistant").first().textContent();

    let newPosts = 0;
    page.on("request", (request) => {
      if (request.url().endsWith("/api/sessions/new") && request.method() === "POST") newPosts += 1;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/sessions/open", async (route) => {
      if (route.request().postDataJSON()?.sessionId === reusableId) {
        await gate;
        await route.fulfill({ status: 500, contentType: "text/plain", body: "Temporary failure" });
      } else {
        await route.continue();
      }
    });
    await clickHeaderNew(page);
    await expect.poll(() => activeSessionId(page)).toBe(reusableId);
    await expect(page.locator("#messages .message")).toHaveCount(0);
    release();
    await expect(page.locator("#messages")).toContainText("Temporary failure");
    await expect(page.locator(".message.user").first()).toHaveText(originalUser || "");
    await expect(page.locator(".message.assistant").first()).toHaveText(originalAssistant || "");
    expect(newPosts).toBe(0);
    await expect.poll(() => activeSessionId(page)).toBe("mock-current");
  });

  test("keeps the current transcript when reusable-tab open has a transport failure", async ({ page }) => {
    await setPinNewSessions(page, true);
    const reusableId = await createNewSession(page);
    await page.locator("#sessionButton").evaluate((button: HTMLButtonElement) => button.click());
    await page.locator('.sessionItem[data-session-id="mock-current"] .sessionItemNavBtn').click();
    const originalUser = await page.locator(".message.user").first().textContent();
    const originalAssistant = await page.locator(".message.assistant").first().textContent();
    let newPosts = 0;
    page.on("request", (request) => {
      if (request.url().endsWith("/api/sessions/new") && request.method() === "POST") newPosts += 1;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/sessions/open", async (route) => {
      if (route.request().postDataJSON()?.sessionId === reusableId) { await gate; await route.abort("failed"); }
      else await route.continue();
    });
    await page.route("**/api/messages?sessionId=mock-current", (route) => route.abort("failed"));

    await clickHeaderNew(page);
    await expect.poll(() => activeSessionId(page)).toBe(reusableId);
    await expect(page.locator("#messages .message")).toHaveCount(0);
    release();
    await expect.poll(() => activeSessionId(page)).toBe("mock-current");
    await expect(page.locator(".message.user").first()).toHaveText(originalUser || "");
    await expect(page.locator(".message.assistant").first()).toHaveText(originalAssistant || "");
    expect(newPosts).toBe(0);
  });

  test("restores local history and the viewer lease after accepted open hydration fails", async ({ page }) => {
    await setPinNewSessions(page, true);
    const reusableId = await createNewSession(page);
    await page.locator("#sessionButton").evaluate((button: HTMLButtonElement) => button.click());
    await page.locator('.sessionItem[data-session-id="mock-current"] .sessionItemNavBtn').click();
    await expect(page.locator("#messages")).toContainText("Can you add image attachments?");
    const originalUser = await page.locator(".message.user").first().textContent();
    let repairClient: string | undefined;
    let openPosts = 0;
    page.on("request", (request) => {
      if (request.url().endsWith("/api/sessions/open")) openPosts++;
      const url = new URL(request.url());
      if (url.pathname === "/api/state" && url.searchParams.get("sessionId") === "mock-current") repairClient = request.headers()["x-pi-web-client-id"];
    });
    await page.route(`**/api/messages?sessionId=${reusableId}`, (route) => route.fulfill({ status: 500, body: "Hydration failed" }));
    await clickHeaderNew(page);
    await expect(page.locator("#messages")).toContainText("Hydration failed");
    await expect.poll(() => activeSessionId(page)).toBe("mock-current");
    await expect(page.locator(".message.user").first()).toHaveText(originalUser || "");
    expect(repairClient).toBeTruthy();
    expect(openPosts).toBe(1);
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
