import { expect, test, type Page, type Route } from "@playwright/test";

const contribution = {
  version: 1, key: "test.layout-dictation", slot: "composer-input", kind: "capture",
  title: "Layout dictation", label: "Dictation", icon: "mic",
  capture: { media: "audio", maxSeconds: 10, maxBytes: 25_000_000, mimeTypes: ["audio/webm"], registrationId: "00000000-0000-4000-8000-000000000044" },
};

async function prepare(page: Page) {
  await page.request.post("/api/mock/reset");
  await page.routeWebSocket("**/ws**", () => {});
  await page.route("**/api/state**", async (route) => {
    const response = await route.fetch();
    const state = await response.json();
    state.webContributions = [contribution];
    await route.fulfill({ response, json: state });
  });
  await page.addInitScript(() => {
    let dataEvents = 0;
    let permissionPending = true;
    let resolvePermission: (() => void) | undefined;
    const NativeRecorder = window.MediaRecorder;
    class Recorder extends NativeRecorder {
      constructor(stream: MediaStream, options?: MediaRecorderOptions) {
        super(stream, options);
        this.addEventListener("dataavailable", (event) => { if (event.data.size) dataEvents += 1; });
      }
    }
    Object.defineProperty(window, "MediaRecorder", { configurable: true, value: Recorder });
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => {
      const context = new AudioContext();
      await context.resume();
      const oscillator = context.createOscillator();
      const destination = context.createMediaStreamDestination();
      oscillator.connect(destination); oscillator.start();
      if (permissionPending) await new Promise<void>((resolve) => { resolvePermission = resolve; });
      return destination.stream;
    } });
    Object.assign(window, {
      __layoutResolvePermission: () => { permissionPending = false; resolvePermission?.(); },
    });
    Object.defineProperty(window, "__layoutCaptureData", { get: () => dataEvents });
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: contribution.title })).toBeVisible();
  await page.addStyleTag({ content: "#promptForm { --composer-footer-height: 44px; --composer-action-size: 44px; }" });
}

const fulfillUpload = (route: Route) => route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ ok: true, captureId: "layout-capture" }) });

async function hitTarget(page: Page, selector: string) {
  return page.locator(selector).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return hit === element || element.contains(hit);
  });
}

async function rects(page: Page) {
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const value = document.querySelector(selector)!.getBoundingClientRect();
      return { x: value.x, y: value.y, width: value.width, height: value.height };
    };
    const form = document.querySelector<HTMLElement>("#promptForm")!;
    return {
      form: rect("#promptForm"), footer: rect(".composerFooter"), model: rect("#modelControl"),
      queue: rect("#queueToggle"), send: rect("#primaryButton"), inputs: rect(".composerExtensionInputs"),
      token: getComputedStyle(form).getPropertyValue("--composer-footer-height").trim(),
      actionToken: getComputedStyle(form).getPropertyValue("--composer-action-size").trim(),
      chrome: form.dataset.captureChrome || "", footerPosition: getComputedStyle(document.querySelector(".composerFooter")!).position,
      footerInlineHeight: (document.querySelector<HTMLElement>(".composerFooter")!).style.height,
    };
  });
}

test("a 44px CSS chrome contract drives the real resolving handoff and final layout", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Frame geometry is sampled once in the touch layout");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await prepare(page);
  await page.route("**/api/web-captures?**", fulfillUpload);
  await page.route("**/api/web-contributions/invoke", async (route) => {
    await gate;
    await route.fulfill({ json: { ok: true, effects: [{ type: "insert-composer-text", text: "layout result", placement: "selection" }] } });
  });

  const before = await rects(page);
  expect(before.token).toBe("44px");
  expect(before.actionToken).toBe("44px");
  // Compact geometry remains its canonical 38px override despite the expanded token.
  expect(before.footer.height).toBe(38);
  await expect(page.locator("#contextMeter")).toHaveCSS("height", "5px");
  expect(await hitTarget(page, ".composerCaptureButton")).toBe(true);

  // Use a genuine pointer click while permission is intentionally pending so
  // the hit target is proven in compact mode rather than bypassed by dispatch.
  await page.locator(".composerCaptureButton").click();
  await expect(page.locator("#promptForm")).toHaveAttribute("data-capture-phase", "permission");
  expect(await hitTarget(page, ".composerCaptureButton")).toBe(true);
  expect(await hitTarget(page, ".composerCaptureCancel")).toBe(true);
  await page.evaluate(() => (window as any).__layoutResolvePermission());
  await expect(page.locator(".composerCaptureButton")).toHaveAttribute("aria-pressed", "true");
  expect(await hitTarget(page, ".composerCaptureButton")).toBe(true);
  expect(await hitTarget(page, ".composerCaptureCancel")).toBe(true);
  const recording = await rects(page);
  expect(Math.abs(recording.model.width - before.model.width)).toBeLessThanOrEqual(.5);

  await expect.poll(() => page.evaluate(() => (window as any).__layoutCaptureData)).toBeGreaterThan(0);
  await page.locator(".composerCaptureButton").click();
  await page.waitForTimeout(700);
  expect(await hitTarget(page, ".composerCaptureCancel")).toBe(true);
  const handoff = await rects(page);
  const firstResolving = page.evaluate(() => new Promise<any>((resolve, reject) => {
    const form = document.querySelector<HTMLElement>("#promptForm")!;
    const timeout = window.setTimeout(() => reject(new Error("resolving phase not observed")), 2_000);
    const observer = new MutationObserver(() => {
      if (form.dataset.capturePhase !== "resolving") return;
      observer.disconnect(); window.clearTimeout(timeout);
      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const queue = document.querySelector("#queueToggle")!, send = document.querySelector("#primaryButton")!;
      resolve({
        model: rect("#modelControl").toJSON(), queue: rect("#queueToggle").toJSON(), send: rect("#primaryButton").toJSON(),
        queueCssWidth: getComputedStyle(queue).width, sendCssWidth: getComputedStyle(send).width,
        actionWidth: getComputedStyle(form).getPropertyValue("--capture-chrome-action-width").trim(),
        queueWidthFrames: queue.getAnimations().flatMap((animation) =>
          (animation.effect as KeyframeEffect).getKeyframes().map((frame) => frame.width).filter(Boolean)),
      });
    });
    observer.observe(form, { attributes: true, attributeFilter: ["data-capture-phase"] });
  }));
  release();
  const first = await firstResolving;
  expect(Math.abs(first.model.width - handoff.model.width)).toBeLessThanOrEqual(.5);
  expect(Math.abs(first.model.x - handoff.model.x)).toBeLessThanOrEqual(1);
  expect(first.actionWidth).toBe("44px");
  expect(first.queueWidthFrames).toContain("0px");
  expect(first.queueWidthFrames).toContain("44px");
  expect(first.queue.width).toBeLessThanOrEqual(2);
  expect(first.send.width).toBeLessThanOrEqual(2);

  await expect(page.locator("#promptForm")).toHaveAttribute("data-capture-phase", "idle");
  await expect(page.locator("#promptForm")).not.toHaveAttribute("data-capture-chrome", /.+/, { timeout: 2_000 });
  const final = await rects(page);
  expect(final.footer.height).toBe(44);
  expect(final.queue.width).toBe(44);
  expect(final.send.width).toBe(44);
  expect(final.inputs.width).toBe(44);
  expect(final.footerPosition).toBe("static");
  expect(final.footerInlineHeight).toBe("");
  expect(final.form.height).toBeGreaterThanOrEqual(98);
});
