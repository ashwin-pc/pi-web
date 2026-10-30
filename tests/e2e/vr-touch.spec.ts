import { expect, test, type Browser, type Page } from "@playwright/test";
import { seedSessionUiState } from "./helpers/sessionUiState.js";

// The VR view's 2D page on touch screens (usability round 2, PR #182): the foldable's inner and cover screens in both
// orientations, with touch input (no headset). Every gesture is checked, and so is its tappable fallback.

type VrWindow = Window & { __vrCity?: any; __desk?: any };
const since = () => new Date().toISOString();
const VIEWPORTS = [
  { name: "inner-landscape", width: 832, height: 750 },
  { name: "inner-portrait", width: 750, height: 832 },
  { name: "cover-portrait", width: 411, height: 960 },
  { name: "cover-landscape", width: 960, height: 411 },
];
const city = <T>(page: Page, fn: (c: any) => T, arg?: unknown) => page.evaluate(`(${fn.toString()})(window.__vrCity, ${JSON.stringify(arg ?? null)})`) as Promise<T>;

async function touchPage(browser: Browser, baseURL: string, vp: { width: number; height: number }) {
  const ctx = await browser.newContext({ baseURL, viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2.625, hasTouch: true, isMobile: true, serviceWorkers: "block" });
  const page = await ctx.newPage();
  return { ctx, page };
}
async function drag(page: Page, from: [number, number], to: [number, number], steps = 8, stepMs = 30) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from[0], y: from[1] }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from[0] + (to[0] - from[0]) * i / steps, y: from[1] + (to[1] - from[1]) * i / steps }] });
    await page.waitForTimeout(stepMs);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
async function pinch(page: Page, c: [number, number], d0: number, d1: number) {
  const cdp = await page.context().newCDPSession(page);
  const pts = (d: number) => [{ x: c[0] - d / 2, y: c[1], id: 1 }, { x: c[0] + d / 2, y: c[1], id: 2 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts(d0) });
  for (let i = 1; i <= 8; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pts(d0 + (d1 - d0) * i / 8) }); await page.waitForTimeout(25); }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
async function longPress(page: Page, x: number, y: number, ms = 700) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await page.waitForTimeout(ms);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

test.describe("VR view on touch screens (foldable inner and cover screens)", () => {
  test.describe.configure({ timeout: 120_000 });
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the viewports are set per test");
    await page.request.post("/api/mock/reset");
    const ids = ["mock-current", "mock-older"];
    for (let i = 0; i < 6; i++) ids.push((await (await page.request.post("/api/sessions/new", { data: {} })).json()).sessionId);
    await seedSessionUiState(page, { lanes: ids.map((sessionId) => ({ sessionId, lane: "pinned", since: since() })) });
  });

  for (const vp of VIEWPORTS) {
    test(`${vp.name}: tap, swipe, drag, pinch, long-press, and every pin reachable`, async ({ browser }, testInfo) => {
      const { ctx, page } = await touchPage(browser, String(testInfo.project.use.baseURL), vp);
      await page.goto("/view/vr");
      await page.waitForFunction(() => ((window as VrWindow).__vrCity?.frames || 0) > 5, null, { timeout: 30_000 });
      // Chrome: no keyboard hints, no horizontal overflow, and Enter VR says why it is unavailable in visible text.
      await expect(page.locator(".vrKeys")).toBeHidden();
      await expect(page.locator("#enterVR .why")).toBeVisible();
      await expect(page.locator("#enterVR .why")).toHaveText(/headset|WebXR|HTTPS|frame/);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      // The dock replaces the 3D bar: every pinned session, Needs you, Home and More, each at least 48 CSS px.
      const dock = page.locator("#vrDock");
      await expect(dock).toBeVisible();
      const state = await city(page, (c) => c.state());
      await expect(dock.locator(".vrAv")).toHaveCount(state.pinned.length);
      for (const sel of ["[data-id='bar:needs']", "[data-id='bar:home']", "[data-id='bar:more']"]) {
        const b = await dock.locator(sel).boundingBox();
        expect(b && b.width >= 48 && b.height >= 48 && b.x >= 0 && b.x + b.width <= vp.width + 1 && b.y + b.height <= vp.height + 1).toBe(true);
      }
      const last = dock.locator(".vrAv").last();
      await last.scrollIntoViewIfNeeded();
      const lb = await last.boundingBox();
      expect(lb && lb.width >= 48 && lb.height >= 48 && lb.x >= 0 && lb.x + lb.width <= vp.width + 1).toBe(true);
      await page.waitForTimeout(400);
      await dock.locator(".vrAv").first().scrollIntoViewIfNeeded();

      // Tap (the critic's P0-N1): an avatar opens its session.
      const target = state.pinned[1];
      const p = await city(page, (c, id) => c.project(`avatar:${id}`), target);
      await page.touchscreen.tap(p.x, p.y);
      await page.waitForFunction((id) => { const s = (window as VrWindow).__vrCity.state(); return s.reading && s.currentId === id && s.panelSettled; }, target, { timeout: 15_000 });
      await page.waitForTimeout(800);

      // Drag up on the conversation scrolls it.
      const mid = await city(page, (c) => c.project("strip"));
      const cx = vp.width / 2, cy = Math.min(vp.height * 0.5, (mid?.y ?? vp.height * 0.5));
      await city(page, (c) => { const r = c._reader(); r.to(0, 0); });
      const max = (await city(page, (c) => c.state())).max;
      if (max > 0) {
        await drag(page, [cx, cy + 80], [cx, cy - 80]);
        await expect.poll(async () => (await city(page, (c) => c.state())).scroll).toBeGreaterThan(0);
      }

      // Swipe sideways on the conversation: the next session (and the view follows the finger meanwhile).
      const before = (await city(page, (c) => c.state())).currentId;
      // Start within the conversation (wide screens show the whole cockpit, so it is narrower there).
      let d = vp.width * 0.3;
      while (d > 30 && (await city(page, (c, xy) => c.hitAt(xy[0], xy[1]), [cx + d, cy])) !== "reader") d -= vp.width * 0.02;
      await drag(page, [cx + d, cy], [cx - d, cy]);

      await expect.poll(async () => (await city(page, (c) => c.state())).currentId).not.toBe(before);
      expect((await city(page, (c) => c.effortLog())).some((e: { kind: string }) => e.kind === "touch:swipe")).toBe(true);
      // A short swipe springs back and changes nothing.
      const now = (await city(page, (c) => c.state())).currentId;
      await page.waitForTimeout(600);
      await drag(page, [cx + 10, cy], [cx - 25, cy], 6, 60);
      await page.waitForTimeout(500);
      expect((await city(page, (c) => c.state())).currentId).toBe(now);
      // A swipe that starts at the screen's edge is left to the browser (its back gesture).
      await drag(page, [4, cy], [vp.width * 0.6, cy]);
      await page.waitForTimeout(500);
      expect((await city(page, (c) => c.state())).currentId).toBe(now);

      // Pinch zooms (the conversation's text gets bigger), and More has the same as buttons.
      const z0 = await page.evaluate(() => (window as VrWindow).__desk.zoom);
      await pinch(page, [cx, cy], 80, 220);
      await expect.poll(() => page.evaluate(() => (window as VrWindow).__desk.zoom)).toBeLessThan(z0);
      await dock.locator("[data-id='bar:more']").tap();
      await expect(page.locator("#vrSheet")).toBeVisible();
      const z1 = await page.evaluate(() => (window as VrWindow).__desk.zoom);
      await page.locator("#vrSheet [data-z='1.18']").tap();
      expect(await page.evaluate(() => (window as VrWindow).__desk.zoom)).toBeGreaterThan(z1);
      await page.locator("#vrSheet .x").tap();
      await expect(page.locator("#vrSheet")).toBeHidden();

      // Long-press an avatar: its card with Open, Beside and Fly to.
      const other = state.pinned[3];
      const av = dock.locator(`[data-id='avatar:${other}']`);
      await av.scrollIntoViewIfNeeded();
      const ab = (await av.boundingBox())!;
      await longPress(page, ab.x + ab.width / 2, ab.y + ab.height / 2);
      await expect(page.locator("#vrSheet")).toBeVisible();
      for (const a of ["open", "beside", "fly"]) {
        const b = await page.locator(`#vrSheet [data-a='${a}']`).boundingBox();
        expect(b && b.height >= 48).toBe(true);
      }
      await page.locator("#vrSheet [data-a='open']").tap();
      await expect.poll(async () => (await city(page, (c) => c.state())).currentId).toBe(other);

      // Replying: the dock's Reply focuses a real text field, shown above the dock with Send (and the 3D box does too).
      await page.waitForFunction(() => (window as VrWindow).__vrCity.state().panelSettled);
      await dock.locator("[data-id='dock:reply']").tap();
      await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("vrComposerInput");
      await expect(page.locator("#vrTyping .send")).toBeVisible();
      const sid = (await city(page, (c) => c.state())).currentId, n0 = (await city(page, (c, x) => c.messages(x), sid)).length;
      await page.keyboard.type("ship it");
      await page.locator("#vrTyping .send").tap();
      await expect.poll(async () => (await city(page, (c, x) => c.messages(x), sid)).length).toBeGreaterThan(n0);

      // Back to the city, then a vertical drag on the city changes height.
      await city(page, (c) => c.close());
      await page.waitForFunction(() => !(window as VrWindow).__vrCity.state().reading);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.waitForTimeout(800);
      const alt0 = (await city(page, (c) => c.state())).nav.altitude;
      await drag(page, [cx, vp.height * 0.6], [cx, vp.height * 0.3]);
      await expect.poll(async () => (await city(page, (c) => c.state())).nav.altitude).toBeGreaterThan(alt0);
      await page.screenshot({ path: testInfo.outputPath(`${vp.name}.png`) });
      await ctx.close();
    });
  }
});
