import { expect, test } from "@playwright/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

test("Files and Git accept workspace identity without a session", async ({ request }) => {
  const response = await request.get("/api/workspaces");
  expect(response.ok()).toBeTruthy();
  const { current } = await response.json();
  expect(current).toMatchObject({ runtime: "local", name: "pi-web" });
  const query = `workspaceId=${encodeURIComponent(current.id)}`;
  const tree = await request.get(`/api/files/tree?${query}`);
  expect(tree.ok()).toBeTruthy();
  expect((await tree.json()).entries.some((item: { name: string }) => item.name === "README.md")).toBeTruthy();
  const read = await request.get(`/api/files/read?${query}&path=README.md`);
  expect(read.ok()).toBeTruthy();
  const repos = await request.get(`/api/git/repos?${query}`);
  expect(repos.ok()).toBeTruthy();
  expect((await request.get(`/api/git/status?${query}`)).ok()).toBeTruthy();
  expect((await request.get(`/api/git/log?${query}`)).ok()).toBeTruthy();
  expect((await request.get(`/api/git/diff?${query}&path=README.md`)).ok()).toBeTruthy();

  const dir = await mkdtemp(join(current.root, ".pi/web/workspace-test-"));
  const path = `${dir.slice(current.root.length + 1)}/note.txt`;
  try {
    await writeFile(join(dir, "note.txt"), "before");
    const { revision } = await (await request.get(`/api/files/read?${query}&path=${encodeURIComponent(path)}`)).json();
    const saved = await request.put("/api/files/write", { data: { workspaceId: current.id, path, content: "after", expectedRevision: revision } });
    expect(saved.ok()).toBeTruthy();
    expect(await readFile(join(dir, "note.txt"), "utf8")).toBe("after");
    const stale = await request.put("/api/files/write", { data: { workspaceId: current.id, path, content: "stale", expectedRevision: revision } });
    expect(stale.status()).toBe(409);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const state = await (await request.get("/api/state")).json();
  expect((await request.get(`/api/files/read?sessionId=${encodeURIComponent(state.sessionId)}&path=README.md`)).ok()).toBeTruthy();
  expect((await request.get("/api/files/tree?workspaceId=unknown")).status()).toBe(404);
  expect((await request.get("/api/git/repos?workspaceId=unknown")).status()).toBe(404);
  expect((await request.get(`/api/files/read?${query}&path=../package.json`)).status()).toBe(400);
});

test("workspace destinations are URL addressable before prompting", async ({ page }) => {
  await page.goto("/?surface=files");
  await expect(page.locator("#filesPanel")).toBeVisible();
  await expect(page.locator('.fileTreeFile[title="README.md"]')).toBeVisible();
  const treeRequests: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/api/git/repos")) treeRequests.push(request.url()); });
  await page.locator('[data-workspace-surface="git"]').click();
  await expect(page.locator("#gitPanel")).toBeVisible();
  await expect(page.locator("#filesPanel")).toBeHidden();
  await expect(page).toHaveURL(/surface=git/);
  await expect.poll(() => treeRequests.length).toBeGreaterThan(0);
  expect(new URL(treeRequests[0]).searchParams.has("workspaceId")).toBeTruthy();
  expect(new URL(treeRequests[0]).searchParams.has("sessionId")).toBeFalsy();
  await page.locator('[data-workspace-surface="chat"]').click();
  await expect(page.locator("#gitPanel")).toBeHidden();
  await expect(page).toHaveURL(/surface=chat/);
  await page.goBack();
  await expect(page.locator("#gitPanel")).toBeVisible();
  await page.goBack();
  await expect(page.locator("#filesPanel")).toBeVisible();
  await page.reload();
  await expect(page.locator("#filesPanel")).toBeVisible();
});

test("a shared resource link opens the same file as direct navigation", async ({ page, request }) => {
  const { current } = await (await request.get("/api/workspaces")).json();
  await page.goto(`/?surface=files&workspaceId=${current.id}&path=README.md`);
  await expect(page.locator('.fileTabLabel[title="README.md"]')).toBeVisible();
  const direct = new URL(page.url());
  await page.locator('[data-workspace-surface="chat"]').click();
  await page.evaluate((href) => {
    const link = document.createElement("a"); link.id = "resourceProbe"; link.href = href; link.textContent = "Open README";
    document.querySelector("#statusBar")!.append(link);
  }, direct.href);
  await page.locator("#resourceProbe").click();
  await expect(page.locator("#filesPanel")).toBeVisible();
  await expect(page.locator('.fileTabLabel[title="README.md"]')).toBeVisible();
  expect(new URL(page.url()).searchParams.get("workspaceId")).toBe(current.id);
  expect(new URL(page.url()).searchParams.get("path")).toBe("README.md");
  await page.reload();
  await expect(page.locator('.fileTabLabel[title="README.md"]')).toBeVisible();
});

test("Ask agent carries a file selection and Back restores the mobile editor", async ({ page, request }) => {
  const { current } = await (await request.get("/api/workspaces")).json();
  await page.goto(`/?surface=files&workspaceId=${current.id}&path=README.md`);
  await expect(page.locator('.fileTabLabel[title="README.md"]')).toBeVisible();
  await page.locator(".cm-content").click();
  await page.locator(".cm-content").press("Control+a");
  await page.getByRole("button", { name: "Ask agent", exact: true }).click();
  await expect(page.locator("#filesPanel")).toBeHidden();
  await expect(page.locator(".contextAttachmentChip")).toContainText("README.md");
  await page.goBack();
  await expect(page.locator("#filesPanel")).toBeVisible();
  await expect(page.locator("#filesPanel")).toHaveAttribute("data-mobile-view", "editor");
  await expect(page.locator('.fileTabLabel[title="README.md"]')).toBeVisible();
  await page.locator('[data-workspace-surface="chat"]').click();
  await page.locator("#prompt").fill("Explain this selection");
  const promptRequest = page.waitForRequest((req) => req.url().endsWith("/api/prompt") && req.method() === "POST");
  await page.locator("#primaryButton").click();
  const payload = (await promptRequest).postDataJSON();
  expect(payload.attachments[0]).toMatchObject({ type: "resource", resource: { kind: "file", workspaceId: current.id, path: "README.md" }, selection: { fromLine: 1 } });
  expect(payload.attachments[0].selection.text).toContain("pi-web");
  await expect(page.locator(".resourceMessageLink").first()).toBeVisible();
  await page.locator(".resourceMessageLink").first().click();
  await expect(page.locator("#filesPanel")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("path")).toBe("README.md");
});

test("Ask agent returns to the selected Git diff rather than the first changed file", async ({ page, request }) => {
  const { current } = await (await request.get("/api/workspaces")).json();
  const files = ["first.ts", "selected.ts"].map((path) => ({ path, indexStatus: " ", worktreeStatus: "M", staged: false, label: "modified" }));
  await page.route("**/api/git/repos**", (route) => route.fulfill({ json: { ok: true, cwd: current.root, repos: [{ path: ".", root: current.root, branch: "main", upstream: "", ahead: 0, behind: 0, dirtyCount: 2, isCurrent: true }] } }));
  await page.route("**/api/git/status?**", (route) => route.fulfill({ json: { ok: true, isRepo: true, root: current.root, branch: "main", ahead: 0, behind: 0, files } }));
  await page.route("**/api/git/log?**", (route) => route.fulfill({ json: { ok: true, commits: [] } }));
  await page.route("**/api/git/diff?**", (route) => route.fulfill({ json: { ok: true, diff: "diff --git a/selected.ts b/selected.ts\n--- a/selected.ts\n+++ b/selected.ts\n@@ -1 +1 @@\n-old\n+new" } }));
  await page.goto(`/?surface=git&workspaceId=${current.id}&path=selected.ts&repo=.&staged=0`);
  await expect(page.locator(".gitFileItem.selected .gitFilePath")).toHaveText("selected.ts");
  await page.locator("#gitPanel .resourceAskButton").click();
  await expect(page.locator(".contextAttachmentChip")).toContainText("selected.ts");
  await page.goBack();
  await expect(page.locator("#gitPanel")).toBeVisible();
  await expect(page.locator(".gitFileItem.selected .gitFilePath")).toHaveText("selected.ts");
  expect(new URL(page.url()).searchParams.get("path")).toBe("selected.ts");
});

test("generated HTML is an interactive peer with an opaque sandbox and no host bridge", async ({ page, request }) => {
  const { current } = await (await request.get("/api/workspaces")).json();
  await page.route("**/api/files/read?**", (route) => route.fulfill({ json: { ok: true, content: `
    <button id="counter">0</button><span id="boundary"></span>
    <script>counter.onclick=()=>counter.textContent=String(Number(counter.textContent)+1);
    try { parent.document.body.dataset.escaped='yes'; boundary.textContent='escaped'; } catch { boundary.textContent='isolated'; }
    </script>` } }));
  await page.goto(`/?surface=preview&workspaceId=${current.id}&appPath=counter.html`);
  const frame = page.frameLocator('.generatedAppBody iframe');
  await expect(frame.locator("#boundary")).toHaveText("isolated");
  await expect(page.locator(".generatedAppBody iframe")).toHaveAttribute("sandbox", "allow-scripts");
  await frame.getByRole("button", { name: "0", exact: true }).click();
  await expect(frame.locator("#counter")).toHaveText("1");
  expect(await page.locator("body").getAttribute("data-escaped")).toBeNull();
  await page.locator('[data-workspace-surface="chat"]').click();
  await expect(page.locator(".generatedAppPanel")).toBeHidden();
  await page.goBack();
  await expect(page.locator(".generatedAppPanel")).toBeVisible();
  await expect(frame.locator("#boundary")).toHaveText("isolated");
});

test("trusted extension apps share shell navigation, reload and browser history", async ({ page }) => {
  await page.request.post("/api/mock/reset");
  await page.request.post("/api/mock/state", { data: { webContributions: [
    { version: 1, slot: "panel", key: "counter", kind: "rendered", label: "Counter app", title: "Counter app" },
  ] } });
  await page.route("**/api/web-contributions/invoke", (route) => {
    const action = route.request().postDataJSON().event?.action;
    return route.fulfill({ json: { ok: true, html: `<button data-web-action="increment">${action === "increment" ? "1" : "0"}</button>` } });
  });
  await page.goto("/?surface=app&app=counter");
  await expect(page.locator("#webExtensionPanel")).toBeVisible();
  await expect(page.locator(".foreignAppBoundary")).toHaveText("Trusted extension");
  await page.locator("#webExtensionPanel button[data-web-action]").click();
  await expect(page.locator("#webExtensionPanel button[data-web-action]")).toHaveText("1");
  await page.locator('[data-workspace-surface="files"]').click();
  await expect(page.locator("#webExtensionPanel")).toBeHidden();
  await page.goBack();
  await expect(page.locator("#webExtensionPanel")).toBeVisible();
  await page.reload();
  await expect(page.locator("#webExtensionPanel button[data-web-action]")).toHaveText("0");
});

test("resource identity keeps same-name files and saves isolated across workspaces", async ({ page }) => {
  const alpha = { id: "local-0000000000000001", root: "/alpha", name: "alpha", runtime: "local" };
  const beta = { id: "local-0000000000000002", root: "/beta", name: "beta", runtime: "local" };
  await page.route("**/api/workspaces?**", (route) => route.fulfill({ json: { ok: true, current: alpha, workspaces: [alpha, beta] } }));
  await page.route("**/api/files/tree?**", (route) => route.fulfill({ json: { ok: true, entries: [] } }));
  await page.route("**/api/files/read?**", (route) => {
    const workspaceId = new URL(route.request().url()).searchParams.get("workspaceId");
    return route.fulfill({ json: { ok: true, content: workspaceId === alpha.id ? "alpha file" : "beta file", revision: "v1", language: "markdown" } });
  });
  await page.route("**/api/files/write", (route) => route.fulfill({ json: { ok: true, revision: "v2" } }));
  await page.goto(`/?surface=files&workspaceId=${alpha.id}&path=README.md`);
  await expect(page.locator(".cm-content")).toHaveText("alpha file");
  await page.evaluate((resource) => window.dispatchEvent(new CustomEvent("pi-web-open-resource", { detail: resource })), { kind: "file", workspaceId: beta.id, path: "README.md" });
  await expect(page.locator(".cm-content")).toHaveText("beta file");
  await page.locator(".cm-content").click();
  await page.locator(".cm-content").press("Control+a");
  await page.locator(".cm-content").press("b");
  const saveRequest = page.waitForRequest((request) => request.url().endsWith("/api/files/write"));
  await page.locator("#fileSaveButton").click();
  expect((await saveRequest).postDataJSON()).toMatchObject({ workspaceId: beta.id, path: "README.md", content: "b" });
});

test("an HTML file launches its saved app from Files and Back restores the editor", async ({ page, request }) => {
  const { current } = await (await request.get("/api/workspaces")).json();
  await page.route("**/api/files/read?**", (route) => route.fulfill({ json: {
    ok: true, content: '<button id="hello">Hello</button>', revision: "v1", language: "html",
  } }));
  await page.goto(`/?surface=files&workspaceId=${current.id}&path=hello.html`);
  await expect(page.locator(".cm-content")).toContainText("Hello");
  await page.getByRole("button", { name: "Run app", exact: true }).click();
  await expect(page.frameLocator('.generatedAppBody iframe').getByRole("button", { name: "Hello", exact: true })).toBeVisible();
  await expect(page.locator("#filesPanel")).toBeHidden();
  expect(new URL(page.url()).searchParams.get("appPath")).toBe("hello.html");
  await page.goBack();
  await expect(page.locator("#filesPanel")).toBeVisible();
  await expect(page.locator('.fileTabLabel[title="hello.html"]')).toBeVisible();
});
