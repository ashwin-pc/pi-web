import { expect, type Locator } from "@playwright/test";

type TabBox = { x: number; y: number; width: number; height: number };

/** CDP gestures bypass Playwright's actionability waits. Require a connected,
 * stable, hit-testable tab before taking coordinates, not just a prior visible
 * assertion: startup session-list hydration can replace that visible node. */
export async function sessionTabBox(tab: Locator): Promise<TabBox> {
  let box: TabBox | undefined;
  await expect.poll(async () => {
    box = await tab.evaluate(async (element) => {
      if (!element.isConnected) return undefined;
      // Scroll and sample the same resolved node in one browser callback.
      // Locator.scrollIntoViewIfNeeded pins a handle while awaiting stability
      // and throws if hydration replaces it before that wait finishes.
      element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
      const rect = () => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      };
      const before = rect();
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const after = rect();
      const hit = document.elementFromPoint(after.x + after.width / 2, after.y + after.height / 2);
      if (!element.isConnected || after.width <= 0 || after.height <= 0
        || before.x !== after.x || before.y !== after.y
        || before.width !== after.width || before.height !== after.height
        || !hit || !element.contains(hit)) return undefined;
      return after;
    });
    return Boolean(box);
  }, { message: "session tab has stable, connected, unobstructed layout" }).toBe(true);
  return box!;
}
