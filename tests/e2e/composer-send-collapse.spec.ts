import { expect, test } from "@playwright/test";

for (const device of ["project device", "folded cover", "unfolded fold"] as const) {
  test.describe(device, () => {
    if (device !== "project device") {
      // Use the app's touch-first focus classification, not viewport width:
      // unfolded foldables can be wider than the mobile CSS breakpoint.
      test.use({ hasTouch: true, isMobile: true, viewport: device === "folded cover" ? { width: 344, height: 882 } : { width: 884, height: 1104 } });
    }
for (const fullscreen of [false, true]) {
  test(`${fullscreen ? "fullscreen" : "focused"} composer: empty submission preserves editor`, async ({ page }) => {
    await page.request.post("/api/mock/reset");
    await page.routeWebSocket("**/ws**", () => {});
    let requests = 0;
    await page.route("**/api/prompt", async (route) => { requests += 1; await route.fulfill({ json: {} }); });
    await page.goto("/");
    const prompt = page.locator("#prompt");
    await prompt.fill("   ");
    if (fullscreen) await page.getByRole("button", { name: "Expand editor", exact: true }).click();
    await prompt.focus();
    await page.locator("#promptForm").evaluate((form: HTMLFormElement) => form.requestSubmit());
    await expect(prompt).toHaveValue("   ");
    await expect(prompt).toBeFocused();
    await expect(page.locator("#promptForm")).not.toHaveClass(/compactInactive/);
    if (fullscreen) await expect(page.locator("#promptForm")).toHaveClass(/expanded/);
    expect(requests).toBe(0);
  });
  for (const outcome of ["success", "failure", "new draft"] as const) {
    test(`${fullscreen ? "fullscreen" : "focused"} composer: ${outcome} after send`, async ({ page }) => {
      await page.request.post("/api/mock/reset");
      await page.routeWebSocket("**/ws**", () => {});
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let requested!: () => void;
      const requestStarted = new Promise<void>((resolve) => { requested = resolve; });
      await page.route("**/api/prompt", async (route) => {
        requested();
        await gate;
        await route.fulfill({ status: outcome === "failure" ? 500 : 200, body: outcome === "failure" ? "Send failed" : "{}" });
      });
      await page.goto("/");
      const prompt = page.locator("#prompt");
      const form = page.locator("#promptForm");
      await prompt.fill("Send this message");
      if (fullscreen) await page.getByRole("button", { name: "Expand editor", exact: true }).click();
      await prompt.focus();
      await page.locator("#primaryButton").click();
      await requestStarted;
      // Nothing collapses optimistically while acceptance is unknown.
      await expect(form).not.toHaveClass(/compactInactive/);
      if (fullscreen) await expect(form).toHaveClass(/expanded/);
      if (outcome === "new draft") await prompt.fill("Keep typing the next message");
      const response = page.waitForResponse("**/api/prompt");
      release();
      await response;
      // Let the submit handler consume the response before checking retained UI.
      await page.waitForTimeout(50);
      if (outcome === "success") {
        const touchFirst = await page.evaluate(() => matchMedia("(hover: none), (pointer: coarse)").matches || "ontouchstart" in window || navigator.maxTouchPoints > 0);
        await expect(prompt).toHaveValue("");
        if (touchFirst) {
          await expect(form).toHaveClass(/compactInactive/);
          await expect(form).not.toHaveClass(/expanded/);
          await expect(prompt).not.toBeFocused();
          await prompt.click();
        } else {
          await expect(form).not.toHaveClass(/compactInactive/);
          await expect(prompt).toBeFocused();
          if (fullscreen) await expect(form).toHaveClass(/expanded/);
          else await expect(form).not.toHaveClass(/expanded/);
        }
        // Desktop can immediately type a follow-up without a click or shortcut.
        await page.keyboard.type("Next message");
        await expect(prompt).toHaveValue("Next message");
        await expect(form).not.toHaveClass(/compactInactive/);
      } else {
        if (outcome === "failure") await expect(prompt).toHaveValue("Send this message");
        else await expect(prompt).toHaveValue("Keep typing the next message");
        await expect(prompt).toBeFocused();
        await expect(form).not.toHaveClass(/compactInactive/);
        if (fullscreen) await expect(form).toHaveClass(/expanded/);
      }
    });
  }
}
  });
}
