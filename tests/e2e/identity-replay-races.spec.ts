import { expect, test } from "@playwright/test";

// Detect stale replay assignments without depending on how quickly a browser
// decodes an APNG after its delayed response arrives.
async function trackReplayBlobs(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL);
    (window as any).__replayBlobs = [] as string[];
    URL.createObjectURL = (blob: Blob) => {
      const url = create(blob);
      (window as any).__replayBlobs.push(url);
      return url;
    };
  });
}

function gate() {
  let release!: () => void;
  let started!: () => void;
  return { waiting: new Promise<void>(resolve => { started = resolve; }),
    held: new Promise<void>(resolve => { release = resolve; }),
    start: () => started(), release: () => release() };
}

async function startSession(page: import("@playwright/test").Page) {
  const response = page.waitForResponse(value => value.url().endsWith("/api/sessions/new"));
  await page.locator("#newSessionHeaderButton").evaluate((button: HTMLButtonElement) => button.click());
  expect((await response).ok()).toBe(true);
}

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Desktop delayed media regression");
  await page.request.post("/api/mock/reset");
});

test.afterEach(async ({ page }) => {
  await page.request.patch("/api/settings", { data: { identity: { avatar: { type: "preset", id: "current-pi" } } } });
});

test("slow Cat replay cannot cover a newly selected Fox avatar", async ({ page }) => {
  await page.request.patch("/api/settings", { data: { identity: { avatar: { type: "preset", id: "cat" } } } });
  await trackReplayBlobs(page);
  const delayed = gate();
  await page.route("**/avatars/cat/new-session.apng", async route => {
    if (route.request().resourceType() === "fetch") { delayed.start(); await delayed.held; }
    await route.continue();
  });
  try {
    await page.goto("/");
    await startSession(page);
    await delayed.waiting;
    await page.request.patch("/api/settings", { data: { identity: { avatar: { type: "preset", id: "fox" } } } });
    const image = page.locator("#identityNewSessionAnimation");
    await expect(image).toHaveAttribute("src", "/avatars/fox/new-session.apng");
    const completed = page.waitForResponse(response => response.url().endsWith("/avatars/cat/new-session.apng") && response.request().resourceType() === "fetch");
    delayed.release();
    await completed;
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
    await expect(image).toHaveAttribute("src", "/avatars/fox/new-session.apng");
    expect(await page.evaluate(() => (window as any).__replayBlobs)).toEqual([]);
  } finally { delayed.release(); }
});

test("an A→B→A switch does not apply an earlier A replay to the replacement node", async ({ page }) => {
  await page.request.patch("/api/settings", { data: { identity: { avatar: { type: "preset", id: "cat" } } } });
  await trackReplayBlobs(page);
  const delayed = gate();
  await page.route("**/avatars/cat/new-session.apng", async route => {
    if (route.request().resourceType() === "fetch") { delayed.start(); await delayed.held; }
    await route.continue();
  });
  try {
    await page.goto("/");
    await startSession(page);
    await delayed.waiting;
    for (const id of ["fox", "cat"]) {
      await page.request.patch("/api/settings", { data: { identity: { avatar: { type: "preset", id } } } });
      await expect(page.locator("#identityNewSessionAnimation")).toHaveAttribute("src", `/avatars/${id}/new-session.apng`);
    }
    const response = page.waitForResponse(value => value.url().endsWith("/avatars/cat/new-session.apng") && value.request().resourceType() === "fetch");
    delayed.release();
    await response;
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
    await expect(page.locator("#identityNewSessionAnimation")).toHaveAttribute("src", "/avatars/cat/new-session.apng");
    expect(await page.evaluate(() => (window as any).__replayBlobs)).toEqual([]);
  } finally { delayed.release(); }
});

test("slow boot-default replay cannot cover the saved Cat identity", async ({ page }) => {
  await page.request.patch("/api/settings", { data: { identity: { avatar: { type: "preset", id: "cat" } } } });
  await trackReplayBlobs(page);
  const settings = gate();
  const replay = gate();
  await page.route("**/api/settings", async route => {
    if (route.request().method() === "GET") { settings.start(); await settings.held; }
    await route.continue();
  });
  await page.route("**/avatars/current-pi/new-session.apng", async route => {
    if (route.request().resourceType() === "fetch") { replay.start(); await replay.held; }
    await route.continue();
  });
  try {
    await page.goto("/");
    await settings.waiting;
    await startSession(page);
    await replay.waiting;
    settings.release();
    await expect(page.locator("#identityNewSessionAnimation")).toHaveAttribute("src", "/avatars/cat/new-session.apng");
    const completed = page.waitForResponse(response => response.url().endsWith("/avatars/current-pi/new-session.apng") && response.request().resourceType() === "fetch");
    replay.release();
    await completed;
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
    await expect(page.locator("#identityNewSessionAnimation")).toHaveAttribute("src", "/avatars/cat/new-session.apng");
    expect(await page.evaluate(() => (window as any).__replayBlobs)).toEqual([]);
  } finally { settings.release(); replay.release(); }
});
