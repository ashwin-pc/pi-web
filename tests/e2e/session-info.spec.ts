import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

test("session details panel shows workspace, tool surface, context assembly, and the effective system prompt", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.request.post("/api/mock/state", { data: {
    webContributions: [{ version: 1, key: "recap", slot: "header-action", kind: "rendered", icon: "scroll-text", title: "Session recap", label: "Recap" }],
  } });
  await page.route("**/api/git/status**", (route) => route.fulfill({ json: {
    ok: true,
    isRepo: true,
    root: "/mock/project",
    branch: "main",
    ahead: 0,
    behind: 0,
    files: [
      { path: "staged.ts", indexStatus: "M", worktreeStatus: " ", label: "staged", staged: true },
      { path: "working.ts", indexStatus: " ", worktreeStatus: "M", label: "modified", staged: false },
      { path: "new.ts", indexStatus: "?", worktreeStatus: "?", label: "untracked", staged: false },
    ],
    diffStats: {
      staged: { files: 1, additions: 12, deletions: 4 },
      unstaged: { files: 2, additions: 7, deletions: 2 },
    },
  } }));

  await page.goto("/");

  await expect(page.locator("#headerActions .webHeaderActionButton")).toHaveAttribute("title", "Session recap");
  await expect(page.locator("#sessionInfoPanel .webHeaderActionButton")).toHaveCount(0);
  await expect(page.locator("#statusPath")).toBeHidden();

  await page.locator(".actionLauncherToggle").click();
  await page.getByRole("menuitem", { name: "Session details" }).click();
  const panel = page.locator("#sessionInfoPanel");
  await expect(panel).toBeVisible();
  await expect(page.locator("body")).toHaveClass(/appRightPanelOpen/);
  await expect(page.locator("#sessionInfoTitle")).toHaveText("Current mock session");
  await expect(page.locator("#sessionInfoCostValue")).toHaveText("$0.092");
  await expect(page.locator("#sessionInfoTokensValue")).toHaveText("32k");
  await expect(page.locator("#sessionInfoToolsValue")).toHaveText("0");
  await expect(page.locator("#sessionInfoElapsedValue")).not.toHaveText("—");
  await expect(page.locator("#sessionInfoInsightsSection")).toHaveCount(0);

  await expect(page.locator("#sessionInfoGitStaged")).toHaveText("1 files");
  await expect(page.locator("#sessionInfoGitUnstaged")).toHaveText("2 files");
  await expect(page.locator("#sessionInfoGitUntracked")).toHaveText("1 files");
  await expect(page.locator("#sessionInfoGitDiff")).toContainText("+19");
  await expect(page.locator("#sessionInfoGitDiff")).toContainText("−6");
  await expect(page.locator("#sessionInfoGitConflicts")).toHaveText("0");
  await expect(page.locator("#sessionInfoGitCount")).toContainText("3 changed files");

  await expect(page.locator("#sessionInfoToolTableBody")).toContainText("Built-in");
  await expect(page.locator("#sessionInfoToolTableBody")).toContainText("mock");
  await expect(page.locator("#sessionInfoToolTableBody")).toContainText("read");
  await expect(page.locator("#sessionInfoToolTableBody .sessionInfoToolStatus")).toHaveText(["Enabled", "Enabled", "Disabled"]);
  const disabledTool = page.locator("#sessionInfoToolTableBody tr[data-enabled='false']");
  await expect(disabledTool).toContainText("mock-disabled");
  await expect(disabledTool).toBeVisible();
  await expect(page.locator("#sessionInfoToolNote")).toContainText("2 enabled · 1 disabled · 3 configured tool schemas");
  await expect(page.locator("#sessionInfoPromptSummary")).toContainText("estimated tokens");
  await expect(page.locator("#sessionInfoResourceSummary")).toContainText("1 skill · 1 extension");
  await expect(page.locator("#sessionInfoSkillsList")).toContainText("mock-skill");
  await expect(page.locator("#sessionInfoExtensionsList")).toContainText("extension");

  await page.locator("#sessionInfoInspectPrompt").click();
  await expect(page.locator("#sessionInfoHeading")).toHaveText("System prompt");
  await expect(page.locator("#sessionInfoPromptCode .sessionInfoPromptLine code")).toHaveText("Mock effective Pi system prompt.");
  await expect(page.locator("#sessionInfoPromptCode .sessionInfoPromptGroupHeader strong")).toHaveText("System prompt");
  await expect(page.locator("#sessionInfoProvenanceSummary")).toContainText("100% attributed");
  await expect(page.locator("#sessionInfoPromptSourceList")).toContainText("/mock/SYSTEM.md");
  await page.locator("#sessionInfoCopyPrompt").click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("Mock effective Pi system prompt.");
  await page.getByRole("button", { name: "Back to session details" }).click();

  await expect(page.locator("#sessionInfoCreatedDetail")).not.toHaveText("—");
  await expect(page.locator("#sessionInfoId strong")).toHaveText("mock-current");
  await expect(page.locator("#sessionInfoCwd strong")).not.toBeEmpty();
  await page.locator("#sessionInfoId").click();
  await expect(page.locator("#sessionInfoId small")).toHaveText("Copied");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("mock-current");

  await page.locator("#sessionInfoGit").click();
  await expect(panel).toBeHidden();
  await expect(page.locator("#gitPanel")).toBeVisible();
});

test("session details panel stays within a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/");
  await page.locator(".actionLauncherToggle").click();
  await page.getByRole("menuitem", { name: "Session details" }).click();

  const box = await page.locator("#sessionInfoPanel").boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  await expect(page.locator("#sessionInfoStatsLine")).toBeVisible();
  await expect(page.locator("#sessionInfoPanel")).toBeVisible();
  const sectionBox = await page.locator(".sessionInfoSection").first().boundingBox();
  expect(sectionBox?.x).toBe(box!.x);
  expect(sectionBox?.width).toBe(box!.width);
  const toolName = page.locator(".sessionInfoToolName strong").first();
  expect(Number.parseFloat(await toolName.evaluate((element) => getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(10);

  await page.locator("#sessionInfoInspectPrompt").click();
  const promptLine = page.locator(".sessionInfoPromptLine").first();
  await expect(promptLine).toBeVisible();
  expect(Number.parseFloat(await promptLine.evaluate((element) => getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(10);
  await expect(page.locator(".sessionInfoPromptGroupHeader").first()).toBeVisible();
  await expect(page.locator(".sessionInfoPromptGroupHeader").first()).toContainText("Line 1");
});
