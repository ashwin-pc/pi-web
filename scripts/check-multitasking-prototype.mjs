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
  if (!["index.html", "style.css", "shell.js", "mascot.png"].includes(name)) { res.writeHead(404).end(); return; }
  try {
    res.setHeader("Content-Type", { "index.html": "text/html", "style.css": "text/css", "shell.js": "text/javascript", "mascot.png": "image/png" }[name]);
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
  await page.locator(`.stage [data-resource-picker="${activityId}"]`).click();
  await page.locator(`[data-picker-resource="${id}"]`).click();
}
try {
  await page.goto(base);
  await expect(page.locator(".workspaceCard")).toHaveCount(2);
  await expect(page.locator(".overview [data-open-activity]")).toHaveCount(5);
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
  await page.locator('.stage [data-open-chat="pi-navigation"]').click();
  await page.locator('[data-agent-form="pi-navigation"] textarea').fill("Review this workspace navigation and its mobile tap targets.");
  await page.locator('[data-agent-form="pi-navigation"] button').click();
  const job = await page.evaluate(() => window.piWebDemo.snapshot().jobs[0]);
  expect(job.executionWorkspaceId).toBe("pi-web");
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
  await other.locator('.stage [data-open-chat="pi-release"]').click();
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
  await expect(page.locator(".overviewTip").first()).toContainText("does not include");
  await expect(page.locator(".context")).toHaveCount(0);

  // An activity is one goal spanning roots; each file still saves to its owner.
  const multi = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const cp = await multi.newPage();
  cp.on("pageerror", (error) => errors.push(error.message));
  const cd = (id) => cp.locator(`textarea[data-resource="${id}"]`);
  const snapshot = () => cp.evaluate(() => window.piWebDemo.snapshot());
  const resume = async (id) => {
    await cp.keyboard.press("Control+k");
    await cp.locator(`#switchRows [data-open-activity="${id}"]`).click();
  };
  const attach = async (id, owner) => {
    await cp.locator(`.stage [data-resource-picker="${owner}"]`).click();
    await cp.locator(`[data-picker-resource="${id}"]`).click();
  };
  await cp.goto(base + "/?activity=coordinate-release");
  await expect(cp.locator(".surface:visible")).toHaveCount(2);
  await expect(cp.locator('.surface[data-resource-workspace="pi-web"]')).toBeVisible();
  await expect(cp.locator('.surface[data-resource-workspace="trail-notes"]')).toBeVisible();
  await expect(cp.locator(".chatForm")).toHaveCount(0);
  expect(await cp.locator(".actionLauncher img").evaluate((img) => img.complete && img.naturalWidth > 0)).toBe(true);
  await cd("pi-release-doc").fill("Release together.\nPi Web checklist stays in Pi Web.");
  await cd("trail-roadmap-doc").fill("Trail Notes roadmap stays in Trail Notes.");
  await cp.locator('[data-save="pi-release-doc"]').click();
  await cp.locator('[data-save="trail-roadmap-doc"]').click();
  const saved = await cp.evaluate(() => Object.entries(localStorage).filter(([key]) => key.includes("/document/")).map(([key, value]) => [JSON.parse(key.split("/document/")[1]), JSON.parse(value).saved]));
  expect(saved).toEqual(expect.arrayContaining([
    [["pi-web", "docs/release-checklist.md"], "Release together.\nPi Web checklist stays in Pi Web."],
    [["trail-notes", "docs/roadmap.md"], "Trail Notes roadmap stays in Trail Notes."],
  ]));
  await cp.screenshot({ path: join(output, "across-workspaces.png") });

  // Workspace buttons filter the same shared activity, rather than cloning it.
  await resume("coordinate-release");
  for (const rootId of ["pi-web", "trail-notes"]) {
    await cp.locator(`button[data-workspace="${rootId}"]`).click();
    expect((await snapshot()).primary).toBe("coordinate-release");
    await expect(cp.locator('.activities [data-open-activity="coordinate-release"]')).toHaveCount(1);
    await expect(cd("pi-release-doc")).toHaveValue(/Release together/);
  }
  await cp.keyboard.press("Control+k");
  await expect(cp.locator('#switchRows [data-open-activity="coordinate-release"]')).toHaveCount(1);
  await cp.keyboard.press("Escape");

  // A goal can be inspected, docked or kept as a pill while one resource is primary.
  await cd("pi-release-doc").evaluate((editor) => { editor.focus(); editor.setSelectionRange(4, 11); });
  await cp.locator('.context [data-card="coordinate-release"]').click();
  await expect(cp.locator(".surface:visible")).toHaveCount(1);
  await expect(cp.locator(".activityDock")).toBeVisible();
  await expect(cp.locator(".cardResources button")).toHaveCount(2);
  expect(new URL(cp.url()).searchParams.get("view")).toBe("resource");
  await cp.locator('button[data-workspace="pi-web"]').click();
  expect((await snapshot()).docked).toBe("coordinate-release");
  await expect(cp.locator(".surface:visible")).toHaveCount(1);
  await cp.screenshot({ path: join(output, "docked-activity.png") });
  await cp.reload();
  await expect(cp.locator(".activityDock")).toBeVisible();
  await expect(cd("pi-release-doc")).toHaveValue(/Release together/);
  await cp.locator('.activityDock [data-compact="coordinate-release"]').click();
  await expect(cp.locator(".activityDock")).toHaveCount(0);
  await expect(cp.locator('.activityShelf [data-card="coordinate-release"]')).toBeVisible();
  await expect(cp.locator(".surface:visible")).toHaveCount(1);
  await cp.screenshot({ path: join(output, "compact-activity.png") });
  await cp.keyboard.press("Control+k");
  await cp.locator('#switchRows [data-card="trail-usage"]').click();
  expect((await snapshot()).primary).toBe("coordinate-release");
  await expect(cd("pi-release-doc")).toHaveValue(/Release together/);
  await expect(cp.locator('.activityDock [data-card-activity="trail-usage"]')).toBeVisible();
  await cp.locator("[data-dock-close]").click();
  await cp.locator('.stage [data-expanded-activity="coordinate-release"]').click();
  await expect(cp.locator(".surface:visible")).toHaveCount(2);
  expect(await cd("pi-release-doc").evaluate((editor) => [editor.selectionStart, editor.selectionEnd])).toEqual([4, 11]);

  // Agent execution and read scopes are explicit and captured at submission.
  await cp.locator('.stage [data-open-chat="coordinate-release"]').click();
  const form = cp.locator('[data-agent-form="coordinate-release"]');
  await form.locator("select").selectOption("trail-notes");
  await form.locator('[name="contextWorkspace"][value="trail-notes"]').uncheck();
  await form.locator('[name="contextWorkspace"][value="pi-web"]').uncheck();
  await expect(form.locator("button")).toBeDisabled();
  await form.locator('[name="contextWorkspace"][value="pi-web"]').check();
  await form.locator("textarea").fill("Review the Pi Web checklist from the Trail Notes agent context.");
  await form.locator("button").click();
  const crossJob = (await snapshot()).jobs.at(-1);
  expect(crossJob.executionWorkspaceId).toBe("trail-notes");
  expect(crossJob.workspaceIds).toEqual(["pi-web"]);
  expect(crossJob.resources).toHaveLength(1);
  expect(crossJob.resources[0].snapshot).toContain("Release together");
  await cp.locator('[data-close-resource="chat:coordinate-release"]').click();

  // Adding another project's resource makes an existing activity span roots.
  await resume("pi-navigation");
  await attach("trail-analysis", "pi-navigation");
  expect((await snapshot()).activities.find((activity) => activity.id === "pi-navigation").workspaceIds).toEqual(["pi-web", "trail-notes"]);
  await expect(cp.locator('.surface[data-resource-workspace="trail-notes"]')).toBeVisible();
  await attach("pi-readme", "pi-navigation");
  await cd("pi-readme").fill("Saved Pi Web README in a shared activity.");
  await cp.locator('[data-save="pi-readme"]').click();
  await attach("trail-readme", "pi-navigation");
  await expect(cd("trail-readme")).toHaveValue(/Trail Notes workspace/);
  await cd("trail-readme").fill("Saved Trail Notes README in that same activity.");
  await cp.locator('[data-save="trail-readme"]').click();
  await expect(cd("pi-readme")).toHaveValue("Saved Pi Web README in a shared activity.");
  expect((await snapshot()).jobs.at(-1)).toEqual(crossJob);
  await cd("pi-readme").focus();
  const foreground = cp.url();
  await cp.evaluate((id) => window.piWebDemo.finishJob(id), crossJob.id);
  expect(cp.url()).toBe(foreground);
  await expect(cd("pi-readme")).toBeFocused();
  await expect(cp.locator(".report")).toHaveCount(0);
  await cp.locator(".topActions [data-inbox]").click();
  await cp.locator('[data-inbox-open="coordinate-release"]').click();
  await expect(cp.locator(".report")).toContainText("Ran in Trail Notes. Read-only context from Pi Web.");

  // One agent can also read both roots; resource snapshots keep qualified owners.
  await cp.locator('.stage [data-open-chat="coordinate-release"]').click();
  await form.locator('[name="contextWorkspace"][value="trail-notes"]').check();
  await form.locator("textarea").fill("Review the release across both projects.");
  await form.locator("button").click();
  const both = (await snapshot()).jobs.at(-1);
  expect(both.workspaceIds).toEqual(["pi-web", "trail-notes"]);
  expect(both.resources.map((item) => item.workspaceId)).toEqual(["pi-web", "trail-notes"]);
  await cp.locator('[data-close-resource="chat:coordinate-release"]').click();
  await cp.locator('.activities [data-card="coordinate-release"]').click();
  await cp.locator('[data-compact="coordinate-release"]').click();
  await cp.evaluate((id) => window.piWebDemo.finishJob(id), both.id);
  await expect(cp.locator('.activityShelf [data-card="coordinate-release"]')).toContainText("Ready");
  await cp.locator('.activityShelf [data-card="coordinate-release"]').click();
  await expect(cp.locator(".cardJob")).toContainText("Context: Pi Web + Trail Notes");
  await cp.setViewportSize({ width: 2560, height: 1440 });
  expect(await cp.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(cp.locator(".surface:visible")).toHaveCount(1);
  await cp.screenshot({ path: join(output, "dense-desktop.png") });
  await cp.goto(base + "/?activity=pi-release&view=resource&resource=trail-data");
  await expect(cp.locator(".overviewTip").first()).toContainText("not attached");
  await expect(cp.locator(".surface")).toHaveCount(0);
  await multi.close();

  const sharedPhone = await browser.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true });
  const sp = await sharedPhone.newPage();
  sp.on("pageerror", (error) => errors.push(error.message));
  await sp.goto(base + "/?activity=coordinate-release");
  await expect(sp.locator(".surface:visible")).toHaveCount(1);
  await sp.locator('textarea[data-resource="pi-release-doc"]').fill("Shared mobile draft.");
  await sp.locator('.context [data-card="coordinate-release"]').click();
  await expect(sp.locator(".activitySheet")).toBeVisible();
  expect(await sp.locator(".activitySheet").evaluate((sheet) => sheet.getBoundingClientRect().height)).toBeLessThan(851 * .8);
  await expect(sp.locator('.cardResources [data-card-resource="trail-roadmap-doc"]')).toBeVisible();
  await sp.screenshot({ path: join(output, "mobile-activity-card.png") });
  await sp.locator('[data-compact="coordinate-release"]').click();
  await sp.locator("[data-launcher]").click();
  await expect(sp.locator("[data-launcher]")).toHaveAttribute("aria-expanded", "true");
  await sp.locator('.actionLauncherItem[data-resource-picker="coordinate-release"]').click();
  await sp.locator('[data-picker-resource="trail-data"]').click();
  await expect(sp.locator(".dataTable")).toBeVisible();
  await sp.locator('[data-show-resource="pi-release-doc"]').click();
  await expect(sp.locator('textarea[data-resource="pi-release-doc"]')).toHaveValue("Shared mobile draft.");
  await sp.locator('.activityShelf [data-card="coordinate-release"]').click();
  await sp.locator('[data-card-resource="trail-roadmap-doc"]').click();
  await expect(sp.locator('textarea[data-resource="trail-roadmap-doc"]')).toBeVisible();
  await expect(sp.locator(".surface:visible")).toHaveCount(1);
  await expect(sp.locator(".chatForm")).toHaveCount(0);
  await sp.setViewportSize({ width: 768, height: 1024 });
  await expect(sp.locator(".surface:visible")).toHaveCount(1);
  await sp.locator("[data-launcher]").click();
  await sp.locator('.actionLauncherItem[data-open-chat="coordinate-release"]').click();
  await sp.locator('[data-agent-form="coordinate-release"] textarea').fill("Review both projects on mobile.");
  await sp.locator('[data-agent-form="coordinate-release"] button').click();
  const phoneJob = await sp.evaluate(() => window.piWebDemo.snapshot().jobs.at(-1));
  await sp.locator('[data-close-resource="chat:coordinate-release"]').click();
  await sp.locator('.activityShelf [data-card="coordinate-release"]').click();
  await expect(sp.locator(".cardJob")).toContainText("Review running");
  await expect(sp.locator("[data-close-overlay]")).toBeFocused();
  const mobileRoute = sp.url();
  await sp.evaluate((id) => window.piWebDemo.finishJob(id), phoneJob.id);
  await expect(sp.locator(".cardJob")).toContainText("Review complete");
  await expect(sp.locator("[data-close-overlay]")).toBeFocused();
  expect(sp.url()).toBe(mobileRoute);
  await sharedPhone.close();
  expect(errors).toEqual([]);
  console.log("Passed: shared activities across roots; owner-qualified saves and same-name files; explicit agent execution/read scopes and immutable snapshots; expanded/docked/compact views; shared activity deduplication; mascot asset loading; optional Chat; drafts/cursors/filters; URL/Back/reload; independent side-by-side contexts and tabs; background completion without focus stealing; active draft conflicts; dense desktop; mobile/tablet single surface, live activity sheet with focus preservation and 44px controls.");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
