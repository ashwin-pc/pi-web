import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

async function routeStableRepo(page: Page) {
  await page.route("**/api/git/repos**", (route) => route.fulfill({ json: {
    ok: true, cwd: "/workspace", depth: 1,
    repos: [{ path: ".", root: "/workspace", branch: "main", upstream: "origin/main", ahead: 0, behind: 0, dirtyCount: 0, isCurrent: true }],
  } }));
  await page.route("**/api/git/status?**", (route) => route.fulfill({ json: {
    ok: true, isRepo: true, root: "/workspace", branch: "main", upstream: "origin/main",
    defaultRemoteBranch: "origin/main", ahead: 0, behind: 0, files: [],
    diffStats: { staged: { files: 0, additions: 0, deletions: 0 }, unstaged: { files: 0, additions: 0, deletions: 0 } },
  } }));
}

test("GitHub issue numbers attach a structured reference to the prompt", async ({ page }) => {
  await page.request.post("/api/mock/state", { data: {
    webContributions: [{ version: 1, key: "github", slot: "git-tab", kind: "rendered", title: "GitHub issues", label: "GitHub" }],
  } });
  await page.route("**/api/web-contributions/invoke", async (route) => {
    const request = route.request().postDataJSON();
    if (request.event?.action === "attach-context") {
      await route.fulfill({ json: {
        ok: true,
        title: "GitHub",
        composerContext: {
          type: "reference",
          id: "github:ashwin-pc/pi-web:issue:123",
          label: "GitHub issue #123",
          title: "Fix the mobile composer",
          reference: {
            provider: "github",
            repository: "ashwin-pc/pi-web",
            resource: "issue",
            number: 123,
            url: "https://github.com/ashwin-pc/pi-web/issues/123",
          },
        },
      } });
      return;
    }
    await route.fulfill({ json: {
      ok: true,
      title: "GitHub",
      html: `<button type="button" class="testIssueNumber" data-web-git-tab-action="attach-context" data-web-git-tab-payload='{"kind":"issue","number":123,"tab":"issues"}'>#123</button>`,
    } });
  });

  await page.goto("/");
  await page.locator("#sessionInfoButton").click();
  await page.locator("#sessionInfoGit").click();
  await expect(page.locator(".gitExtensionTab", { hasText: "GitHub" })).toBeVisible();
  await page.locator(".gitExtensionTab", { hasText: "GitHub" }).click();
  await page.locator(".testIssueNumber").click();

  const contextChip = page.locator(".contextAttachmentChip");
  await expect(contextChip).toContainText("GitHub issue #123");
  await expect(contextChip).toContainText("Fix the mobile composer");

  await page.locator("#prompt").fill("Please implement this.");
  const promptRequest = page.waitForRequest((request) => request.url().endsWith("/api/prompt") && request.method() === "POST");
  await page.locator("#primaryButton").click();
  const body = (await promptRequest).postDataJSON();
  expect(body.message).toBe("Please implement this.");
  expect(body.attachments).toEqual([{
    type: "reference",
    id: "github:ashwin-pc/pi-web:issue:123",
    label: "GitHub issue #123",
    title: "Fix the mobile composer",
    reference: {
      provider: "github",
      repository: "ashwin-pc/pi-web",
      resource: "issue",
      number: 123,
      url: "https://github.com/ashwin-pc/pi-web/issues/123",
    },
  }]);
  await expect(contextChip).toHaveCount(0);
  await page.unrouteAll({ behavior: "wait" });
});

test("Git-tab invalidation ignores an older in-flight response", async ({ page }) => {
  await page.request.post("/api/mock/state", { data: {
    webContributions: [{ version: 1, key: "github", slot: "git-tab", kind: "rendered", title: "GitHub issues", label: "GitHub" }],
  } });
  let requestCount = 0;
  let releaseOld!: () => void;
  const oldPending = new Promise<void>((resolve) => { releaseOld = resolve; });
  await page.route("**/api/web-contributions/invoke", async (route) => {
    requestCount += 1;
    if (requestCount === 1) {
      await oldPending;
      await route.fulfill({ json: { ok: true, html: '<div class="gitRevision">old</div>' } });
      return;
    }
    await route.fulfill({ json: { ok: true, html: '<div class="gitRevision">fresh</div>' } });
  });

  await page.goto("/");
  await page.locator("#sessionInfoButton").click();
  await page.locator("#sessionInfoGit").click();
  await page.locator(".gitExtensionTab", { hasText: "GitHub" }).click();
  await expect.poll(() => requestCount).toBe(1);
  await page.request.post("/api/mock/event", { data: { type: "web_contribution_updated", sessionId: "mock-current", key: "github" } });
  await expect(page.locator(".gitRevision")).toHaveText("fresh");
  releaseOld();
  await expect.poll(() => requestCount).toBe(2);
  await expect(page.locator(".gitRevision")).toHaveText("fresh");
});

test("extension tabs remain available in split view with a reduced viewport height", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 500 });
  await page.request.post("/api/mock/state", { data: {
    webContributions: [{ version: 1, key: "github", slot: "git-tab", kind: "rendered", title: "GitHub issues", label: "GitHub" }],
  } });
  await page.route("**/api/web-contributions/invoke", (route) => route.fulfill({ json: {
    ok: true,
    title: "GitHub",
    html: "<div class=\"testGitHubExtension\">GitHub extension content</div>",
  } }));

  await page.goto("/");
  await page.locator("#sessionInfoButton").click();
  await page.locator("#sessionInfoGit").click();
  const extensionTab = page.locator(".gitExtensionTab", { hasText: "GitHub" });
  await expect(extensionTab).toBeVisible();
  await extensionTab.click();
  await expect(page.locator(".testGitHubExtension")).toBeVisible();

  const panelWidth = (await page.locator("#gitPanel").boundingBox())?.width || 0;
  const appWidth = (await page.locator(".app").boundingBox())?.width || 0;
  expect(panelWidth).toBeLessThan(900);
  expect(appWidth).toBeGreaterThanOrEqual(360);
  await page.unrouteAll({ behavior: "wait" });
});

test("git panel opens, switches views, and commit rows do not overlap", async ({ page }) => {
  await routeStableRepo(page);
  await page.route("**/api/git/log?**", (route) => route.fulfill({ json: { ok: true, isRepo: true, commits: Array.from({ length: 15 }, (_, index) => ({ hash: String(index).padStart(40, "0"), shortHash: String(index), parents: index < 14 ? [String(index + 1).padStart(40, "0")] : [], author: "Test", date: "2026-01-01T00:00:00Z", refs: index === 0 ? ["HEAD -> main"] : [], subject: `Commit ${index}` })) } }));
  await page.goto("/");
  await page.locator("#sessionInfoButton").click();
  await page.locator("#sessionInfoGit").click();
  await expect(page.locator("#gitPanel")).toBeVisible();
  await expect(page.locator("#gitStatusTab")).toHaveClass(/active/);

  await page.locator("#gitGraphTab").click();
  await expect(page.locator("#gitGraphTab")).toHaveClass(/active/);
  await expect(page.locator(".gitCommitItem").first()).toBeVisible();

  const overlaps = await page.locator(".gitCommitItem").evaluateAll((items) => {
    const boxes = items.slice(0, 12).map((item) => item.getBoundingClientRect());
    return boxes.some((box, index) => index > 0 && box.top < boxes[index - 1].bottom - 0.5);
  });
  expect(overlaps).toBe(false);
});

test("git graph renders nested branches and merges with continuous, stable-colour lanes", async ({ page }) => {
  await routeStableRepo(page);
  const definitions: Array<[string, string[], string[]?]> = [
    ["merge-release", ["main-five", "hotfix-two"], ["HEAD -> main", "tag: v2.0.0"]],
    ["main-five", ["merge-feature"]],
    ["merge-feature", ["main-four", "feature-three"]],
    ["main-four", ["main-three"]],
    ["main-three", ["base-three"]],
    ["feature-three", ["feature-two"], ["origin/feature"]],
    ["feature-two", ["feature-one", "nested-two"]],
    ["feature-one", ["base-two"]],
    ["nested-two", ["nested-one"]],
    ["nested-one", ["base-two"]],
    ["hotfix-two", ["hotfix-one"], ["origin/hotfix"]],
    ["hotfix-one", ["base-three"]],
    ["base-three", ["base-two"]],
    ["base-two", ["base-one"]],
    ["base-one", []],
  ];
  const hash = (id: string) => id.padEnd(40, "0");
  await page.route("**/api/git/log?**", (route) => route.fulfill({ json: {
    ok: true,
    isRepo: true,
    commits: definitions.map(([id, parents, refs], index) => ({
      hash: hash(id),
      shortHash: id.slice(0, 7),
      parents: parents.map(hash),
      author: "Example Dev",
      date: `2026-07-${String(25 - index).padStart(2, "0")}T12:00:00Z`,
      refs: refs || [],
      subject: id.replaceAll("-", " ").replace(/^./, (value) => value.toUpperCase()),
    })),
  } }));

  await page.goto("/");
  await page.locator("#sessionInfoButton").click();
  await page.locator("#sessionInfoGit").click();
  await page.locator("#gitGraphTab").click();
  const rows = page.locator(".gitCommitItem");
  await expect(rows).toHaveCount(definitions.length);

  const metrics = await rows.evaluateAll((items) => items.map((item) => {
    const box = item.getBoundingClientRect();
    const svg = item.querySelector("svg")!;
    const dot = svg.querySelector("circle")!;
    const subjectBox = item.querySelector(".gitCommitSubject")!.getBoundingClientRect();
    const metaBox = item.querySelector(".gitCommitMetaLine")!.getBoundingClientRect();
    const cx = dot.getAttribute("cx");
    const incoming = [...svg.querySelectorAll("path")].some((path) => {
      const data = path.getAttribute("d") || "";
      return data.startsWith(`M ${cx} -1 `) && data.endsWith(`${cx} 20`);
    });
    return { top: box.top, bottom: box.bottom, width: Number(svg.getAttribute("width")), colour: dot.getAttribute("fill"), incoming, linesAligned: Math.abs(subjectBox.left - metaBox.left) < 0.5 };
  }));
  expect(new Set(metrics.map(({ colour }) => colour)).size).toBe(4);
  expect(metrics.every(({ width }) => width === 64)).toBe(true);
  expect(metrics.slice(1).every(({ incoming }) => incoming)).toBe(true);
  expect(metrics.every(({ linesAligned }) => linesAligned)).toBe(true);
  expect(metrics.slice(1).every(({ top }, index) => Math.abs(top - metrics[index].bottom) < 0.5)).toBe(true);

  const hotfixColour = await rows.filter({ hasText: "Hotfix one" }).evaluate((row) => {
    const svg = row.querySelector("svg")!;
    const dotColour = svg.querySelector("circle")!.getAttribute("fill");
    const outgoing = [...svg.querySelectorAll("path")].find((path) => /M \d+ 20 /.test(path.getAttribute("d") || ""));
    return { dotColour, edgeColour: outgoing?.getAttribute("stroke") };
  });
  expect(hotfixColour.edgeColour).toBe(hotfixColour.dotColour);
});

test("git status repo accordions switch the selected file", async ({ page }) => {
  await page.route("**/api/git/repos**", (route) => route.fulfill({ json: {
    ok: true,
    cwd: "/workspace",
    depth: 1,
    repos: [
      { path: "repo-a", root: "/workspace/repo-a", branch: "main", upstream: "", ahead: 0, behind: 0, dirtyCount: 1, isCurrent: false },
      { path: "repo-b", root: "/workspace/repo-b", branch: "feature", upstream: "origin/feature", ahead: 0, behind: 2, dirtyCount: 1, isCurrent: false },
    ],
  } }));
  await page.route("**/api/git/status?**", (route) => {
    const repo = new URL(route.request().url()).searchParams.get("repo");
    return route.fulfill({ json: {
      ok: true,
      isRepo: true,
      root: `/workspace/${repo}`,
      branch: repo === "repo-b" ? "feature" : "main",
      upstream: repo === "repo-b" ? "origin/feature" : "",
      defaultRemoteBranch: "",
      ahead: 0,
      behind: repo === "repo-b" ? 2 : 0,
      files: [{ path: repo === "repo-b" ? "b.txt" : "a.txt", indexStatus: " ", worktreeStatus: "M", label: "modified", staged: false }],
    } });
  });
  await page.route("**/api/git/log?**", (route) => route.fulfill({ json: { ok: true, isRepo: true, commits: [] } }));
  await page.route("**/api/git/diff?**", (route) => route.fulfill({ json: { ok: true, path: "file.txt", staged: false, diff: "" } }));

  await page.goto("/");
  await page.locator("#sessionInfoButton").click();
  await page.locator("#sessionInfoGit").click();
  await expect(page.locator(".gitRepoChangesAccordion .gitRepoName")).toHaveText(["repo-a", "repo-b"]);
  await expect(page.locator(".gitRepoChangesAccordion").first().locator("summary")).not.toContainText("↑0");
  await expect(page.locator(".gitRepoChangesAccordion").first().locator("summary")).not.toContainText("↓0");
  await expect(page.locator(".gitFileItem.selected .gitFilePath")).toHaveText("a.txt");
  await expect(page.locator(".gitRebaseButton")).toHaveCount(1);
  await expect(page.locator(".gitRebaseButton")).toHaveAttribute("aria-label", "Fetch and rebase repo-b onto upstream");

  await page.locator(".gitRepoChangesAccordion", { hasText: "repo-b" }).locator(".gitFileItem").click();

  await expect(page.locator(".gitFileItem.selected .gitFilePath")).toHaveText("b.txt");
});

test("mobile launcher opens Git without activating a compact composer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const composer = page.locator("#promptForm");
  const prompt = page.locator("#prompt");
  await prompt.fill("A draft that should remain compact while opening Git");
  await prompt.blur();

  await expect(composer).toHaveClass(/compactInactive/);
  await expect.poll(async () => (await composer.boundingBox())?.height || 0).toBeLessThanOrEqual(50);
  await page.locator(".actionLauncherToggle").click();
  await page.locator(".actionLauncherItem", { hasText: "Git" }).click();

  await expect(page.locator("#gitPanel")).toBeVisible();
  await expect(prompt).not.toBeFocused();
  await expect.poll(async () => (await composer.boundingBox())?.height || 0).toBeLessThanOrEqual(50);
});

test("git panel switches to a single visible pane when its container is narrow", async ({ page }) => {
  await page.route("**/api/git/repos**", (route) => route.fulfill({ json: {
    ok: true,
    cwd: "/workspace",
    depth: 1,
    repos: [{ path: ".", root: "/workspace", branch: "main", upstream: "", ahead: 0, behind: 0, dirtyCount: 1, isCurrent: true }],
  } }));
  await page.route("**/api/git/status?**", (route) => route.fulfill({ json: {
    ok: true,
    isRepo: true,
    root: "/workspace",
    branch: "main",
    upstream: "",
    defaultRemoteBranch: "",
    ahead: 0,
    behind: 0,
    files: [{ path: "src/git/diffView.ts", indexStatus: " ", worktreeStatus: "M", label: "modified", staged: false }],
  } }));
  await page.route("**/api/git/log?**", (route) => route.fulfill({ json: { ok: true, isRepo: true, commits: [] } }));
  await page.route("**/api/git/diff?**", (route) => route.fulfill({ json: {
    ok: true,
    path: "src/git/diffView.ts",
    staged: false,
    diff: "diff --git a/src/git/diffView.ts b/src/git/diffView.ts\n--- a/src/git/diffView.ts\n+++ b/src/git/diffView.ts\n@@ -1 +1 @@\n-old\n+new",
  } }));

  await page.goto("/");
  await page.locator("#sessionInfoButton").click();
  await page.locator("#sessionInfoGit").click();

  await expect(page.locator("#gitPrimaryPane")).toBeVisible();
  await expect(page.locator("#gitDetailPane")).toBeHidden();

  await page.locator(".gitFileItem").click();

  await expect(page.locator("#gitPrimaryPane")).toBeHidden();
  await expect(page.locator("#gitDetailPane")).toBeVisible();
  const back = page.locator(".gitBackButton");
  await expect(back).toHaveAttribute("aria-label", "Back to changed files");
  await expect(back.locator("svg")).toHaveCount(1);
  await expect(back).toHaveText("");
});

test("git panel remains split when the software keyboard reduces viewport height", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 500 });
  await page.goto("/");
  await page.locator("#sessionInfoButton").click();
  await page.locator("#sessionInfoGit").click();

  const panel = page.locator("#gitPanel");
  const app = page.locator(".app");
  await expect(panel).toBeVisible();
  await expect.poll(async () => {
    const panelWidth = (await panel.boundingBox())?.width || 0;
    const appWidth = (await app.boundingBox())?.width || 0;
    return panelWidth < 900 && appWidth >= 360;
  }).toBe(true);
});

test("git commit detail shows changed files, diff, and layout toggle", async ({ page }) => {
  await page.goto("/");
  await page.locator("#sessionInfoButton").click();
  await page.locator("#sessionInfoGit").click();
  await page.locator("#gitGraphTab").click();
  // Plain `git show` has no combined patch for merge commits, so exercise a
  // regular commit when the repository's newest entry is a PR merge.
  await page.locator(".gitCommitItem").filter({ hasNotText: /^Merge / }).first().click();

  await expect(page.locator(".gitCommitDetails")).toBeVisible();
  await expect(page.locator(".gitCommitFiles")).toBeVisible();
  await expect(page.locator(".gitPatchFile").first()).toBeVisible();

  const diff = page.locator(".gitDetailPane .diffContainer").first();
  await expect(diff).toHaveClass(/diffContainer--/);
  const wasStacked = (await diff.getAttribute("class"))?.includes("diffContainer--stacked") ?? false;
  await page.locator(".gitDetailPane .diffLayoutToggle").first().click();
  await expect(diff).toHaveClass(wasStacked ? /diffContainer--sideBySide/ : /diffContainer--stacked/);
});
