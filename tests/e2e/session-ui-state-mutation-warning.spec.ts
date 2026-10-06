import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { openSessionDrawerFooterAction } from "./helpers/sessionDrawer.js";
import { seedSessionUiState } from "./helpers/sessionUiState.js";

const warning = "Synthetic preferences transfer unavailable; chat remains usable.";

async function expectReadOnlyChat(page: Page, prompt: string) {
  const notice = page.locator('#sessionPreferencesWarning[role="status"]');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(warning);
  await expect(notice).toHaveCount(1);
  await expect(page.locator("#prompt")).toBeEnabled();
  await page.locator("#prompt").fill(prompt);
  const submitted = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/prompt");
  await page.locator("#promptForm").evaluate((form: HTMLFormElement) => form.requestSubmit());
  expect((await submitted).status()).toBe(202);
  await expect(page.locator(".message.assistant", { hasText: "Mock response." }).last()).toBeVisible();
  await expect(notice).toContainText(warning);
  await openSessionDrawerFooterAction(page, "Preferences");
  await page.locator("#settingsNavBuckets").click();
  await expect(page.getByRole("textbox", { name: "Blue bucket name" })).toBeDisabled();
  await expect(page.locator(".settingsBucketDragHandle").first()).toBeDisabled();
}

// A synthetic warning is added to an otherwise successful real mock /clear.
// This is not a disk-fault test: the backend transfer actually succeeds.
test("successful clear with metadata warning keeps the new chat usable and makes preferences read-only", async ({ page }, testInfo) => {
  expect((await page.request.post("/api/mock/reset")).ok()).toBe(true);
  await seedSessionUiState(page, { lanes: [{ sessionId: "mock-current", lane: "pinned", since: "2026-01-01T00:00:00.000Z" }] });
  let afterWarningMutations = 0;
  let deliveredNewSessionId = "";
  let deliveredCommand = 0;
  await page.route("**/api/session-ui-state**", async (route) => {
    if (deliveredCommand && route.request().method() !== "GET") afterWarningMutations += 1;
    await route.continue();
  });
  await page.route("**/api/command", async (route) => {
    const request = route.request().postDataJSON() as { command?: string };
    if (request.command !== "/clear") return route.continue();
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    const actual = await response.json();
    expect(actual.ok).toBe(true);
    expect(actual.state?.sessionId).toEqual(expect.any(String));
    expect(actual.state.sessionId).not.toBe("mock-current");
    deliveredNewSessionId = actual.state.sessionId;
    const { sessionUiState: _omitted, ...state } = actual.state;
    deliveredCommand += 1;
    await route.fulfill({ response, json: { ...actual, state, sessionUiStateWarning: warning } });
  });

  await page.goto("/");
  await expect(page.locator("#statusTitle")).toHaveText("Current mock session");
  await expect(page.locator("#sessionPreferencesWarning")).toBeHidden();
  await page.locator("#prompt").fill("/clear");
  await page.locator("#primaryButton").click();
  await expect(page.locator("#statusTitle")).toHaveText("New session");
  expect(deliveredCommand).toBe(1);
  await expect.poll(() => new URL(page.url()).searchParams.get("sessionId")).toBe(deliveredNewSessionId);
  await expectReadOnlyChat(page, "synthetic clear warning chat");
  expect(afterWarningMutations).toBe(0);

  const serverState = await page.request.get("/api/session-ui-state");
  expect(serverState.ok()).toBe(true);
  const data = (await serverState.json()).sessionUiState;
  expect(data.lanes.some((lane: { sessionId: string }) => lane.sessionId === deliveredNewSessionId)).toBe(true);
  const evidencePath = testInfo.outputPath("synthetic-clear-warning-evidence.json");
  await writeFile(evidencePath, JSON.stringify({
    newSessionId: deliveredNewSessionId, warning, assistantReply: "Mock response.",
    afterWarningMutations, transferPersisted: true,
  }, null, 2));
  await testInfo.attach("synthetic-clear-warning-evidence", { path: evidencePath, contentType: "application/json" });
});

test("successful new session warns and stays read-only even when pin-new is disabled", async ({ page }, testInfo) => {
  expect((await page.request.post("/api/mock/reset")).ok()).toBe(true);
  expect((await page.request.patch("/api/settings", { data: { defaults: { pinNewSessions: false } } })).ok()).toBe(true);
  let newId = "";
  let afterWarningMutations = 0;
  let delivered = false;
  await page.route("**/api/session-ui-state**", async (route) => {
    if (delivered && route.request().method() !== "GET") afterWarningMutations += 1;
    await route.continue();
  });
  await page.route("**/api/sessions/new", async (route) => {
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    const actual = await response.json();
    expect(actual.ok).toBe(true);
    newId = actual.sessionId;
    expect(newId).toEqual(expect.any(String));
    expect(newId).not.toBe("mock-current");
    const { sessionUiState: _omitted, ...state } = actual;
    delivered = true;
    await route.fulfill({ response, json: { ...state, sessionUiStateWarning: warning } });
  });

  await page.goto("/");
  await expect(page.locator("#statusTitle")).toHaveText("Current mock session");
  await page.locator("#newSessionHeaderButton").evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.locator("#statusTitle")).toHaveText("New session");
  expect(delivered).toBe(true);
  await expect.poll(() => new URL(page.url()).searchParams.get("sessionId")).toBe(newId);
  await expectReadOnlyChat(page, "synthetic new-session warning chat");
  expect(afterWarningMutations).toBe(0);
  const created = await page.request.get(`/api/state?sessionId=${encodeURIComponent(newId)}`);
  expect(created.ok()).toBe(true);
  expect((await created.json()).sessionId).toBe(newId);
  const evidencePath = testInfo.outputPath("synthetic-new-warning-evidence.json");
  await writeFile(evidencePath, JSON.stringify({ newSessionId: newId, warning, assistantReply: "Mock response.", afterWarningMutations }, null, 2));
  await testInfo.attach("synthetic-new-warning-evidence", { path: evidencePath, contentType: "application/json" });
});

test("successful new session with pin-new enabled cannot invent a local pin after warning", async ({ page }, testInfo) => {
  expect((await page.request.post("/api/mock/reset")).ok()).toBe(true);
  expect((await page.request.patch("/api/settings", { data: { defaults: { pinNewSessions: true } } })).ok()).toBe(true);
  await seedSessionUiState(page, { lanes: [{ sessionId: "mock-current", lane: "pinned", since: "2026-01-01T00:00:00.000Z" }] });
  let newId = "";
  let afterWarningMutations = 0;
  let delivered = false;
  await page.route("**/api/session-ui-state**", async (route) => {
    if (delivered && route.request().method() !== "GET") afterWarningMutations += 1;
    await route.continue();
  });
  await page.route("**/api/sessions/new", async (route) => {
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    const actual = await response.json();
    expect(actual.ok).toBe(true);
    newId = actual.sessionId;
    expect(newId).toEqual(expect.any(String));
    expect(newId).not.toBe("mock-current");
    const { sessionUiState: _omitted, ...state } = actual;
    delivered = true;
    await route.fulfill({ response, json: { ...state, sessionUiStateWarning: warning } });
  });

  await page.goto("/");
  await expect(page.locator('.sessionBarTab.pinned[data-session-id="mock-current"]')).toBeVisible();
  await page.locator("#newSessionHeaderButton").evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.locator("#statusTitle")).toHaveText("New session");
  expect(delivered).toBe(true); // A genuine new session, not an empty-tab reuse.
  await expect.poll(() => new URL(page.url()).searchParams.get("sessionId")).toBe(newId);
  await expect(page.locator(`.sessionBarTab.pinned[data-session-id="${newId}"]`)).toHaveCount(0);
  await expect(page.locator('.sessionBarTab.pinned[data-session-id="mock-current"]')).toHaveCount(1);
  await expectReadOnlyChat(page, "synthetic pin-new warning chat");
  expect(afterWarningMutations).toBe(0);
  const serverState = await page.request.get("/api/session-ui-state");
  expect(serverState.ok()).toBe(true);
  const pins = (await serverState.json()).sessionUiState.lanes.filter((lane: { lane: string }) => lane.lane === "pinned")
    .map((lane: { sessionId: string }) => lane.sessionId);
  expect(pins).toEqual(["mock-current"]);
  const created = await page.request.get(`/api/state?sessionId=${encodeURIComponent(newId)}`);
  expect(created.ok()).toBe(true);
  expect((await created.json()).sessionId).toBe(newId);
  const evidencePath = testInfo.outputPath("synthetic-pin-new-warning-evidence.json");
  await writeFile(evidencePath, JSON.stringify({ newSessionId: newId, warning, assistantReply: "Mock response.", cachedPinned: ["mock-current"], afterWarningMutations }, null, 2));
  await testInfo.attach("synthetic-pin-new-warning-evidence", { path: evidencePath, contentType: "application/json" });
});

test("successful deletion warns and stays read-only while the active chat remains usable", async ({ page }, testInfo) => {
  expect((await page.request.post("/api/mock/reset")).ok()).toBe(true);
  const created = await page.request.post("/api/sessions/new", { data: {} });
  expect(created.ok()).toBe(true);
  const olderId = (await created.json()).sessionId as string;
  expect(olderId).toEqual(expect.any(String));
  expect(olderId).not.toBe("mock-current");
  expect((await page.request.post("/api/sessions/open", { data: { sessionId: "mock-current" } })).ok()).toBe(true);
  await seedSessionUiState(page, { lanes: [
    { sessionId: olderId, lane: "pinned", since: "2026-01-01T00:00:00.000Z" },
    { sessionId: "mock-current", lane: "pinned", since: "2026-01-02T00:00:00.000Z" },
  ] });
  const initialSessions = await page.request.get("/api/sessions");
  expect(initialSessions.ok()).toBe(true);
  expect((await initialSessions.json()).sessions.map((entry: { id: string }) => entry.id)).toContain(olderId);
  // /mock/reset can retain duplicate mock index rows across projects on one server.
  // Preserve real index entries, presenting each ID once to the browser fixture.
  await page.route((url) => url.pathname === "/api/sessions", async (route) => {
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    const actual = await response.json();
    const seen = new Set<string>();
    await route.fulfill({ response, json: { ...actual, sessions: actual.sessions.filter((entry: { id: string }) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    }) } });
  });
  let deletedId = "";
  let cleanupObserved = false;
  let afterWarningMutations = 0;
  let delivered = false;
  await page.route("**/api/session-ui-state**", async (route) => {
    if (delivered && route.request().method() !== "GET") afterWarningMutations += 1;
    await route.continue();
  });
  await page.route("**/api/sessions/delete", async (route) => {
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    const actual = await response.json();
    expect(actual.ok).toBe(true);
    deletedId = actual.id;
    expect(deletedId).toBe(olderId);
    const cleaned = await page.request.get("/api/session-ui-state");
    expect(cleaned.ok()).toBe(true);
    expect((await cleaned.json()).sessionUiState.lanes.some((lane: { sessionId: string }) => lane.sessionId === deletedId)).toBe(false);
    cleanupObserved = true;
    // Controlled stale canonical fixture: reinstate the deleted ID via real CAS after
    // healthy cleanup, before delivering the warning. This is NOT a disk-fault claim.
    await seedSessionUiState(page, { lanes: [
      { sessionId: deletedId, lane: "pinned", since: "2026-01-01T00:00:00.000Z" },
      { sessionId: "mock-current", lane: "pinned", since: "2026-01-02T00:00:00.000Z" },
    ] });
    delivered = true;
    await route.fulfill({ response, json: { ...actual, sessionUiStateWarning: warning } });
  });

  page.on("dialog", (dialog) => dialog.accept());
  const listed = page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/sessions");
  await page.goto("/");
  const browserSessions = await (await listed).json();
  expect(browserSessions.sessions.map((entry: { id: string }) => entry.id)).toContain(olderId);
  await expect(page.locator("#statusTitle")).toHaveText("Current mock session");
  await expect(page.locator(`.sessionBarTab.pinned[data-session-id="${olderId}"]`)).toBeVisible();
  await expect(page.locator('.sessionBarTab.pinned[data-session-id="mock-current"]')).toBeVisible();
  await page.reload();
  await expect(page.locator(`.sessionBarTab.pinned[data-session-id="${olderId}"]`)).toBeVisible();
  await page.locator("#sessionButton").click();
  const drawer = page.locator("#sessionDrawer");
  const older = drawer.locator(`.sessionItem[data-session-id="${olderId}"]`);
  await expect(older).toBeVisible();
  await older.locator(".sessionItemActionsBtn").click();
  await page.locator(".sessionActionsMenu").getByRole("menuitem", { name: "Delete" }).click();
  await expect(older).toHaveCount(0);
  // session_deleted can remove the row before the intercepted delete response
  // finishes reinstating the stale fixture and delivering its warning.
  await expect.poll(() => delivered).toBe(true);
  expect(cleanupObserved).toBe(true);
  await expect(page.locator(`.sessionBarTab[data-session-id="${olderId}"]`)).toHaveCount(0);
  await expect(page.locator('.sessionBarTab.pinned[data-session-id="mock-current"]')).toBeVisible();
  await expect(page.locator("#statusTitle")).toHaveText("Current mock session");
  await expectReadOnlyChat(page, "synthetic deletion warning chat");
  await page.locator("#settingsCloseButton").click();
  await page.locator("#sessionButton").click();
  await expect(drawer.locator(`.sessionItem[data-session-id="${olderId}"]`)).toHaveCount(0);
  await expect(page.locator(`.sessionBarTab[data-session-id="${olderId}"]`)).toHaveCount(0);
  await expect(page.locator('.sessionBarTab.pinned[data-session-id="mock-current"]')).toBeVisible();
  await drawer.getByRole("button", { name: "Close sessions" }).click();
  await expect(drawer).toBeHidden();
  await page.locator(".sessionLayersButton").click();
  await expect(page.locator(`.sessionLaneDrawerCard[data-session-id="${olderId}"]`)).toHaveCount(0);
  await expect(page.locator('.sessionLaneDrawerCard[data-session-id="mock-current"]')).toBeVisible();
  await page.keyboard.press("Escape");
  expect(afterWarningMutations).toBe(0);
  const sessions = await page.request.get("/api/sessions");
  expect(sessions.ok()).toBe(true);
  const sessionIds = (await sessions.json()).sessions.map((entry: { id: string }) => entry.id);
  expect(sessionIds).not.toContain(deletedId);
  expect(sessionIds).toContain("mock-current");
  const serverState = await page.request.get("/api/session-ui-state");
  expect(serverState.ok()).toBe(true);
  const pinned = (await serverState.json()).sessionUiState.lanes.filter((lane: { lane: string }) => lane.lane === "pinned")
    .map((lane: { sessionId: string }) => lane.sessionId);
  expect(pinned).toContain(deletedId); // Only the controlled stale canonical fixture retains metadata.
  expect(pinned).toContain("mock-current");
  const evidencePath = testInfo.outputPath("synthetic-delete-warning-evidence.json");
  await writeFile(evidencePath, JSON.stringify({ deletedSessionId: deletedId, activeSessionId: "mock-current", cleanupObserved, sessionIds, staleCanonicalPinned: pinned, warning, assistantReply: "Mock response.", afterWarningMutations }, null, 2));
  await testInfo.attach("synthetic-delete-warning-evidence", { path: evidencePath, contentType: "application/json" });
});

test("successful cwd replacement warns while the new chat stays usable and preferences become read-only", async ({ page }, testInfo) => {
  expect((await page.request.post("/api/mock/reset")).ok()).toBe(true);
  const cwd = testInfo.outputPath("cwd-replacement");
  await mkdir(cwd, { recursive: true });
  let replacementId = "";
  let previousId = "";
  let afterWarningMutations = 0;
  let delivered = false;
  await page.route("**/api/session-ui-state**", async (route) => {
    if (delivered && route.request().method() !== "GET") afterWarningMutations += 1;
    await route.continue();
  });
  await page.route("**/api/session/cwd", async (route) => {
    const request = route.request().postDataJSON() as { cwd?: string; sessionId?: string };
    expect(request.cwd).toBe(cwd);
    expect(request.sessionId).toBe(previousId);
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    const actual = await response.json();
    expect(actual.ok).toBe(true);
    expect(actual.sessionId).toEqual(expect.any(String));
    expect(actual.sessionId).not.toBe(previousId);
    // The mock factory uses its fixed cwd; only the requested path and genuinely new ID are under test.
    expect(actual.cwd).toEqual(expect.any(String));
    replacementId = actual.sessionId;
    const { sessionUiState: _omitted, ...state } = actual;
    delivered = true;
    await route.fulfill({ response, json: { ...state, sessionUiStateWarning: warning } });
  });

  await page.goto("/");
  await expect(page.locator("#statusTitle")).toHaveText("Current mock session");
  await page.locator("#prompt").fill("/clear");
  await page.locator("#primaryButton").click();
  await expect(page.locator("#statusTitle")).toHaveText("New session");
  previousId = new URL(page.url()).searchParams.get("sessionId") || "";
  expect(previousId).toEqual(expect.any(String));
  expect(previousId).not.toBe("");
  expect(previousId).not.toBe("mock-current");
  await page.getByRole("button", { name: "Change working directory" }).click();
  await page.getByRole("button", { name: "Browse folders" }).click();
  await page.getByRole("button", { name: "Edit folder path" }).click();
  await page.getByRole("textbox", { name: "Folder path" }).fill(cwd);
  await page.getByRole("textbox", { name: "Folder path" }).press("Enter");
  const cwdResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/session/cwd");
  await page.getByRole("button", { name: `Use ${cwd}` }).click();
  expect((await cwdResponse).ok()).toBe(true);
  expect(delivered).toBe(true);
  await expect.poll(() => new URL(page.url()).searchParams.get("sessionId")).toBe(replacementId);
  await expect(page.locator("#statusTitle")).toHaveText("New session");
  await expectReadOnlyChat(page, "synthetic cwd replacement warning chat");
  expect(afterWarningMutations).toBe(0);
  const serverState = await page.request.get(`/api/state?sessionId=${encodeURIComponent(replacementId)}`);
  expect(serverState.ok()).toBe(true);
  const actualState = await serverState.json();
  expect(actualState.sessionId).toBe(replacementId);
  expect(actualState.cwd).toEqual(expect.any(String));
  const evidencePath = testInfo.outputPath("synthetic-cwd-warning-evidence.json");
  await writeFile(evidencePath, JSON.stringify({ previousId, replacementId, requestedCwd: cwd, actualMockCwd: actualState.cwd, warning, assistantReply: "Mock response.", afterWarningMutations }, null, 2));
  await testInfo.attach("synthetic-cwd-warning-evidence", { path: evidencePath, contentType: "application/json" });
});
