import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

test("a pending message panel link upgrades in place when its panel registers", async ({ page }) => {
  const invocations: any[] = [];
  await page.route("**/api/messages**", (route) => route.fulfill({ json: {
    ok: true,
    messages: [{
      role: "assistant",
      isError: false,
      text: "[Open late note](#panel:late-notes:id=n-7&undeclared=drop)",
    }],
  } }));
  await page.route("**/api/web-contributions/invoke", async (route) => {
    const input = route.request().postDataJSON();
    invocations.push(input);
    if (input.event?.action === "__pi_web_describe_deep_link") {
      await route.fulfill({ json: { ok: true, description: `Late notes › ${input.event.payload.id}` } });
      return;
    }
    await route.fulfill({ json: { ok: true, title: "Late notes", html: "<p>Late panel opened</p>" } });
  });
  await page.request.post("/api/mock/state", { data: { webContributions: [] } });
  await page.goto("/");

  const pending = page.getByRole("link", { name: "Open late note" });
  await expect(pending).toHaveClass(/panelDeepLinkPending/);

  const messagesReloaded = page.waitForResponse((response) => response.url().includes("/api/messages") && response.ok());
  await page.request.post("/api/mock/state", { data: { webContributions: [{
    version: 1,
    key: "late-notes",
    slot: "panel",
    kind: "rendered",
    title: "Late notes",
    label: "Late notes",
    icon: "notebook-pen",
    deepLinks: { allowedKeys: ["id"], requiredKeys: ["id"], hasDescribe: true },
  }] } });
  await messagesReloaded;

  const upgraded = page.getByRole("link", { name: "Late notes › n-7" });
  await expect(upgraded).toHaveClass(/panelDeepLinkChip/);
  await upgraded.click();
  await expect(page.locator("#webExtensionPanel")).toBeVisible();
  expect(invocations.find((input) => input.event?.action === "deep-link")).toMatchObject({
    key: "late-notes",
    event: { action: "deep-link", source: "message", payload: { id: "n-7" } },
  });
});

test("opens an extension panel from chat and the FAB, then submits its form", async ({ page }) => {
  const webContributions = [
    {
      version: 1, key: "notes", slot: "panel", kind: "rendered", title: "Global notepad", label: "Notepad", icon: "notebook-pen",
      deepLinks: { allowedKeys: ["id"], requiredKeys: ["id"], hasDescribe: true },
    },
    { version: 1, key: "quiet", slot: "panel", kind: "rendered", title: "No launcher", label: "Quiet", icon: "notebook-pen" },
    { version: 1, key: "notes-launcher", slot: "fab", kind: "static", title: "Global notepad", label: "Notepad", icon: "notebook-pen", opens: "notes" },
    { version: 1, key: "open-notes", slot: "header-action", kind: "rendered", title: "Open notes", label: "Open notes", icon: "scroll-text" },
  ];
  await page.route("**/api/messages**", (route) => route.fulfill({ json: {
    ok: true,
    messages: [
      { role: "assistant", isError: false, text: "[Missing panel](#panel:missing:note=ignored) · [Malformed panel](#panel::note=ignored)" },
      { role: "assistant", isError: false, text: "[Open assistant task](#panel:notes:id=t-3f2a&undeclared=drop-me) · [Invalid task](#panel:notes:undeclared=only)" },
      { role: "user", text: "[Open legacy panel](#panel:quiet:note=oncall%2Fw34)" },
    ],
  } }));
  await page.request.post("/api/mock/state", { data: {
    webContributions,
  } });

  const invocations: any[] = [];
  let revision = 1;
  await page.route("**/api/web-contributions/invoke", async (route) => {
    const input = route.request().postDataJSON();
    invocations.push(input);
    if (input.slot === "panel" && input.event?.action === "__pi_web_describe_deep_link") {
      await route.fulfill({ json: { ok: true, description: `Notepad › task › ${input.event.payload.id}` } });
      return;
    }
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
    const content = input.event?.action === "deep-link"
      ? `<div id="deep-link-target" tabindex="-1" autofocus>Scanner task</div>`
      : `<form class="webPanelForm" data-web-action="save"><textarea class="webPanelTextarea" name="content" autofocus>${value}</textarea><div class="webPanelFormActions"><span role="status">${status}</span><button class="webPanelButton" type="submit" data-web-action="save">Save</button></div></form>`;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        title: "Global notepad",
        html: content,
      }),
    });
  });

  const stateLoaded = page.waitForResponse((response) => response.url().includes("/api/state") && response.ok());
  await page.goto("/");
  await stateLoaded;
  // The response can complete before contributions have been applied to the UI.
  await expect(page.locator('.webHeaderActionButton[title="Open notes"]')).toBeVisible();
  await page.locator("#prompt").blur();

  const panel = page.locator("#webExtensionPanel");
  await expect(page.getByRole("link", { name: "Malformed panel" })).toHaveCount(0);
  await expect(panel).toBeHidden();
  expect(invocations.filter((input) => input.event?.action !== "__pi_web_describe_deep_link")).toEqual([]);

  let unexpectedDialogs = 0;
  const dismissUnexpected = async (dialog: import("@playwright/test").Dialog) => {
    unexpectedDialogs += 1;
    await dialog.dismiss();
  };
  page.on("dialog", dismissUnexpected);
  const missingPanel = page.getByRole("link", { name: "Missing panel" });
  await expect(missingPanel).toBeVisible();
  await missingPanel.click();
  await expect(panel).toBeHidden();
  page.off("dialog", dismissUnexpected);
  expect(unexpectedDialogs).toBe(0);
  expect(invocations.filter((input) => input.event?.action !== "__pi_web_describe_deep_link")).toEqual([]);

  await expect(page.getByText("Invalid task", { exact: true })).not.toHaveAttribute("href");
  let assistantLink = page.getByRole("link", { name: "Notepad › task › t-3f2a" });
  await expect(assistantLink).toBeVisible();
  expect(invocations.filter((input) => input.event?.action === "__pi_web_describe_deep_link")).toHaveLength(1);
  const messagesReloaded = page.waitForResponse((response) => response.url().includes("/api/messages") && response.ok());
  await page.request.post("/api/mock/state", { data: { webContributions } });
  await messagesReloaded;
  assistantLink = page.getByRole("link", { name: "Notepad › task › t-3f2a" });
  await expect(assistantLink).toBeVisible();
  expect(invocations.filter((input) => input.event?.action === "__pi_web_describe_deep_link")).toHaveLength(1);
  const updatedContributions = webContributions.map((entry) => entry.key === "notes"
    ? { ...entry, deepLinks: { allowedKeys: ["id", "view"], requiredKeys: ["id"], hasDescribe: true } }
    : entry);
  const changedMessagesReloaded = page.waitForResponse((response) => response.url().includes("/api/messages") && response.ok());
  await page.request.post("/api/mock/state", { data: { webContributions: updatedContributions } });
  await changedMessagesReloaded;
  assistantLink = page.getByRole("link", { name: "Notepad › task › t-3f2a" });
  await expect(assistantLink).toBeVisible();
  expect(invocations.filter((input) => input.event?.action === "__pi_web_describe_deep_link")).toHaveLength(2);
  await assistantLink.click();
  await expect(panel).toBeVisible();
  await expect.poll(() => invocations.filter((input) => input.event?.action === "deep-link").length).toBe(1);
  expect(invocations.find((input) => input.event?.action === "deep-link")).toMatchObject({
    slot: "panel",
    key: "notes",
    event: { action: "deep-link", source: "message", payload: { id: "t-3f2a" } },
  });
  await panel.getByRole("button", { name: "Close panel" }).click();

  await page.getByRole("link", { name: "Open legacy panel" }).click();
  await expect(panel).toBeVisible();
  expect(invocations.at(-1)).toMatchObject({
    slot: "panel",
    key: "quiet",
    event: { action: "deep-link", source: "message", payload: { note: "oncall/w34" } },
  });
  const deepLinkTarget = panel.locator("#deep-link-target");
  await expect(deepLinkTarget).toHaveAttribute("autofocus", "");
  await expect(deepLinkTarget).toHaveAttribute("tabindex", "-1");
  await expect(deepLinkTarget).toBeFocused();
  await panel.getByRole("button", { name: "Close panel" }).click();

  await page.locator(".actionLauncherToggle").click();
  await expect(page.locator(".actionLauncherItem", { hasText: "Notepad" })).toBeVisible();
  await expect(page.locator(".actionLauncherItem", { hasText: "Quiet" })).toHaveCount(0);
  await page.locator(".actionLauncherItem", { hasText: "Notepad" }).click();

  await expect(panel).toBeVisible();  await expect(panel.locator("h2")).toHaveText("Global notepad");
  const panelInput = panel.locator("textarea");
  await expect(panelInput).toHaveAttribute("autofocus", "");
  await expect(panelInput).toBeFocused();
  await expect(panelInput).toHaveValue("Initial global note");
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
