import { expect, test, type Page, type TestInfo } from "@playwright/test";

/**
 * Minimal UI visual contract. Update intentionally with:
 *   npx playwright test tests/e2e/minimal-visual.spec.ts --update-snapshots --retries=0
 * Then run the same command without --update-snapshots to exercise the comparator.
 */
const timestamp = "2026-01-01T00:00:00.000Z";
const ref = (sessionId: string, name: string, status: "running" | "idle" = "idle") => ({ sessionId, name, status });
const prose = (text: string) => ({ role: "assistant", text, raw: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } });
const thought = (text: string, id: string) => ({ role: "assistant", raw: { id, role: "assistant", stopReason: "toolUse", content: [{ type: "thinking", thinking: text }] } });
const tool = (toolName: string, text: string, id: string, details?: unknown) => ({
  role: "toolResult", toolName, text, details, raw: { id, details }, toolArgs: { command: text },
});

async function prepareMinimal(page: Page) {
  await page.request.post("/api/mock/reset");
  await page.route("**/api/settings", route => route.request().method() === "GET"
    ? route.fulfill({ json: { settings: { appearance: { density: "minimal" } } } })
    : route.continue());
  await page.emulateMedia({ reducedMotion: "reduce" });
}

async function settleVisual(page: Page) {
  await page.addStyleTag({ content: `
    *,*::before,*::after { animation: none !important; transition: none !important; caret-color: transparent !important; }
    .messageTimestamp { visibility: hidden !important; }
  ` });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

async function screenshotMessages(page: Page, name: string, testInfo: TestInfo) {
  await expect(page.locator("#messages")).toHaveScreenshot(`${name}-${testInfo.project.name}.png`, {
    animations: "disabled",
  });
}

test.beforeEach(async ({ page }) => prepareMinimal(page));

test("collapsed transcript: singleton tools, structured workers, grouped activity, prose, and report", async ({ page }, testInfo) => {
  const workers = [ref("worker-a", "Accessibility audit", "running"), ref("worker-b", "Release notes")];
  await page.route("**/api/messages?*", route => route.fulfill({ json: { messages: [
    { role: "user", text: "Polish the release and delegate the checks." },
    tool("bash", "npm run typecheck", "bash-single"),
    prose("Typecheck is clean. I’m handing off the final checks now."),
    tool("delegate_task", "Two focused reviews started.", "delegate-single", { sessionRefs: workers }),
    prose("Meanwhile, I tightened the summary spacing."),
    thought("Review the remaining visual states.", "thinking-group"),
    tool("read", "Loaded the activity styles.", "read-group"),
    tool("write", "Updated the visual fixture.", "write-group"),
    {
      role: "custom", customType: "quality-review",
      text: "Final message:\nThe **accessibility audit is complete** and all landmarks passed.",
      details: {
        sessionRefs: [ref("worker-a", "Accessibility audit")],
        presentation: { kind: "expandable-report", label: "Accessibility audit · finished", preview: "The accessibility audit is complete and all landmarks passed.", tone: "accent" },
      },
    },
  ] } }));

  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-density", "minimal");
  await expect(page.locator(".activitySummary")).toHaveCount(3);
  await expect(page.locator(".activitySummary").nth(1).locator(".activitySessionRefs > .activitySessionLink")).toHaveCount(2);
  await expect(page.locator(".customMessageReport--accent.custom--quality-review")).toBeVisible();
  await settleVisual(page);
  await screenshotMessages(page, "minimal-transcript-collapsed", testInfo);
});

test("expanded activity and completion report", async ({ page }, testInfo) => {
  const worker = ref("worker-review", "UI review");
  await page.route("**/api/messages?*", route => route.fulfill({ json: { messages: [
    { role: "user", text: "Show me the implementation details." },
    thought("Inspect spacing and color tokens.", "thinking-expanded"),
    tool("read", "The layout uses the shared spacing scale.", "read-expanded"),
    tool("delegate_task", "Review completed successfully.", "delegate-expanded", { sessionRefs: [worker] }),
    {
      role: "custom", customType: "quality-review",
      text: "Final message:\nThe **UI review is complete**. Tight spacing, muted prose, and accent status all passed.",
      details: {
        sessionRefs: [worker],
        presentation: { kind: "expandable-report", label: "UI review · finished", preview: "The UI review is complete. Tight spacing, muted prose, and accent status all passed.", tone: "accent" },
      },
    },
  ] } }));

  await page.goto("/");
  const activity = page.locator(".activitySummary");
  await activity.locator(".activitySummaryToggle").click();
  await page.locator(".customMessageReportToggle").click();
  await expect(activity.locator(".activitySummaryBody")).toBeVisible();
  await expect(page.locator(".customMessageReportBody")).toBeVisible();
  await settleVisual(page);
  await screenshotMessages(page, "minimal-transcript-expanded", testInfo);
});

const runtime = (isRunning: boolean, pendingMessageCount = 0) => ({
  loaded: true, isRunning, isStreaming: isRunning, isRetrying: false, isCompacting: false, pendingMessageCount,
});

async function sendRuntime(page: Page, sessionId: string, value: ReturnType<typeof runtime>) {
  await page.request.post("/api/mock/event", { data: { type: "session_runtime_changed", sessionId, runtime: value } });
}

test("worker dock remains clear and horizontally contained while parent runs or idles", async ({ page }, testInfo) => {
  const workers = Array.from({ length: 6 }, (_, index) => [`worker-${index}`, `Worker ${index + 1}: ${index % 2 ? "content review" : "implementation"}`]);
  await page.request.patch("/api/session-ui-state", { data: { sessionOrigins: workers.map(([sessionId]) => ({
    sessionId, originSessionId: "mock-current", kind: "spawn", updatedAt: timestamp,
  })) } });
  await page.route(/\/api\/sessions(?:\?.*)?$/, route => route.fulfill({ json: { ok: true, sessions: [
    { id: "mock-current", name: "Release parent", cwd: ".", created: timestamp, modified: timestamp, messageCount: 1, isCurrent: true },
    ...workers.map(([id, name]) => ({ id, name, cwd: ".", created: timestamp, modified: timestamp, messageCount: 1, isCurrent: false })),
  ] } }));
  await page.goto("/");
  await sendRuntime(page, "mock-current", runtime(true));
  for (let index = 0; index < workers.length; index++) {
    await sendRuntime(page, workers[index][0], index % 2 ? runtime(false, 1) : runtime(true));
  }

  const dock = page.locator("#waitingSessions.activeWorkerDock");
  await expect(dock.locator(".activeWorkerPill")).toHaveCount(6);
  await settleVisual(page);
  await expect(page).toHaveScreenshot(`minimal-worker-dock-parent-active-${testInfo.project.name}.png`, { animations: "disabled" });

  await sendRuntime(page, "mock-current", runtime(false));
  await expect(dock).toBeVisible();
  const clearance = await page.evaluate(() => {
    const dockBox = document.querySelector("#waitingSessions")!.getBoundingClientRect();
    const contextBox = document.querySelector("#contextMeter")!.getBoundingClientRect();
    return { clear: dockBox.bottom <= contextBox.top + 1 };
  });
  expect(clearance.clear).toBe(true);
  await expect(page).toHaveScreenshot(`minimal-worker-dock-parent-idle-${testInfo.project.name}.png`, { animations: "disabled" });
});
