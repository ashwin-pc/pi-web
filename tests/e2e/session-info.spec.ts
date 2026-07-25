import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

test("session info shows copyable metadata and real Git stats while header actions stay in the header", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.route("**/api/state**", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ response, json: {
      ...data,
      webHeaderActions: [{ key: "recap", icon: "scroll-text", title: "Session recap", label: "Recap" }],
    } });
  });
  await page.route("**/api/git/status**", (route) => route.fulfill({ json: {
    ok: true,
    isRepo: true,
    ahead: 0,
    behind: 0,
    files: [
      { path: "staged.ts", indexStatus: "M", worktreeStatus: " ", label: "staged", staged: true },
      { path: "working.ts", indexStatus: " ", worktreeStatus: "M", label: "modified", staged: false },
    ],
    diffStats: {
      staged: { files: 1, additions: 12, deletions: 4 },
      unstaged: { files: 1, additions: 7, deletions: 2 },
    },
  } }));

  await page.goto("/");

  await expect(page.locator("#headerActions .webHeaderActionButton")).toHaveAttribute("title", "Session recap");
  await expect(page.locator("#sessionInfoPopover .webHeaderActionButton")).toHaveCount(0);
  await expect(page.locator("#statusPath")).toBeHidden();

  await page.locator("#sessionInfoButton").click();
  const popover = page.locator("#sessionInfoPopover");
  await expect(popover).toBeVisible();
  await expect(page.locator("#sessionInfoId strong")).toHaveText("mock-current");
  await expect(page.locator("#sessionInfoCwd strong")).not.toBeEmpty();
  await expect(page.locator("#sessionInfoGitCount")).toContainText("Staged 1");
  await expect(page.locator("#sessionInfoGitCount")).toContainText("+12");
  await expect(page.locator("#sessionInfoGitCount")).toContainText("−4");
  await expect(page.locator("#sessionInfoGitCount")).toContainText("Unstaged 1");
  await expect(page.locator("#sessionInfoGitCount")).toContainText("+7");
  await expect(page.locator("#sessionInfoGitCount")).toContainText("−2");

  await page.locator("#sessionInfoId").click();
  await expect(page.locator("#sessionInfoId small")).toHaveText("Copied");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("mock-current");

  await page.locator("#sessionInfoGit").click();
  await expect(popover).toBeHidden();
  await expect(page.locator("#gitPanel")).toBeVisible();
});

test("session info popover stays within a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/");
  await page.locator("#sessionInfoButton").click();

  const box = await page.locator("#sessionInfoPopover").boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(320);
});
