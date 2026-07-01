import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
  await page.request.patch("/api/settings", {
    data: {
      appearance: { density: "comfortable", accentColor: "#7dd3fc" },
      composer: { queueMode: "steer", expanded: false },
      defaults: { model: null, thinkingLevel: null },
    },
  });
});

async function openConversationTree(page: any) {
  await page.locator("#conversationTreeButton").click();
  const panel = page.locator(".conversationTreePanel");
  await expect(panel).toBeVisible();
  return panel;
}

test.describe("conversation tree UI", () => {
  test("opens as a compact proper tree with visible branch structure", async ({ page }) => {
    await page.goto("/");
    const panel = await openConversationTree(page);

    await expect(panel.locator(".conversationTreeTitle h2")).toHaveText("Conversation tree");
    await expect(panel.locator(".conversationTreeFilter")).toHaveValue("default");
    await expect(panel.locator(".conversationTreeNode")).toHaveCount(4);
    await expect(panel.getByRole("treeitem", { name: /Can you add image attachments/i })).toBeVisible();
    await expect(panel.getByRole("treeitem", { name: /Actually, make the attachment picker mobile-first/i })).toBeVisible();
    await expect(panel.locator(".conversationTreeBadge.branch")).toHaveText("2 branches");
    await expect(panel.locator(".conversationTreeGraph")).toBeVisible();
    await expect(panel.locator(".conversationTreeGraphPath")).toHaveCount(3);
    await expect(panel.locator(".conversationTreeGraphPath.activePath")).toHaveCount(1);
    await expect(panel.locator(".conversationTreeGraphPath.inactivePath")).toHaveCount(2);
    await expect(panel.locator(".conversationTreeBadge.branchLane").first()).toContainText("branch 1 · current");
    await expect(panel.locator(".conversationTreeBadge.branchLane").last()).toContainText("branch 2");

    const firstRowHeight = await panel.locator(".conversationTreeNode").first().evaluate((el: HTMLElement) => el.getBoundingClientRect().height);
    expect(firstRowHeight).toBeLessThanOrEqual(36);
  });

  test("filters tool entries out of the default tree and shows them in all entries", async ({ page }) => {
    await page.goto("/");
    await page.locator("#prompt").fill("edit diff");
    await page.locator("#primaryButton").click();
    await expect(page.locator(".toolCard", { hasText: "edit" }).last()).toBeVisible();

    const panel = await openConversationTree(page);
    await expect(panel).not.toContainText("Tool call: edit /some/file.ts");
    await expect(panel).not.toContainText("Tool result: edit");
    await expect(panel.getByRole("treeitem", { name: /edit diff/i })).toBeVisible();

    await panel.locator(".conversationTreeFilter").selectOption("all");
    await expect(panel).toContainText("Tool call: edit /some/file.ts");
    await expect(panel).toContainText("Tool result: edit");
  });

  test("loads a selected user node into the composer for branch editing", async ({ page }) => {
    await page.goto("/");
    const panel = await openConversationTree(page);

    await panel.getByRole("treeitem", { name: /Actually, make the attachment picker mobile-first/i }).click();
    await expect(panel.locator(".conversationTreeSelection")).toBeVisible();
    await panel.getByRole("button", { name: "Edit from here" }).click();

    await expect(page.locator("#prompt")).toHaveValue("Actually, make the attachment picker mobile-first.");
    await expect(page.locator(".message.system", { hasText: "Loaded an earlier prompt" })).toBeVisible();
  });

  test("renders assistant provider errors as compact expandable error cards in chat", async ({ page }) => {
    await page.request.patch("/api/settings", { data: { appearance: { density: "compact" } } });
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-density", "compact");

    await page.locator("#prompt").fill("provider error");
    await page.locator("#primaryButton").click();

    const card = page.locator(".runtimeErrorCard.toolCard--error").last();
    await expect(card).toBeVisible();
    await expect(card).toHaveClass(/toolCard--compactCollapsed/);
    await expect(card.locator(".toolCardName")).toHaveText("assistant error");
    await expect(card.locator(".toolCardSubtitle")).toContainText("The usage limit has been reached");
    await expect(card.locator(".toolCardBody")).toBeHidden();

    const collapsedHeight = await card.evaluate((el: HTMLElement) => el.getBoundingClientRect().height);
    expect(collapsedHeight).toBeLessThanOrEqual(32);

    await card.locator(".toolCardExpandToggle").click();
    await expect(card).not.toHaveClass(/toolCard--compactCollapsed/);
    await expect(card.locator(".toolCardBody")).toBeVisible();
    await expect(card.locator(".toolCardBody")).toContainText("usage_limit_reached");
  });

  test("keeps provider errors out of the default tree but exposes them in all entries", async ({ page }) => {
    await page.goto("/");
    await page.locator("#prompt").fill("provider error");
    await page.locator("#primaryButton").click();
    await expect(page.locator(".runtimeErrorCard").last()).toBeVisible();

    const panel = await openConversationTree(page);
    await expect(panel).not.toContainText("usage limit");

    await panel.locator(".conversationTreeFilter").selectOption("all");
    await expect(panel).toContainText("error:");
    await expect(panel).toContainText("The usage limit has been reached");
  });
});
