import { expect, type Locator, type Page, test } from "@playwright/test";

async function clickMessageAction(page: Page, message: Locator, buttonName: string, menuLabel: string) {
  if ((page.viewportSize()?.width || 0) > 700) {
    await message.hover();
    await message.getByRole("button", { name: buttonName }).click();
    return;
  }
  await message.scrollIntoViewIfNeeded();
  const box = await message.boundingBox();
  if (!box) throw new Error("Message is not visible");
  await page.mouse.move(box.x + box.width / 2, Math.max(8, box.y + Math.min(box.height / 2, 24)));
  await page.mouse.down();
  await page.waitForTimeout(550);
  await page.mouse.up();
  await page.locator(".messageActionMenu").getByRole("menuitem", { name: menuLabel, exact: true }).click();
}

function messagesFor(sessionId: string, origin: string) {
  if (sessionId === "mock-older") return [
    { role: "user", entryId: "old-u1", text: "Older request" },
    { role: "assistant", entryId: "old-a1", text: "Older answer" },
  ];
  return [
    { role: "user", entryId: "mock-u1", text: "Current request" },
    {
      role: "assistant",
      entryId: "mock-a1",
      text: [
        "[Named target](/?sessionId=mock-current&entryId=mock-a1)",
        "[Older target](/?sessionId=mock-older&entryId=old-a1)",
        "[External docs](https://example.com/reference)",
        `${origin}/?sessionId=mock-current&entryId=mock-u1`,
      ].join("\n\n"),
    },
  ];
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    document.addEventListener("click", (event) => {
      const button = event.target instanceof HTMLElement ? event.target.closest<HTMLButtonElement>(".messageActionButton") : null;
      if (button && button.getClientRects().length === 0) event.stopImmediatePropagation();
    }, true);
  });
  await page.request.post("/api/mock/reset");
});

test("copies canonical header and persisted-message links", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => { (window as any).__copied = text; } },
    });
  });
  await page.goto("/");
  const origin = new URL(page.url()).origin;

  const user = page.locator('.message.user[data-entry-id="mock-u1"]');
  await clickMessageAction(page, user, "Copy link to this message", "Copy link");
  await expect.poll(() => page.evaluate(() => (window as any).__copied)).toBe(`${origin}/?sessionId=mock-current&entryId=mock-u1`);

  const assistant = page.locator('.message.assistant[data-entry-id="mock-a1"]');
  await clickMessageAction(page, assistant, "Copy link to this message", "Copy link");
  await expect.poll(() => page.evaluate(() => (window as any).__copied)).toBe(`${origin}/?sessionId=mock-current&entryId=mock-a1`);

  await page.locator("#copySessionLinkButton").click();
  await expect.poll(() => page.evaluate(() => (window as any).__copied)).toBe(`${origin}/?sessionId=mock-current`);
});

test("opens named and raw Markdown citations in place, including cold load and Back", async ({ page }) => {
  await page.request.patch("/api/session-ui-state", { data: { pinnedSessions: [{ id: "mock-current" }, { id: "mock-older" }] } });
  await page.route("**/api/messages?*", async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({ json: { messages: messagesFor(url.searchParams.get("sessionId") || "mock-current", url.origin) } });
  });
  await page.goto("/?sessionId=mock-older&entryId=old-a1");
  await expect(page.locator('.message.assistant[data-entry-id="old-a1"]')).toBeFocused();
  await page.goto("/?sessionId=mock-current&entryId=mock-u1");
  const initial = page.locator('.message.user[data-entry-id="mock-u1"]');
  await expect(initial).toBeFocused();

  const named = page.locator(".sessionCitation", { hasText: "Named target" });
  const raw = page.locator('.sessionCitation[href="/?sessionId=mock-current&entryId=mock-u1"]');
  await expect(named.locator("svg.sessionCitationChatIcon")).toHaveCount(1);
  await expect(raw.locator("svg.sessionCitationChatIcon")).toHaveCount(1);
  await expect(raw).not.toContainText("sessionId=");
  await expect(raw).not.toContainText("message");
  await expect(named).toHaveAttribute("href", "/?sessionId=mock-current&entryId=mock-a1");
  const external = page.locator('a[href="https://example.com/reference"]');
  await expect(external).toHaveAttribute("target", "_blank");
  await expect(external).not.toHaveAttribute("data-session-citation", "true");

  await named.click();
  const currentTarget = page.locator('.message.assistant[data-entry-id="mock-a1"]');
  await expect(page).toHaveURL(/sessionId=mock-current&entryId=mock-a1/);
  await expect(currentTarget).toBeFocused();

  await page.locator(".sessionCitation", { hasText: "Older target" }).click();
  const olderTarget = page.locator('.message.assistant[data-entry-id="old-a1"]');
  await expect(page).toHaveURL(/sessionId=mock-older&entryId=old-a1/);
  await expect(olderTarget).toBeFocused();

  await page.goBack();
  await expect(currentTarget).toBeFocused();
  await page.goBack();
  await expect(initial).toBeFocused();
  await page.locator(".sessionBarTab").filter({ hasText: "Older mock session" }).click();
  await expect(page).toHaveURL((url) => url.searchParams.get("sessionId") === "mock-older" && !url.searchParams.has("entryId"));
});

test("consumes a citation target once instead of replaying it after refresh", async ({ page }) => {
  await page.route("**/api/messages?*", async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({ json: { messages: messagesFor("mock-current", url.origin) } });
  });
  await page.goto("/?sessionId=mock-current&entryId=mock-u1");
  const target = page.locator('.message.user[data-entry-id="mock-u1"]');
  await expect(target).toBeFocused();

  const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/messages");
  await page.locator("#prompt").fill("refresh after citation");
  await page.locator("#primaryButton").click();
  await refreshed;
  await page.waitForTimeout(120);
  await expect(target).not.toBeFocused();
});

test("quotes a saved target outside the transcript without tree mutation", async ({ page }) => {
  let treeRequests = 0;
  await page.route("**/api/messages?*", async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({ json: { messages: messagesFor(url.searchParams.get("sessionId") || "mock-current", url.origin) } });
  });
  await page.route("**/api/session/reference?*", async (route) => {
    await route.fulfill({ json: { entries: [{ text: "Saved before compaction", truncated: true }], truncated: true } });
  });
  await page.route("**/api/session/tree/navigate", async (route) => { treeRequests += 1; await route.abort(); });

  await page.goto("/?sessionId=mock-current&entryId=gone-entry");
  const quote = page.getByRole("dialog", { name: "Referenced message" });
  await expect(quote).toContainText("Saved before compaction");
  await expect(quote).toContainText("Saved text was truncated");
  await expect(page.locator(".message.citationQuote")).toHaveCount(0);
  await expect.poll(() => page.locator("#messages").evaluate((node) => node.scrollTop)).toBe(0);
  await expect(quote.getByRole("link", { name: /Message/ })).toHaveAttribute("href", "/?sessionId=mock-current&entryId=gone-entry");
  await expect(quote.getByRole("link", { name: /Session/ })).toHaveAttribute("href", "/?sessionId=mock-current");
  await page.keyboard.press("Escape");
  await expect(quote).not.toBeVisible();
  await page.goto("/?sessionId=mock-current&entryId=gone-entry");
  await expect(quote).toBeVisible();
  await page.mouse.click(2, 2);
  await expect(quote).not.toBeVisible();
  await page.goto("/?sessionId=mock-current&entryId=gone-entry");
  await expect(quote).toBeVisible();
  await quote.getByRole("link", { name: /Session/ }).click();
  await expect(page).toHaveURL((url) => url.searchParams.get("sessionId") === "mock-current" && !url.searchParams.has("entryId"));
  await expect(quote).not.toBeVisible();
  expect(treeRequests).toBe(0);
});

test("reports a truly missing saved target and still links to its session", async ({ page }) => {
  await page.route("**/api/messages?*", async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({ json: { messages: messagesFor("mock-current", url.origin) } });
  });
  await page.route("**/api/session/reference?*", async (route) => {
    await route.fulfill({ status: 404, json: { ok: false, error: "Session entry not found" } });
  });
  await page.goto("/?sessionId=mock-current&entryId=missing-entry");
  const quote = page.getByRole("dialog", { name: "Referenced message" });
  await expect(quote).toContainText("Referenced message unavailable");
  await expect(quote).toContainText("Session entry not found");
  await expect(quote.getByRole("link", { name: /Session/ })).toHaveAttribute("href", "/?sessionId=mock-current");
});

test("keeps loading fallback modal, restores focus, and ignores its response after dismissal", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/messages?*", async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({ json: { messages: messagesFor("mock-current", url.origin) } });
  });
  await page.route("**/api/session/reference?*", async (route) => {
    await gate;
    await route.fulfill({ json: { entries: [{ text: "Late saved text" }] } });
  });

  await page.goto("/?sessionId=mock-current");
  const prompt = page.locator("#prompt");
  await prompt.focus();
  const beforeCount = await page.locator("#messages .message").count();
  const beforeScroll = await page.locator("#messages").evaluate((node) => node.scrollTop);
  await page.evaluate(() => history.pushState({}, "", "/?sessionId=mock-current&entryId=slow-entry"));
  await page.evaluate(() => window.dispatchEvent(new PopStateEvent("popstate")));

  const quote = page.getByRole("dialog", { name: "Referenced message" });
  await expect(quote).toContainText("Loading saved message");
  await expect(quote.getByRole("button", { name: "Close referenced message" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(quote).not.toBeVisible();
  await expect(prompt).toBeFocused();
  release();
  await page.waitForTimeout(100);
  await expect(quote).not.toBeVisible();
  await expect(page.locator("#messages .message")).toHaveCount(beforeCount);
  expect(await page.locator("#messages").evaluate((node) => node.scrollTop)).toBe(beforeScroll);
});

test("shows cross-session unavailable targets with distinct exact-message and session links", async ({ page }) => {
  await page.route("**/api/messages?*", async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({ json: { messages: messagesFor(url.searchParams.get("sessionId") || "mock-current", url.origin) } });
  });
  await page.route("**/api/session/reference?*", async (route) => {
    await route.fulfill({ status: 404, json: { ok: false, error: "Archived entry unavailable" } });
  });
  await page.goto("/?sessionId=mock-older&entryId=deleted-cross-entry");
  const quote = page.getByRole("dialog", { name: "Referenced message" });
  await expect(quote).toContainText("Archived entry unavailable");
  await expect(quote.getByRole("link", { name: /Message/ })).toHaveAttribute("href", "/?sessionId=mock-older&entryId=deleted-cross-entry");
  await expect(quote.getByRole("link", { name: /Session/ })).toHaveAttribute("href", "/?sessionId=mock-older");
});

test("discards a stale quote response after citation navigation", async ({ page }) => {
  await page.route("**/api/messages?*", async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({ json: { messages: messagesFor("mock-current", url.origin) } });
  });
  await page.route("**/api/session/reference?*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await route.fulfill({ json: { entries: [{ text: "Stale saved text" }] } });
  });
  await page.goto("/?sessionId=mock-current&entryId=missing-entry");
  await page.evaluate(() => history.pushState({}, "", "/?sessionId=mock-current"));
  await page.waitForTimeout(250);
  await expect(page.getByRole("dialog", { name: "Referenced message" })).not.toBeVisible();
});
