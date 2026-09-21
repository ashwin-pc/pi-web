import { expect, request, test } from "@playwright/test";
import { startRegisteredWavyServer, type RegisteredWavyServer } from "./helpers/registeredWavy.js";

let server: RegisteredWavyServer;

test.beforeEach(async ({}, info) => {
  test.skip(info.project.name !== "desktop", "one real Chromium/runtime path is sufficient");
  server = await startRegisteredWavyServer();
});
test.afterEach(async () => { await server?.stop(); });

test("real registered Wavy review is lossless, lazy, authenticated, and deterministically disposed", async ({ page }) => {
  await page.addInitScript(() => {
    if (top === self) {
      (window as any).__previewChannels = [];
      addEventListener("message", event => {
        if (event.data?.piWebPreview && event.data?.type === "ready") (window as any).__previewChannels.push(event.data.piWebPreview);
      });
      return;
    }
    const lifecycle = { contexts: 0, resumes: 0, decodes: 0, closes: 0, starts: 0, stops: 0, intervals: 0, cleared: 0 };
    (window as any).__audioLifecycle = lifecycle;
    (window as any).__holdAudioResume = false;
    (window as any).__releaseAudioResume = () => {};
    const nativeSetInterval = window.setInterval.bind(window), nativeClearInterval = window.clearInterval.bind(window);
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: any[]) => { lifecycle.intervals++; return nativeSetInterval(handler, timeout, ...args); }) as typeof window.setInterval;
    window.clearInterval = ((id?: number) => { lifecycle.cleared++; return nativeClearInterval(id); }) as typeof window.clearInterval;
    class Node extends EventTarget { playbackRate = { value: 1 }; frequency = { value: 0 }; type = ""; buffer: unknown; connect() { return this; } start() { lifecycle.starts++; } stop() { lifecycle.stops++; } }
    class Gain { gain = { setValueAtTime() {}, exponentialRampToValueAtTime() {} }; connect() { return this; } }
    class TestAudioContext {
      currentTime = 0; destination = {}; state = "running"; constructor() { lifecycle.contexts++; }
      async resume() {
        lifecycle.resumes++;
        if ((window as any).__holdAudioResume) await new Promise<void>(resolve => { (window as any).__releaseAudioResume = resolve; });
      }
      async decodeAudioData() { lifecycle.decodes++; return {}; }
      createBufferSource() { return new Node(); } createOscillator() { return new Node(); } createGain() { return new Gain(); }
      async close() { lifecycle.closes++; this.state = "closed"; }
    }
    Object.defineProperty(window, "AudioContext", { value: TestAudioContext, configurable: true });
  });

  const anonymous = await request.newContext({ baseURL: server.origin });
  expect((await anonymous.get("/api/state")).status()).toBe(401);
  await anonymous.dispose();

  const audioRequests: string[] = [];
  page.on("request", req => { if (/wavy-preview-cache\/.*\.mp3$/.test(req.url())) audioRequests.push(req.url()); });
  await page.goto(`${server.origin}/?token=${server.token}`);
  await expect(page.locator("#statusTitle")).toBeVisible();
  expect((await page.request.get(`${server.origin}/api/state`)).status()).toBe(200);

  const preview = page.locator(".artifactPreview--file", { has: page.locator("iframe") });
  const iframe = preview.locator("iframe");
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
  await expect(iframe).not.toHaveAttribute("sandbox", /allow-same-origin/);
  const frame = iframe.contentFrame();
  await expect(frame.getByRole("heading", { name: "Registered Wavy fixture" })).toBeVisible();
  await preview.getByRole("button", { name: /Click to interact with Registered Wavy fixture/i }).click();

  expect(audioRequests).toEqual([]);
  expect(await frame.locator("body").evaluate(() => ({ ...(window as any).__audioLifecycle }))).toMatchObject({ contexts: 0, decodes: 0 });

  await frame.getByRole("button", { name: "Piano roll" }).click();
  const notes = frame.locator("#roll .roll-note");
  await notes.first().click();
  await frame.getByRole("button", { name: "Select" }).click();
  await notes.nth(1).click();
  const frozen = await frame.locator("body").evaluate(() => (window as any).__wavyTest.selection());
  await frame.getByRole("button", { name: "Comment on selected passage" }).click();
  await frame.getByRole("textbox", { name: "Passage edit comment" }).fill("Make the registered passage lighter.");
  await frame.getByRole("button", { name: "Notation", exact: true }).click();
  expect(await frame.locator("body").evaluate(() => (window as any).__wavyTest.selection())).toEqual(frozen);
  await expect(frame.getByRole("textbox", { name: "Passage edit comment" })).toHaveValue("Make the registered passage lighter.");
  await frame.getByRole("button", { name: "Piano roll" }).click();
  expect(await frame.locator("body").evaluate(() => (window as any).__wavyTest.selection())).toEqual(frozen);

  await page.locator("#prompt").fill("Existing draft");
  await page.locator("#imageInput").setInputFiles({ name: "existing.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64") });
  const messagesBefore = await page.locator(".message.user").count();
  await frame.getByRole("button", { name: "Review edit request" }).click();
  let dialog = page.getByRole("dialog", { name: /Review score edit/ });
  await expect(dialog).toContainText("composition revision 1");
  await expect(dialog).toContainText(server.scoreSha256);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(frame.getByRole("textbox", { name: "Passage edit comment" })).toHaveValue("Make the registered passage lighter.");
  await frame.getByRole("button", { name: "Notation", exact: true }).click();
  await frame.getByRole("button", { name: "Review edit request" }).click();
  dialog = page.getByRole("dialog", { name: /Review score edit/ });
  await expect(dialog).toContainText("Make the registered passage lighter.");
  await dialog.getByRole("button", { name: "Add to chat" }).click();
  await expect(page.locator("#prompt")).toHaveValue(/Composition revision: 1/);
  const stagedDraft = await page.locator("#prompt").inputValue();
  expect(stagedDraft).toContain("Existing draft");
  expect(stagedDraft).toContain("Composition revision: 1");
  expect(stagedDraft).toContain(`Score SHA-256: ${server.scoreSha256}`);
  await expect(page.locator(".attachmentChip", { hasText: "existing.png" })).toHaveCount(1);
  await expect(page.locator(".attachmentChip", { hasText: "Wavy score passage" })).toHaveCount(1);
  expect(await page.locator(".message.user").count()).toBe(messagesBefore);

  await frame.getByRole("button", { name: "Play written music" }).click();
  await expect.poll(() => audioRequests.length).toBeGreaterThan(0);
  await expect.poll(() => frame.locator("body").evaluate(() => (window as any).__audioLifecycle.contexts)).toBe(1);
  await frame.getByRole("button", { name: "Pause written music" }).click();
  await frame.locator("body").evaluate(() => { (window as any).__holdAudioResume = true; });
  await frame.getByRole("button", { name: "Play written music" }).click();
  await expect.poll(() => frame.locator("body").evaluate(() => (window as any).__audioLifecycle.resumes)).toBe(2);
  await expect.poll(() => page.evaluate(() => (window as any).__previewChannels.at(-1))).not.toBeFalsy();
  const activeChannel = await page.evaluate(() => (window as any).__previewChannels.at(-1));
  await iframe.evaluate((element: HTMLIFrameElement, value) => element.contentWindow!.postMessage({ piWebPreview: value, type: "disposed" }, "*"), activeChannel);
  await frame.locator("body").evaluate(() => (window as any).__releaseAudioResume());
  await expect.poll(() => frame.locator("body").evaluate(() => (window as any).__audioLifecycle.closes)).toBe(1);
  await expect.poll(() => frame.locator("body").evaluate(() => ({
    playing: (window as any).__wavyTest.player.playing,
    aborted: (window as any).__wavyTest.player.abort?.signal.aborted ?? true,
    ...((window as any).__audioLifecycle),
  }))).toMatchObject({ playing: false, aborted: true, closes: 1 });
  await expect(iframe).toBeAttached();
  const resourcesBefore = await frame.locator("body").evaluate(() => ({ ...(window as any).__audioLifecycle }));
  await frame.locator("body").evaluate(async () => {
    await (window as any).__wavyTest.player.startPlayback(0);
    await (window as any).__wavyTest.selectTake(0);
  });
  await expect(frame.locator("body")).toHaveAttribute("inert", "");
  await page.waitForTimeout(100);
  expect(await frame.locator("body").evaluate(() => ({ ...(window as any).__audioLifecycle }))).toEqual(resourcesBefore);
});
