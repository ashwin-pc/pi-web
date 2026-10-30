import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";
import { seedSessionUiState } from "./helpers/sessionUiState.js";

// The VR view's usability round 2 (PR #182) in an IWER-emulated Meta Quest 3: the critic's round 2 findings, each
// checked the way the critic verified it.

const iwerScript = createRequire(import.meta.url).resolve("iwer/build/iwer.min.js");
type XrWindow = Window & { __vrCity?: any; __iwer?: any };
const vr = <T>(page: Page, fn: (city: any, iwer: any) => T, arg?: unknown) => page.evaluate(`(${fn.toString()})(window.__vrCity, window.__iwer, ${JSON.stringify(arg ?? null)})`) as Promise<T>;
const since = () => new Date().toISOString();

async function enter(page: Page, { hands = false, refuseLocalFloor = false } = {}) {
  await page.addInitScript({ path: iwerScript });
  await page.addInitScript(([h, refuse]) => {
    const IWER = (window as unknown as { IWER: any }).IWER;
    const device = new IWER.XRDevice(IWER.metaQuest3, { stereoEnabled: true });
    device.installRuntime({ forceInstall: true });
    device.position.set(0, 1.6, 0);
    if (h) device.primaryInputMode = "hand";
    (window as XrWindow).__iwer = device;
    if (refuse) {
      const orig = XRSession.prototype.requestReferenceSpace;
      XRSession.prototype.requestReferenceSpace = function (type: XRReferenceSpaceType) { return type === "local-floor" ? Promise.reject(new DOMException("refused", "NotSupportedError")) : orig.call(this, type); };
    }
  }, [hands, refuseLocalFloor]);
  await page.goto("/view/vr");
  await page.waitForFunction(() => ((window as XrWindow).__vrCity?.frames || 0) > 5, null, { timeout: 25_000 });
  await page.locator("#enterVR").click();
  await page.waitForFunction(() => (window as XrWindow).__vrCity.state().xrPresenting, null, { timeout: 10_000 });
  await page.waitForFunction(() => (window as XrWindow).__vrCity.state().reading && (window as XrWindow).__vrCity.state().panelSettled, null, { timeout: 10_000 });
}
async function frames(page: Page, n = 2) { const f0 = await vr(page, (city) => city.frames); await page.waitForFunction(([a, b]) => (window as XrWindow).__vrCity.frames > a + b, [f0, n]); }
async function aim(page: Page, id: string | number[], from = [0.2, 1.05, -0.3], { side = "right", hand = false } = {}) {
  await vr(page, (city, iwer, [region, f, s, h]: [string | number[], number[], string, boolean]) => {
    const T = city._three.THREE, w = typeof region === "string" ? city.world(region) : { x: region[0], y: region[1], z: region[2] }, c = h ? iwer.hands[s] : iwer.controllers[s];
    c.position.set(f[0], f[1], f[2]);
    const q = new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 0, -1), new T.Vector3(w.x - f[0], w.y - f[1], w.z - f[2]).normalize());
    c.quaternion.set(q.x, q.y, q.z, q.w);
  }, [id, from, side, hand]);
  await frames(page, 2);
}
async function trigger(page: Page, side = "right") {
  await vr(page, (_c, iwer, s: string) => iwer.controllers[s].updateButtonValue("trigger", 1), side);
  await frames(page, 1);
  await vr(page, (_c, iwer, s: string) => iwer.controllers[s].updateButtonValue("trigger", 0), side);
  await frames(page, 2);
}
const ptrHits = async (page: Page) => (await vr(page, (city) => city._ptrs())).map((p: { hit: string | null }) => p.hit);

test.describe("VR view, usability round 2 (emulated Quest 3)", () => {
  test.describe.configure({ timeout: 90_000 });
  let ids: string[] = [];
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "one emulated headset run is enough");
    await page.request.post("/api/mock/reset");
    ids = ["mock-current", "mock-older"];
    for (let i = 0; i < 2; i++) {
      const created = await (await page.request.post("/api/sessions/new", { data: {} })).json();
      ids.push(created.sessionId);
      await page.request.post("/api/prompt", { data: { sessionId: created.sessionId, message: "Summarise it in markdown" } });
    }
    await seedSessionUiState(page, { lanes: ids.map((sessionId) => ({ sessionId, lane: "pinned", since: since() })) });
  });

  test("P1-A: two pinches on empty sky change nothing; Needs you is a button on the bar", async ({ page }) => {
    await enter(page, { hands: true });
    const s0 = await vr(page, (city) => city.state());
    await aim(page, [0.6, 2.6, -1.5], [0.2, 1.25, -0.3], { hand: true });
    await vr(page, (_c, iwer) => new Promise<void>((done) => { const xs = (window as XrWindow).__vrCity._three.renderer.xr.getSession(); const seq = [1, 0, 1, 0]; let n = 0; const step = () => { iwer.hands.right.updatePinchValue(seq[n++]); if (n < seq.length) xs.requestAnimationFrame(step); else done(); }; xs.requestAnimationFrame(step); }));
    await page.waitForTimeout(1500);
    expect((await vr(page, (city) => city.state())).currentId).toBe(s0.currentId);
    expect(await vr(page, (city) => city.allRegions())).toContain("bar:needs");
  });

  test("P1-B: a cold open never shows the panel with undrawn text; a far jump cuts to drawn text", async ({ page }) => {
    await enter(page);
    // Sample every XR frame: the reader's opacity, and whether the text in view is drawn.
    await vr(page, () => {
      const w = window as any, xs = w.__vrCity._three.renderer.xr.getSession(); w.__samples = [];
      const tick = () => { const r = w.__vrCity._reader(); w.__samples.push({ sid: r.sid, alpha: r.alpha, ready: r.viewReady(), held: r.held() }); if (w.__samples.length < 4000) xs.requestAnimationFrame(tick); };
      xs.requestAnimationFrame(tick);
    });
    for (const id of [ids[3], ids[1], ids[2]]) {
      await vr(page, (city, _i, x: string) => city.choose(x), id);
      await page.waitForFunction((x) => { const s = (window as XrWindow).__vrCity.state(); return s.currentId === x && s.panelSettled; }, id, { timeout: 10_000 });
      await page.waitForTimeout(400);
    }
    const bad = await page.evaluate(() => (window as any).__samples.filter((s: { alpha: number; ready: boolean }) => s.alpha > 0.3 && !s.ready).length);
    expect(bad).toBe(0);
    expect(await vr(page, (city) => city._reader().holes.count)).toBe(0); // no placeholders left once drawn
  });

  test("P1-C: a select on the composer focuses the text field in the select event (user activation), logged", async ({ page }) => {
    await enter(page);
    await aim(page, "composer:input", [0.2, 1.2, -0.3]);
    expect(await ptrHits(page)).toContain("composer:input");
    await trigger(page);
    const f = await vr(page, (city) => city.composerFocus());
    expect(f.active).toBe("vrComposerInput");
    expect(f.log.some((e: { from: string; focused: boolean }) => e.from === "select" && e.focused)).toBe(true);
    expect(f.activation.map((e: { event: string }) => e.event)).toEqual(expect.arrayContaining(["select", "selectend"]));
  });

  test("P2: the bar sits at −28° or higher while reading, clear of the composer; just above an avatar is not the composer", async ({ page }) => {
    await enter(page);
    // The bar eases to its place (slower under load): wait for it to settle.
    await expect.poll(async () => (await vr(page, (city) => city.r3().bar)).elev, { timeout: 10_000 }).toBeGreaterThanOrEqual(-28.01);
    // A ray 0.4° above an avatar's top edge: it must not land on the composer.
    const id = (await vr(page, (city) => city.state())).pinned[1];
    const above = await vr(page, (city, _i, x: string) => { const T = city._three.THREE, eye = city._three.head.pos.clone(), w = new T.Vector3(...Object.values(city.world(`avatar:${x}`)) as number[]), d = city.targetDeg(`avatar:${x}`); const dir = w.clone().sub(eye).normalize(); const up = new T.Vector3(0, 1, 0).projectOnPlane(dir).normalize(); const a = (d.h / 2 + 0.4) * Math.PI / 180; const p = eye.clone().add(dir.clone().multiplyScalar(Math.cos(a)).addScaledVector(up, Math.sin(a)).multiplyScalar(2)); return [p.x, p.y, p.z]; }, id);
    await aim(page, above, [0.2, 1.05, -0.3]);
    expect(await ptrHits(page)).not.toContain("composer:input");
  });

  test("P2: the session opened on Enter VR is not marked read until your first input", async ({ page }) => {
    await enter(page);
    await page.waitForTimeout(2600); // longer than the 2 s dwell
    const s = await vr(page, (city) => city.state());
    expect(s.dwell?.done ?? false).toBe(false);
    await aim(page, [0.6, 2.6, -1.5], [0.2, 1.25, -0.3]); // any input (here a press on empty sky) starts the dwell
    await trigger(page);
    await expect.poll(async () => (await vr(page, (city) => city.state())).dwell?.done ?? true, { timeout: 6_000 }).toBe(true);
  });

  test("P2: the local-floor fallback is for that session only", async ({ page }) => {
    await enter(page, { refuseLocalFloor: true });
    expect((await vr(page, (city) => city.state())).xr.framebuffer?.space).toBe("local");
    await vr(page, (city) => city._three.renderer.xr.getSession().end());
    await page.waitForFunction(() => !(window as XrWindow).__vrCity.state().xrPresenting);
    expect((await vr(page, (city) => city.state())).xr.spaceRestored).toBe(true);
  });

  test("P2: two flicks back are two turns", async ({ page }) => {
    for (const m of ["Second", "Third", "Fourth"]) await page.request.post("/api/prompt", { data: { sessionId: "mock-older", message: `${m} turn` } });
    await enter(page);
    await vr(page, (city) => city.choose("mock-older"));
    await page.waitForFunction(() => (window as XrWindow).__vrCity.state().currentId === "mock-older" && (window as XrWindow).__vrCity.readerTiles()?.pending === 0, null, { timeout: 15_000 });
    await vr(page, (city) => { const r = city._reader(); r.to(r.maxScroll, 0); });
    await frames(page, 3);
    const n = (await vr(page, (city) => city.state())).snaps.length, t0 = (await vr(page, (city) => city.state())).turnIdx;
    expect(n).toBeGreaterThanOrEqual(4);
    for (let i = 0; i < 2; i++) { await vr(page, (city) => { const r = city._reader(); r.stepTurn(-1); r.to(r.dest, 0); }); await frames(page, 3); }
    expect((await vr(page, (city) => city.state())).turnIdx).toBe(t0 - 2);
  });

  test("P2: the hover card closes after Beside; editing shows dir/file", async ({ page }) => {
    await enter(page);
    await vr(page, (city) => city.choose("mock-older"));
    await page.waitForFunction(() => (window as XrWindow).__vrCity.state().currentId === "mock-older" && (window as XrWindow).__vrCity.state().panelSettled);
    await page.request.post("/api/mock/event", { data: { type: "agent_event", sessionId: "mock-older", event: { type: "agent_start", startedAt: since() } } });
    await page.request.post("/api/mock/event", { data: { type: "agent_event", sessionId: "mock-older", event: { type: "tool_execution_start", toolCallId: "r2", toolName: "edit", args: { path: "src/views/main.ts" } } } });
    await expect.poll(async () => (await vr(page, (city) => city.header()))?.status || "").toMatch(/editing views\/main\.ts/);
    // Point at another avatar, wait for its card, press Beside: the card goes away.
    const other = ids[2];
    await aim(page, `avatar:${other}`, [0.2, 1.05, -0.3]);
    await page.waitForFunction((x) => (window as XrWindow).__vrCity.state().bar.preview === x, other, { timeout: 5_000 });
    await aim(page, "pv:beside", [0.2, 1.05, -0.3]);
    await trigger(page);
    await page.waitForFunction(() => (window as XrWindow).__vrCity.r3().mode === "pair");
    await frames(page, 4);
    expect((await vr(page, (city) => city.state())).bar.preview).toBeNull();
  });
});
