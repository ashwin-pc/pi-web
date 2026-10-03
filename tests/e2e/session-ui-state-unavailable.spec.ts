import { expect, test } from "@playwright/test";
import { openSessionDrawerFooterAction } from "./helpers/sessionDrawer.js";
import { seedSessionUiState } from "./helpers/sessionUiState.js";

const warning = "Session preferences are unavailable. Chat remains available; preferences are read-only until storage is repaired.";

// This is a routed availability simulation against healthy mock storage. The
// actual corrupt-file/recovery behavior is covered by server API tests.
test("unavailable preferences are read-only while the mock conversation remains usable", async ({ page }, testInfo) => {
  expect((await page.request.post("/api/mock/reset")).ok()).toBe(true);
  await seedSessionUiState(page, { bucketLabels: { blue: "Synthetic saved label" } });
  const beforeResponse = await page.request.get("/api/session-ui-state");
  expect(beforeResponse.ok()).toBe(true);
  const before = (await beforeResponse.json()).sessionUiState;

  // A legacy browser seed must never become an initialization attempt after a
  // trusted unavailability marker, even if a cached view remains visible.
  await page.addInitScript(() => {
    localStorage.setItem("pi-web-pinned-sessions", JSON.stringify([{ id: "mock-older" }]));
  });
  let uiGets = 0;
  let uiMutations = 0;
  let stateMarkers = 0;
  let listMarkers = 0;
  await page.route("**/api/session-ui-state**", async (route) => {
    if (route.request().method() === "GET") uiGets += 1;
    else uiMutations += 1;
    await route.fulfill({ status: 503, json: { ok: false, error: "Synthetic preferences unavailable" } });
  });
  await page.route(/\/api\/(?:state|sessions)(?:\?.*)?$/, async (route) => {
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    const { sessionUiState: _omitted, ...actual } = await response.json();
    if (new URL(route.request().url()).pathname === "/api/state") stateMarkers += 1;
    else listMarkers += 1;
    await route.fulfill({ response, json: { ...actual, sessionUiStateAvailability: "unavailable", sessionUiStateWarning: warning } });
  });

  await page.goto("/");
  const notice = page.locator('#sessionPreferencesWarning[role="status"]');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(warning);
  await expect(page.locator('#sessionPreferencesWarning[role="status"]')).toHaveCount(1);
  await expect(page.locator("#messages")).toContainText("Resumed older session.");
  await expect(page.locator("#prompt")).toBeEnabled();
  await page.locator("#prompt").fill("synthetic availability chat");
  const submitted = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/prompt");
  await page.locator("#promptForm").evaluate((form: HTMLFormElement) => form.requestSubmit());
  expect((await submitted).status()).toBe(202);
  await expect(page.locator(".message.assistant", { hasText: "Mock response." }).last()).toBeVisible();
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(warning);
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const warningRect = await notice.boundingBox();
  const promptRect = await page.locator("#prompt").boundingBox();
  for (const [name, rect] of [["warning", warningRect], ["prompt", promptRect]] as const) {
    expect(rect, `${name} must have a layout box`).not.toBeNull();
    expect(rect!.width, `${name} width`).toBeGreaterThan(0);
    expect(rect!.height, `${name} height`).toBeGreaterThan(0);
    expect(rect!.x, `${name} left`).toBeGreaterThanOrEqual(0);
    expect(rect!.y, `${name} top`).toBeGreaterThanOrEqual(0);
    expect(rect!.x + rect!.width, `${name} right`).toBeLessThanOrEqual(viewport!.width + 1);
    expect(rect!.y + rect!.height, `${name} bottom`).toBeLessThanOrEqual(viewport!.height + 1);
  }
  await expect(page.locator("#prompt")).toBeEnabled();
  expect(stateMarkers).toBeGreaterThan(0);
  expect(uiGets).toBe(0);
  expect(uiMutations).toBe(0);

  // Capture real rendered UI with synthetic mock data; the banner and replied
  // conversation remain visible together, before navigating into Settings.
  if (testInfo.project.name === "desktop") {
    await page.screenshot({ path: testInfo.outputPath("availability-chat.png"), fullPage: true });
  }

  await openSessionDrawerFooterAction(page, "Preferences");
  await page.locator("#settingsNavBuckets").click();
  await expect(page.getByRole("textbox", { name: "Blue bucket name" })).toBeDisabled();
  await expect(page.locator(".settingsBucketDragHandle").first()).toBeDisabled();
  await expect(notice).toBeVisible();
  expect(listMarkers).toBeGreaterThan(0);
  expect(uiGets).toBe(0);
  expect(uiMutations).toBe(0);
  const afterResponse = await page.request.get("/api/session-ui-state");
  expect(afterResponse.ok()).toBe(true);
  const after = (await afterResponse.json()).sessionUiState;
  expect(after.bucketLabels).toEqual(before.bucketLabels);
  expect(after.lanes).toEqual(before.lanes);
});
