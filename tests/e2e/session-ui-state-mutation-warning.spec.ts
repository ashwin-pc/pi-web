import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { openSessionDrawerFooterAction } from "./helpers/sessionDrawer.js";
import { seedSessionUiState } from "./helpers/sessionUiState.js";

const warning = "Synthetic preferences transfer unavailable; chat remains usable.";

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
  const notice = page.locator('#sessionPreferencesWarning[role="status"]');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(warning);
  await expect(page.locator('#sessionPreferencesWarning[role="status"]')).toHaveCount(1);
  await expect(page.locator("#prompt")).toBeEnabled();
  await page.locator("#prompt").fill("synthetic clear warning chat");
  const submitted = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/prompt");
  await page.locator("#promptForm").evaluate((form: HTMLFormElement) => form.requestSubmit());
  expect((await submitted).status()).toBe(202);
  await expect(page.locator(".message.assistant", { hasText: "Mock response." }).last()).toBeVisible();
  await expect(notice).toContainText(warning);
  await openSessionDrawerFooterAction(page, "Preferences");
  await page.locator("#settingsNavBuckets").click();
  await expect(page.getByRole("textbox", { name: "Blue bucket name" })).toBeDisabled();
  await expect(page.locator(".settingsBucketDragHandle").first()).toBeDisabled();
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
