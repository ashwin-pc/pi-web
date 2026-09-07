import { expect, test } from "@playwright/test";

test("new-session action stays busy until refresh and drawer focus restoration finish", async ({ page }) => {
  await page.request.post("/api/mock/reset");
  await page.goto("/");
  await expect(page.locator(".message.assistant").first()).toBeVisible();
  let releaseModels!: () => void;
  const modelsGate = new Promise<void>((resolve) => { releaseModels = resolve; });
  let modelsRequested!: () => void;
  const requested = new Promise<void>((resolve) => { modelsRequested = resolve; });
  await page.route("**/api/models**", async (route) => {
    modelsRequested();
    await modelsGate;
    await route.continue();
  });
  await page.locator("#sessionButton").click();
  await page.locator("#sessionNewButton").click();
  try {
    await requested;
    // Transcript completion is not operation completion: settings/models and
    // the drawer's close/focus callback are still pending behind this gate.
    await expect(page.locator("#emptyCwdChooser")).toBeVisible();
    await expect(page.locator("#sessionNewButton")).toBeDisabled();
  } finally {
    releaseModels();
  }
  await expect(page.locator("#sessionNewButton")).toBeEnabled();
  if (await page.locator("#sessionDrawer").isVisible()) {
    await page.locator("#sessionCloseButton").click();
  }
  await page.locator("#statusTitle").click();
  await page.locator("#statusTitle input").fill("Name after complete refresh");
  const saved = page.waitForResponse((response) => response.url().endsWith("/api/session/name") && response.request().method() === "POST");
  await page.locator("#statusTitle input").press("Enter");
  const result = await saved;
  expect(result.ok()).toBe(true);
  expect(await result.json()).toMatchObject({ sessionTitle: "Name after complete refresh" });
  await expect(page.locator("#statusTitle")).toHaveText("Name after complete refresh");
  await page.reload();
  await expect(page.locator("#statusTitle")).toHaveText("Name after complete refresh");
});
