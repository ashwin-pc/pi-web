import { expect, type Page, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
  await page.request.patch("/api/settings", {
    data: {
      appearance: { density: "comfortable", accentColor: "#e2b15f", loadingAnimation: "fireworks" },
      composer: { queueMode: "steer", expanded: false },
    },
  });
});

async function selectAssistantExcerpt(page: Page, text: string) {
  await page.locator(".message.assistant .body p").filter({ hasText: text }).first().evaluate((paragraph: HTMLElement, selectedText: string) => {
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    let node: Text | null = null;
    let start = -1;
    while (walker.nextNode()) {
      const candidate = walker.currentNode as Text;
      start = candidate.data.indexOf(selectedText);
      if (start >= 0) {
        node = candidate;
        break;
      }
    }
    if (!node) throw new Error(`Could not find ${selectedText}`);
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + selectedText.length);
    const selection = getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    paragraph.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  }, text);
}

test("links questions to multiple assistant responses and sends structured quote pairs", async ({ page }) => {
  await page.goto("/");
  await page.locator("#prompt").fill("Create another response");
  await page.locator("#primaryButton").click();
  await expect(page.locator(".message.assistant", { hasText: "Mock response" })).toBeVisible();

  await selectAssistantExcerpt(page, "Image attachment support");
  await expect(page.getByRole("button", { name: "Reply", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  const firstQuestion = page.getByRole("textbox", { name: "Question for quote 1" });
  await expect(firstQuestion).toBeFocused();
  await firstQuestion.fill("How should this behave on mobile?");
  await page.getByRole("button", { name: "Confirm question" }).click();

  await selectAssistantExcerpt(page, "Mock response");
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await page.getByRole("textbox", { name: "Question for quote 2" }).fill("What should happen next?");
  await page.getByRole("button", { name: "Confirm question" }).click();

  await expect(page.locator(".quoteFootnote:visible")).toHaveCount(0);
  await expect(page.locator(".quoteReplySummaryButton")).toContainText("2 linked replies");
  await page.locator(".quoteReplyPin").first().click();
  await expect(page.locator(".quoteFootnoteQuestion").first()).toHaveText("How should this behave on mobile?");

  const promptRequest = page.waitForRequest((request) => request.url().endsWith("/api/prompt") && request.method() === "POST");
  await page.locator("#prompt").fill("Keep the answer concise.");
  await page.locator("#primaryButton").click();
  const payload = (await promptRequest).postDataJSON();

  expect(payload.message).toContain('<pi-web-quote-replies version="1">');
  expect(payload.message).toContain("<quote>Image attachment support</quote>");
  expect(payload.message).toContain("<question>How should this behave on mobile?</question>");
  expect(payload.message).toContain("<quote>Mock response</quote>");
  expect(payload.message).toContain("<question>What should happen next?</question>");
  expect(payload.message).toContain("<overall-instruction>Keep the answer concise.</overall-instruction>");
  await expect(page.locator(".message.user .submittedQuoteDetails").last()).toContainText("2 linked excerpts");
  await expect(page.locator(".quoteReplySummaryButton")).toBeHidden();
});
