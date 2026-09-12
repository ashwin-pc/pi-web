import { expect, test, type Page } from "@playwright/test";

const now = "2026-01-01T00:00:00.000Z";
const runtime = (isRunning: boolean, pendingMessageCount = 0) => ({
  loaded: true, isRunning, isStreaming: isRunning, isRetrying: false, isCompacting: false, pendingMessageCount,
});

async function resetMinimal(page: Page) {
  await page.request.post("/api/mock/reset");
  await page.waitForTimeout(50);
  await page.request.patch("/api/settings", { data: { appearance: { density: "minimal" } } });
  await page.route("**/api/settings", route => route.request().method() === "GET"
    ? route.fulfill({ json: { settings: { appearance: { density: "minimal" } } } })
    : route.continue());
}

async function runtimeEvent(page: Page, sessionId: string, value: ReturnType<typeof runtime>) {
  await page.request.post("/api/mock/event", { data: { type: "session_runtime_changed", sessionId, runtime: value } });
}

test.beforeEach(async ({ page }) => resetMinimal(page));

test("active worker dock derives only direct spawn children and follows running, queued, completed, and session switches", async ({ page }) => {
  const sessions = [
    ["mock-current", "Current parent"], ["worker-run", "Compile assets"], ["worker-queue", "Queued review"],
    ["worker-done", "Completed"], ["wrong-parent", "Wrong parent"], ["nonspawn", "Continuation"], ["unavailable", "Unavailable"],
  ];
  await page.request.patch("/api/session-ui-state", { data: { sessionOrigins: [
    { sessionId: "worker-run", originSessionId: "mock-current", kind: "spawn", updatedAt: now },
    { sessionId: "worker-queue", originSessionId: "mock-current", kind: "spawn", updatedAt: now },
    { sessionId: "worker-done", originSessionId: "mock-current", kind: "spawn", updatedAt: now },
    { sessionId: "wrong-parent", originSessionId: "mock-older", kind: "spawn", updatedAt: now },
    { sessionId: "nonspawn", originSessionId: "mock-current", kind: "continuation", updatedAt: now },
    { sessionId: "unavailable", originSessionId: "mock-current", kind: "spawn", updatedAt: now },
  ] } });
  await page.route(/\/api\/sessions(?:\?.*)?$/, route => route.fulfill({ json: { ok: true, sessions: sessions.map(([id, name]) => ({
    id, name, cwd: ".", created: now, modified: now, messageCount: 1, isCurrent: id === "mock-current", unread: false,
  })) } }));
  await page.goto("/");

  // The parent may itself be active: child workers must still remain available.
  await runtimeEvent(page, "mock-current", runtime(true));
  await runtimeEvent(page, "worker-run", runtime(true));
  await runtimeEvent(page, "worker-queue", runtime(false, 2));
  await runtimeEvent(page, "worker-done", runtime(false));
  await runtimeEvent(page, "wrong-parent", runtime(true));
  await runtimeEvent(page, "nonspawn", runtime(true));

  const dock = page.locator(".activeWorkerDock");
  await expect(dock).toBeVisible();
  await expect(dock.locator(".activeWorkerPill")).toHaveCount(2);
  await expect(dock.locator('[data-session-id="worker-run"]')).toHaveAttribute("data-worker-status", "running");
  await expect(dock.locator('[data-session-id="worker-queue"]')).toHaveAttribute("data-worker-status", "queued");
  await expect(dock).not.toContainText("Completed");
  await expect(dock).not.toContainText("Wrong parent");
  await expect(dock).not.toContainText("Continuation");
  await expect(dock).not.toContainText("Unavailable");

  // It persists when the current parent becomes idle and updates without reload.
  await runtimeEvent(page, "mock-current", runtime(false));
  await expect(dock).toBeVisible();
  await runtimeEvent(page, "worker-run", runtime(false, 1));
  await expect(dock.locator('[data-session-id="worker-run"]')).toHaveAttribute("data-worker-status", "queued");
  await runtimeEvent(page, "worker-run", runtime(false));
  await runtimeEvent(page, "worker-queue", runtime(false));
  await expect(dock).toBeHidden();

  // Switching current sessions clears stale parent workers.
  await runtimeEvent(page, "worker-run", runtime(true));
  await expect(dock).toBeVisible();
  await page.goto("/?sessionId=mock-older");
  await expect(dock).toBeHidden();
});

test("durable origins hydrate an active dock from session snapshots with no pins or runtime event", async ({ page }) => {
  await page.request.patch("/api/session-ui-state", { data: { sessionOrigins: [
    { sessionId: "hydrated-worker", originSessionId: "mock-current", kind: "spawn", updatedAt: now },
  ] } });
  await page.route(/\/api\/sessions(?:\?.*)?$/, route => route.fulfill({ json: { ok: true, sessions: [
    { id: "mock-current", name: "Current parent", cwd: ".", created: now, modified: now, messageCount: 1, isCurrent: true },
    { id: "hydrated-worker", name: "Hydrated worker", cwd: ".", created: now, modified: now, messageCount: 1, isCurrent: false,
      runtime: runtime(true) },
  ] } }));
  await page.goto("/");
  await expect(page.locator("#sessionDrawer")).toBeHidden();
  const strip = page.locator("#waitingSessions.activeWorkerDock");
  await expect(strip).toBeVisible();
  await expect(strip.locator('.activeWorkerPill[data-session-id="hydrated-worker"]')).toContainText("Hydrated worker");
  await expect(page.locator("#waitingSessions")).toHaveCount(1);
  await expect(page.locator(".waitingSessionChip")).toHaveCount(0);
  await expect(page.locator(".composer #waitingSessions")).toHaveCount(0);
});

test("dock links navigate to workers and retain vertical clearance above the context meter", async ({ page }) => {
  await page.request.patch("/api/session-ui-state", { data: { sessionOrigins: [
    { sessionId: "mock-older", originSessionId: "mock-current", kind: "spawn", updatedAt: now },
  ] } });
  await page.goto("/");
  // Populate canonical session metadata (including cwd) before the runtime event.
  await page.locator("#sessionButton").click();
  await expect(page.locator("#sessionDrawer")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#sessionDrawer")).toBeHidden();
  await runtimeEvent(page, "mock-older", runtime(true));
  const pill = page.locator('.activeWorkerPill[data-session-id="mock-older"]');
  await expect(pill).toBeVisible();
  await expect(pill).toHaveAttribute("href", /sessionId=mock-older/);
  const boxes = await page.evaluate(() => {
    const dock = document.querySelector(".activeWorkerDock")!.getBoundingClientRect();
    const meter = document.querySelector("#contextMeter")!.getBoundingClientRect();
    return { dockBottom: dock.bottom, meterTop: meter.top };
  });
  expect(boxes.dockBottom).toBeLessThanOrEqual(boxes.meterTop + 1);
  await expect(page.locator("#waitingSessions.activeWorkerDock")).toHaveCount(1);
  await expect(page.locator(".composer .activeWorkerDock")).toHaveCount(0);
  await expect(page.locator(".waitingSessionChip")).toHaveCount(0);
  await pill.click();
  await expect(page).toHaveURL(url => url.searchParams.get("sessionId") === "mock-older");
});

test("Minimal preserves explicit scroll intent across streamed activity reconciliation", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#prompt")).toBeVisible();
  await page.locator("#messages").evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.locator("#prompt").fill("slow pending tool refresh");
  await page.locator("#primaryButton").click();
  await page.waitForTimeout(50);

  await page.locator("#messages").dispatchEvent("wheel", { deltaY: -320 });
  const afterIntent = await page.locator("#messages").evaluate(element => element.scrollTop);
  await expect(page.locator(".jumpToLatestButton")).toBeVisible();
  await expect(page.locator(".message.assistant", { hasText: "Let me check that for you." })).toBeVisible({ timeout: 3000 });
  const afterDelta = await page.locator("#messages").evaluate(element => element.scrollTop);
  expect(afterDelta).toBeLessThanOrEqual(afterIntent + 1);
  await expect(page.locator(".jumpToLatestButton")).toBeVisible();
});

const thought = (text: string, id: string) => ({ role: "assistant", raw: { id, role: "assistant", stopReason: "toolUse", content: [{ type: "thinking", thinking: text }] } });
const tool = (name: string, id: string) => ({ role: "toolResult", toolName: name, text: "result", raw: { id }, toolArgs: { path: `${name}.ts` } });

test("manual activity and nested-tool choices stay independent and survive message refresh", async ({ page }) => {
  await page.route("**/api/messages?*", route => route.fulfill({ json: { messages: [thought("live tail", "think-stable"), tool("read", "tool-stable")] } }));
  await page.goto("/");
  const group = page.locator(".activitySummary");
  await group.locator(".activitySummaryToggle").click();
  await expect(group.locator(".activitySummaryBody")).toBeVisible();
  const card = group.locator(".toolCard").last();
  await card.locator(".toolCardExpandToggle").click();
  await expect(card.locator(".toolCardBody")).toBeVisible();
  // Unwrap and re-wrap through density changes; stable card IDs retain both choices.
  await page.locator("#settingDensitySelect").evaluate((select: HTMLSelectElement) => {
    select.value = "compact"; select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.locator(".activitySummary")).toHaveCount(0);
  await page.locator("#settingDensitySelect").evaluate((select: HTMLSelectElement) => {
    select.value = "minimal"; select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(group.locator(".activitySummaryBody")).toBeVisible();
  await expect(group.locator(".toolCard").last().locator(".toolCardBody")).toBeVisible();
  await group.locator(".activitySummaryToggle").click();
  await runtimeEvent(page, "mock-current", runtime(true));
  await expect(group.locator(".activitySummaryBody")).toBeHidden();
});

test("minimal live thinking shows the streamed newest tail without group counts and honors reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.locator("#prompt").fill("please show a thinking card");
  await page.locator("#primaryButton").click();
  const preview = page.locator(".thinkingLivePreview");
  await expect(preview).toBeVisible();
  await expect(preview).not.toHaveText("");
  await expect(page.locator(".activitySummaryStatus")).toHaveText("running");
  const animated = await preview.evaluate(element => {
    const style = getComputedStyle(element);
    return style.animationName !== "none" && style.animationDuration !== "0s";
  });
  expect(animated).toBe(false);
});
