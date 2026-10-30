import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";
import { seedSessionUiState } from "./helpers/sessionUiState.js";

// The VR view's usability round 1 (PR #182): the critic's findings, each checked the way the critic verified it, in
// an IWER-emulated Meta Quest 3 on the mock server.

const iwerScript = createRequire(import.meta.url).resolve("iwer/build/iwer.min.js");
type XrWindow = Window & { __vrCity?: any; __iwer?: any };
const vr = <T>(page: Page, fn: (city: any, iwer: any) => T, arg?: unknown) => page.evaluate(`(${fn.toString()})(window.__vrCity, window.__iwer, ${JSON.stringify(arg ?? null)})`) as Promise<T>;
const since = () => new Date().toISOString();
const LONG_LINES = 300;

async function enter(page: Page, opts: { refuseLocalFloor?: boolean } = {}) {
  await page.addInitScript({ path: iwerScript });
  await page.addInitScript((refuse) => {
    const IWER = (window as unknown as { IWER: any }).IWER;
    const device = new IWER.XRDevice(IWER.metaQuest3, { stereoEnabled: true });
    device.installRuntime({ forceInstall: true });
    device.position.set(0, 1.6, 0);
    (window as XrWindow).__iwer = device;
    if (refuse) {
      const orig = XRSession.prototype.requestReferenceSpace;
      XRSession.prototype.requestReferenceSpace = function (type: XRReferenceSpaceType) { return type === "local-floor" ? Promise.reject(new DOMException("refused", "NotSupportedError")) : orig.call(this, type); };
    }
  }, Boolean(opts.refuseLocalFloor));
  await page.goto("/view/vr");
  await page.waitForFunction(() => ((window as XrWindow).__vrCity?.frames || 0) > 5, null, { timeout: 25_000 });
  await page.locator("#enterVR").click();
  await page.waitForFunction(() => (window as XrWindow).__vrCity.state().xrPresenting, null, { timeout: 10_000 });
  // Entering VR opens the session that needs you (else the current one).
  await page.waitForFunction(() => (window as XrWindow).__vrCity.state().reading && (window as XrWindow).__vrCity.state().panelSettled, null, { timeout: 10_000 });
}
/** Aim a controller from `from` at a named region's world position. */
async function aim(page: Page, id: string, from = [0.2, 1.05, -0.3], side = "right") {
  await vr(page, (city, iwer, [region, f, s]: [string, number[], string]) => {
    const T = city._three.THREE, w = city.world(region), c = iwer.controllers[s];
    c.position.set(f[0], f[1], f[2]);
    const q = new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 0, -1), new T.Vector3(w.x - f[0], w.y - f[1], w.z - f[2]).normalize());
    c.quaternion.set(q.x, q.y, q.z, q.w);
  }, [id, from, side]);
  const f0 = await vr(page, (city) => city.frames);
  await page.waitForFunction((n) => (window as XrWindow).__vrCity.frames > n + 2, f0);
}
async function trigger(page: Page, side = "right") {
  await vr(page, (_c, iwer, s: string) => iwer.controllers[s].updateButtonValue("trigger", 1), side);
  const f0 = await vr(page, (city) => city.frames);
  await page.waitForFunction((n) => (window as XrWindow).__vrCity.frames > n + 1, f0);
  await vr(page, (_c, iwer, s: string) => iwer.controllers[s].updateButtonValue("trigger", 0), side);
  const f1 = await vr(page, (city) => city.frames);
  await page.waitForFunction((n) => (window as XrWindow).__vrCity.frames > n + 2, f1);
}
async function rest(page: Page) {
  await vr(page, (_c, iwer) => { for (const s of ["left", "right"]) { const c = iwer.controllers[s]; c.position.set(s === "left" ? -0.2 : 0.2, 0.95, -0.12); const a = -50 * Math.PI / 180; c.quaternion.set(Math.sin(a / 2), 0, 0, Math.cos(a / 2)); } });
}

test.describe("VR view, usability round 1 (emulated Quest 3)", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "one emulated headset run is enough");
    await page.request.post("/api/mock/reset");
  });

  async function seed(page: Page, extra = 0) {
    const ids = ["mock-current", "mock-older"];
    for (let i = 0; i < extra; i++) {
      const created = await (await page.request.post("/api/sessions/new", { data: i === 0 ? { origin: { sessionId: "mock-older", kind: "spawn" } } : {} })).json();
      ids.push(created.sessionId);
      await page.request.post("/api/prompt", { data: { sessionId: created.sessionId, message: "Summarise it in markdown" } });
    }
    await seedSessionUiState(page, { lanes: ids.map((sessionId) => ({ sessionId, lane: "pinned", since: since() })) });
    return ids;
  }

  test("P0-1: a 300-line turn is never cut: the last line is laid out, on screen and drawn at the end", async ({ page }) => {
    await seed(page);
    const lines = Array.from({ length: LONG_LINES }, (_, i) => `Line ${i + 1} of the long reply`).join("\n");
    await page.request.post("/api/prompt", { data: { sessionId: "mock-older", message: `${lines}\nLAST-LINE-MARKER` } });
    await enter(page);
    await vr(page, (city) => city.choose("mock-older"));
    await page.waitForFunction(() => (window as XrWindow).__vrCity.readerTiles()?.sid === "mock-older" && (window as XrWindow).__vrCity.readerTiles().pending === 0, null, { timeout: 30_000 });
    await vr(page, (city) => { const r = city._reader(); r.to(r.maxScroll, 0); });
    await page.waitForFunction(() => (window as XrWindow).__vrCity.lastLine()?.drawn, null, { timeout: 20_000 });
    const tiles = await vr(page, (city) => city.readerTiles());
    expect(Math.max(...tiles.turns.map((t: { h: number }) => t.h))).toBeGreaterThan(4096);
    expect(tiles.cut).toBe(0);
    expect(await vr(page, (city) => city.lastLine())).toMatchObject({ visible: true, drawn: true });
    // The marker line is in the transcript the reader laid out.
    expect((await vr(page, (city) => city.messages("mock-older"))).some((m: { text: string }) => m.text.includes("LAST-LINE-MARKER"))).toBe(true);
    expect(tiles.residentMB).toBeLessThan(150);
  });

  test("P0-3: pointing from elbow height opens what you point at; an empty tap opens nothing", async ({ page }) => {
    const ids = await seed(page, 2);
    await enter(page);
    await vr(page, (city) => city.close());
    await page.waitForFunction(() => !(window as XrWindow).__vrCity.state().reading);
    await rest(page);
    const target = ids[2];
    for (const y of [0.9, 1.05, 1.2]) {
      await vr(page, (city) => city.close());
      await aim(page, `avatar:${target}`, [0.2, y, -0.3]);
      expect((await vr(page, (city) => city._ptrs())).map((p: { hit: string | null }) => p.hit)).toContain(`avatar:${target}`);
      await trigger(page);
      await page.waitForFunction((x) => (window as XrWindow).__vrCity.state().reading && (window as XrWindow).__vrCity.state().currentId === x, target, { timeout: 5_000 });
    }
    // An empty tap (the ray at the sky): nothing opens, after waiting longer than the old 330 ms.
    await vr(page, (city) => city.close());
    await page.waitForFunction(() => !(window as XrWindow).__vrCity.state().reading);
    await vr(page, (_c, iwer) => { const c = iwer.controllers.right; c.position.set(0.2, 1.2, -0.3); const a = 40 * Math.PI / 180; c.quaternion.set(Math.sin(a / 2), 0, 0, Math.cos(a / 2)); });
    await trigger(page);
    await page.waitForTimeout(700);
    expect((await vr(page, (city) => city.state())).reading).toBe(false);
  });

  test("P0-4: selecting the composer focuses a real text field (the system keyboard), and Send sends", async ({ page }) => {
    await seed(page);
    await enter(page);
    await vr(page, (city) => city.choose("mock-older"));
    await page.waitForFunction(() => (window as XrWindow).__vrCity.state().currentId === "mock-older" && (window as XrWindow).__vrCity.state().panelSettled);
    const before = (await vr(page, (city) => city.messages("mock-older"))).length;
    await aim(page, "composer:input", [0.2, 1.2, -0.3]);
    await trigger(page);
    const focus = await vr(page, (city) => city.composerFocus());
    expect(focus).toMatchObject({ active: "vrComposerInput", focused: true });
    // XRSession.isSystemKeyboardSupported is reported (IWER says false; a Quest says true and shows its keyboard).
    expect(typeof focus.keyboard).toBe("boolean");
    expect((await vr(page, (city) => city.state())).dictating).toBe(false); // the box never starts dictation
    await page.keyboard.type("ship it");
    expect((await vr(page, (city) => city.state())).composerText).toBe("ship it");
    await aim(page, "composer:send", [0.2, 1.2, -0.3]);
    expect((await vr(page, (city) => city._ptrs())).map((p: { hit: string | null }) => p.hit)).toContain("composer:send");
    await trigger(page);
    await expect.poll(async () => (await vr(page, (city) => city.messages("mock-older"))).length).toBeGreaterThan(before);
    expect((await vr(page, (city) => city.messages("mock-older"))).some((m: { text: string }) => m.text === "ship it")).toBe(true);
  });

  test("P1-1, P1-7, P1-9: you start in a session at eye level, the cockpit fits ±35°, pair ≤ 75°, every target ≥ 2.5°", async ({ page }) => {
    const ids = await seed(page, 2);
    await enter(page);
    const size = await vr(page, (city) => city.focusSize());
    expect(size.cockpit.wDeg).toBeLessThanOrEqual(70);
    expect(size.conversation.wDeg).toBeLessThanOrEqual(37);
    expect(Math.abs(size.cockpit.centreYaw)).toBeLessThan(15);
    expect(Math.abs(size.conversation.centreElev)).toBeLessThan(15);
    const small = await vr(page, (city) => city.allRegions().map((id: string) => [id, city.targetDeg(id)?.min]).filter(([, d]: [string, number]) => d != null && d < 2.5));
    expect(small).toEqual([]);
    await vr(page, (city, _i, id: string) => city.openBeside(id), ids[2]);
    await page.waitForFunction(() => (window as XrWindow).__vrCity.r3().mode === "pair" && (window as XrWindow).__vrCity.r3().settled);
    expect((await vr(page, (city) => city.layoutExtent())).wDeg).toBeLessThanOrEqual(75);
  });

  test("P1-2, P1-3, P1-4: the bar holds when you look at its ends, a light grip and a stray thumb move nothing", async ({ page }) => {
    await seed(page, 2);
    await enter(page);
    const navBefore = await vr(page, (city) => city.nav().pos);
    // Grip held lightly for 1 s while reading.
    await vr(page, (_c, iwer) => iwer.controllers.right.updateButtonValue("squeeze", 1));
    await page.waitForTimeout(1000);
    await vr(page, (_c, iwer) => iwer.controllers.right.updateButtonValue("squeeze", 0));
    expect(await vr(page, (city) => city.nav().pos)).toEqual(navBefore);
    // A stray thumb in the city view: y −0.45 for 1.5 s.
    await vr(page, (city) => city.close());
    await vr(page, (_c, iwer) => iwer.controllers.right.updateAxes("thumbstick", 0.05, -0.45));
    await page.waitForTimeout(1500);
    await vr(page, (_c, iwer) => iwer.controllers.right.updateAxes("thumbstick", 0, 0));
    expect(await vr(page, (city) => city.nav().pos)).toEqual(navBefore);
    // Turning the head 40° toward the bar's end does not move the bar.
    const yaw0 = (await vr(page, (city) => city.state())).bar.yaw;
    for (const deg of [20, 30, 40]) {
      await vr(page, (city, iwer, d: number) => { const T = city._three.THREE; const q = new T.Quaternion().setFromEuler(new T.Euler(-27 * Math.PI / 180, -d * Math.PI / 180, 0, "YXZ")); iwer.quaternion.set(q.x, q.y, q.z, q.w); }, deg);
      await page.waitForTimeout(1200);
      expect((await vr(page, (city) => city.state())).bar.yaw).toBe(yaw0);
    }
  });

  test("P1-6, P1-8: the header names the file being edited; every avatar is named; a worker never 'needs you'", async ({ page }) => {
    await seed(page, 2);
    await enter(page);
    await vr(page, (city) => city.choose("mock-older"));
    await page.waitForFunction(() => (window as XrWindow).__vrCity.state().currentId === "mock-older");
    await page.request.post("/api/mock/event", { data: { type: "agent_event", sessionId: "mock-older", event: { type: "agent_start", startedAt: since() } } });
    await page.request.post("/api/mock/event", { data: { type: "agent_event", sessionId: "mock-older", event: { type: "tool_execution_start", toolCallId: "u1", toolName: "edit", args: { path: "src/main.ts" } } } });
    await expect.poll(async () => (await vr(page, (city) => city.header()))?.status || "").toMatch(/editing main\.ts/);
    // The avatar's hover card says the same.
    await aim(page, "avatar:mock-older", [0.2, 1.05, -0.3]);
    await expect.poll(async () => (await vr(page, (city) => city.preview()))?.status || "", { timeout: 5_000 }).toMatch(/editing main\.ts/);
    await rest(page);
    const bar = await vr(page, (city) => city.barCheck());
    expect(bar.drawn?.length ?? 0).toBeGreaterThan(0);
    expect(bar.drawn.every((cell: { lines: string[] }) => cell.lines.length > 0)).toBe(true);
    const state = await vr(page, (city) => city.state());
    const worker = state.pinned[2];
    expect(state.needs).not.toContain(worker);
  });

  test("P1-10: a refused local-floor falls back to local (no black, stuck session); recentring follows a reset", async ({ page }) => {
    await seed(page);
    await enter(page, { refuseLocalFloor: true });
    const xr = (await vr(page, (city) => city.state())).xr;
    expect(xr.framebuffer?.width).toBeGreaterThan(0);
    expect(xr.framebuffer?.space).toBe("local");
    await vr(page, (city) => city._three.renderer.xr.getReferenceSpace().dispatchEvent(new Event("reset")));
    await expect.poll(async () => (await vr(page, (city) => city.effortLog())).some((e: { kind: string }) => e.kind === "xr:reset")).toBe(true);
  });

  test("Exit VR: More has an Exit VR item that ends the session and stays on the VR page", async ({ page }) => {
    await seed(page);
    await enter(page);
    await vr(page, (city) => { city.close(); });
    await page.waitForFunction(() => !(window as XrWindow).__vrCity.state().reading);
    await page.waitForTimeout(1500); // the bar settles back under your gaze
    await aim(page, "bar:more", [0.2, 1.2, -0.3]);
    expect((await vr(page, (city) => city._ptrs())).map((p: { hit: string | null }) => p.hit)).toContain("bar:more");
    await trigger(page);
    await page.waitForFunction(() => (window as XrWindow).__vrCity.allRegions().includes("menu:exitvr"));
    await aim(page, "menu:exitvr", [0.2, 1.2, -0.3]);
    await trigger(page);
    await page.waitForFunction(() => !(window as XrWindow).__vrCity.state().xrPresenting, null, { timeout: 5_000 });
    expect(page.url()).toMatch(/\/view\/vr/);
  });
});
