import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";

const root = fileURLToPath(new URL("../docs/prototypes/multitasking-shell/", import.meta.url));
const output = process.argv[2] || "/tmp/pi-web-multitasking-check";
await mkdir(output, { recursive: true });
const errors = [];
const server = createServer(async (req, res) => {
  const name = new URL(req.url, "http://localhost").pathname.slice(1) || "index.html";
  if (!["index.html", "style.css", "shell.js"].includes(name)) { res.writeHead(404).end(); return; }
  try {
    res.setHeader("Content-Type", { "index.html": "text/html", "style.css": "text/css", "shell.js": "text/javascript" }[name]);
    res.end(await readFile(join(root, name)));
  } catch { res.writeHead(500).end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 950 } });
const page = await context.newPage();
page.on("pageerror", (error) => errors.push(error.message));
const open = (id) => page.locator(`.activities [data-open-activity="${id}"]`).click();
const doc = (id, owner) => page.locator(`textarea[data-resource="${id}"]${owner ? `[data-activity="${owner}"]` : ""}`);
async function switchTo(id, beside = false) {
  await page.keyboard.press("Control+k");
  await page.locator(`#switchRows [data-${beside ? "beside" : "open-activity"}="${id}"]`).click();
}
async function pick(id, activityId) {
  await page.locator(`[data-resource-picker="${activityId}"]`).click();
  await page.locator(`[data-picker-resource="${id}"]`).click();
}
try {
  await page.goto(base);
  await expect(page.locator(".workspaceCard")).toHaveCount(2);
  await expect(page.locator(".overview [data-open-activity]")).toHaveCount(4);
  await expect(page.locator(".chatForm")).toHaveCount(0);
  await page.screenshot({ path: join(output, "overview.png") });

  await page.locator('.overview [data-open-activity="pi-navigation"]').click();
  await doc("pi-nav").fill("Workspace navigation draft\nKeep Chat optional.\nCheck 44px tap targets.");
  await open("pi-release");
  await doc("pi-release-doc").fill("Release checklist\n[ ] Verify the workspace package\nDraft: add the multitasking demo.");
  await switchTo("trail-usage");
  await page.locator('[data-range="7"]').click();
  await doc("trail-analysis").fill("Observation: weekend return visits increased.\nKeep the seven-day filter.");
  await doc("trail-analysis").evaluate((editor) => { editor.focus(); editor.setSelectionRange(4, 9); });
  await switchTo("pi-navigation");
  await expect(doc("pi-nav")).toHaveValue(/Keep Chat optional/);
  await page.locator('[data-open-chat="pi-navigation"]').click();
  await page.locator('[data-agent-form="pi-navigation"] textarea').fill("Review this workspace navigation and its mobile tap targets.");
  await page.locator('[data-agent-form="pi-navigation"] button').click();
  const job = await page.evaluate(() => window.piWebDemo.snapshot().jobs[0]);
  expect(job.workspaceId).toBe("pi-web");
  expect(job.activityId).toBe("pi-navigation");
  expect(job.resources.every((item) => item.workspaceId === "pi-web")).toBe(true);
  expect(job.resources.find((item) => item.path === "docs/workspace-shell.md").snapshot).toContain("Keep Chat optional");
  await page.locator('[data-close-resource="chat:pi-navigation"]').click();
  await expect(page.locator(".chatForm")).toHaveCount(0);
  expect((await page.evaluate(() => window.piWebDemo.snapshot())).jobs[0].status).toBe("running");

  await open("pi-release");
  await switchTo("trail-usage", true);
  await expect(page.locator(".context:visible")).toHaveCount(2);
  await expect(page.locator('[data-context="trail-usage"] [data-range="7"]')).toHaveClass(/selected/);
  await doc("pi-release-doc").evaluate((editor) => { editor.focus(); editor.setSelectionRange(3, 8); });
  const route = page.url();
  await page.evaluate((id) => window.piWebDemo.finishJob(id), job.id);
  expect(page.url()).toBe(route);
  await expect(doc("pi-release-doc")).toBeFocused();
  expect(await doc("pi-release-doc").evaluate((editor) => [editor.selectionStart, editor.selectionEnd])).toEqual([3, 8]);
  await expect(page.locator(".report")).toHaveCount(0);
  await expect(page.locator('.activityMain[data-open-activity="pi-navigation"]')).toContainText("Review ready");
  await page.screenshot({ path: join(output, "side-by-side.png") });
  await page.locator(".topActions [data-inbox]").click();
  await expect(page.locator(".inboxItem .label")).toHaveText("Pi Web / Workspace navigation");
  await page.locator('[data-inbox-open="pi-navigation"]').click();
  await expect(page.locator('[data-context="pi-navigation"] .report')).toBeVisible();
  await expect(page.locator('[data-context="trail-usage"] .dashboard')).toBeVisible();
  await expect(page.locator(".chatForm")).toHaveCount(0);
  await page.screenshot({ path: join(output, "report-with-other-project.png") });
  await open("pi-release");
  await expect(doc("pi-release-doc")).toHaveValue(/Draft: add the multitasking demo/);
  await page.reload();
  await expect(page.locator(".context:visible")).toHaveCount(2);
  expect(await doc("pi-release-doc").evaluate((editor) => [editor.selectionStart, editor.selectionEnd])).toEqual([3, 8]);
  await expect(page.locator('[data-context="trail-usage"] [data-range="7"]')).toHaveClass(/selected/);
  await page.goBack();
  await expect(page.locator('[data-context="pi-navigation"]')).toBeVisible();
  await page.locator('button[data-workspace="trail-notes"]').click();
  await expect(doc("trail-analysis")).toHaveValue(/weekend return visits/);
  expect(await doc("trail-analysis").evaluate((editor) => [editor.selectionStart, editor.selectionEnd])).toEqual([4, 9]);

  // Same filename, different workspace: content and saves must stay separate.
  await pick("trail-readme", "trail-usage");
  await expect(doc("trail-readme")).toHaveValue(/Trail Notes workspace/);
  await switchTo("pi-release");
  await pick("pi-readme", "pi-release");
  await doc("pi-readme").fill("Pi Web only: saved README.");
  await page.locator('[data-save="pi-readme"]').click();
  await switchTo("trail-usage");
  await expect(doc("trail-readme")).toHaveValue(/Trail Notes workspace/);

  // A second browser tab has its own selected context and receives background status.
  const other = await context.newPage();
  other.on("pageerror", (error) => errors.push(error.message));
  await other.goto(base + "/?workspace=pi-web&activity=pi-release");
  await other.locator('[data-open-chat="pi-release"]').click();
  await other.locator('[data-agent-form="pi-release"] textarea').fill("Read-only release review");
  await other.locator('[data-agent-form="pi-release"] button').click();
  const second = await other.evaluate(() => window.piWebDemo.snapshot().jobs.at(-1));
  const keptRoute = page.url();
  await other.evaluate((id) => window.piWebDemo.finishJob(id), second.id);
  await expect(page.locator(".topActions [data-inbox]")).toContainText("1 ready");
  expect(page.url()).toBe(keptRoute);
  await expect(page.locator('[data-context="trail-usage"]')).toBeVisible();

  // Two views of one shared resource preserve an active conflicting draft.
  await switchTo("pi-release");
  await doc("pi-readme").fill("My active draft");
  await doc("pi-readme").focus();
  await other.locator('[data-close-resource="chat:pi-release"]').click();
  await other.locator('[data-show-resource="pi-readme"]').click();
  await other.locator('textarea[data-resource="pi-readme"]').fill("Draft from the other tab");
  await expect(page.locator(".conflict")).toBeVisible();
  await expect(doc("pi-readme")).toHaveValue("My active draft");
  await page.locator('[data-resolve="pi-readme"][data-keep="false"]').click();
  await expect(doc("pi-readme")).toHaveValue("Draft from the other tab");
  await other.close();

  const phone = await browser.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true });
  const mp = await phone.newPage();
  mp.on("pageerror", (error) => errors.push(error.message));
  await mp.goto(base + "/?workspace=pi-web&activity=pi-navigation");
  await expect(mp.locator(".surface:visible")).toHaveCount(1);
  await expect(mp.locator(".chatForm")).toHaveCount(0);
  await mp.locator(".mobileContext").click();
  await mp.locator('[data-open-activity="trail-usage"]').last().click();
  await expect(mp.locator(".dashboard")).toBeVisible();
  await mp.locator('[data-show-resource="trail-analysis"]').click();
  await mp.locator('textarea[data-resource="trail-analysis"]').fill("Mobile observation stays here.");
  await mp.locator(".mobileContext").click();
  await mp.locator('[data-open-activity="pi-navigation"]').last().click();
  await mp.locator(".mobileContext").click();
  await mp.locator('[data-open-activity="trail-usage"]').last().click();
  await expect(mp.locator('textarea[data-resource="trail-analysis"]')).toHaveValue("Mobile observation stays here.");
  await expect(mp.locator(".surface:visible")).toHaveCount(1);
  expect(await mp.locator(".sourceChip").first().evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  await mp.screenshot({ path: join(output, "mobile.png") });
  await mp.setViewportSize({ width: 768, height: 1024 });
  await expect(mp.locator(".surface:visible")).toHaveCount(1);
  await phone.close();

  await page.goto(base + "/?workspace=pi-web&activity=trail-usage");
  await expect(page.locator(".overviewTip").first()).toContainText("does not belong");
  await expect(page.locator(".context")).toHaveCount(0);
  expect(errors).toEqual([]);
  console.log("Passed: workspace overview; optional Chat; workspace/activity ownership; drafts, cursors and filters; URL/Back/reload; independent side-by-side contexts; background completion without focus stealing; independent tabs; same-name resource isolation; active draft conflict; mobile/tablet single surface and 44px controls.");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
