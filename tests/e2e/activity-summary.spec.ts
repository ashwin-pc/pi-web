import { expect, test } from "@playwright/test";

const user = (text: string) => ({ role: "user", text });
const prose = (text: string) => ({ role: "assistant", text, raw: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } });
const thought = (text: string, id: string) => ({ role: "assistant", raw: { id, role: "assistant", stopReason: "toolUse", content: [{ type: "thinking", thinking: text }] } });
const tool = (name: string, text: string, id: string, details?: unknown) => ({ role: "toolResult", toolName: name, text, details, raw: { id, details }, toolArgs: { path: `${name}.ts` } });

async function minimal(page: import("@playwright/test").Page) {
  await page.request.patch("/api/settings", { data: { appearance: { density: "minimal" } } });
}

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
  // The mock reset persists defaults asynchronously; avoid racing its settings write.
  await page.waitForTimeout(50);
  await minimal(page);
});

test("Minimal is selectable, persisted across reload, and can switch back", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-density", "minimal");
  await page.locator("#settingsButton").evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.locator("#settingDensitySelect")).toHaveValue("minimal");
  await page.locator("#settingDensitySelect").evaluate((select: HTMLSelectElement) => {
    select.value = "comfortable";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.locator("html")).toHaveAttribute("data-density", "comfortable");
  await page.reload();
  await expect(page.locator("#settingDensitySelect")).toHaveValue("comfortable");
  await page.locator("#settingDensitySelect").evaluate((select: HTMLSelectElement) => {
    select.value = "compact";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
});

test("every activity run folds; prose, notices, and errors remain boundaries", async ({ page }) => {
  await page.route("**/api/messages?*", route => route.fulfill({ json: { messages: [
    user("request"), thought("first reasoning", "t1"), tool("read", "contents", "r1"),
    prose("between runs"), tool("write", "done", "single"),
    { role: "custom", customType: "deploy_notice", text: "notice boundary" },
    thought("second reasoning", "t2"), tool("bash", "ok", "b1"),
    { role: "toolResult", toolName: "bash", text: "failed", isError: true, raw: { id: "err" } },
  ] } }));
  await page.goto("/");
  const groups = page.locator(".activitySummary");
  await expect(groups).toHaveCount(3);
  await expect(groups.first().locator(".activitySummaryToggle")).toHaveText(/1 tool.*1 thinking/);
  await expect(groups.first().locator(".activitySummaryBody")).toBeHidden();
  await expect(groups.nth(1).locator(".activitySummaryToggle")).toHaveText("1 tool");
  await expect(groups.nth(1).locator(".activitySummaryBody")).toBeHidden();
  const intermediate = page.locator(".message.assistant", { hasText: "between runs" });
  await expect(intermediate).toBeVisible();
  const rhythm = await intermediate.evaluate(element => {
    const style = getComputedStyle(element);
    const root = getComputedStyle(document.documentElement);
    return { paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, color: style.color, normal: root.getPropertyValue("--text").trim() };
  });
  expect(rhythm.paddingTop).toBe("6px");
  expect(rhythm.paddingBottom).toBe("6px");
  expect(rhythm.color).not.toBe(rhythm.normal);
  await expect(page.locator(".customMessageReportPreview")).toHaveText("notice boundary");
  await groups.first().locator(".activitySummaryToggle").click();
  await expect(groups.first().locator(".activitySummaryBody")).toBeVisible();
  const firstCard = groups.first().locator(".toolCard").first();
  await firstCard.locator(".toolCardExpandToggle").click();
  await expect(firstCard.locator(".toolCardBody")).toBeVisible();
  // A nested card choice must not toggle the enclosing group.
  await expect(groups.first().locator(".activitySummaryToggle")).toHaveAttribute("aria-expanded", "true");
});

test("standalone tools use independent quiet summaries in Minimal, including session spawns", async ({ page }) => {
  const worker = { sessionId: "worker-single", name: "Single worker", status: "running" };
  await page.route("**/api/messages?*", route => route.fulfill({ json: { messages: [
    tool("read", "ordinary result body", "single-read"), prose("first boundary"),
    tool("sessions_spawn", "spawn result body", "single-spawn", { workers: [worker] }), prose("second boundary"),
    { role: "toolResult", toolName: "bash", text: "failure remains visible", isError: true, raw: { id: "single-error" } },
  ] } }));
  await page.goto("/");

  const summaries = page.locator(".activitySummary");
  await expect(summaries).toHaveCount(2);
  for (const summary of [summaries.nth(0), summaries.nth(1)]) {
    await expect(summary.locator(".activitySummaryToggle")).toHaveText("1 tool");
    await expect(summary.locator(".activitySummaryBody")).toBeHidden();
    await expect(summary.locator(".activitySummaryToggle")).toHaveAttribute("aria-expanded", "false");
  }

  const spawnSummary = summaries.nth(1);
  const workerLink = spawnSummary.locator(".activitySessionRefs > .activitySessionLink");
  await expect(workerLink).toHaveAttribute("href", /sessionId=worker-single/);
  await workerLink.evaluate(link => link.addEventListener("click", event => { event.preventDefault(); event.stopImmediatePropagation(); }, { once: true, capture: true }));
  await workerLink.click();
  await expect(spawnSummary.locator(".activitySummaryBody")).toBeHidden();

  // Summary and nested tool choices remain independent across density changes.
  await spawnSummary.locator(".activitySummaryToggle").click();
  const spawn = spawnSummary.locator('.toolCard[data-tool-name="sessions_spawn"]');
  await spawn.locator(".toolCardExpandToggle").click();
  await expect(spawn.locator(".toolCardBody")).toBeVisible();
  await page.locator("#settingsButton").evaluate((button: HTMLButtonElement) => button.click());
  await page.locator("#settingDensitySelect").evaluate((select: HTMLSelectElement) => {
    select.value = "comfortable";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    select.value = "minimal";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(spawnSummary.locator(".activitySummaryBody")).toBeVisible();
  await expect(spawn.locator(".toolCardBody")).toBeVisible();
  await expect(summaries.nth(0).locator(".activitySummaryBody")).toBeHidden();
  await expect(page.locator('.toolCard[data-tool-name="bash"]')).toBeVisible();
});

test("structured worker refs are deduplicated, bounded, and navigate independently of group toggle", async ({ page }) => {
  const workers = Array.from({ length: 10 }, (_, i) => ({ sessionId: `worker-${i}`, name: `Worker ${i}`, status: i ? "idle" : "running" }));
  await page.route("**/api/messages?*", route => route.fulfill({ json: { messages: [
    tool("sessions_spawn", "spawned", "s1", { workers }),
    tool("read", "done", "s2", { sessionRefs: [workers[0], workers[1]] }),
    prose("boundary"),
    tool("read", "one", "n1", { sessionId: "bare-ref-must-not-render" }),
    tool("write", "two", "n2"),
  ] } }));
  await page.goto("/");
  const first = page.locator(".activitySummary").first();
  await expect(first.locator(".activitySessionRefs > .activitySessionLink")).toHaveCount(8);
  const expanded = await first.locator(".activitySummaryToggle").getAttribute("aria-expanded");
  const firstLink = first.locator(".activitySessionRefs > .activitySessionLink").first();
  await expect(firstLink).toHaveAttribute("href", /sessionId=worker-0/);
  // Prevent navigation so the assertion isolates click bubbling from the summary toggle.
  await firstLink.evaluate(link => link.addEventListener("click", event => { event.preventDefault(); event.stopImmediatePropagation(); }, { once: true, capture: true }));
  await firstLink.click();
  await expect(first.locator(".activitySummaryToggle")).toHaveAttribute("aria-expanded", expanded!);
  await expect(page.locator(".activitySummary").nth(1).locator(".activitySessionRefs")).toBeHidden();
});

test("Minimal generic custom report honors presentation metadata and session navigation", async ({ page }) => {
  // Isolate rendering from a prior project's density switch on the shared mock server.
  await page.route("**/api/settings", route => route.request().method() === "GET"
    ? route.fulfill({ json: { settings: { appearance: { density: "minimal" } } } })
    : route.continue());
  const report = "Final message:\nA complete **worker report** with details.";
  await page.route("**/api/messages?*", route => route.fulfill({ json: { messages: [{
    role: "custom", customType: "release-review", text: report,
    details: {
      sessionRefs: [{ sessionId: "worker-complete", name: "A very long worker name that remains valid", status: "idle" }],
      presentation: { kind: "expandable-report", label: "Worker complete", preview: "A complete worker report with details.", tone: "accent" },
    },
  }] } }));
  await page.goto("/");
  const card = page.locator(".customMessageReport.custom--release-review");
  await expect(card).toHaveClass(/customMessageReport--accent/);
  const headingColor = await card.locator(".customMessageReportLabel").evaluate(element => {
    const probe = document.createElement("span");
    probe.style.color = "var(--accent)";
    document.body.append(probe);
    const colors = { actual: getComputedStyle(element).color, accent: getComputedStyle(probe).color };
    probe.remove();
    return colors;
  });
  expect(headingColor.actual).toBe(headingColor.accent);
  await expect(card.locator(".customMessageReportPreview")).toContainText("complete worker report");
  await expect(card.locator(".customMessageReportBody")).toBeHidden();
  await card.locator(".customMessageReportToggle").click();
  await expect(card.locator(".customMessageReportBody")).toContainText("A complete worker report with details.");
  const link = card.locator(".customMessageReportSessionLink");
  await expect(link).toHaveAttribute("href", /sessionId=worker-complete/);
  await link.evaluate(node => node.addEventListener("click", event => { event.preventDefault(); event.stopImmediatePropagation(); }, { once: true, capture: true }));
  await link.click();
  await expect(card.locator(".customMessageReportToggle")).toHaveAttribute("aria-expanded", "true");
});
