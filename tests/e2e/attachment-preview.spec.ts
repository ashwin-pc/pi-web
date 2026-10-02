import { expect, test } from "@playwright/test";
import { nextRealtimeHello } from "./helpers/realtimeReady.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
test.use({ locale: "en-US" });

for (const clock of [
  { name: "short clock", hour: 1, minute: 11, label: "You · 1:11 AM" },
  { name: "wide clock", hour: 11, minute: 58, label: "You · 11:58 AM" },
]) {
  for (const prompt of ["Hi", "photo and report"]) {
    test(`attachment pointer preview with ${clock.name} and prompt ${prompt}`, async ({ page }) => {
      // Change only the displayed clock, not Date.now(), streaming or animation timers.
      await page.addInitScript(({ hour, minute }) => {
        const format = Date.prototype.toLocaleTimeString;
        Date.prototype.toLocaleTimeString = function (locales, options) {
          return format.call(new Date(2026, 9, 2, hour, minute), locales, options);
        };
      }, clock);
      await page.request.post("/api/mock/reset");
      await page.request.patch("/api/settings", { data: {
        appearance: { density: "comfortable", accentColor: "#e2b15f", loadingAnimation: "fireworks" },
        composer: { queueMode: "steer", expanded: false },
      } });
      const hello = nextRealtimeHello(page);
      await page.goto("/");
      await hello;
      await expect(page.locator("#prompt")).toBeVisible();
      await page.locator("#imageInput").setInputFiles({ name: "session-photo.png", mimeType: "image/png", buffer: png });
      await page.locator("#prompt").fill(prompt);
      await page.locator("#promptForm").evaluate((form: HTMLFormElement) => form.requestSubmit());
      const image = page.locator(".message.user .messageAttachmentImage");
      await expect(image).toBeVisible();
      await page.locator("#prompt").fill("show markdown artifact");
      await page.locator("#promptForm").evaluate((form: HTMLFormElement) => form.requestSubmit());
      await expect(page.locator(".artifactPreview--markdown")).toBeVisible();
      await expect(image).toHaveAttribute("src", /^blob:/);
      const message = page.locator(".message.user").filter({ has: page.locator(".messageAttachmentImage") });
      const summary = message.locator(".messageAttachmentSummary");
      await expect(message.locator(".messageTimestamp")).toHaveText(clock.label);
      await expect(message.locator(".messageAttachmentPreview .imageFrame, .messageAttachmentPreview .imageActions")).toHaveCount(0);
      await expect(image).toHaveAttribute("aria-label", "Preview session-photo.png");
      await message.hover();
      const layout = await image.evaluate(img => {
        const rect = img.getBoundingClientRect();
        const thumbnail = img.closest(".messageAttachmentPreview")!.getBoundingClientRect();
        const message = img.closest(".message")!;
        const footer = message.querySelector(".messageAttachmentBaseline")!.getBoundingClientRect();
        const actions = message.querySelector(".messageActions")!.getBoundingClientRect();
        return {
          fits: rect.width > 0 && rect.height > 0
            && rect.left >= thumbnail.left && rect.right <= thumbnail.right + 1
            && rect.top >= thumbnail.top && rect.bottom <= thumbnail.bottom + 1,
          actionsClear: (actions.width === 0 && actions.height === 0) || actions.top >= footer.bottom,
          noEmptyActionRow: actions.width > 0 || parseFloat(getComputedStyle(message).paddingBottom) === 0,
          notNested: !img.parentElement?.closest("button, [role='button']"),
          image: rect.toJSON(), thumbnail: thumbnail.toJSON(), footer: footer.toJSON(), actions: actions.toJSON(),
        };
      });
      expect(layout, JSON.stringify(layout)).toMatchObject({ fits: true, actionsClear: true, noEmptyActionRow: true, notNested: true });

      // Keep a real pointer click: keyboard activation cannot substitute for this regression.
      await image.click();
      const source = await page.locator("#artifactBrowserPreviewOpen").getAttribute("href");
      expect(source).toMatch(/^blob:/);
      await expect(page.locator("#artifactBrowserPreviewBody > img")).toHaveAttribute("src", source!);
      await page.getByRole("button", { name: "Next preview" }).click();
      await expect(page.locator("#artifactBrowserPreviewBody h1")).toHaveText("Artifact report");
      await page.goBack();
      await expect(page.locator("#artifactBrowserPreviewBody > img")).toHaveAttribute("src", source!);
      await page.keyboard.press("Escape");
      await expect(page.locator("#filesPanel")).toBeHidden();
      await expect(image).toBeFocused();
      await expect(summary).toHaveAttribute("aria-expanded", "false");

      // The separate count control owns the details popover; preview clicks do not toggle it.
      await summary.click();
      await expect(summary).toHaveAttribute("aria-expanded", "true");
      await expect(message.locator(".messageAttachmentPopover")).toBeVisible();
      await summary.click();
      await expect(summary).toHaveAttribute("aria-expanded", "false");
      for (const key of ["Enter", "Space"]) {
        await image.press(key);
        await expect(page.locator("#artifactBrowserPreviewBody > img")).toHaveAttribute("src", source!);
        await expect(summary).toHaveAttribute("aria-expanded", "false");
        await page.keyboard.press("Escape");
        await expect(page.locator("#filesPanel")).toBeHidden();
        await expect(image).toBeFocused();
      }
    });
  }
}
