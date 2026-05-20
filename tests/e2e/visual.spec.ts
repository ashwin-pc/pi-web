import { expect, test } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function sendPrompt(page: import("@playwright/test").Page, prompt: string) {
  await page.locator("#prompt").fill(prompt);
  await page.locator("#primaryButton").click();
}

async function scrollMessagesToBottom(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    const messages = document.querySelector("#messages");
    if (messages) messages.scrollTop = messages.scrollHeight;
  });
}

async function startEmptySession(page: import("@playwright/test").Page) {
  await page.locator("#sessionButton").click();
  await page.locator("#sessionNewButton").click();
  await expect(page.locator("#statusTitle")).toHaveText("New session");
}

async function mockGitApi(page: import("@playwright/test").Page) {
  const commit = {
    hash: "debd35dbb8ba41a56c3e6b22dbf7ed93a310443a",
    shortHash: "debd35d",
    parents: ["3179eff"],
    author: "Ashwin Pc",
    date: "2026-05-07T09:58:54.000Z",
    refs: ["HEAD -> main", "origin/main"],
    subject: "Improve showcase artifact image",
  };
  const diff = [
    "diff --git a/src/git/diffView.ts b/src/git/diffView.ts",
    "index 1111111..2222222 100644",
    "--- a/src/git/diffView.ts",
    "+++ b/src/git/diffView.ts",
    "@@ -1,5 +1,7 @@",
    "-import { renderUnifiedPatch } from \"../components/diff.js\";",
    "+import { Columns2, createElement, Rows2 } from \"lucide\";",
    "+import { renderUnifiedPatch, setDiffLayout } from \"../components/diff.js\";",
    " import type { GitFileStatus } from \"./types.js\";",
    " ",
    " export function renderUnifiedDiff(diff: string) {",
    "-  return renderUnifiedPatch(diff, { stacked: true });",
    "+  return renderUnifiedPatch(diff, { stacked: window.matchMedia(\"(max-width: 700px)\").matches });",
    " }",
    "diff --git a/src/git/commitView.ts b/src/git/commitView.ts",
    "index 3333333..4444444 100644",
    "--- a/src/git/commitView.ts",
    "+++ b/src/git/commitView.ts",
    "@@ -20,6 +20,10 @@ export function renderCommitView(options) {",
    "   container.append(card);",
    " ",
    "+  const filesTitle = document.createElement(\"h3\");",
    "+  filesTitle.textContent = `Changed files (${files.length})`;",
    "+  container.append(filesTitle, renderUnifiedDiff(diff));",
    "+",
    "   return container;",
    " }",
  ].join("\n");

  await page.route("**/api/git/repos", (route) => route.fulfill({ json: {
    ok: true,
    cwd: "/Users/ashwin/projects/pi-web",
    depth: 1,
    repos: [{ path: ".", root: "/Users/ashwin/projects/pi-web", branch: "main", upstream: "origin/main", ahead: 0, behind: 0, dirtyCount: 2, isCurrent: true }],
  } }));
  await page.route("**/api/git/status?**", (route) => route.fulfill({ json: {
    ok: true,
    isRepo: true,
    root: "/Users/ashwin/projects/pi-web",
    branch: "main",
    upstream: "origin/main",
    defaultRemoteBranch: "origin/main",
    ahead: 0,
    behind: 0,
    files: [
      { path: "src/git/diffView.ts", indexStatus: " ", worktreeStatus: "M", label: "modified", staged: false },
      { path: "src/git/commitView.ts", indexStatus: " ", worktreeStatus: "M", label: "modified", staged: false },
    ],
  } }));
  await page.route("**/api/git/log?**", (route) => route.fulfill({ json: { ok: true, isRepo: true, commits: [
    commit,
    { ...commit, hash: "3179eff000000000000000000000000000000000", shortHash: "3179eff", parents: [], refs: [], subject: "Use downloaded showcase image fixture" },
  ] } }));
  await page.route("**/api/git/commit?**", (route) => route.fulfill({ json: {
    ok: true,
    commit,
    files: [
      { path: "src/git/diffView.ts", status: "M", additions: 4, deletions: 2 },
      { path: "src/git/commitView.ts", status: "M", additions: 4, deletions: 0 },
    ],
    diff,
  } }));
  await page.route("**/api/git/diff?**", (route) => route.fulfill({ json: { ok: true, path: "src/git/diffView.ts", staged: false, diff } }));
}

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
  await page.request.patch("/api/settings", {
    data: {
      appearance: { density: "comfortable" },
      composer: { queueMode: "steer", expanded: false },
      defaults: { model: null, thinkingLevel: null },
    },
  });
  const artifactDir = join(process.cwd(), ".pi", "web", "artifacts");
  await mkdir(artifactDir, { recursive: true });
  await writeFile(join(artifactDir, "e2e-test.jpg"), await readFile(join(process.cwd(), "tests", "fixtures", "showcase-artifact.jpg")));
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        caret-color: transparent !important;
      }
    `,
  });
});

test.describe("visual regression", () => {
  test("hero showcase", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "tablet", "Covered by mobile and desktop visual snapshots");

    if (testInfo.project.name === "desktop") await page.setViewportSize({ width: 1280, height: 1000 });

    await page.goto("/");
    await expect(page.locator("#prompt")).toBeVisible();
    await startEmptySession(page);

    await sendPrompt(page, "showcase");
    await expect(page.locator(".message.assistant .markdownBody pre").last()).toBeVisible();
    await expect(page.locator(".toolCard.toolCard--success", { hasText: "read" })).toBeVisible();
    await expect(page.locator(".toolCard.toolCard--success", { hasText: "edit" })).toBeVisible();
    await expect(page.locator(".message.assistant .imageFrame")).toBeVisible();
    if (testInfo.project.name === "mobile") await scrollMessagesToBottom(page);

    await expect(page).toHaveScreenshot(`hero-showcase-${testInfo.project.name}.png`, {
      fullPage: true,
      animations: "disabled",
    });
  });

  test("sessions drawer", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "tablet", "Covered by mobile and desktop visual snapshots");
    if (testInfo.project.name === "desktop") await page.setViewportSize({ width: 1600, height: 1000 });

    await page.goto("/");
    await sendPrompt(page, "slow background task");
    await page.locator("#sessionButton").click();
    await expect(page.locator("#sessionDrawer")).toBeVisible();
    await expect(page.locator(".sessionSpinner")).toBeVisible();

    await expect(page).toHaveScreenshot(`sessions-drawer-${testInfo.project.name}.png`, {
      fullPage: true,
      animations: "disabled",
    });
  });

  test("conversation tree", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "tablet", "Covered by mobile and desktop visual snapshots");
    if (testInfo.project.name === "desktop") await page.setViewportSize({ width: 1280, height: 1000 });

    await page.goto("/");
    await page.locator("#conversationTreeButton").click();
    await expect(page.locator(".conversationTreePanel")).toBeVisible();
    await expect(page.locator(".conversationTreeChildren")).toBeVisible();
    await expect(page.locator(".conversationTreeBadge.branch")).toHaveText("2 branches");

    await expect(page).toHaveScreenshot(`conversation-tree-${testInfo.project.name}.png`, {
      fullPage: true,
      animations: "disabled",
      maxDiffPixelRatio: 0.06, // Higher threshold: safe-area padding shifts layout slightly across platforms
    });
  });

  test("diff review", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "tablet", "Covered by mobile and desktop visual snapshots");

    await page.goto("/");
    await startEmptySession(page);
    await sendPrompt(page, "edit diff");
    await expect(page.locator(".toolCard.toolCard--success", { hasText: "edit" })).toBeVisible();
    await scrollMessagesToBottom(page);

    await expect(page).toHaveScreenshot(`diff-review-${testInfo.project.name}.png`, {
      fullPage: true,
      animations: "disabled",
    });
  });

  test("git diff viewer", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "tablet", "Covered by mobile and desktop visual snapshots");
    if (testInfo.project.name === "desktop") await page.setViewportSize({ width: 1280, height: 1000 });
    await mockGitApi(page);

    await page.goto("/");
    await page.locator("#gitButton").click();
    await page.locator("#gitGraphTab").click();
    await page.locator(".gitCommitItem").first().click();
    await expect(page.locator(".gitCommitDetails")).toBeVisible();
    await expect(page.locator(".gitPatchFile").first()).toBeVisible();

    await expect(page).toHaveScreenshot(`git-diff-viewer-${testInfo.project.name}.png`, {
      fullPage: true,
      animations: "disabled",
    });
  });
});
