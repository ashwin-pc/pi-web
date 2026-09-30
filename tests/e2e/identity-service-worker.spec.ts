import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "allow" });
test("controlling worker does not freeze the identity manifest or bulk-download avatars", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Production Chromium service-worker regression");
  const avatarRequests: string[] = [];
  let coldAvatarBytes = 0;
  page.on("request", request => { if (request.url().includes("/avatars/")) avatarRequests.push(request.url()); });
  page.on("response", response => {
    if (response.url().includes("/avatars/")) coldAvatarBytes += Number(response.headers()["content-length"] || 0);
  });
  await page.request.patch("/api/settings", { data: { identity: { name: "Pi Web", shortName: "Pi", avatar: { type: "preset", id: "current-pi" } } } });
  try {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    expect(coldAvatarBytes).toBeLessThan(8 * 1024 * 1024);
    await page.evaluate(async () => { await navigator.serviceWorker.register("/sw.js"); await navigator.serviceWorker.ready; });
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    expect(avatarRequests.some(url => url.endsWith(".webm"))).toBe(false);
    expect(new Set(avatarRequests.filter(url => url.endsWith(".apng"))).size).toBeLessThanOrEqual(1);
    const first = await page.evaluate(async () => (await fetch("/manifest.webmanifest")).json());
    const update = await page.request.patch("/api/settings", { data: { identity: { name: "Worker Brand", shortName: "Worker", avatar: { type: "preset", id: "fox" } } } });
    expect(update.ok()).toBe(true);
    await page.reload();
    const second = await page.evaluate(async () => (await fetch("/manifest.webmanifest")).json());
    expect(second.name).toBe("Worker Brand");
    expect(second.short_name).toBe("Worker");
    expect(second.icons[0].src).not.toBe(first.icons[0].src);
  } finally {
    await page.request.patch("/api/settings", { data: { identity: { name: "Pi Web", shortName: "Pi", avatar: { type: "preset", id: "current-pi" } } } });
  }
});
