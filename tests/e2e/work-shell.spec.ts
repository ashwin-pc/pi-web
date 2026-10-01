import { expect, test, type Page, type APIRequestContext } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

test.beforeEach(async ({ page }) => { await page.addInitScript(() => localStorage.removeItem("pi-web.shell")); });
async function setup(request: APIRequestContext) {
  const dir = await mkdtemp(join(tmpdir(), "pi-work-ui-"));
  for (const name of ["a", "b"]) { await mkdir(join(dir, name)); await writeFile(join(dir, name, "note.md"), `Project ${name}\n`); }
  const roots = [];
  for (const name of ["a", "b"]) { const response = await request.post("/api/workspaces", { data: { root: join(dir, name) } }); expect(response.ok()).toBeTruthy(); roots.push((await response.json()).workspace); }
  const { current } = await (await request.get("/api/workspaces")).json(), state = await (await request.get("/api/state")).json();
  const create = async (title: string) => (await (await request.post("/api/work", { data: { title: title + randomUUID().slice(0, 8), workspaceIds: [current.id, ...roots.map(r => r.id)], sessionIds: [state.sessionId] } })).json()).work;
  const work = await create("Release "), other = await create("Other ");
  return { dir, roots, current, sessionId: state.sessionId, work, other };
}
async function openFile(page: Page, path: string, rootId: string, split = false) {
  await page.locator(split ? "#workSplit" : "#workOpen").click();
  const modal = page.locator("dialog.workDialog");
  await modal.locator("select").selectOption(rootId);
  await modal.getByRole("textbox", { name: "Open file", exact: true }).fill(path);
  await modal.getByRole("button", { name: "Open file", exact: true }).click();
}

async function edit(page: Page, selector: string, text: string) {
  const content = page.locator(selector); await content.selectText(); await page.keyboard.insertText(text);
}

test("real work spans projects and restores unsaved files after switching and reload", async ({ page, request }) => {
  const f = await setup(request);
  try {
    await page.goto(`/?work=${f.work.id}`);
    await expect(page.locator("#filesPanel")).toBeVisible();
    await expect(page.locator("main.workChat")).toBeHidden();
    await openFile(page, "note.md", f.roots[0].id);
    const content = page.locator("#fileEditor .cm-content");
    await expect(content).toContainText("Project a");
    await edit(page, "#fileEditor .cm-content", "My unsaved notes\n");
    await page.locator("#workToggle").click();
    if (!await page.locator("#workDrawer").isVisible()) await page.locator("#workToggle").click();
    await page.locator(`[data-work="${f.other.id}"]`).click();
    await openFile(page, "note.md", f.roots[1].id);
    await expect(content).toContainText("Project b");
    await page.locator("#workToggle").click();
    if (!await page.locator("#workDrawer").isVisible()) await page.locator("#workToggle").click();
    await page.locator(`[data-work="${f.work.id}"]`).click();
    await expect(content).toContainText("My unsaved notes");
    expect(await readFile(join(f.dir, "a/note.md"), "utf8")).toBe("Project a\n");
    page.on("dialog", dialog => void dialog.accept());
    await page.reload();
    await expect(content).toContainText("My unsaved notes");
    await page.locator("#fileSaveButton").click();
    await expect.poll(() => readFile(join(f.dir, "a/note.md"), "utf8")).toBe("My unsaved notes\n");
    expect(await readFile(join(f.dir, "b/note.md"), "utf8")).toBe("Project b\n");
    const saved = (await (await request.get("/api/work")).json()).work.find((w: { id: string }) => w.id === f.work.id);
    expect(saved.references).toContainEqual({ kind: "file", workspaceId: f.roots[0].id, path: "note.md" });
    const width = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth); expect(width).toBeTruthy();
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("two files use their original projects in a split, with one primary view on mobile", async ({ page, request }, info) => {
  const f = await setup(request);
  try {
    await page.goto(`/?work=${f.work.id}`); await expect(page.locator("#filesPanel")).toBeVisible();
    await openFile(page, "note.md", f.roots[0].id);
    if (info.project.name !== "desktop") {
      await openFile(page, "note.md", f.roots[1].id);
      await expect(page.locator("#fileEditor .cm-content")).toContainText("Project b");
      await expect(page.locator("#workCompanionFile")).toBeHidden();
    } else {
      await openFile(page, "note.md", f.roots[1].id, true);
      await expect(page.locator("#fileEditor .cm-content")).toContainText("Project a");
      await expect(page.locator("#workCompanionFile .cm-content")).toContainText("Project b");
      await edit(page, "#workCompanionFile .cm-content", "Companion draft\n");
      await page.locator("#workCompanionFile").getByRole("button", { name: "Save", exact: true }).click();
      await expect.poll(() => readFile(join(f.dir, "b/note.md"), "utf8")).toBe("Companion draft\n");
      expect(await readFile(join(f.dir, "a/note.md"), "utf8")).toBe("Project a\n");
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator("#workCompanionFile")).toBeHidden();
      await page.locator('.workTab.companion > button').first().click();
      await expect(page.locator("#fileEditor .cm-content")).toContainText("Companion draft");
      await page.setViewportSize({ width: 1920, height: 1080 });
      await expect(page.locator("#workCompanionFile .cm-content")).toContainText("Project a");
    }
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("Pi floats over the work and submits explicit scope and the current draft", async ({ page, request }) => {
  const f = await setup(request);
  try {
    await page.goto(`/?work=${f.work.id}`); await expect(page.locator("#filesPanel")).toBeVisible();
    await openFile(page, "note.md", f.roots[0].id);
    await edit(page, "#fileEditor .cm-content", "Unsaved user plan\n");
    await page.locator("#workAskPi").click();
    await expect(page.locator("main.workChat")).toBeVisible();
    await expect(page.locator("#filesPanel")).toBeVisible();
    await page.locator("#prompt").fill("Read my current draft and explain it");
    const sent = page.waitForRequest(r => r.url().endsWith("/api/prompt") && r.method() === "POST");
    await page.locator("#primaryButton").click();
    const payload = (await sent).postDataJSON();
    expect(payload.workContext).toMatchObject({ workId: f.work.id, readWorkspaceIds: [f.current.id, f.roots[0].id, f.roots[1].id], drafts: [{ resource: { kind: "file", workspaceId: f.roots[0].id, path: "note.md" }, text: "Unsaved user plan\n" }] });
    expect(payload.workContext.windowId).toBeTruthy();
    await page.getByRole("button", { name: "Minimize", exact: true }).click();
    await expect(page.locator("main.workChat")).toBeHidden();
    await expect(page.locator("#fileEditor .cm-content")).toContainText("Unsaved user plan");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("agent view requests defer while editing or in a different work and protect pins", async ({ page, request }) => {
  const f = await setup(request);
  try {
    await page.goto(`/?work=${f.work.id}`); await expect(page.locator("#filesPanel")).toBeVisible();
    await openFile(page, "note.md", f.roots[0].id);
    await page.locator("#fileEditor .cm-content").click();
    const scene = await page.evaluate(id => JSON.parse(sessionStorage.getItem("pi-web.work.scene/" + id)!), f.work.id);
    const context = { workId: f.work.id, windowId: "external-agent-window", revision: scene.revision, readWorkspaceIds: f.work.workspaceIds };
    const item = { kind: "file", workspaceId: f.roots[1].id, path: "note.md" };
    const response = await request.post("/api/work/views", { data: { sessionId: f.sessionId, context, action: "open", item } }); expect(response.ok()).toBeTruthy();
    await expect(page.locator("#workUpdates")).toContainText("ready");
    await expect(page.locator("#fileEditor .cm-content")).toContainText("Project a");
    await page.locator("#workUpdates").click();
    await page.getByRole("button", { name: "Show in this work", exact: true }).last().click();
    await expect(page.locator("#fileEditor .cm-content")).toContainText("Project b");
    const btab = page.locator(".workTab.active"); await btab.getByRole("button", { name: "Pin note.md", exact: true }).click();
    await request.post("/api/work/views", { data: { sessionId: f.sessionId, context, action: "close", item } });
    await page.locator("#workUpdates").click(); await page.getByRole("button", { name: "Show in this work", exact: true }).last().click();
    await expect(page.locator("#fileEditor .cm-content")).toContainText("Project b");
    expect((await request.post("/api/work/views", { data: { sessionId: f.sessionId, context: { ...context, readWorkspaceIds: [f.roots[0].id] }, action: "open", item } })).status()).toBe(403);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("automatic requests stay in the originating window and can restore its arrangement", async ({ page, context, request }) => {
  const f = await setup(request); let clientId = "";
  page.on("request", req => { clientId = req.headers()["x-pi-web-client-id"] || clientId; });
  const second = await context.newPage(); await second.addInitScript(() => localStorage.removeItem("pi-web.shell"));
  try {
    await page.goto(`/?work=${f.work.id}`); await expect(page.locator("#filesPanel")).toBeVisible(); await openFile(page, "note.md", f.roots[0].id);
    await second.goto(`/?work=${f.other.id}`); await expect(second.locator("#filesPanel")).toBeVisible(); await openFile(second, "note.md", f.roots[0].id);
    await page.locator("#workOpen").focus();
    const revision = await page.evaluate(id => JSON.parse(sessionStorage.getItem("pi-web.work.scene/" + id)!).revision, f.work.id);
    const commandContext = { workId: f.work.id, windowId: clientId, revision, readWorkspaceIds: f.work.workspaceIds };
    const response = await request.post("/api/work/views", { data: { sessionId: f.sessionId, context: commandContext, action: "open", item: { kind: "file", workspaceId: f.roots[1].id, path: "note.md" } } }); expect(response.ok()).toBeTruthy();
    await expect(page.locator("#fileEditor .cm-content")).toContainText("Project b");
    await expect(second.locator("#fileEditor .cm-content")).toContainText("Project a");
    await page.getByRole("button", { name: "Restore my previous view", exact: true }).click();
    await expect(page.locator("#fileEditor .cm-content")).toContainText("Project a");
    await page.locator("#workAskPi").click(); await expect(page.locator("main.workChat")).toBeVisible(); await page.getByRole("button", { name: "Minimize", exact: true }).click();
    await page.locator("#workToggle").click(); if (!await page.locator("#workDrawer").isVisible()) await page.locator("#workToggle").click();
    await page.locator("#workDrawer").getByRole("button", { name: "Preferences", exact: true }).click(); await expect(page.locator("#settingsPanel")).toBeVisible();
    await page.locator("#settingsCloseButton").click(); await expect(page.locator("#fileEditor .cm-content")).toContainText("Project a");
  } finally { await second.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test("session links open Pi in the work that owns the conversation", async ({ page, request }) => {
  const f = await setup(request);
  try {
    await page.goto(`/?sessionId=${f.sessionId}`);
    await expect(page.locator("main.workChat")).toBeVisible();
    const workId = new URL(page.url()).searchParams.get("work");
    const work = (await (await request.get("/api/work")).json()).work.find((work: { id: string }) => work.id === workId);
    expect(work.sessionIds).toContain(f.sessionId);
    expect(new URL(page.url()).searchParams.get("sessionId")).toBe(f.sessionId);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("a late file response cannot replace the next work or its URL", async ({ page, request }) => {
  const f = await setup(request);
  let release!: () => void, requested!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), loading = new Promise<void>(resolve => { requested = resolve; });
  try {
    await page.goto(`/?work=${f.work.id}`); await expect(page.locator("#filesPanel")).toBeVisible();
    await page.route("**/api/files/read?**", async route => { const url = new URL(route.request().url()); if (url.searchParams.get("workspaceId") === f.roots[0].id) { const response = await route.fetch(); requested(); await gate; await route.fulfill({ response }); } else await route.continue(); });
    await openFile(page, "note.md", f.roots[0].id); await loading;
    await page.locator("#workToggle").click(); if (!await page.locator("#workDrawer").isVisible()) await page.locator("#workToggle").click(); await page.locator(`[data-work="${f.other.id}"]`).click();
    await openFile(page, "note.md", f.roots[1].id); await expect(page.locator("#fileEditor .cm-content")).toContainText("Project b");
    release(); await expect.poll(() => new URL(page.url()).searchParams.get("work")).toBe(f.other.id); await expect(page.locator("#fileEditor .cm-content")).toContainText("Project b");
    await page.unrouteAll({ behavior: "wait" }); expect(new URL(page.url()).searchParams.get("work")).toBe(f.other.id);
  } finally { release(); await rm(f.dir, { recursive: true, force: true }); }
});

test("the Work dialog creates a project grouping and removes only its associations", async ({ page, request }) => {
  const f = await setup(request);
  try {
    await page.goto(`/?work=${f.work.id}`); await expect(page.locator("#filesPanel")).toBeVisible();
    await page.locator("#workToggle").click(); if (!await page.locator("#workDrawer").isVisible()) await page.locator("#workToggle").click();
    await page.locator("#workDrawer").getByRole("button", { name: "New", exact: true }).click();
    const modal = page.locator("dialog.workDialog"); await modal.getByRole("textbox", { name: "Work name" }).fill("My cross-project goal");
    for (const root of f.roots) await modal.locator(`input[value="${root.id}"]`).check();
    await modal.getByRole("button", { name: "Create work", exact: true }).click(); await expect(page.locator(".workTitle strong")).toHaveText("My cross-project goal");
    await openFile(page, "note.md", f.roots[1].id); await expect(page.locator("#fileEditor .cm-content")).toContainText("Project b");
    await page.locator("#workToggle").click(); if (!await page.locator("#workDrawer").isVisible()) await page.locator("#workToggle").click();
    await page.locator("#workDrawer").getByRole("button", { name: "Edit this work", exact: true }).click();
    await modal.locator(`input[value="${f.roots[1].id}"]`).uncheck(); await modal.getByRole("button", { name: "Save work", exact: true }).click();
    await expect(modal).toHaveCount(0); await expect(page.locator(".workTitle small")).not.toContainText("b");
    expect(await readFile(join(f.dir, "b/note.md"), "utf8")).toBe("Project b\n");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
