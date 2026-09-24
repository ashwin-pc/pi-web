import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

test("user scroll intent pauses stream following before the next streamed update", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#prompt")).toBeVisible();

  await page.locator("#messages").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });

  await page.locator("#prompt").fill("slow pending tool refresh");
  await page.locator("#primaryButton").click();
  // Let the submit handler's programmatic scroll finish, but stay before the
  // mock's first streamed delta (delayed by 750ms for this prompt).
  await page.waitForTimeout(50);

  // Simulate the first user movement before the next streamed delta arrives.
  // This is the race we care about: follow must pause on intent, not only after
  // the browser has emitted a scroll event and moved the viewport.
  await page.locator("#messages").dispatchEvent("wheel", { deltaY: -320 });
  const scrollTopAfterIntent = await page.locator("#messages").evaluate((el) => el.scrollTop);

  await expect(page.locator(".jumpToLatestButton")).toBeVisible();
  await expect(page.locator(".message.assistant", { hasText: "Let me check that for you." })).toBeVisible({ timeout: 3000 });

  const scrollTopAfterDelta = await page.locator("#messages").evaluate((el) => el.scrollTop);
  expect(scrollTopAfterDelta).toBeLessThanOrEqual(scrollTopAfterIntent + 1);
  await expect(page.locator(".jumpToLatestButton")).toBeVisible();

  // Being within the 48px follow threshold is not the physical bottom: End
  // remains movable, then its settled position resumes following.
  await page.locator("#messages").evaluate((el) => {
    el.scrollTop = el.scrollHeight - el.clientHeight - 20;
    el.dispatchEvent(new Event("scroll"));
  });
  await page.locator("#messages").dispatchEvent("keydown", { key: "End" });
  await page.locator("#messages").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event("scroll"));
  });
  await expect(page.locator(".jumpToLatestButton")).toBeHidden();
});

test("an upward wheel gesture on short content does not disable following", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#prompt")).toBeVisible();
  await page.locator("#messages").evaluate((el) => {
    el.replaceChildren();
    el.scrollTop = 0;
  });

  await page.locator("#prompt").fill("slow pending tool refresh");
  await page.locator("#primaryButton").click();
  await page.waitForTimeout(50);

  await page.locator("#messages").dispatchEvent("wheel", { deltaY: -320 });
  await expect(page.locator(".jumpToLatestButton")).toBeHidden();
  await expect(page.locator(".message.assistant", { hasText: "Let me check that for you." })).toBeVisible({ timeout: 3000 });
  await expect(page.locator(".jumpToLatestButton")).toBeHidden();
});

test("non-stream scrolling away and back settles pointer intent from position", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#prompt")).toBeVisible();
  const messages = page.locator("#messages");
  await messages.evaluate((el) => { el.scrollTop = el.scrollHeight; });

  await messages.dispatchEvent("pointerdown", { pointerType: "mouse" });
  await messages.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
  await expect(page.locator(".jumpToLatestButton")).toBeVisible();

  // A downward gesture that cannot move farther at the physical bottom still
  // reconciles the paused follow state and stale intent.
  await messages.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await messages.dispatchEvent("wheel", { deltaY: 320 });
  await expect(page.locator(".jumpToLatestButton")).toBeHidden();

  await messages.dispatchEvent("pointerdown", { pointerType: "mouse" });
  await messages.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
  await expect(page.locator(".jumpToLatestButton")).toBeVisible();

  await messages.dispatchEvent("pointerdown", { pointerType: "mouse" });
  await messages.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event("scroll"));
  });
  await expect(page.locator(".jumpToLatestButton")).toBeHidden();
});

test("explicit wheel intent wins during a programmatic scroll's pending reset", async ({ page }) => {
  await page.goto("/");
  await page.locator("#prompt").fill("streaming markdown benchmark paced");
  await page.locator("#primaryButton").click();
  await expect(page.locator(".message.assistant p", { hasText: "This deliberately long response" })).toContainText("avoid executing unsafe markup");
  // Deliver input after the next real autoscroll write, but before its zero-delay
  // reset timer. This pins the race without waiting for a lucky event-loop order.
  await page.locator("#messages").evaluate((element) => {
    const native = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
    let sent = false;
    Object.defineProperty(element, "scrollTop", {
      configurable: true,
      get: () => native.get!.call(element),
      set: (value: number) => {
        native.set!.call(element, value);
        if (sent) return;
        sent = true;
        queueMicrotask(() => {
          element.dispatchEvent(new WheelEvent("wheel", { deltaY: -600 }));
          element.dataset.wheelDuringAutoscroll = "sent";
        });
      },
    });
  });
  await expect(page.locator("#messages")).toHaveAttribute("data-wheel-during-autoscroll", "sent");
  await expect(page.locator("#stopButton")).toBeHidden({ timeout: 20_000 });
  await expect(page.locator(".jumpToLatestButton")).toBeVisible();
});
