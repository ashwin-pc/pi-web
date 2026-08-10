import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

test("opens an extension panel from the FAB and submits its form", async ({ page }) => {
  await page.route("**/api/state**", async (route) => {
    const response = await route.fetch();
    const state = await response.json();
    state.webContributions = [
      { version: 1, key: "notes", slot: "panel", kind: "rendered", title: "Global notepad", label: "Notepad", icon: "notebook-pen" },
      { version: 1, key: "quiet", slot: "panel", kind: "rendered", title: "No launcher", label: "Quiet", icon: "notebook-pen" },
      { version: 1, key: "notes-launcher", slot: "fab", kind: "static", title: "Global notepad", label: "Notepad", icon: "notebook-pen", opens: "notes" },
      { version: 1, key: "open-notes", slot: "header-action", kind: "rendered", title: "Open notes", label: "Open notes", icon: "scroll-text" },
    ];
    await route.fulfill({ response, json: state });
  });

  const invocations: any[] = [];
  let revision = 1;
  await page.route("**/api/web-contributions/invoke", async (route) => {
    const input = route.request().postDataJSON();
    invocations.push(input);
    if (input.slot === "header-action") {
      await route.fulfill({ json: {
        ok: true,
        label: "Open notes",
        markdown: "Panel opened from the header.",
        effects: [{ type: "open-panel", key: "notes" }],
      } });
      return;
    }
    const value = input.event?.fields?.content || "Initial global note";
    const status = input.event?.action === "save" ? "Saved globally" : `Shared with every conversation · revision ${revision}`;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        title: "Global notepad",
        html: `<form class="webPanelForm" data-web-action="save"><textarea class="webPanelTextarea" name="content" autofocus>${value}</textarea><div class="webPanelFormActions"><span role="status">${status}</span><button class="webPanelButton" type="submit" data-web-action="save">Save</button></div></form>`,
      }),
    });
  });

  const stateLoaded = page.waitForResponse((response) => response.url().includes("/api/state") && response.ok());
  await page.goto("/");
  await stateLoaded;
  await page.locator("#prompt").blur();
  await page.locator(".actionLauncherToggle").click();
  await expect(page.locator(".actionLauncherItem", { hasText: "Notepad" })).toBeVisible();
  await expect(page.locator(".actionLauncherItem", { hasText: "Quiet" })).toHaveCount(0);
  await page.locator(".actionLauncherItem", { hasText: "Notepad" }).click();

  const panel = page.locator("#webExtensionPanel");
  await expect(panel).toBeVisible();  await expect(panel.locator("h2")).toHaveText("Global notepad");
  await expect(panel.locator("textarea")).toHaveValue("Initial global note");
  await expect(panel.getByRole("status")).toContainText("revision 1");

  const invokesBeforeUpdate = invocations.length;
  await panel.locator("textarea").fill("Unsubmitted draft");
  revision = 2;
  await page.request.post("/api/mock/event", { data: { type: "web_contribution_updated", sessionId: "mock-current", key: "notes" } });
  await page.waitForTimeout(100);
  await expect(panel.locator("textarea")).toHaveValue("Unsubmitted draft");
  expect(invocations.length).toBe(invokesBeforeUpdate);

  await page.locator("#prompt").focus();
  await expect(panel.getByRole("status")).toContainText("revision 2");
  expect(invocations.length).toBe(invokesBeforeUpdate + 1);

  await panel.locator("textarea").fill("Remember this everywhere");
  await panel.getByRole("button", { name: "Save" }).click();

  await expect(panel.getByRole("status")).toHaveText("Saved globally");
  expect(invocations.at(-1)).toMatchObject({
    slot: "panel",
    key: "notes",
    event: { action: "save", fields: { content: "Remember this everywhere" } },
  });

  await panel.getByRole("button", { name: "Close panel" }).click();
  await expect(panel).toBeHidden();
  await page.locator('.webHeaderActionButton[title="Open notes"]').click();
  await expect.poll(() => invocations.some((input) => input.slot === "header-action")).toBe(true);
  await expect(panel).toBeVisible();
  await expect(page.locator(".webHeaderActionPopoverBody")).toContainText("Panel opened from the header.");
});
