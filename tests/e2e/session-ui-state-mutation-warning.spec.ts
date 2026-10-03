import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
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
  let deletedId = "";
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
    expect(deletedId).toBe("mock-older");
    delivered = true;
    await route.fulfill({ response, json: { ...actual, sessionUiStateWarning: warning } });
  });

  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("/");
  await expect(page.locator("#statusTitle")).toHaveText("Current mock session");
  await page.locator("#sessionButton").click();
  const drawer = page.locator("#sessionDrawer");
  const older = drawer.locator(".sessionItem", { hasText: "Older mock session" });
  await expect(older).toBeVisible();
  await older.locator(".sessionItemActionsBtn").click();
  await page.locator(".sessionActionsMenu").getByRole("menuitem", { name: "Delete" }).click();
  await expect(older).toHaveCount(0);
  expect(delivered).toBe(true);
  await expect(page.locator("#statusTitle")).toHaveText("Current mock session");
  await expectReadOnlyChat(page, "synthetic deletion warning chat");
  expect(afterWarningMutations).toBe(0);
  const sessions = await page.request.get("/api/sessions");
  expect(sessions.ok()).toBe(true);
  expect((await sessions.json()).sessions.some((entry: { id: string }) => entry.id === deletedId)).toBe(false);
  const evidencePath = testInfo.outputPath("synthetic-delete-warning-evidence.json");
  await writeFile(evidencePath, JSON.stringify({ deletedSessionId: deletedId, activeSessionId: "mock-current", warning, assistantReply: "Mock response.", afterWarningMutations }, null, 2));
  await testInfo.attach("synthetic-delete-warning-evidence", { path: evidencePath, contentType: "application/json" });
});
