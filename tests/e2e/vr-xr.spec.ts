import { createRequire } from "node:module";
import { expect, test } from "@playwright/test";
import { seedSessionUiState } from "./helpers/sessionUiState.js";

// WebXR smoke test for the VR view in an IWER-emulated Meta Quest 3: Enter VR
// starts an immersive session, frames render in stereo within the draw-call
// budget, and one right-stick flick switches sessions without moving you.

const iwerScript = createRequire(import.meta.url).resolve("iwer/build/iwer.min.js");
type XrWindow = Window & { __vrCity?: any; __iwer?: any };

test.describe("VR view in an emulated headset", () => {
  test.describe.configure({ timeout: 60_000 });
  test("enters VR, renders stereo frames, and a right-stick flick switches sessions", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "one emulated headset run is enough");
    await page.request.post("/api/mock/reset");
    const since = new Date().toISOString();
    await seedSessionUiState(page, { lanes: [
      { sessionId: "mock-current", lane: "pinned", since },
      { sessionId: "mock-older", lane: "pinned", since },
    ] });
    await page.addInitScript({ path: iwerScript });
    await page.addInitScript(() => {
      const IWER = (window as unknown as { IWER: any }).IWER;
      const device = new IWER.XRDevice(IWER.metaQuest3, { stereoEnabled: true });
      device.installRuntime({ forceInstall: true });
      (window as XrWindow).__iwer = device;
    });
    await page.goto("/view/vr");
    await page.waitForFunction(() => ((window as XrWindow).__vrCity?.frames || 0) > 5, null, { timeout: 25_000 });
    await expect(page.locator("#enterVR")).toBeEnabled();
    await page.locator("#enterVR").click();
    await page.waitForFunction(() => (window as XrWindow).__vrCity.state().xrPresenting, null, { timeout: 10_000 });
    const before = await page.evaluate(() => (window as XrWindow).__vrCity.frames);
    await page.waitForFunction((count) => (window as XrWindow).__vrCity.frames > count + 10, before);
    const stats = await page.evaluate(() => (window as XrWindow).__vrCity.stats());
    // The mocks' comfort budget: at most 70 draw calls for both eyes.
    expect(stats.calls).toBeGreaterThan(0);
    expect(stats.calls).toBeLessThanOrEqual(70);

    const navBefore = await page.evaluate(() => (window as XrWindow).__vrCity.nav());
    const current = await page.evaluate(() => (window as XrWindow).__vrCity.state().currentId);
    const fps = await page.evaluate(() => (window as XrWindow).__vrCity.fps());
    await page.evaluate(async (id) => {
      // Rest the controller with its ray at the floor (the flick works with the ray anywhere).
      const city = (window as XrWindow).__vrCity;
      const stick = (window as XrWindow).__iwer.controllers.right;
      stick.position.set(0.2, 1.0, -0.25);
      stick.quaternion.set(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);
      await new Promise((resolve) => setTimeout(resolve, 300));
      // Software rendering is slow, so hold the stick until a frame has seen it, then release (one flick).
      stick.updateAxes("thumbstick", 0.95, 0);
      const deadline = performance.now() + 8000;
      while (city.state().currentId === id && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 16));
      stick.updateAxes("thumbstick", 0, 0);
    }, current);
    test.info().annotations.push({ type: "xr", description: `fps ${fps}, draw calls ${stats.calls}` });
    const after = await page.evaluate(() => ({ state: (window as XrWindow).__vrCity.state(), nav: (window as XrWindow).__vrCity.nav() }));
    expect(after.state.reading).toBe(true);
    expect(after.state.currentId).not.toBe(current);
    // Switching never moves you.
    expect(after.nav.pos).toEqual(navBefore.pos);
    expect(after.nav.yaw).toEqual(navBefore.yaw);
  });
});
