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
