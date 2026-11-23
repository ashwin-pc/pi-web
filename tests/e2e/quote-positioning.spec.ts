import { expect, type Locator, type Page, test } from "@playwright/test";

const fixture = `# Review the rendering pipeline

A paragraph with **inline emphasis** and \`inline_code()\` for review.

| Stage | Policy | Result |
|---|---|---|
| Batch | bounded cadence | equivalent DOM |

\`\`\`ts
const render = () => updateMarkdown();
\`\`\`

\`\`\`mermaid
graph LR
  Delta --> Batch
  Batch --> Markdown
\`\`\`

[Artifact report](/api/artifacts/report.md)

${Array.from({ length: 8 }, () => "Additional context makes the transcript scrollable.").join("\n\n")}`;
const question = "Could we make this configurable?\nPlease explain the default behavior.\nInclude a retry example and the accessibility implications.\nFinally, compare the tradeoffs.";

async function selectText(page: Page, target: Locator, text: string) {
  await target.scrollIntoViewIfNeeded();
  await page.locator("#prompt").blur();
  await target.evaluate((element, text) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const start = element.textContent!.indexOf(text);
    if (start < 0) throw new Error(`Missing selectable text: ${text}`);
    const range = document.createRange();
    let offset = 0;
    let started = false;
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const end = offset + node.length;
      if (!started && start < end) { range.setStart(node, start - offset); started = true; }
      if (started && start + text.length <= end) { range.setEnd(node, start + text.length - offset); break; }
      offset = end;
    }
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  }, text);
}

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
  await page.request.patch("/api/settings", { data: { composer: { expanded: false } } });
  await page.route("**/api/messages?*", (route) => route.fulfill({ json: { messages: [
    { role: "assistant", text: fixture, entryId: "quote-layout-source" },
  ] } }));
  await page.goto("/");
});

for (const surface of ["table", "Mermaid", "inline code", "code block", "inline artifact"] as const) {
  test(`multiline ${surface} comments live outside the source and preserve layout`, async ({ page }) => {
    let target: Locator;
    let text: string;
    if (surface === "table") { target = page.locator("td").filter({ hasText: "bounded cadence" }); text = "bounded cadence"; }
    else if (surface === "Mermaid") {
      await page.locator(".mermaidDiagram").scrollIntoViewIfNeeded();
      target = page.locator(".mermaidDiagram .nodeLabel").filter({ hasText: /^Batch$/ }); text = "Batch";
    } else if (surface === "inline code") { target = page.locator(".message.assistant p code").first(); text = "inline_code()"; }
    else if (surface === "code block") { target = page.locator("pre code").first(); text = "updateMarkdown()"; }
    else { target = page.locator(".artifactPreviewContent p").first(); text = "artifact renders inline"; }
    await expect(target).toBeVisible();
    const originalCells = await page.locator("tr").last().locator("td").count();
    await selectText(page, target, text);
    await page.keyboard.press(".");
    const input = page.getByRole("textbox", { name: "Question for quote 1" });
    await expect(input).toBeVisible();
    await input.fill(question);
    const note = page.locator(".quoteFootnote.open");
    expect(await note.evaluate((el) => el.parentElement?.className)).toBe("quoteReplyLayer");
    expect((await input.boundingBox())!.width).toBeGreaterThan(180);
    expect((await input.boundingBox())!.height).toBeGreaterThan(68);
    expect(await page.locator("tr").last().locator("td").count()).toBe(originalCells);
    expect(await page.locator("table .quoteFootnote, svg .quoteFootnote, table .quoteReplyPin, svg .quoteReplyPin").count()).toBe(0);
    await page.getByRole("button", { name: "Confirm question" }).click();
    await expect(input).toBeHidden();
    const mark = page.locator(".quoteReplyMark");
    await mark.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.locator(".quoteReplyPin").click();
    await expect(note).toBeVisible();
    await expect(note.locator(".quoteFootnoteQuestion")).toHaveText(question);
    await expect(note.locator(".quoteFootnoteQuestion")).toHaveCSS("white-space", "pre-wrap");
    const viewport = page.viewportSize()!;
    await page.setViewportSize({ width: Math.max(360, viewport.width - 70), height: viewport.height });
    await expect.poll(async () => {
      const b = await note.boundingBox();
      return !!b && b.x >= 0 && b.y >= 0 && b.x + b.width <= page.viewportSize()!.width && b.y + b.height <= page.viewportSize()!.height;
    }).toBe(true);
    await page.locator("#messages").evaluate((el) => { el.scrollTop += 45; });
    await expect.poll(async () => {
      const pin = await page.locator(".quoteReplyPin").boundingBox();
      const anchor = await mark.boundingBox();
      return pin && anchor ? Math.abs(pin.y - (anchor.y - 18)) : Infinity;
    }).toBeLessThan(2);
    await page.locator("#statusTitle").click();
    await expect(note).toHaveCount(0);
    await page.reload();
    // Lazy Mermaid/artifact content must be ready before its offsets can restore.
    if (surface === "Mermaid") await page.locator(".mermaidDiagram").scrollIntoViewIfNeeded();
    if (surface === "inline artifact") await page.locator(".artifactPreview--markdown").scrollIntoViewIfNeeded();
    if (surface === "code block") {
      await page.locator(".message.assistant pre code").first().scrollIntoViewIfNeeded();
      await expect(page.locator(".message.assistant pre code").first()).toHaveAttribute("data-highlighted", "true");
    }
    await expect.poll(async () => {
      const mark = page.locator(".quoteReplyMark");
      if (await mark.count() !== 1) return false;
      await mark.evaluate((el) => el.scrollIntoView({ block: "center" }));
      return page.locator(".quoteReplyPin").isVisible();
    }).toBe(true);
    await page.locator(".quoteReplyPin").click();
    await expect(page.locator(".quoteFootnote.open .quoteFootnoteQuestion")).toHaveText(question);
  });
}

test("an active code comment survives asynchronous source replacement", async ({ page }) => {
  const code = page.locator(".message.assistant pre code").first();
  await selectText(page, code, "updateMarkdown()");
  await page.keyboard.press(".");
  const input = page.getByRole("textbox", { name: "Question for quote 1" });
  await input.fill(question);
  await input.focus();
  await code.evaluate((el) => { el.textContent = el.textContent; });
  await expect(page.locator(".quoteReplyMark")).toHaveCount(1);
  await expect(input).toHaveValue(question);
  await expect(input).toBeFocused();
  await expect(page.locator(".quoteFootnote.editing.open")).toHaveCount(1);
});

test("right artifact panel remains a separate, non-commentable surface", async ({ page }) => {
  await page.locator(".artifactPreview--markdown").scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Open in Artifacts panel" }).click();
  const paragraph = page.locator("#artifactBrowserPreviewBody p").first();
  await expect(paragraph).toBeVisible();
  await selectText(page, paragraph, "markdown");
  await paragraph.dispatchEvent("pointerup");
  await expect(page.locator(".quoteSelectionToolbar")).toBeHidden();
  await page.keyboard.press(".");
  await expect(page.locator(".quoteFootnote")).toHaveCount(0);
});
