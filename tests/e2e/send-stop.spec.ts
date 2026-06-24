import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
  await page.goto("/");
  await expect(page.locator("#connectionStatus")).toBeHidden();
});

test.describe("stop button", () => {
  test("is hidden when not streaming", async ({ page }) => {
    await expect(page.locator("#stopButton")).toBeHidden();
  });

  test("appears while streaming and hides after", async ({ page }) => {
    await page.locator("#prompt").fill("slow running task");
    await page.locator("#primaryButton").click();

    await expect(page.locator("#stopButton")).toBeVisible();

    // wait for streaming to end
    await expect(page.locator("#stopButton")).toBeHidden({ timeout: 5000 });
  });

  test("stays hidden when a stale running runtime update arrives after completion", async ({ page }) => {
    await page.locator("#prompt").fill("slow stale runtime after end");
    await page.locator("#primaryButton").click();

    await expect(page.locator("#stopButton")).toBeVisible();
    await expect(page.locator(".message.assistant", { hasText: "Mock response." }).last()).toBeVisible();
    await expect(page.locator("#stopButton")).toBeHidden({ timeout: 5000 });
    await expect(page.locator("#runtimeStatus")).toBeHidden();
    await page.waitForTimeout(300);
    await expect(page.locator("#stopButton")).toBeHidden();
    await expect(page.locator("#runtimeStatus")).toBeHidden();
  });

  test("has red background while streaming", async ({ page }) => {
    await page.locator("#prompt").fill("slow running task");
    await page.locator("#primaryButton").click();

    await expect(page.locator("#stopButton")).toBeVisible();

    const bg = await page.locator("#stopButton").evaluate((el) => getComputedStyle(el).backgroundColor);
    // should not be transparent
    expect(bg).not.toBe("rgba(0, 0, 0, 0)");
    expect(bg).not.toBe("transparent");
  });

  test("clicking stop aborts streaming", async ({ page }) => {
    await page.locator("#prompt").fill("slow running task");
    await page.locator("#primaryButton").click();

    await expect(page.locator("#stopButton")).toBeVisible();
    await page.locator("#stopButton").click();
    await expect(page.locator("#stopButton")).toBeHidden({ timeout: 3000 });
  });

  test("compact stop aborts streaming with one click", async ({ page }) => {
    let abortRequests = 0;
    await page.route("**/api/abort", async (route) => {
      abortRequests += 1;
      await route.continue();
    });

    await page.locator("#prompt").fill("slow running task");
    await page.locator("#primaryButton").click();
    await expect(page.locator("#stopButton")).toBeVisible();

    await page.locator("#prompt").focus();
    await page.locator("#prompt").evaluate((el) => (el as HTMLTextAreaElement).blur());
    await expect(page.locator("#promptForm")).toHaveClass(/compactInactive/);

    await page.locator("#stopButton").click();

    await expect.poll(() => abortRequests).toBe(1);
    await page.waitForTimeout(100);
    expect(abortRequests).toBe(1);
    await expect(page.locator("#stopButton")).toBeHidden({ timeout: 3000 });
  });
});

test.describe("send button", () => {
  test("is disabled with empty input", async ({ page }) => {
    await expect(page.locator("#primaryButton")).toBeDisabled();
  });

  test("is enabled when input has text", async ({ page }) => {
    await page.locator("#prompt").fill("hello");
    await expect(page.locator("#primaryButton")).toBeEnabled();
  });

  test("is disabled again after clearing input", async ({ page }) => {
    await page.locator("#prompt").fill("hello");
    await page.locator("#prompt").fill("");
    await expect(page.locator("#primaryButton")).toBeDisabled();
  });
});

test.describe("send while streaming", () => {
  test("both stop and send buttons visible when streaming with text typed", async ({ page }) => {
    await page.locator("#prompt").fill("slow running task");
    await page.locator("#primaryButton").click();

    await expect(page.locator("#stopButton")).toBeVisible();

    // type into the prompt while streaming
    await page.locator("#prompt").fill("steer it this way");

    await expect(page.locator("#stopButton")).toBeVisible();
    await expect(page.locator("#primaryButton")).toBeVisible();
    await expect(page.locator("#primaryButton")).toBeEnabled();
  });

  test("send button disabled during streaming with no input", async ({ page }) => {
    await page.locator("#prompt").fill("slow running task");
    await page.locator("#primaryButton").click();

    await expect(page.locator("#stopButton")).toBeVisible();
    // no text in prompt - send should be disabled
    await expect(page.locator("#primaryButton")).toBeDisabled();
  });

  test("sending a steer message while streaming queues it", async ({ page }) => {
    await page.locator("#prompt").fill("slow running task");
    await page.locator("#primaryButton").click();

    await expect(page.locator("#stopButton")).toBeVisible();

    await page.locator("#prompt").fill("steer it this way");
    await page.locator("#primaryButton").click();

    // the steer message should appear as a user message
    await expect(page.locator(".message.user", { hasText: "steer it this way" })).toBeVisible();

    // streaming eventually ends
    await expect(page.locator("#stopButton")).toBeHidden({ timeout: 5000 });
  });
});
