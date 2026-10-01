import { expect, test } from "@playwright/test";

test("new-session APNG restarts via reusable bytes without repeated downloads", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop animation regression");
  const requests: string[] = [];
  page.on("request", request => { if (request.url().includes("/new-session.apng")) requests.push(request.url()); });
  await page.request.post("/api/mock/reset");
  await page.goto("/");
  const image = page.locator("#identityNewSessionAnimation");
  const urls: string[] = [];
  for (let i = 0; i < 3; i++) {
    const response = page.waitForResponse(response => response.url().endsWith("/api/sessions/new"));
    await page.locator("#newSessionHeaderButton").evaluate((button: HTMLButtonElement) => button.click());
    expect((await response).status()).toBe(200);
    await expect.poll(async () => image.getAttribute("src")).toMatch(/^blob:/);
    const src = (await image.getAttribute("src"))!;
    if (urls.length) await expect.poll(async () => image.getAttribute("src")).not.toBe(urls.at(-1));
    urls.push((await image.getAttribute("src"))!);
  }
  expect(new Set(urls).size).toBe(3);
  expect(requests.length).toBeLessThanOrEqual(2); // initial image plus one canonical blob fetch
  expect(requests.every(url => !url.includes("replay="))).toBe(true);
});
