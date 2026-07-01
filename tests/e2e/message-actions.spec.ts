import { expect, type Locator, type Page, test } from "@playwright/test";

async function clickMessageAction(page: Page, message: Locator, buttonName: string, menuLabel: string) {
  const width = page.viewportSize()?.width || 0;
  if (width <= 700) {
    const box = await message.boundingBox();
    if (!box) throw new Error("Message is not visible");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(650);
    await page.mouse.up();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: menuLabel }).click();
    return;
  }

  await message.hover();
  await message.getByRole("button", { name: buttonName }).click();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const hiddenInlineAction = target.closest<HTMLButtonElement>(".messageActionButton");
      if (!hiddenInlineAction || hiddenInlineAction.getClientRects().length > 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  });

  await page.request.post("/api/mock/reset");
  await page.request.patch("/api/settings", {
    data: {
      appearance: { density: "comfortable", accentColor: "#e2b15f" },
      composer: { queueMode: "steer", expanded: false },
      defaults: { model: null, thinkingLevel: null },
    },
  });
});

test.describe("message actions", () => {
  test("copies user and assistant messages", async ({ page }) => {
    await page.addInitScript(() => {
      let copied = "";
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => { copied = text; (window as any).__copiedText = text; },
          readText: async () => copied,
        },
      });
    });

    await page.goto("/");

    const user = page.locator(".message.user", { hasText: "Can you add image attachments?" }).first();
    await clickMessageAction(page, user, "Copy user message", "Copy");
    await expect.poll(() => page.evaluate(() => (window as any).__copiedText)).toBe("Can you add image attachments?");

    const assistant = page.locator(".message.assistant", { hasText: "Image attachment support" }).first();
    await clickMessageAction(page, assistant, "Copy assistant message", "Copy");
    await expect.poll(() => page.evaluate(() => (window as any).__copiedText)).toContain("## Image attachment support");
  });

  test("edits and reruns user messages via tree navigation", async ({ page }) => {
    await page.goto("/");

    const user = page.locator(".message.user", { hasText: "Can you add image attachments?" }).first();
    await clickMessageAction(page, user, "Edit message from here", "Edit");

    await expect(page.locator("#prompt")).toHaveValue("Can you add image attachments?");
    await expect(page.locator(".message.system", { hasText: "Loaded an earlier prompt" })).toBeVisible();

    await page.request.post("/api/mock/reset");
    await page.reload();

    const rerunUser = page.locator(".message.user", { hasText: "Can you add image attachments?" }).first();
    await clickMessageAction(page, rerunUser, "Rerun message from here", "Rerun");

    await expect(page.locator(".message.user", { hasText: "Can you add image attachments?" })).toBeVisible();
    await expect(page.locator(".message.assistant", { hasText: "Mock response" })).toBeVisible();
  });

  test("continues from an assistant message by moving the active tree position", async ({ page }) => {
    await page.goto("/");

    await page.locator("#prompt").fill("branch followup");
    await page.locator("#primaryButton").click();
    await expect(page.locator(".message.user", { hasText: "branch followup" })).toBeVisible();
    await expect(page.locator(".message.assistant", { hasText: "Mock response" })).toBeVisible();

    const firstAssistant = page.locator(".message.assistant", { hasText: "Image attachment support" }).first();
    await clickMessageAction(page, firstAssistant, "Continue from this assistant message", "Continue");

    await expect(page.locator(".message.user", { hasText: "branch followup" })).toHaveCount(0);
  });
});
