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

test("keeps one reply action tethered to the highlighted text and dismisses it with Escape", async ({ page }) => {
  await page.goto("/");
  await selectAssistantExcerpt(page, "Image attachment support");

  const action = page.locator(".quoteSelectionToolbar");
  await expect(action).toBeVisible();
  await action.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  const geometry = await page.evaluate(() => {
    const range = getSelection()!.getRangeAt(0);
    const selectionRect = Array.from(range.getClientRects()).at(-1)!;
    const actionElement = document.querySelector<HTMLElement>(".quoteSelectionToolbar")!;
    const actionRect = actionElement.getBoundingClientRect();
    const rangeElement = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE ? range.commonAncestorContainer as Element : range.commonAncestorContainer.parentElement!;
    const block = rangeElement.closest("p, li, blockquote, pre, td, th")!;
    const blockRange = document.createRange();
    blockRange.selectNodeContents(block);
    const overlapsText = Array.from(blockRange.getClientRects()).some((rect) => actionRect.left < rect.right && actionRect.right > rect.left && actionRect.top < rect.bottom && actionRect.bottom > rect.top);
    return {
      placement: actionElement.dataset.placement,
      buttonCount: actionElement.querySelectorAll("button").length,
      overlapsText,
      selection: { left: selectionRect.left, top: selectionRect.top, right: selectionRect.right, bottom: selectionRect.bottom },
      action: { left: actionRect.left, top: actionRect.top, right: actionRect.right, bottom: actionRect.bottom },
    };
  });

  expect(geometry.buttonCount).toBe(1);
  expect(geometry.overlapsText).toBe(false);
  if (geometry.placement === "right") {
    expect(geometry.action.left - geometry.selection.right).toBeGreaterThanOrEqual(6);
    expect(geometry.action.left - geometry.selection.right).toBeLessThanOrEqual(120);
    const selectionCenter = (geometry.selection.top + geometry.selection.bottom) / 2;
    const actionCenter = (geometry.action.top + geometry.action.bottom) / 2;
    expect(Math.abs(actionCenter - selectionCenter)).toBeLessThanOrEqual(2);
  } else if (geometry.placement === "left") {
    expect(geometry.selection.left - geometry.action.right).toBeGreaterThanOrEqual(6);
  } else if (geometry.placement === "above") {
    expect(geometry.selection.top - geometry.action.bottom).toBeGreaterThanOrEqual(6);
    expect(geometry.selection.top - geometry.action.bottom).toBeLessThanOrEqual(10);
  } else {
    expect(geometry.action.top - geometry.selection.bottom).toBeGreaterThanOrEqual(6);
    expect(geometry.action.top - geometry.selection.bottom).toBeLessThanOrEqual(10);
  }

  await page.keyboard.press("Escape");
  await expect(action).toBeHidden();
  await expect.poll(() => page.evaluate(() => getSelection()?.isCollapsed)).toBe(true);
});

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

  expect(payload.message).toBe("Keep the answer concise.");
  expect(payload.attachments).toEqual(expect.arrayContaining([
    expect.objectContaining({
      type: "quote-reply",
      label: "Excerpt 1",
      quote: "Image attachment support",
      question: "How should this behave on mobile?",
      source: expect.objectContaining({ messageId: expect.any(String), startOffset: expect.any(Number), endOffset: expect.any(Number) }),
    }),
    expect.objectContaining({
      type: "quote-reply",
      label: "Excerpt 2",
      quote: "Mock response",
      question: "What should happen next?",
      source: expect.objectContaining({ messageId: expect.any(String), startOffset: expect.any(Number), endOffset: expect.any(Number) }),
    }),
  ]));
  await expect(page.locator(".message.user .submittedQuoteDetails").last()).toContainText("2 linked excerpts");
  await expect(page.locator(".quoteReplySummaryButton")).toBeHidden();

  await page.reload();
  await expect(page.locator(".message.user .submittedQuoteDetails").last()).toContainText("2 linked excerpts");
  await expect(page.locator(".quoteReplyMark")).toHaveCount(2);
  await expect(page.locator(".quoteReplyPin.submitted")).toHaveCount(2);
  await page.locator(".quoteReplyPin.submitted").first().click();
  await expect(page.locator(".quoteFootnote.open .quoteFootnoteQuestion")).toHaveText("How should this behave on mobile?");
});
