import { expect, type Locator, type Page, test } from "@playwright/test";

const runnerCapabilities = {
  messageBranching: true,
  sessionRename: false,
  slashCommands: false,
  shellCommands: false,
  sessionStats: false,
  gitSync: false,
  extensionUi: false,
  compactionCancel: false,
};

const runtimeRef = { id: "container:test", kind: "container", label: "Test runtime", cwd: "/workspace", capabilities: runnerCapabilities };

async function routeRuntimeSession(page: Page) {
  await page.route("**/api/runtimes", (route) => route.fulfill({ json: { ok: true, runtimes: [
    { id: "local", kind: "local", label: "Local machine" },
    runtimeRef,
  ] } }));
  await page.route("**/api/state?**", (route) => route.fulfill({ json: {
    ok: true,
    sessionId: "runtime-session",
    sessionName: "Runtime session",
    cwd: "/workspace",
    runtimeRef,
    model: null,
    thinkingLevel: "off",
    thinkingLevels: ["off"],
    isStreaming: false,
    isCompacting: false,
    stats: null,
  } }));
  await page.route("**/api/messages?**", (route) => route.fulfill({ json: { ok: true, messages: [
    { role: "user", text: "Runtime user message", entryId: "runtime-entry-1" },
    { role: "assistant", text: "Runtime assistant response", entryId: "runtime-entry-2" },
  ] } }));
  await page.route("**/api/models?**", (route) => route.fulfill({ json: { ok: true, models: [], current: null, thinkingLevel: "off", thinkingLevels: ["off"] } }));
}

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
      appearance: { density: "comfortable", accentColor: "#e2b15f", loadingAnimation: "fireworks" },
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

  test("keeps runtime message entry ids so Edit and Rerun remain available", async ({ page }) => {
    await routeRuntimeSession(page);
    let navigatedTo = "";
    await page.route("**/api/session/tree/navigate", async (route) => {
      const body = JSON.parse(route.request().postData() || "{}");
      navigatedTo = body.targetId;
      await route.fulfill({ json: {
        ok: true,
        cancelled: false,
        editorText: "Runtime user message",
        state: { sessionId: "runtime-session", sessionName: "Runtime session", cwd: "/workspace", runtimeRef, isStreaming: false, isCompacting: false },
      } });
    });

    await page.goto("/?sessionId=runtime-session&runtimeId=container%3Atest");
    const user = page.locator(".message.user", { hasText: "Runtime user message" });
    await expect(user.locator('button[aria-label="Edit message from here"]')).toHaveCount(1);
    await expect(user.locator('button[aria-label="Rerun message from here"]')).toHaveCount(1);
    await clickMessageAction(page, user, "Edit message from here", "Edit");
    await expect(page.locator("#prompt")).toHaveValue("Runtime user message");
    expect(navigatedTo).toBe("runtime-entry-1");
  });

  test("disables unsupported runtime commands and rename before making API calls", async ({ page }) => {
    await routeRuntimeSession(page);
    let shellRequests = 0;
    let commandRequests = 0;
    await page.route("**/api/shell", (route) => { shellRequests += 1; return route.fulfill({ status: 500, json: { ok: false } }); });
    await page.route("**/api/command", (route) => { commandRequests += 1; return route.fulfill({ status: 500, json: { ok: false } }); });

    await page.goto("/?sessionId=runtime-session&runtimeId=container%3Atest");
    await expect(page.locator("#statusTitle")).toHaveAttribute("aria-disabled", "true");
    await expect(page.locator("#statusTitle")).toHaveAttribute("title", "Session rename is not supported by this runtime");

    await page.locator("#prompt").fill("!pwd");
    await page.locator("#promptForm").evaluate((form: HTMLFormElement) => form.requestSubmit());
    await expect(page.locator(".message.system", { hasText: "Shell commands are not supported by this runtime." })).toBeVisible();
    expect(shellRequests).toBe(0);

    await page.locator("#prompt").fill("/clear");
    await page.locator("#promptForm").evaluate((form: HTMLFormElement) => form.requestSubmit());
    await expect(page.locator(".message.system", { hasText: "Slash commands are not supported by this runtime." })).toBeVisible();
    expect(commandRequests).toBe(0);
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
