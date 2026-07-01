import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
  await page.request.patch("/api/settings", {
    data: {
      appearance: { density: "comfortable", accentColor: "#b8b5ad" },
      composer: { queueMode: "steer", expanded: false },
      defaults: { model: null, thinkingLevel: null },
    },
  });
  await page.goto("/");
  await expect(page.locator("#connectionStatus")).toBeHidden();
});

test.describe("composer shell escape", () => {
  test("runs ! commands through bash instead of prompting the agent", async ({ page }) => {
    let promptRequests = 0;
    const shellRequests: any[] = [];

    await page.route("**/api/prompt", async (route) => {
      promptRequests += 1;
      await route.continue();
    });
    await page.route("**/api/shell", async (route) => {
      shellRequests.push(route.request().postDataJSON());
      await route.continue();
    });

    await page.locator("#prompt").fill("!printf shell-ok");
    await page.locator("#primaryButton").click();

    const card = page.locator(".toolCard", { hasText: "bash" }).last();
    await expect(card).toContainText("printf shell-ok");
    await expect(card).toContainText("in agent context");
    await expect(card).toContainText("Mock bash output: printf shell-ok");
    await expect(page.locator(".message.user", { hasText: "!printf shell-ok" })).toHaveCount(0);

    expect(promptRequests).toBe(0);
    expect(shellRequests).toHaveLength(1);
    expect(shellRequests[0]).toMatchObject({ command: "printf shell-ok", excludeFromContext: false });
  });

  test("runs !! commands outside agent context", async ({ page }) => {
    const shellRequests: any[] = [];
    await page.route("**/api/shell", async (route) => {
      shellRequests.push(route.request().postDataJSON());
      await route.continue();
    });

    await page.locator("#prompt").fill("!!printf no-context");
    await page.locator("#primaryButton").click();

    const card = page.locator(".toolCard", { hasText: "bash" }).last();
    await expect(card).toContainText("printf no-context");
    await expect(card).toContainText("not in agent context");
    await expect(card).toContainText("Mock bash output: printf no-context");

    expect(shellRequests).toHaveLength(1);
    expect(shellRequests[0]).toMatchObject({ command: "printf no-context", excludeFromContext: true });

    const messages = await (await page.request.get("/api/messages")).json();
    expect(messages.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "bashExecution", command: "printf no-context", excludeFromContext: true }),
    ]));
  });
});
