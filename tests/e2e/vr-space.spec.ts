import { expect, test, type Page } from "@playwright/test";
import { seedVrSessions, VR_ARTIFACT_DIR, writeVrArtifacts } from "./helpers/vrFixtures.js";

// The City's round 3 "use the space" features on live mock data: the focus
// cockpit, several sessions at once, and real artifacts as spatial objects.

type VrWindow = Window & { __vrCity?: any };
const city = <T>(page: Page, fn: (vr: any) => T) => page.evaluate(`(${fn.toString()})(window.__vrCity)`) as Promise<T>;
const artifactId = (name: string) => `mock-older:${VR_ARTIFACT_DIR}/${name}`;

test.describe("VR view: use the space", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the spatial layouts are exercised once, on the desktop preview");
    await page.request.post("/api/mock/reset");
  });

  async function open(page: Page, extra = 0) {
    const links = await writeVrArtifacts();
    const ids = await seedVrSessions(page, { extra, worker: extra > 0, artifacts: links });
    await page.goto("/view/vr");
    await page.waitForFunction(() => ((window as VrWindow).__vrCity?.frames || 0) > 5, null, { timeout: 30_000 });
    return ids;
  }

  test("a focused session is a large three-column cockpit with its real artifacts on the rail", async ({ page }) => {
    await open(page);
    await page.evaluate(() => (window as VrWindow).__vrCity.open("mock-older"));
    await expect.poll(() => city(page, (vr) => vr.r3().mode)).toBe("focus");
    // Once the open motion has settled: the mock measured 86° × 44° (round 2's panel was 50° × 30°).
    await expect.poll(() => city(page, (vr) => vr.focusSize().cockpit.wDeg), { timeout: 5000 }).toBeGreaterThan(80);
    const size = await city(page, (vr) => vr.focusSize());
    expect(size.cockpit.hDeg).toBeGreaterThan(35);
    const artifacts = await city(page, (vr) => vr.artifacts("mock-older").map((a: { id: string; kind: string; turn: number }) => [a.id, a.kind, a.turn]));
    expect(artifacts).toEqual(expect.arrayContaining([
      [artifactId("screen-before.png"), "image", 2], [artifactId("report.md"), "markdown", 2], [artifactId("fix.diff"), "diff", 2],
      [artifactId("flow.mmd"), "diagram", 2], [artifactId("dial.stl"), "model", 2], [artifactId("playground.html"), "html", 2],
    ]));
    // Pointing at another avatar threads it to its beam, but never across the cockpit's text.
    const avatar = await city(page, (vr) => vr.project("avatar:mock-current"));
    expect(avatar?.visible).toBe(true);
    await page.mouse.move(avatar.x, avatar.y);
    await expect.poll(() => city(page, (vr) => vr.state().bar.highlight)).toBe("mock-current");
    await page.waitForTimeout(200);
    const thread = await city(page, (vr) => vr.threadOverPanels());
    expect(thread.panels).toBeGreaterThan(0);
    expect(thread.covered).toBe(0);
    // Each artifact file is a building in the city, with a marker.
    const markers = await city(page, (vr) => vr.markers().map((m: { id: string }) => m.id));
    expect(markers).toEqual(expect.arrayContaining([artifactId("screen-before.png"), artifactId("dial.stl")]));
  });

  test("artifacts pull out with their real content, HTML hands off to 2D, and a model sits on the pedestal", async ({ page }) => {
    await open(page);
    await page.evaluate(() => (window as VrWindow).__vrCity.open("mock-older"));
    for (const name of ["screen-after.png", "report.md", "fix.diff", "flow.mmd"]) {
      const id = artifactId(name);
      expect(await page.evaluate((x) => (window as VrWindow).__vrCity.pullOut(x), id)).toBe("panel");
      await expect.poll(() => page.evaluate((x) => (window as VrWindow).__vrCity.artifactState(x), id)).toBe("ready");
      expect(await city(page, (vr) => vr.r3().artifact?.wDeg)).toBeGreaterThanOrEqual(34);
    }
    expect(await page.evaluate((x) => (window as VrWindow).__vrCity.pullOut(x), artifactId("dial.stl"))).toBe("pedestal");
    await expect.poll(() => city(page, (vr) => vr.pedestalStatus())).toBe("ready");
    const model = await city(page, (vr) => vr.modelScreen());
    expect(model?.visible).toBe(true);
    await page.mouse.move(model.x, model.y);
    await page.mouse.down();
    await page.mouse.move(model.x + 80, model.y + 10, { steps: 6 });
    await page.mouse.up();
    expect(await city(page, (vr) => vr.r3().pedestal.turned)).toBeGreaterThan(0);

    expect(await page.evaluate((x) => (window as VrWindow).__vrCity.pullOut(x), artifactId("playground.html"))).toBe("panel");
    await page.waitForFunction(() => (window as VrWindow).__vrCity.allRegions().includes("art:2d"));
    const button = await city(page, (vr) => vr.project("art:2d"));
    await page.mouse.click(button.x, button.y);
    await page.waitForURL((url) => url.pathname === "/" && url.searchParams.get("sessionId") === "mock-older");
    await expect(page.locator("#artifactBrowserPreviewTitle")).toHaveText("playground.html");
    expect(new URL(page.url()).searchParams.has("artifact")).toBe(false);
  });

  test("several sessions at once: beside, triptych, a wall of six, refocus, and pinned artifacts, with nothing overlapping", async ({ page }) => {
    const ids = await open(page, 4);
    await page.evaluate(() => (window as VrWindow).__vrCity.open("mock-current"));
    const navBefore = await city(page, (vr) => vr.nav().pos);
    await page.evaluate((id) => (window as VrWindow).__vrCity.openBeside(id), ids[1]);
    await expect.poll(() => city(page, (vr) => vr.r3().mode)).toBe("pair");
    await page.evaluate((id) => (window as VrWindow).__vrCity.openBeside(id), ids[2]);
    await expect.poll(() => city(page, (vr) => vr.r3().mode)).toBe("triptych");
    await page.evaluate(() => (window as VrWindow).__vrCity.setLayout("wall"));
    for (const id of ids.slice(3)) await page.evaluate((x) => (window as VrWindow).__vrCity.openBeside(x), id);
    await expect.poll(() => city(page, (vr) => vr.r3().visible)).toBe(6);
    await expect.poll(() => city(page, (vr) => vr.r3().settled)).toBe(true);
    expect((await city(page, (vr) => vr.overlaps())).pairs).toEqual([]);
    const before = await city(page, (vr) => vr.r3().items);
    const refocused = await page.evaluate(() => (window as VrWindow).__vrCity.refocusTile(2));
    await expect.poll(() => city(page, (vr) => vr.r3().items[0])).toBe(refocused);
    expect((await city(page, (vr) => vr.r3().items)).sort()).toEqual([...before].sort());
    expect(await city(page, (vr) => vr.nav().pos)).toEqual(navBefore);

    // Compare two screenshots on the wall.
    await page.evaluate(() => (window as VrWindow).__vrCity.setLayout("focus"));
    await page.evaluate(() => (window as VrWindow).__vrCity.open("mock-older"));
    for (const name of ["screen-before.png", "screen-after.png"]) await page.evaluate((x) => (window as VrWindow).__vrCity.pinArtifact(x), artifactId(name));
    await page.evaluate(() => (window as VrWindow).__vrCity.setLayout("wall"));
    await expect.poll(() => city(page, (vr) => vr.r3().items.filter((item: string) => item.startsWith("artifact:")).length)).toBe(2);
    await expect.poll(() => city(page, (vr) => vr.r3().settled)).toBe(true);
    expect((await city(page, (vr) => vr.overlaps())).pairs).toEqual([]);
  });
});
