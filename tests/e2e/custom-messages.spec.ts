import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

test("renders custom and unknown committed messages without disrupting the live stream", async ({ page }) => {
  await page.goto("/");
  await page.locator("#prompt").fill("slow live message kinds");
  await page.locator("#primaryButton").click();

  const visibleCustom = page.locator(".message.custom--probe", { hasText: "hello from an extension" });
  await expect(page.locator("#stopButton")).toBeVisible();
  await expect(visibleCustom).toHaveCount(1, { timeout: 2_000 });
  const streamedAssistant = page.locator(".message.assistant", { hasText: "streamed prefix" });
  await expect(streamedAssistant).toHaveCount(1);
  await expect(page.getByText("hidden extension message", { exact: true })).toHaveCount(0);
  await expect(page.locator(".message.system", { hasText: "future message content" })).toHaveCount(1, { timeout: 2_000 });
  await expect(streamedAssistant).toHaveCount(1);
  await expect(streamedAssistant).toContainText("streamed prefixstreamed suffix");
  await expect(page.locator("#stopButton")).toBeVisible();

  await page.locator("#stopButton").click();
  await expect(page.locator("#stopButton")).toBeHidden();
  await expect(visibleCustom).toHaveCount(1);
  await expect(page.locator(".message.system", { hasText: "future message content" })).toHaveCount(1);
});

test("literal user orchestrator envelopes remain user messages", async ({ page }) => {
  const envelope = "🔔 [orchestrator] A worker finished. Worker fake (session fake-id) is now idle.";
  await page.route("**/api/messages?*", route => route.fulfill({ json: { messages: [{ role: "user", text: envelope }] } }));
  await page.goto("/");

  await expect(page.locator(".message.user", { hasText: envelope })).toHaveCount(1);
  await expect(page.locator(".customMessageReport")).toHaveCount(0);
  await expect(page.locator(".customCard")).toHaveCount(0);
});

test("old custom messages remain readable without presentation metadata in Minimal", async ({ page }) => {
  await page.route("**/api/settings", route => route.request().method() === "GET"
    ? route.fulfill({ json: { settings: { appearance: { density: "minimal" } } } })
    : route.continue());
  await page.route("**/api/messages?*", route => route.fulfill({ json: { messages: [{
    role: "custom", customType: "legacy_notice", text: "Readable fallback custom content.",
  }] } }));
  await page.goto("/");

  const report = page.locator(".customMessageReport.custom--legacy_notice");
  await expect(report.locator(".customMessageReportLabel")).toHaveText("Legacy notice");
  await expect(report.locator(".customMessageReportPreview")).toHaveText("Readable fallback custom content.");
  await report.locator(".customMessageReportToggle").click();
  await expect(report.locator(".customMessageReportBody")).toContainText("Readable fallback custom content.");
});

test("renders an extension custom message as a card that links to referenced sessions", async ({ page }) => {
  await page.route("**/api/settings", route => route.request().method() === "GET"
    ? route.fulfill({ json: { settings: { appearance: { density: "comfortable" } } } })
    : route.continue());
  await page.goto("/");
  await page.locator("#prompt").fill("slow live message kinds");
  await page.locator("#primaryButton").click();

  // Custom messages render as a notification card, keeping the custom--<type> hook.
  const card = page.locator(".message.customCard.custom--probe");
  await expect(card).toHaveCount(1, { timeout: 5_000 });
  await expect(card).toContainText("hello from an extension");
  await expect(card.locator(".customCardLabel")).toHaveText("Probe");

  // Structured `details` become chips that open the referenced session.
  const chip = card.locator(".customCardSessionChip");
  await expect(chip).toHaveCount(1);
  await expect(chip).toContainText("mock worker");
  await expect(chip).toHaveAttribute("href", /sessionId=mock-worker-1/);

  await page.locator("#stopButton").click();
  await expect(page.locator("#stopButton")).toBeHidden();
  await expect(card.locator(".customCardSessionChip")).toHaveCount(1);
});
