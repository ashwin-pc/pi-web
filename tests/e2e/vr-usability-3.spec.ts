import { expect, test, type Page } from "@playwright/test";
import { seedSessionUiState } from "./helpers/sessionUiState.js";
import { seedVrSessions, writeVrArtifacts } from "./helpers/vrFixtures.js";

// The VR view's usability round 3 (PR #182): the critic's third-pass P2s that a scripted check can hold.

type VrWindow = Window & { __vrCity?: any };
const since = () => new Date().toISOString();
const city = <T>(page: Page, fn: (c: any) => T, arg?: unknown) => page.evaluate(`(${fn.toString()})(window.__vrCity, ${JSON.stringify(arg ?? null)})`) as Promise<T>;

test.describe("VR view, usability round 3", () => {
  test.describe.configure({ timeout: 90_000 });
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the viewports are set per test");
    await page.request.post("/api/mock/reset");
    const ids = ["mock-current", "mock-older"];
    for (let i = 0; i < 3; i++) ids.push((await (await page.request.post("/api/sessions/new", { data: {} })).json()).sessionId);
    await seedSessionUiState(page, { lanes: ids.map((sessionId) => ({ sessionId, lane: "pinned", since: since() })) });
  });

  test("P2-8: a short or slow mouse drag on the conversation does not switch session; a quick long flick does", async ({ page }) => {
    await page.goto("/view/vr");
    await page.waitForFunction(() => ((window as VrWindow).__vrCity?.frames || 0) > 5, null, { timeout: 25_000 });
    await city(page, (c) => c.open("mock-older"));
    await page.waitForFunction(() => (window as VrWindow).__vrCity.state().panelSettled && (window as VrWindow).__vrCity.state().reading);
    await page.waitForTimeout(800);
    const vp = page.viewportSize()!;
    let x0 = vp.width / 2, y0 = vp.height / 2;
    for (const [x, y] of [[0.5, 0.5], [0.5, 0.45], [0.52, 0.55], [0.48, 0.4]]) { const h = String(await city(page, (c, xy) => c.hitAt(xy[0], xy[1]), [vp.width * x, vp.height * y])); if (h === "reader" || h.startsWith("turn:")) { x0 = vp.width * x + 100; y0 = vp.height * y; break; } }
    const drag = async (dx: number, steps: number) => { await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move(x0 - dx, y0, { steps }); await page.mouse.up(); await page.waitForTimeout(900); };
    const cur = async () => (await city(page, (c) => c.state())).currentId;
    const a = await cur();
    for (const dx of [40, 80]) { await drag(dx, 6); expect(await cur()).toBe(a); }
    await drag(220, 60); // slow
    expect(await cur()).toBe(a);
    await drag(200, 4); // a quick flick
    await expect.poll(cur).not.toBe(a);
  });

  test("P2-2: on the inner screen in portrait the first tap on the top artifact card opens it", async ({ browser, page: seedPage }, testInfo) => {
    await seedVrSessions(seedPage, { extra: 0, worker: false, artifacts: await writeVrArtifacts() });
    const ctx = await browser.newContext({ baseURL: String(testInfo.project.use.baseURL), viewport: { width: 750, height: 832 }, deviceScaleFactor: 2.625, hasTouch: true, isMobile: true, serviceWorkers: "block" });
    const page = await ctx.newPage();
    await page.goto("/view/vr");
    await page.waitForFunction(() => ((window as VrWindow).__vrCity?.frames || 0) > 5, null, { timeout: 30_000 });
    await page.locator("#vrDock [data-id='avatar:mock-older']").tap();
    await page.waitForFunction(() => (window as VrWindow).__vrCity.state().reading);
    let id: string | undefined;
    await expect.poll(async () => (id = (await city(page, (c) => c.allRegions())).find((r: string) => r.startsWith("rail:art:")))).toBeTruthy();
    await page.waitForTimeout(400);
    const p = await city(page, (c, x) => c.project(x), id);
    await page.touchscreen.tap(p.x, p.y);
    await expect.poll(async () => (await city(page, (c) => c.r3())).artifact?.id ?? (await city(page, (c) => c.r3())).pedestal?.id ?? null).toBe(id!.slice("rail:art:".length));
    expect((await city(page, (c) => c.effortLog())).some((e: { kind: string }) => e.kind === "mouse:strip-jump")).toBe(false);
    await ctx.close();
  });
});
