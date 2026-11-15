import { expect, test } from "@playwright/test";
import { sessionTabBox } from "./helpers/sessionBar.js";

test("tab coordinates come from the current layout when a visible node is replaced", async ({ page }) => {
  await page.setContent('<div id="tab" style="position:absolute;left:10px;top:10px;width:100px;height:40px">Initial tab</div>');
  const tab = page.locator("#tab");
  await expect(tab).toBeVisible();
  await tab.evaluate(element => {
    const original = element.getBoundingClientRect.bind(element);
    element.getBoundingClientRect = () => {
      // Model startup hydration landing between resolving a visible tab and
      // measuring it. Replace once, at the next layout frame, without a sleep.
      element.getBoundingClientRect = original;
      requestAnimationFrame(() => {
        const replacement = element.cloneNode(true) as HTMLElement;
        replacement.textContent = "Hydrated tab";
        replacement.style.left = "180px";
        replacement.style.width = "160px";
        element.replaceWith(replacement);
      });
      return original();
    };
  });

  const box = await sessionTabBox(tab);
  await expect(tab).toHaveText("Hydrated tab");
  expect(box).toEqual({ x: 180, y: 10, width: 160, height: 40 });
});
