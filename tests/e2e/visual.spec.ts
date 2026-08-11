import { expect, test } from "@playwright/test";
import { openLauncherAction } from "./helpers/actionLauncher.js";
import { openSessionDrawerFooterAction } from "./helpers/sessionDrawer.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const visualArtifactRoot = ".pi/web/artifacts";

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
  if (await page.locator("#sessionDrawer").isVisible()) {
    // New-session setup may auto-close the mobile drawer between the visibility
    // check and an actionability-based click; a DOM click is safely idempotent.
    await page.locator("#sessionCloseButton").evaluate((button: HTMLButtonElement) => button.click());
  }
}

async function seedSessionShowcaseState(page: import("@playwright/test").Page, currentSessionId = "mock-current", currentLabel = "Current mock session") {
  await page.request.patch("/api/session-ui-state", { data: {
    pinnedSessions: [
      { id: currentSessionId, label: currentLabel },
      { id: "mock-older", label: "Older mock session" },
      { id: "mock-release", label: "Release notes" },
      { id: "mock-git", label: "Git diff review" },
    ],
    sessionMarkers: [
      { sessionId: currentSessionId, color: "blue", updatedAt: "2026-01-01T00:00:00.000Z" },
      { sessionId: "mock-older", color: "green", updatedAt: "2026-01-01T00:00:00.000Z" },
      { sessionId: "mock-release", color: "purple", updatedAt: "2026-01-01T00:00:00.000Z" },
      { sessionId: "mock-git", color: "yellow", updatedAt: "2026-01-01T00:00:00.000Z" },
    ],
    selectedMarkerColor: "green",
  } });
}

async function mockConversationTreeApi(page: import("@playwright/test").Page) {
  const timestamp = "2026-05-07T10:00:00Z";
  const treeNode = (
    id: string,
    parentId: string | null,
    preview: string,
    childCount: number,
    options: { role?: string; active?: boolean; current?: boolean } = {},
  ) => ({
    id,
    parentId,
    type: "message",
    role: options.role || "assistant",
    preview,
    timestamp,
    childCount,
    isOnActivePath: Boolean(options.active),
    isCurrentLeaf: Boolean(options.current),
  });
  const nodes = [
    treeNode("tree-root", null, "Plan the conversation tree layout", 4, { role: "user", active: true }),
    treeNode("outer-1", "tree-root", "Explore compact branch rendering", 1, { role: "custom" }),
    treeNode("nested-fork", "outer-1", "Compare nested lane strategies", 4, { role: "user" }),
    treeNode("nested-1", "nested-fork", "Reserve every visible connector lane", 0),
    treeNode("nested-2", "nested-fork", "Pack chains by their row intervals", 0),
    treeNode("nested-3", "nested-fork", "Keep nested fans from colliding", 0),
    treeNode("nested-4", "nested-fork", "Reuse lanes only after branches end", 0),
    treeNode("outer-2", "tree-root", "Try chronological branch ordering", 0),
    treeNode("outer-3", "tree-root", "Test an abandoned early branch", 0),
    treeNode("outer-4", "tree-root", "Keep the active continuation last", 1, { active: true }),
    treeNode("tree-current", "outer-4", "Nested branch graph is ready", 0, { active: true, current: true }),
  ];

  await page.route("**/api/session/tree**", (route) => route.fulfill({ json: {
    ok: true,
    sessionId: "mock-current",
    leafId: "tree-current",
    activePathIds: ["tree-root", "outer-4", "tree-current"],
    entryCount: nodes.length,
    branchPointCount: 2,
    nodes,
  } }));
}

async function mockFilesApi(page: import("@playwright/test").Page) {
  await page.route("**/api/files/tree**", async (route) => {
    const path = new URL(route.request().url()).searchParams.get("path") || "";
    const entries = path === "src"
      ? [
          { name: "app", path: "src/app", kind: "directory" },
          { name: "main.ts", path: "src/main.ts", kind: "file", size: 152 },
          { name: "styles.css", path: "src/styles.css", kind: "file", size: 84 },
        ]
      : path === visualArtifactRoot
        ? [
            { name: "image-edits", path: `${visualArtifactRoot}/image-edits`, kind: "directory" },
            { name: "showcase", path: `${visualArtifactRoot}/showcase`, kind: "directory" },
            { name: "concept.html", path: `${visualArtifactRoot}/concept.html`, kind: "file", size: 4_320 },
            { name: "launch-preview.png", path: `${visualArtifactRoot}/launch-preview.png`, kind: "file", size: 125_400 },
            { name: "notes.md", path: `${visualArtifactRoot}/notes.md`, kind: "file", size: 1_860 },
            { name: "walkthrough.webm", path: `${visualArtifactRoot}/walkthrough.webm`, kind: "file", size: 820_100 },
          ]
        : path === `${visualArtifactRoot}/image-edits`
          ? [
              { name: "final.png", path: `${visualArtifactRoot}/image-edits/final.png`, kind: "file", size: 96_500 },
              { name: "source.png", path: `${visualArtifactRoot}/image-edits/source.png`, kind: "file", size: 104_200 },
            ]
          : [
              { name: "src", path: "src", kind: "directory" },
              { name: "tests", path: "tests", kind: "directory" },
              { name: "package.json", path: "package.json", kind: "file", size: 418 },
              { name: "README.md", path: "README.md", kind: "file", size: 226 },
            ];
    await route.fulfill({ json: { ok: true, path, entries } });
  });
  await page.route(/\/api\/(?:session-)?artifacts\//, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith(".html")) {
      await route.fulfill({ contentType: "text/html", body: `<!doctype html><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 30% 20%,#5a4324,#14100b 56%,#070706);color:#fff;font:16px system-ui}.card{width:min(82vw,620px);padding:44px;border:1px solid #9b7740;border-radius:24px;background:rgba(15,12,8,.72);box-shadow:0 24px 80px #0008}small{color:#e2b15f;text-transform:uppercase;letter-spacing:.18em}h1{font-size:clamp(30px,6vw,68px);margin:.2em 0}p{color:#c8bdad;line-height:1.6}button{padding:12px 18px;border:1px solid #b68d4d;border-radius:99px;background:#e2b15f;color:#17120b;font-weight:700}</style><div class="card"><small>Interactive artifact</small><h1>Constellation</h1><p>A tactile prototype with live controls, motion, and a warm editorial palette.</p><button>Explore prototype</button></div>` });
    } else if (path.endsWith(".webm")) {
      await route.fulfill({ contentType: "video/webm", body: Buffer.from([]) });
    } else {
      await route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><defs><radialGradient id="g"><stop stop-color="#8b6630"/><stop offset="1" stop-color="#111318"/></radialGradient></defs><rect width="640" height="360" fill="url(#g)"/><circle cx="320" cy="180" r="82" fill="#e2b15f" opacity=".92"/><circle cx="320" cy="180" r="114" fill="none" stroke="#f4d9a3" opacity=".35"/></svg>' });
    }
  });
  await page.route("**/api/files/read**", async (route) => {
    const path = new URL(route.request().url()).searchParams.get("path") || "README.md";
    const artifact = path === `${visualArtifactRoot}/notes.md`;
    const content = artifact
      ? "# Artifact field notes\n\nA rendered study of the new **gallery and interactive preview** experience.\n"
      : "# pi-web\n\nA focused, responsive web UI for the pi coding agent.\n\n## Workspace Explorer\n\n- Browse the active session directory\n- Edit files with syntax highlighting\n- Save safely with revision conflict detection\n- Preview images without leaving the workspace\n";
    await route.fulfill({ json: { ok: true, path, size: content.length, readOnly: false, language: "markdown", revision: artifact ? "artifact-notes" : "showcase-readme", content } });
  });
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
      appearance: { density: "comfortable", accentColor: "#e2b15f", loadingAnimation: "fireworks" },
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
    const state = await (await page.request.get("/api/state")).json();
    await seedSessionShowcaseState(page, state.sessionId, state.sessionTitle || "New session");
    await expect(page.locator(".sessionBarTab.pinned")).toHaveCount(4);

    await sendPrompt(page, "showcase");
    await expect(page.locator(".message.assistant .markdownBody pre").last()).toBeVisible();
    await expect(page.locator(".toolCard.toolCard--success", { hasText: "read" })).toBeVisible();
    await expect(page.locator(".toolCard.toolCard--success", { hasText: "edit" })).toBeVisible();
    await expect(page.locator(".message.assistant .imageFrame")).toBeVisible();
    if (testInfo.project.name === "mobile") await scrollMessagesToBottom(page);

    await expect(page.locator("#modelSettingsButton")).toHaveScreenshot(`model-picker-${testInfo.project.name}.png`, {
      animations: "disabled",
      maxDiffPixelRatio: 0.001,
    });
    // The README showcase presents the compact composer with its app launcher open.
    await page.locator("#prompt").blur();
    await page.locator(".actionLauncherToggle").click();
    await expect(page.locator(".actionLauncher")).toHaveClass(/open/);
    await expect(page).toHaveScreenshot(`hero-showcase-${testInfo.project.name}.png`, {
      fullPage: true,
      animations: "disabled",
    });
  });

  test("new session", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "tablet", "Covered by mobile and desktop visual snapshots");

    await page.goto("/");
    await startEmptySession(page);
    const emptyState = page.locator("#emptyCwdChooser");
    const animation = emptyState.locator(".newChatLoadingAnimation");
    await expect(emptyState).toBeVisible();
    await expect(animation).toBeVisible();
    await expect(emptyState.getByRole("button", { name: "Change working directory" })).toBeVisible();

    // A PNG cannot represent motion. Wait for the one-shot animation to finish
    // naturally, then capture its settled final frame.
    await expect.poll(() => animation.evaluate((video: HTMLVideoElement) => video.ended), { timeout: 3_000 }).toBe(true);
    await animation.evaluate((video: HTMLVideoElement) => video.pause());

    await expect(page).toHaveScreenshot(`new-session-${testInfo.project.name}.png`, {
      fullPage: true,
      animations: "disabled",
    });
  });

  test("sessions drawer", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "tablet", "Covered by mobile and desktop visual snapshots");
    if (testInfo.project.name === "desktop") await page.setViewportSize({ width: 1600, height: 1000 });

    await seedSessionShowcaseState(page);
    await page.goto("/");
    await sendPrompt(page, "slow background task");
    await page.locator("#sessionButton").click();
    await expect(page.locator("#sessionDrawer")).toBeVisible();
    await expect(page.locator(".sessionSpinner")).toBeVisible();
    await expect(page.locator(".sessionBarTab.pinned")).toHaveCount(4);
    await expect(page.locator(".sessionItem.marker-green")).toContainText("Older mock session");

    await expect(page).toHaveScreenshot(`sessions-drawer-${testInfo.project.name}.png`, {
      fullPage: true,
      animations: "disabled",
    });
  });

  test("system information", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "tablet", "Covered by mobile and desktop visual snapshots");
    if (testInfo.project.name === "desktop") await page.setViewportSize({ width: 1280, height: 1000 });

    await page.goto("/");
    await openSessionDrawerFooterAction(page, "System info");
    await expect(page.locator("#systemInfoPanel")).toBeVisible();
    await expect(page.locator("#systemInfoPanel").getByRole("heading", { name: "Host machine" })).toBeVisible();

    await expect(page).toHaveScreenshot(`system-info-${testInfo.project.name}.png`, {
      fullPage: true,
      animations: "disabled",
    });
  });

  test("conversation tree", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "tablet", "Covered by mobile and desktop visual snapshots");
    if (testInfo.project.name === "desktop") await page.setViewportSize({ width: 1280, height: 1000 });

    await mockConversationTreeApi(page);
    await page.goto("/");
    await openLauncherAction(page, "Conversation tree");
    const panel = page.locator(".conversationTreePanel");
    await expect(panel).toBeVisible();
    await expect(panel.locator(".conversationTreeNode")).toHaveCount(11);
    await expect(panel.locator(".conversationTreeGraphPath")).toHaveCount(10);
    await expect(panel.locator(".conversationTreeBadge.branch")).toHaveText(["4 branches", "4 branches"]);
    await expect(panel.locator(".conversationTreeNode").last()).toHaveAttribute("data-node-id", "tree-current");

    if (testInfo.project.name === "desktop") {
      await expect(page).toHaveScreenshot("conversation-tree-desktop.png", {
        fullPage: true,
        animations: "disabled",
      });
    } else {
      await expect(panel).toHaveScreenshot("conversation-tree-mobile.png", {
        animations: "disabled",
      });
    }
  });

  test("workspace explorer", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "tablet", "Covered by mobile and desktop visual snapshots");
    if (testInfo.project.name === "desktop") await page.setViewportSize({ width: 1600, height: 1000 });
    await mockFilesApi(page);

    await page.goto("/");
    await openLauncherAction(page, "File explorer");
    await page.locator(".fileTreeDirectory summary", { hasText: "src" }).click();
    await expect(page.locator('.fileTreeFile[title="src/main.ts"]')).toBeVisible();
    await page.locator('.fileTreeFile[title="README.md"]').click();
    await expect(page.locator(".fileTab.active")).toContainText("README.md");
    await expect(page.locator(".cm-editor")).toBeVisible();

    await expect(page).toHaveScreenshot(`workspace-explorer-${testInfo.project.name}.png`, {
      fullPage: true,
      animations: "disabled",
    });
  });

  test("artifacts explorer", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "tablet", "Covered by mobile and desktop visual snapshots");
    if (testInfo.project.name === "desktop") await page.setViewportSize({ width: 1600, height: 1000 });
    await mockFilesApi(page);

    await page.goto("/");
    await openLauncherAction(page, "File explorer");
    await page.locator("#filesArtifactsScope").click();
    await expect(page.locator(`.artifactGalleryCard[data-artifact-path="${visualArtifactRoot}/launch-preview.png"] img`)).toBeVisible();
    const thumbnail = page.locator(`.artifactGalleryCard[data-artifact-path="${visualArtifactRoot}/concept.html"] iframe`);
    await expect(thumbnail.contentFrame().locator("h1")).toHaveText("Constellation");

    await expect(page).toHaveScreenshot(`artifacts-explorer-${testInfo.project.name}.png`, {
      fullPage: true,
      animations: "disabled",
    });
  });

  test("large interactive artifact preview", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "tablet", "Covered by mobile and desktop visual snapshots");
    if (testInfo.project.name === "desktop") await page.setViewportSize({ width: 1600, height: 1000 });
    await mockFilesApi(page);

    await page.goto("/");
    await openLauncherAction(page, "File explorer");
    await page.locator("#filesArtifactsScope").click();
    await page.getByRole("button", { name: "Preview concept.html" }).click();
    const preview = page.locator("#artifactBrowserPreviewBody iframe");
    await expect(preview.contentFrame().locator("h1")).toHaveText("Constellation");

    await expect(page).toHaveScreenshot(`artifact-preview-${testInfo.project.name}.png`, {
      fullPage: true,
      animations: "disabled",
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
    await page.locator("#sessionInfoButton").click();
    await page.locator("#sessionInfoGit").click();
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
