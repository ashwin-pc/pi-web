import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";

// Compare rendered pixels of the real APNG, not naturalWidth or CSS motion.
// Canvas drawImage snapshots an APNG's static poster in Chromium, so capture
// the visible image element itself (with CSS animation disabled) instead.
test("new-session APNG has moving frames, settles, and respects reduced motion", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Pixel-frame playback smoke on desktop Chromium");
  await page.request.post("/api/mock/reset");
  await page.request.patch("/api/settings", { data: { identity: { avatar: { type: "preset", id: "fox" } } } });
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { started = resolve; });
  await page.route("**/avatars/fox/new-session.apng", async route => {
    started();
    await held;
    await route.continue();
  });
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await requested;
    const response = page.waitForResponse(value => value.url().endsWith("/api/sessions/new"));
    await page.locator("#newSessionHeaderButton").evaluate((button: HTMLButtonElement) => button.click());
    expect((await response).ok()).toBe(true);
    await expect(page.locator("#emptyCwdChooser")).toBeVisible();
    release();
    const image = page.locator("#identityNewSessionAnimation");
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
    const fingerprint = async () => createHash("sha256").update(await image.screenshot({ animations: "disabled" })).digest("hex");
    const frames: string[] = [];
    for (let i = 0; i < 7; i++) {
      frames.push(await fingerprint());
      await page.waitForTimeout(110);
    }
    expect(new Set(frames.slice(1, 5)).size).toBeGreaterThan(1);
    await page.waitForTimeout(1300);
    const settled = await fingerprint();
    await page.waitForTimeout(250);
    expect(await fingerprint()).toBe(settled);
    expect(frames[0]).not.toBe(settled);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload();
    await expect(page.locator("#identityNewSessionStill")).toHaveAttribute("src", "/avatars/fox/still.png");
    await expect(page.locator("#identityNewSessionAnimation")).toHaveCount(0);
  } finally {
    release();
    await page.request.patch("/api/settings", { data: { identity: { avatar: { type: "preset", id: "current-pi" } } } });
  }
});
