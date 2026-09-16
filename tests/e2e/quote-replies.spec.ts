import { expect, type Page, test } from "@playwright/test";
import { sessionDraftPersistDelayMs } from "../../src/drafts/sessionDraftStore.js";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
  await page.request.patch("/api/settings", {
    data: {
      appearance: { density: "comfortable", accentColor: "#e2b15f", loadingAnimation: "fireworks" },
      composer: { queueMode: "steer", expanded: false },
    },
  });
});

async function switchSession(page: Page, sessionName: string) {
  const drawer = page.locator("#sessionDrawer");
  const target = page.locator(".sessionItem").filter({ hasText: sessionName }).locator(".sessionItemNavBtn");
  if (!await target.isVisible()) {
    await expect(drawer).toBeHidden();
    await page.locator("#sessionButton").click();
  }
  await expect(target).toBeAttached();
  await target.evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.locator("#statusTitle")).toHaveText(sessionName);
}

async function delayQuoteDraftPersistence(page: Page) {
  await page.evaluate((debounceMs) => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
      nativeSetTimeout(handler, timeout === debounceMs ? 1_000 : timeout, ...args)) as typeof window.setTimeout;
  }, sessionDraftPersistDelayMs);
}

async function selectAssistantExcerpt(page: Page, text: string) {
  const paragraph = page.locator(".message.assistant .body p").filter({ hasText: text }).first();
  await paragraph.scrollIntoViewIfNeeded();
  await paragraph.evaluate((paragraph: HTMLElement, selectedText: string) => {
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
  // selectionchange deliberately performs a delayed placement pass (longer on
  // touch); measure only after that canonical pass has replaced the first one.
  await page.waitForTimeout(350);
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

test("migrates legacy composer and session quote drafts", async ({ page }) => {
  const quote = [{ id: 4, quote: "Image attachment support", question: "Migrated question", sourceMessageId: "assistant-entry", startOffset: 0, endOffset: 24 }];
  await page.addInitScript((legacyQuote) => {
    localStorage.setItem("pi-web-composer-draft", "Migrated composer text");
    localStorage.setItem("pi-web-quote-reply-drafts-v1", JSON.stringify({ "mock-current": legacyQuote }));
  }, quote);
  await page.goto("/");

  await expect(page.locator("#prompt")).toHaveValue("Migrated composer text");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("pi-web-session-drafts-v1"))).toContain("Migrated question");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("pi-web-composer-draft"))).toBeNull();
});

test("restores unfinished quote replies and composer text after reload", async ({ page }) => {
  await page.goto("/");
  await selectAssistantExcerpt(page, "Image attachment support");
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await page.getByRole("textbox", { name: "Question for quote 1" }).fill("How should this work offline?");
  await page.getByRole("button", { name: "Confirm question" }).click();
  await page.locator("#prompt").fill("Please compare the tradeoffs.");

  await page.reload();

  await expect(page.locator("#prompt")).toHaveValue("Please compare the tradeoffs.");
  await expect(page.locator(".quoteReplyMark")).toHaveCount(1);
  await expect(page.locator(".quoteReplySummaryButton")).toContainText("1 linked reply");
  await page.locator(".quoteReplyPin").click();
  await expect(page.locator(".quoteFootnote.open .quoteFootnoteQuestion")).toHaveText("How should this work offline?");
});

test("keeps composer text per session across fast switches and reload", async ({ page }) => {
  await page.goto("/");
  await page.locator("#prompt").fill("Current session draft");
  await switchSession(page, "Older mock session");
  await expect(page.locator("#prompt")).toHaveValue("");
  await page.locator("#prompt").fill("Older session draft");

  await switchSession(page, "Current mock session");
  await expect(page.locator("#prompt")).toHaveValue("Current session draft");
  await switchSession(page, "Older mock session");
  await expect(page.locator("#prompt")).toHaveValue("Older session draft");
  await expect(page).toHaveURL(/sessionId=mock-older/);

  await page.reload();
  await expect(page.locator("#prompt")).toHaveValue("Older session draft");
});

test("a failed send restores only its captured session after switching", async ({ page }) => {
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/prompt", async (route) => {
    await delayed;
    await route.fulfill({ status: 500, body: "delayed failure" });
  });
  await page.goto("/");
  await page.locator("#prompt").fill("Session A submission");
  await page.locator("#primaryButton").click();
  await switchSession(page, "Older mock session");
  await page.locator("#prompt").fill("Session B draft");
  release();
  await expect(page.locator("#prompt")).toHaveValue("Session B draft");
  await switchSession(page, "Current mock session");
  await expect(page.locator("#prompt")).toHaveValue("Session A submission");
});

test("an upload completion remains owned by the session where it started", async ({ page }) => {
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/attachments?**", async (route) => {
    await delayed;
    await route.fulfill({ json: { attachment: { type: "file", id: "delayed-file", name: "delayed.png", mediaType: "image/png", bytes: 3, path: "/tmp/delayed.png", contentUrl: "/api/attachments/delayed-file" } } });
  });
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles({ name: "delayed.png", mimeType: "image/png", buffer: Buffer.from([1, 2, 3]) });
  await switchSession(page, "Older mock session");
  release();
  await expect(page.locator(".attachmentChip")).toHaveCount(0);
  await switchSession(page, "Current mock session");
  await expect(page.locator(".attachmentChip")).toContainText("delayed.png");
});

test("restores an outgoing quote draft after switching sessions before its debounce fires", async ({ page }) => {
  await page.goto("/");
  await selectAssistantExcerpt(page, "Image attachment support");
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await delayQuoteDraftPersistence(page);
  await page.getByRole("textbox", { name: "Question for quote 1" }).fill("Preserve this outgoing draft");

  await switchSession(page, "Older mock session");
  await switchSession(page, "Current mock session");

  await page.locator(".quoteReplyPin").click();
  await expect(page.locator(".quoteFootnote.open .quoteFootnoteQuestion")).toHaveText("Preserve this outgoing draft");
});

test("a successful in-flight quote send cannot commit into the destination session", async ({ page }) => {
  const destinationDraft = [{ id: 7, quote: "Resumed older session.", question: "Keep destination", sourceMessageId: "destination-entry", startOffset: 0, endOffset: 22 }];
  await page.addInitScript((draft) => localStorage.setItem("pi-web-session-drafts-v1", JSON.stringify({ version: 1, sessions: {
    "mock-older": { text: "", attachments: [], quoteReplies: draft },
  } })), destinationDraft);
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/prompt", async (route) => { await delayed; await route.fulfill({ json: { ok: true } }); });
  await page.goto("/");
  await selectAssistantExcerpt(page, "Image attachment support");
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await page.getByRole("textbox", { name: "Question for quote 1" }).fill("Send from A");
  await page.getByRole("button", { name: "Confirm question" }).click();
  await page.locator("#promptForm").evaluate((form: HTMLFormElement) => form.requestSubmit());
  await switchSession(page, "Older mock session");
  release();

  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("pi-web-session-drafts-v1") || "{}").sessions?.["mock-older"]?.quoteReplies)).toEqual(destinationDraft);
});

test("does not delete destination quote drafts during a fast session switch", async ({ page }) => {
  const destinationDraft = [{
    id: 7,
    quote: "Resumed older session.",
    question: "Keep the destination draft",
    sourceMessageId: "destination-entry",
    startOffset: 0,
    endOffset: 22,
  }];
  await page.addInitScript((draft) => localStorage.setItem("pi-web-session-drafts-v1", JSON.stringify({
    version: 1,
    sessions: { "mock-older": { text: "", attachments: [], quoteReplies: draft } },
  })), destinationDraft);
  await page.goto("/");
  await selectAssistantExcerpt(page, "Image attachment support");
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await delayQuoteDraftPersistence(page);
  await page.getByRole("textbox", { name: "Question for quote 1" }).fill("Pending source edit");

  await switchSession(page, "Older mock session");
  await page.waitForTimeout(1_100);

  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("pi-web-session-drafts-v1") || "{}").sessions?.["mock-older"]?.quoteReplies)).toEqual(destinationDraft);
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
  if (await page.evaluate(() => matchMedia("(pointer: coarse)").matches || innerWidth <= 760)) {
    const animation = await page.locator(".quoteFootnoteEntering").evaluate((note) => {
      const style = getComputedStyle(note);
      return {
        names: style.animationName,
        delays: style.animationDelay,
        durations: style.animationDuration,
      };
    });
    expect(animation).toEqual({
      names: "quoteFootnoteInputIn, quoteFootnoteAttention",
      delays: "0.32s, 0.5s",
      durations: "0.46s, 0.78s",
    });
  }
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
