import { expect, test, type BrowserContext, type Page } from "@playwright/test";

async function controlledProbe(context: BrowserContext): Promise<Page> {
  // The main app reloads on controllerchange. Register on a same-origin page
  // without that listener so activation cannot destroy the evaluation context.
  const probe = await context.newPage();
  await probe.goto("/artifact-preview.html");
  await probe.evaluate(async () => { await navigator.serviceWorker.register("/sw.js"); await navigator.serviceWorker.ready; });
  await probe.reload();
  await expect.poll(() => probe.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  return probe;
}

test.use({ serviceWorkers: "allow" });
test("a fresh worker serves the default still offline before that avatar was selected", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Production Chromium service-worker regression");
  await page.request.patch("/api/settings", { data: { identity: { avatar: { type: "preset", id: "fox" } } } });
  try {
    await page.goto("/");
    await expect(page.locator(".actionLauncherToggle img")).toHaveAttribute("src", "/avatars/fox/still.png");
    const probe = await controlledProbe(context);
    await context.setOffline(true);
    const result = await probe.evaluate(async () => {
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

test("controlling worker does not freeze the identity manifest or bulk-download avatars", async ({ page, context }, testInfo) => {
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
    const probe = await controlledProbe(context);
    expect(avatarRequests.some(url => url.endsWith(".webm"))).toBe(false);
    expect(new Set(avatarRequests.filter(url => url.endsWith(".apng"))).size).toBeLessThanOrEqual(1);
    const first = await probe.evaluate(async () => (await fetch("/manifest.webmanifest")).json());
    const update = await page.request.patch("/api/settings", { data: { identity: { name: "Worker Brand", shortName: "Worker", avatar: { type: "preset", id: "fox" } } } });
    expect(update.ok()).toBe(true);
    await probe.reload();
    const second = await probe.evaluate(async () => (await fetch("/manifest.webmanifest")).json());
    expect(second.name).toBe("Worker Brand");
    expect(second.short_name).toBe("Worker");
    expect(second.icons[0].src).not.toBe(first.icons[0].src);
  } finally {
    await page.request.patch("/api/settings", { data: { identity: { name: "Pi Web", shortName: "Pi", avatar: { type: "preset", id: "current-pi" } } } });
  }
});
