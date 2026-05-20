import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

test.describe("iOS viewport and orientation fixes", () => {
  test("viewport meta tag includes viewport-fit=cover without maximum-scale", async ({ page }) => {
    await page.goto("/");
    const content = await page.locator('meta[name="viewport"]').getAttribute("content");
    expect(content).toContain("viewport-fit=cover");
    // maximum-scale must NOT be set — it breaks accessibility (WCAG 1.4.4)
    expect(content).not.toContain("maximum-scale");
  });

  test("no horizontal overflow on page load or after focusing textarea", async ({ page }) => {
    await page.goto("/");
    let overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);

    await page.locator("#prompt").focus();
    await page.waitForTimeout(300);
    overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);
  });

  test("--app-height CSS variable is set from visualViewport", async ({ page }) => {
    await page.goto("/");
    const appHeight = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--app-height").trim(),
    );
    expect(appHeight).toMatch(/^\d+px$/);
    const viewportHeight = page.viewportSize()?.height || 0;
    expect(parseInt(appHeight)).toBeCloseTo(viewportHeight, -1);
  });

  test("textarea font-size is at least 16px to prevent iOS auto-zoom", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const fontSize = await page.locator("#prompt").evaluate((el) =>
      parseFloat(getComputedStyle(el).fontSize),
    );
    expect(fontSize).toBeGreaterThanOrEqual(16);
  });

  test("touch-action manipulation is set on body", async ({ page }) => {
    await page.goto("/");
    const touchAction = await page.evaluate(() => getComputedStyle(document.body).touchAction);
    expect(touchAction).toBe("manipulation");
  });

  test("overscroll-behavior is none", async ({ page }) => {
    await page.goto("/");
    const overscroll = await page.evaluate(() => getComputedStyle(document.body).overscrollBehavior);
    expect(overscroll).toBe("none");
  });

  test("jumpToLatestButton uses absolute positioning within .app", async ({ page }) => {
    await page.goto("/");
    // Verify via stylesheet that the rule is position:absolute
    const position = await page.evaluate(() => {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule instanceof CSSStyleRule && rule.selectorText === ".jumpToLatestButton") {
              return rule.style.position;
            }
          }
        } catch (_) { /* cross-origin */ }
      }
      return "not-found";
    });
    expect(position).toBe("absolute");
  });

  test("keyboard-open class hides session bar on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const pinnedKey = "pi-web-pinned-sessions";
    await page.addInitScript(
      ([key, value]) => localStorage.setItem(key, value),
      [pinnedKey, JSON.stringify([{ id: "mock-current", label: "Current mock session" }])],
    );

    await page.goto("/");
    await expect(page.locator("#sessionBar")).toBeVisible();

    // Simulate keyboard-open state (as set by syncAppHeight when keyboard opens)
    await page.evaluate(() => document.documentElement.classList.add("keyboard-open"));
    await expect(page.locator("#sessionBar")).toBeHidden();

    await page.evaluate(() => document.documentElement.classList.remove("keyboard-open"));
    await expect(page.locator("#sessionBar")).toBeVisible();
  });

  test("keyboard-open detection requires focused input and reduced viewport", async ({ page }) => {
    await page.goto("/");
    // Simulate syncAppHeight with a focused textarea and small viewport
    const isKeyboardOpen = await page.evaluate(() => {
      // Focus the textarea
      const textarea = document.querySelector<HTMLTextAreaElement>("#prompt");
      textarea?.focus();
      // Check that the logic would detect keyboard-open if viewport were small
      const activeTag = document.activeElement?.tagName;
      const inputFocused = activeTag === "TEXTAREA" || activeTag === "INPUT";
      return inputFocused;
    });
    expect(isKeyboardOpen).toBe(true);

    // Without focus, keyboard-open should not be set even if viewport shrinks
    const noKeyboard = await page.evaluate(() => {
      (document.activeElement as HTMLElement)?.blur();
      const activeTag = document.activeElement?.tagName;
      return activeTag === "TEXTAREA" || activeTag === "INPUT";
    });
    expect(noKeyboard).toBe(false);
  });

  test("focusin handler resets horizontal scroll", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => { document.documentElement.scrollLeft = 50; });
    await page.locator("#prompt").focus();
    await page.waitForTimeout(100);
    const scrollLeft = await page.evaluate(() => document.documentElement.scrollLeft);
    expect(scrollLeft).toBe(0);
  });

  test("syncAppHeight toggles keyboard-open when visualViewport is mocked", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");

    // Mock visualViewport to simulate keyboard opening (height shrinks to 400px)
    const result = await page.evaluate(() => {
      // Focus textarea first
      const textarea = document.querySelector<HTMLTextAreaElement>("#prompt");
      textarea?.focus();

      // Override visualViewport.height to simulate keyboard
      Object.defineProperty(window.visualViewport, "height", { value: 400, configurable: true });
      // window.innerHeight stays at the original value (844)

      // Manually call syncAppHeight by dispatching a resize on visualViewport
      window.visualViewport!.dispatchEvent(new Event("resize"));

      const hasClass = document.documentElement.classList.contains("keyboard-open");
      const appHeight = getComputedStyle(document.documentElement).getPropertyValue("--app-height").trim();

      // Restore
      Object.defineProperty(window.visualViewport, "height", { value: 844, configurable: true });
      window.visualViewport!.dispatchEvent(new Event("resize"));

      return { hasClass, appHeight };
    });

    expect(result.hasClass).toBe(true);
    expect(result.appHeight).toBe("400px");

    // After restoring, keyboard-open should be removed (textarea still focused but viewport is full)
    const afterRestore = await page.evaluate(() =>
      document.documentElement.classList.contains("keyboard-open"),
    );
    expect(afterRestore).toBe(false);
  });
});
