import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";

const root = fileURLToPath(new URL("../docs/prototypes/multitasking-shell/", import.meta.url));
const output = process.argv[2] || "/tmp/pi-web-multitasking-check";
await mkdir(output, { recursive: true });
const errors = [], externalRequests = [];
const server = createServer(async (req, res) => {
  const name = new URL(req.url, "http://localhost").pathname.slice(1) || "index.html";
  if (!["index.html", "style.css", "shell.js", "mascot.png"].includes(name)) { res.writeHead(404).end(); return; }
  res.setHeader("Content-Type", { "index.html":"text/html", "style.css":"text/css", "shell.js":"text/javascript", "mascot.png":"image/png" }[name]);
  res.end(await readFile(join(root, name)));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const contexts = [];
const firstPrompt = "Open the Pi Web preview in a browser and the release planner. Compare them and tell me what is missing for the launch.";
const editPrompt = "Add the missing check to the Pi Web checklist, keep the planner pinned, and close the browser.";
async function setup(options = {}) {
  const context = await browser.newContext({ viewport:{width:1600,height:950}, ...options }); contexts.push(context);
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => { if (/^https?:/.test(request.url()) && !request.url().startsWith(base)) externalRequests.push(request.url()); });
  await page.goto(base + "/?work=coordinate-release"); return { page, context };
}
const snapshot = (page) => page.evaluate(() => window.piWebDemo.snapshot());
const doc = (page,id="pi-release-doc") => page.locator(`[data-document="${id}"]`);
async function message(page, text, finish = true) {
  if (!await page.locator(".chatPopup").count()) await page.locator(".topbar [data-open-chat]").click();
  await page.locator("[data-prompt]").fill(text); await page.locator("[data-send]").click();
  const job = (await snapshot(page)).jobs.at(-1);
  if (finish) { await page.evaluate((id) => window.piWebDemo.finishJob(id), job.id); await expect.poll(async () => (await snapshot(page)).jobs.at(-1).status).not.toBe("running"); }
  return (await snapshot(page)).jobs.at(-1);
}
async function open(page, id) {
  await page.locator(".topbar [data-picker]").click();
  const category = ["browser"].includes(id) ? "browser" : ["release-planner","trail-dashboard","trail-board","pi-preview","trail-data"].includes(id) ? "apps" : "files";
  await page.locator(`#overlay [data-picker-category="${category}"]`).click();
  await page.locator(`#overlay [data-${id === "browser" ? "browser-open=\"pi-web\"" : `open-item="${id}"`}]`).click();
}
async function work(page, id) {
  if (await page.locator(`.workDrawer [data-work="${id}"]`).isVisible()) await page.locator(`.workDrawer [data-work="${id}"]`).click();
  else { await page.locator(".topbar [data-toggle-work]").click(); await page.locator(`#overlay [data-work="${id}"]`).click(); }
}
try {
  const { page } = await setup();
  await expect(page.locator(".workDrawer")).toHaveCount(1);
  await expect(page.locator(".workDrawer [data-work]")).toHaveCount(5);
  await expect(page.locator(".bottomTabs [data-work]")).toHaveCount(0);
  await expect(page.locator(".bottomTab")).toHaveCount(1);
  await expect(page.locator(".view:visible")).toHaveCount(1);
  await expect(page.locator(".chatPopup")).toHaveCount(0);
  const labels = await page.locator(".topbar,.workDrawer,.bottomTabs,.viewNotice").allTextContents();
  expect(labels.join(" ")).not.toMatch(/\b(resource|surface|scene|activit(?:y|ies))\b/i);
  await doc(page).click();
  await expect(doc(page)).toBeFocused();
  await doc(page).fill("My launch notes stay here.\n[ ] Keep the existing checklist draft.");
  await doc(page).evaluate((editor) => { editor.focus(); editor.setSelectionRange(3,9); });
  await page.screenshot({path:join(output,"work-and-file.png")});
  const first = await message(page, firstPrompt);
  expect(first.status).toBe("done"); expect(first.readWorkspaceIds).toEqual(["pi-web","trail-notes"]);
  expect(first.inspection.targets).toHaveLength(3); expect(first.inspection.targets.every((target) => target.height >= 44)).toBe(true);
  expect(first.reply).toContain("Compact map is still missing");
  await expect(page.locator(".view:visible")).toHaveCount(2);
  await expect(page.locator('[data-view="browser"]')).toBeVisible();
  await expect(page.locator('[data-view="release-planner"]')).toBeVisible();
  await expect(page.locator('.bottomTabs [data-tab="pi-release-doc"]')).toBeVisible();
  await expect(page.locator('.bottomTabs [data-tab^="chat"]')).toHaveCount(0);
  const app = page.frameLocator('iframe[data-app="release-planner"]');
  await expect(app.locator(".row")).toHaveCount(4);
  await expect(app.locator("body")).toContainText("Trail Notes");
  await expect(page.locator('iframe[data-app]')).toHaveAttribute("sandbox","allow-scripts");
  expect(await app.locator("body").evaluate(() => { try { void parent.document.body; return false; } catch { return true; } })).toBe(true);
  expect(new URL(page.url()).searchParams.get("tab")).toBe("browser");
  await page.screenshot({path:join(output,"prompt-opens-browser-and-app.png")});

  const second = await message(page, editPrompt);
  expect(second.edit.workspaceId).toBe("pi-web"); expect(second.edit.state).toBe("applied");
  await expect(doc(page)).toHaveValue(/My launch notes stay here/);
  await expect(doc(page)).toHaveValue(/Check Trail Notes: compact map before launch/);
  await expect(page.locator('[data-view="browser"]')).toHaveCount(0);

  await expect(page.locator('[data-view="release-planner"]')).toBeVisible();
  const view = (await snapshot(page)).scenes.find((entry) => entry.id === "coordinate-release").view;
  expect(view.pinned).toContain("release-planner"); expect(view.open).not.toContain("browser");
  const trail = await page.evaluate(() => localStorage.getItem('pi-web.multitasking-probe.v3/document/["trail-notes","docs/roadmap.md"]'));
  expect(trail).toBeNull();
  await page.screenshot({path:join(output,"prompt-edits-checklist-closes-browser.png")});
  await page.locator('[data-close-chat]').click();
  await expect(doc(page)).toHaveValue(/compact map before launch/);
  await page.locator('[data-save="pi-release-doc"]').click();
  await page.reload();
  await expect(doc(page)).toHaveValue(/My launch notes stay here/);
  await expect(page.locator('[data-view="release-planner"]')).toBeVisible();
  await page.locator('.topbar [data-open-chat]').click();
  await doc(page).click();
  await expect(doc(page)).toBeFocused();
  await expect(page.locator('.chatPopup')).toBeVisible();
  await page.locator('.workSearch input').fill('release');
  await doc(page).click();
  await expect(doc(page)).toBeFocused();
  await expect(page.locator('.chatPopup')).toBeVisible();
  await page.locator('.workSearch input').fill('');
  await page.locator(`[data-restore-view="${second.id}"]`).click();
  await expect(page.locator('[data-view="browser"]')).toBeVisible();
  await expect(page.locator('[data-view="release-planner"]')).toBeVisible();
  await page.locator('.bottomTabs [data-open-item="pi-release-doc"]').click();
  await expect(doc(page)).toHaveValue(/compact map before launch/);

  // The agent reads the same app data that the user can change in the iframe.
  await open(page,"release-planner");
  await app.locator('[data-id="trail-map"]').click();
  await expect(app.locator('[data-id="trail-map"]')).toHaveText("Mark missing");
  const third = await message(page,"Use the release planner and tell me what is still missing for launch.");
  expect(third.reply).toContain("4 of 4 checks are ready"); expect(third.reply).toContain("no missing checks");

  // An app frame gets scoped tools, not arbitrary file or host access.
  const denial = await app.locator("body").evaluate(() => new Promise((resolve) => {
    const receive = (event) => { if (event.data?.id === 989) { removeEventListener("message",receive); resolve(event.data); } };
    addEventListener("message",receive);
    parent.postMessage({jsonrpc:"2.0",id:989,method:"tools/call",params:{name:"write_file",arguments:{path:"README.md",text:"bad"}}},"*");
  }));
  expect(denial.error.message).toContain("unavailable");
  await open(page,"browser");
  await page.frameLocator('[data-view="browser"] iframe').locator("body").evaluate(() => parent.postMessage({jsonrpc:"2.0",id:990,method:"tools/call",params:{name:"set_launch_status",arguments:{id:"trail-map",status:"missing"}}},"*"));
  expect((await snapshot(page)).planner.find((entry) => entry.id === "trail-map").status).toBe("ready");
  await page.locator('[data-view="browser"] [data-pin="browser"]').click();
  const pinned = await message(page,"Close the browser.");
  expect(pinned.reply).toContain("stays open because you pinned it");
  await expect(page.locator('[data-view="browser"]')).toBeVisible();
  await page.locator('[data-view="browser"] [data-close-item="browser"]').click();
  await expect(page.locator('[data-view="browser"]')).toHaveCount(0);

  const beforeReadOnly = await page.evaluate(() => localStorage.getItem('pi-web.multitasking-probe.v3/document/["pi-web","docs/release-checklist.md"]'));
  const readOnly = await message(page,"Do not edit the checklist. Use the planner and tell me what is missing.");
  expect(readOnly.edit).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('pi-web.multitasking-probe.v3/document/["pi-web","docs/release-checklist.md"]'))).toBe(beforeReadOnly);
  await message(page,"Unpin and close the planner, and show only the checklist.");
  await expect(page.locator('[data-view="release-planner"]')).toHaveCount(0);
  await expect(doc(page)).toBeVisible();
  await expect(page.locator(".view:visible")).toHaveCount(1);
  await open(page,"trail-roadmap-doc");
  await expect(doc(page,"trail-roadmap-doc")).toBeVisible();
  await page.goBack();
  await expect(doc(page)).toBeVisible();
  await expect(doc(page)).toHaveValue(/compact map before launch/);

  // Late agent UI proposals cannot replace a document the user started editing.
  const { page: editing } = await setup();
  await editing.evaluate(() => window.piWebDemo.setAutoFinish(false));
  const stopped = await message(editing,firstPrompt,false);
  await editing.locator("[data-prompt]").fill("Keep this next message as a draft.");
  await editing.locator("[data-stop-agent]").click();
  await editing.evaluate((id) => window.piWebDemo.finishJob(id),stopped.id);
  expect((await snapshot(editing)).jobs.at(-1).status).toBe("stopped");
  expect((await snapshot(editing)).jobs).toHaveLength(1);
  await expect(editing.locator(".view:visible")).toHaveCount(1);
  await expect(doc(editing)).toBeVisible();
  const pending = await message(editing,firstPrompt,false);
  await editing.locator('[data-close-chat]').click();
  await doc(editing).fill("Typing while Pi works. Keep this draft.");
  await doc(editing).evaluate((editor) => { editor.focus(); editor.setSelectionRange(2,8); });
  const keptRoute = editing.url();
  await editing.evaluate((id) => window.piWebDemo.finishJob(id),pending.id);
  expect(editing.url()).toBe(keptRoute); await expect(doc(editing)).toBeFocused();
  expect(await doc(editing).evaluate((editor) => [editor.selectionStart,editor.selectionEnd])).toEqual([2,8]);
  await expect(editing.locator(".view:visible")).toHaveCount(1);
  await expect(editing.locator("[data-show-job]")).toBeVisible();
  await editing.locator("[data-show-job]").click();
  await expect(editing.locator(".view:visible")).toHaveCount(2);
  await editing.locator('.bottomTabs [data-open-item="pi-release-doc"]').click();
  await expect(doc(editing)).toHaveValue("Typing while Pi works. Keep this draft.");
  const proposed = await message(editing,editPrompt,false);
  await editing.locator('[data-close-chat]').click();
  await doc(editing).fill("A newer draft, after I asked Pi to edit.");
  await editing.evaluate((id) => window.piWebDemo.finishJob(id),proposed.id);
  await expect(doc(editing)).toHaveValue("A newer draft, after I asked Pi to edit.");
  expect((await snapshot(editing)).jobs.at(-1).edit.state).toBe("proposed");
  await editing.locator('.topbar [data-open-chat]').click();
  await editing.locator(`[data-apply-edit="${proposed.id}"]`).click();
  await expect(doc(editing)).toHaveValue(/A newer draft, after I asked Pi to edit/);
  await expect(doc(editing)).toHaveValue(/compact map before launch/);

  // Switching workspaces while an agent runs keeps the destination and its filter.
  const { page: background, context: shared } = await setup();
  const mirror = await shared.newPage();
  mirror.on("pageerror", (error) => errors.push(error.message));
  await mirror.goto(base + "/?work=coordinate-release&tab=pi-release-doc");
  await doc(mirror).focus();
  const mirrorRoute = mirror.url();
  const job = await message(background,firstPrompt,false);
  await work(background,"trail-usage");
  await background.locator('[data-range="7"]').click(); const route = background.url();
  await background.evaluate((id) => window.piWebDemo.finishJob(id),job.id);
  expect(background.url()).toBe(route); await expect(background.locator(".dashboard")).toBeVisible();
  await expect(background.locator('[data-range="7"]')).toHaveClass(/selected/);
  await expect(background.locator(".chatPopup")).toHaveCount(0);
  await background.locator("[data-updates]").click();
  await expect(background.locator(".update")).toContainText("Coordinate the release");
  await background.locator(`[data-visit-job="${job.id}"]`).click();
  await expect(background.locator('[data-view="browser"]')).toBeVisible();
  await expect(background.locator(".chatPopup")).toBeVisible();
  await expect(doc(mirror)).toBeVisible();
  await expect(doc(mirror)).toBeFocused();
  expect(mirror.url()).toBe(mirrorRoute);
  await expect(mirror.locator(`[data-show-job="${job.id}"]`)).toBeVisible();
  await mirror.locator(`[data-show-job="${job.id}"]`).click();
  await expect(mirror.locator('[data-view="browser"]')).toBeVisible();
  await mirror.close();

  // One connected app can show only the roots captured in the prompt's context.
  const { page: scoped } = await setup();
  await scoped.locator('.topbar [data-open-chat]').click();
  await scoped.locator(".chatContext summary").click();
  await scoped.locator('[name="executionWorkspace"]').selectOption("trail-notes");
  await scoped.locator('[name="readWorkspace"][value="trail-notes"]').uncheck();
  await scoped.locator('[name="readWorkspace"][value="pi-web"]').uncheck();
  await expect(scoped.locator("[data-send]")).toBeDisabled();
  await scoped.locator('[name="readWorkspace"][value="pi-web"]').check();
  const scopedJob = await message(scoped,"Open the browser and planner and check the launch.");
  expect(scopedJob.executionWorkspaceId).toBe("trail-notes"); expect(scopedJob.readWorkspaceIds).toEqual(["pi-web"]);
  expect(scopedJob.launch.items).toHaveLength(2);
  // The app uses the work's permitted roots, not the agent's narrower prompt selection.
  expect((await snapshot(scoped)).work.find((entry) => entry.id === "coordinate-release").workspaceIds).toHaveLength(2);
  await work(scoped,"pi-release"); await open(scoped,"release-planner");
  const limitedApp = scoped.frameLocator('[data-app="release-planner"]');
  await expect(limitedApp.locator(".row")).toHaveCount(2);
  const outside = await limitedApp.locator("body").evaluate(() => new Promise((resolve) => {
    const receive=(event)=>{if(event.data?.id===991){removeEventListener("message",receive);resolve(event.data);}};
    addEventListener("message",receive);parent.postMessage({jsonrpc:"2.0",id:991,method:"tools/call",params:{name:"set_launch_status",arguments:{id:"trail-map",status:"ready"}}},"*");
  }));
  expect(outside.error.message).toContain("cannot update");

  // Same-named files keep their roots; independent tabs keep their current work.
  await work(background,"coordinate-release"); await open(background,"pi-readme");
  await doc(background,"pi-readme").fill("Pi Web README saved alone."); await background.locator('[data-save="pi-readme"]').click();
  await open(background,"trail-readme"); await expect(doc(background,"trail-readme")).toHaveValue(/Trail Notes workspace/);
  const other = await shared.newPage(); other.on("pageerror",(error)=>errors.push(error.message));
  await other.goto(base + "/?work=coordinate-release&tab=pi-readme");
  await background.locator('.bottomTabs [data-open-item="pi-readme"]').click();
  await doc(background,"pi-readme").fill("My active Pi Web README draft."); await doc(background,"pi-readme").focus();
  await doc(other,"pi-readme").fill("The other window's README draft.");
  await expect(background.locator(".conflict")).toBeVisible();
  await expect(doc(background,"pi-readme")).toHaveValue("My active Pi Web README draft.");
  await background.locator('[data-resolve="pi-readme"][data-mine="false"]').click();
  await expect(doc(background,"pi-readme")).toHaveValue("The other window's README draft.");
  await other.close();

  // Phones keep one primary file/app, with chat floating above the same bottom tabs.
  const { page: phone } = await setup({viewport:{width:393,height:851},isMobile:true,hasTouch:true});
  await expect(phone.locator(".view:visible")).toHaveCount(1);
  await message(phone,firstPrompt);
  await expect(phone.locator(".view:visible")).toHaveCount(1);
  await expect(phone.locator(".chatPopup")).toBeVisible();
  expect(await phone.locator(".chatPopup").evaluate((node)=>node.getBoundingClientRect().width)).toBeLessThan(393);
  await phone.locator('[data-close-chat]').click();
  await phone.locator('.bottomTabs [data-open-item="release-planner"]').click();
  await expect(phone.locator('[data-view="release-planner"]')).toBeVisible();
  await expect(phone.locator(".view:visible")).toHaveCount(1);
  expect(await phone.locator('.bottomTab button').first().evaluate((node)=>node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  await phone.screenshot({path:join(output,"mobile-app-tabs.png")});
  await phone.locator(".topbar [data-toggle-work]").click();
  await expect(phone.locator('#overlay [data-work="coordinate-release"]')).toHaveCount(1);
  await phone.locator('#overlay [data-work="trail-usage"]').click();
  await phone.locator('[data-range="7"]').click();
  await work(phone,"coordinate-release");
  await phone.setViewportSize({width:768,height:1024}); await expect(phone.locator(".view:visible")).toHaveCount(1);
  await phone.setViewportSize({width:2560,height:1440}); await expect(phone.locator(".view:visible")).toHaveCount(2);
  expect(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await phone.screenshot({path:join(output,"dense-desktop.png")});

  await page.goto(base+"/?work=pi-release&tab=trail-readme");
  await expect(page.locator(".routeProblem")).toContainText("has not been opened");
  await expect(page.locator(".view")).toHaveCount(0);
  expect(errors).toEqual([]); expect(externalRequests).toEqual([]);
  console.log("Passed: one work drawer and file/app/browser tabs; floating chat; prompt-driven opening, comparison, scoped draft edit, pinning and closing; actual sandboxed preview inspection; interactive MCP-style app with shared agent/UI tools; bridge scoping and isolation; deferred view changes while editing or in another work; draft conflict recovery; history/reload; same-name files across roots; mobile/tablet single view and 44px targets; dense desktop; no external requests.");
} finally {
  for (const context of contexts) await context.close();
  await browser.close(); await new Promise((resolve)=>server.close(resolve));
}
