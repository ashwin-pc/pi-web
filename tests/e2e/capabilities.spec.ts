import { expect, test } from "@playwright/test";

const limitedCapabilities = {
  harness: "limited",
  queue: false,
  steering: false,
  followUp: false,
  thinkingLevel: false,
  tree: false,
  compaction: false,
  retry: false,
  bash: false,
  extensions: false,
  interactions: false,
};

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

test("hides harness-specific controls when capabilities are absent", async ({ page }) => {
  await page.request.post("/api/mock/state", { data: { capabilities: limitedCapabilities, queue: undefined, thinkingLevel: undefined, thinkingLevels: undefined } });
  await page.goto("/");
  await expect(page.locator("#queueToggle")).toBeHidden();
  await expect(page.locator("#conversationTreeButton")).toBeHidden();
  await page.locator("#modelSettingsButton").click();
  await expect(page.locator("#thinkingSelect")).toBeHidden();
  await expect(page.locator("#extensionFooter")).toBeEmpty();
});
