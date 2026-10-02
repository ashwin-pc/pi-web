import { expect, test, type Page } from "@playwright/test";

test.use({ serviceWorkers: "allow" });

async function waitForWorkerActivation(page: Page) {
  // The production page already registers its worker and reloads on activation.
  // waitForFunction survives that navigation; page.evaluate does not. Observe
  // the controlled, post-reload document before fetching anything offline.
  await page.waitForFunction(() => {
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return !!navigator.serviceWorker.controller && navigation?.type === "reload";
  });
  await page.waitForLoadState("load");
}
test("a fresh worker serves the default still offline before that avatar was selected", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Production Chromium service-worker regression");
  await page.request.patch("/api/settings", { data: { identity: { avatar: { type: "preset", id: "fox" } } } });
  try {
    await page.goto("/");
    await expect(page.locator(".actionLauncherToggle img")).toHaveAttribute("src", "/avatars/fox/still.png");
    await waitForWorkerActivation(page);
    await context.setOffline(true);
    const result = await page.evaluate(async () => {
      const response = await fetch("/avatars/current-pi/still.png");
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { status: response.status, signature: [...bytes.slice(0, 8)] };
    });
    expect(result).toEqual({ status: 200, signature: [137, 80, 78, 71, 13, 10, 26, 10] });
  } finally {
    await context.setOffline(false);
    await page.request.patch("/api/settings", { data: { identity: { avatar: { type: "preset", id: "current-pi" } } } });
  }
});

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
    await waitForWorkerActivation(page);
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
