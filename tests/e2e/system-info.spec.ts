import { expect, test } from "@playwright/test";
import { openSessionDrawerFooterAction } from "./helpers/sessionDrawer.js";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

test("system information is available from the session drawer", async ({ page }) => {
  await page.goto("/");

  const response = await page.request.get("/api/system-info");
  expect(response.ok()).toBe(true);
  const payload = await response.json();
  expect(payload).toMatchObject({
    ok: true,
    system: {
      piWeb: { version: expect.any(String), nodeVersion: expect.stringMatching(/^v/) },
      pi: { version: expect.any(String), agentDirectory: expect.any(String) },
      host: {
        hostname: expect.any(String),
        architecture: expect.any(String),
        logicalCpuCount: expect.any(Number),
        totalMemoryBytes: expect.any(Number),
      },
    },
  });

  await openSessionDrawerFooterAction(page, "System info");
  const panel = page.locator("#systemInfoPanel");
  await expect(panel).toBeVisible();
  await expect(page.locator("#sessionDrawer")).toBeHidden();
  await expect(panel.getByRole("heading", { name: "System information" })).toBeVisible();
  await expect(panel.getByRole("heading", { name: "pi", exact: true })).toBeVisible();
  await expect(panel.getByRole("heading", { name: "pi-web runtime" })).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Host machine" })).toBeVisible();
  await expect(panel).toContainText("Agent directory");
  await expect(panel).toContainText("Operating system");
  await expect(panel.getByRole("button", { name: "Copy system report" })).toBeVisible();
});

test("renders an interactive system-info contribution and reports invocation failures", async ({ page }) => {
  await page.request.post("/api/mock/state", { data: {
    webContributions: [{ version: 1, key: "runtime-tools", slot: "system-info", kind: "rendered", title: "Runtime tools", label: "Tools" }],
  } });
  const invocations: any[] = [];
  await page.route("**/api/web-contributions/invoke", async (route) => {
    const input = route.request().postDataJSON();
    invocations.push(input);
    if (input.event?.action === "explode") {
      await route.fulfill({ status: 500, json: { ok: false, error: "Probe failed" } });
      return;
    }
    await route.fulfill({ json: {
      ok: true,
      title: "Runtime tools",
      html: `<form><input name="query" value=""><input type="checkbox" name="scope" value="host" checked><input type="checkbox" name="scope" value="process" checked><button type="submit" data-web-action="run" data-web-payload='{"depth":2}'>Run probe</button></form><button data-web-action="explode">Fail probe</button>`,
    } });
  });

  await page.goto("/");
  await openSessionDrawerFooterAction(page, "System info");
  const panel = page.locator("#systemInfoPanel");
  await expect(panel.getByRole("heading", { name: "Runtime tools" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Run probe" })).toBeVisible();
  expect(invocations[0]).toMatchObject({ sessionId: "mock-current", slot: "system-info", key: "runtime-tools" });

  await panel.locator('input[name="query"]').fill("disk usage");
  await panel.getByRole("button", { name: "Run probe" }).click();
  await expect.poll(() => invocations.length).toBe(2);
  expect(invocations[1]).toMatchObject({
    sessionId: "mock-current", slot: "system-info", key: "runtime-tools",
    event: { action: "run", payload: { depth: 2 }, fields: { query: "disk usage", scope: ["host", "process"] } },
  });

  await panel.getByRole("button", { name: "Fail probe" }).click();
  await expect(panel.locator(".systemInfoError")).toHaveText("Probe failed");
  await expect(panel.locator(".systemInfoExtensionBody")).not.toHaveAttribute("aria-busy", "true");
});

test("settings lives in the drawer and the FAB contains session actions only", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/");

  await page.locator(".actionLauncherToggle").click();
  const launcher = page.locator(".actionLauncherMenu");
  await expect(launcher.getByRole("menuitem", { name: "Settings" })).toHaveCount(0);
  await expect(launcher.getByRole("menuitem", { name: "Session details" })).toBeVisible();
  await expect(launcher.getByRole("menuitem", { name: "Git" })).toBeVisible();
  await expect(launcher.getByRole("menuitem", { name: "File explorer" })).toBeVisible();
  await expect(launcher.getByRole("menuitem", { name: "Conversation tree" })).toBeVisible();
  await expect(launcher.getByRole("menuitem", { name: "New session" })).toBeVisible();
  const widths = await launcher.getByRole("menuitem").evaluateAll((items) => items.map((item) => item.getBoundingClientRect().width));
  expect(widths).toEqual([...widths].sort((a, b) => a - b));
  await expect(page.locator(".actionLauncherToggle")).toHaveAttribute("aria-label", "Close session actions");
  await page.locator(".actionLauncherToggle").click();

  await openSessionDrawerFooterAction(page, "Settings");
  await expect(page.locator("#settingsPanel")).toBeVisible();
  await expect(page.locator("#sessionDrawer")).toBeHidden();
});
