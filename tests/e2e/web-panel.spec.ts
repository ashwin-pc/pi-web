import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

test("opens an extension panel from the FAB and submits its form", async ({ page }) => {
  await page.route("**/api/state**", async (route) => {
    const response = await route.fetch();
    const state = await response.json();
    state.webPanels = [
      { key: "notes", title: "Global notepad", label: "Notepad", icon: "notebook-pen" },
      { key: "quiet", title: "No launcher", label: "Quiet", icon: "notebook-pen" },
    ];
    state.webFabActions = [
      { key: "notes-launcher", title: "Global notepad", label: "Notepad", icon: "notebook-pen", opens: "notes" },
    ];
    await route.fulfill({ response, json: state });
  });

  const invocations: any[] = [];
  await page.route("**/api/web-panel/invoke", async (route) => {
    const input = route.request().postDataJSON();
    invocations.push(input);
    const value = input.fields?.content || "Initial global note";
    const status = input.action === "save" ? "Saved globally" : "Shared with every conversation";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        title: "Global notepad",
        html: `<form class="webPanelForm" data-web-panel-action="save"><textarea class="webPanelTextarea" name="content" autofocus>${value}</textarea><div class="webPanelFormActions"><span role="status">${status}</span><button class="webPanelButton" type="submit" data-web-panel-action="save">Save</button></div></form>`,
      }),
    });
  });

  await page.goto("/");
  await page.locator("#prompt").blur();
  await page.locator(".actionLauncherToggle").click();
  await expect(page.locator(".actionLauncherItem", { hasText: "Notepad" })).toBeVisible();
  await expect(page.locator(".actionLauncherItem", { hasText: "Quiet" })).toHaveCount(0);
  await page.locator(".actionLauncherItem", { hasText: "Notepad" }).click();

  const panel = page.locator("#webExtensionPanel");
  await expect(panel).toBeVisible();  await expect(panel.locator("h2")).toHaveText("Global notepad");
  await expect(panel.locator("textarea")).toHaveValue("Initial global note");

  await panel.locator("textarea").fill("Remember this everywhere");
  await panel.getByRole("button", { name: "Save" }).click();

  await expect(panel.getByRole("status")).toHaveText("Saved globally");
  expect(invocations.at(-1)).toMatchObject({
    key: "notes",
    action: "save",
    fields: { content: "Remember this everywhere" },
  });
});
