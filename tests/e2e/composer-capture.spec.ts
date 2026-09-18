import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type CaptureHarness = {
  setPermissionMode(mode: "immediate" | "pending"): void;
  resolvePermission(): void;
  tracksStopped: number;
  dataEvents: number;
};

const contribution = {
  version: 1,
  key: "test.dictation",
  slot: "composer-input",
  kind: "capture",
  title: "Dictate test audio",
  label: "Dictation",
  icon: "mic",
  capture: { media: "audio", maxSeconds: 10, maxBytes: 25_000_000, mimeTypes: ["audio/webm"], registrationId: "00000000-0000-4000-8000-000000000001" },
};

async function installAudioCaptureHarness(page: Page) {
  await page.addInitScript(() => {
    type Deferred = { stream: MediaStream; resolve: (stream: MediaStream) => void };
    let permissionMode: "immediate" | "pending" = "immediate";
    let deferred: Deferred | undefined;
    const harness: CaptureHarness = {
      tracksStopped: 0,
      dataEvents: 0,
      setPermissionMode(mode) { permissionMode = mode; },
      resolvePermission() {
        if (!deferred) throw new Error("No microphone permission request is pending");
        deferred.resolve(deferred.stream);
        deferred = undefined;
      },
    };

    async function audioStream() {
      const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
      const context = new AudioContextCtor();
      await context.resume();
      const oscillator = context.createOscillator();
      const destination = context.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      const stream = destination.stream;
      for (const track of stream.getTracks()) {
        const stop = track.stop.bind(track);
        track.stop = () => {
          harness.tracksStopped += 1;
          stop();
          oscillator.stop();
          void context.close();
        };
      }
      return stream;
    }

    const NativeMediaRecorder = window.MediaRecorder;
    class ObservedMediaRecorder extends NativeMediaRecorder {
      constructor(stream: MediaStream, options?: MediaRecorderOptions) {
        super(stream, options);
        this.addEventListener("dataavailable", (event) => {
          if (event.data.size > 0) harness.dataEvents += 1;
        });
      }
    }
    Object.defineProperty(window, "MediaRecorder", { configurable: true, value: ObservedMediaRecorder });

    const mediaDevices = navigator.mediaDevices || {} as MediaDevices;
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: mediaDevices });
    Object.defineProperty(mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        const stream = await audioStream();
        if (permissionMode === "immediate") return stream;
        return await new Promise<MediaStream>((resolve) => { deferred = { stream, resolve }; });
      },
    });
    (window as any).__captureHarness = harness;
  });
}

async function prepare(page: Page) {
  await page.request.post("/api/mock/reset");
  await page.routeWebSocket("**/ws**", () => {
    // Keep each test on its routed REST snapshot; replayed global mock events can
    // otherwise replace the synthetic contribution from an earlier test.
  });
  await page.route("**/api/state**", async (route) => {
    const response = await route.fetch();
    const state = await response.json();
    state.webContributions = [contribution];
    await route.fulfill({ response, json: state });
  });
  await installAudioCaptureHarness(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: contribution.title })).toBeVisible();
}

async function startRecording(page: Page) {
  const button = page.locator(".composerCaptureButton");
  await button.focus();
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect(button).toHaveAccessibleName("Stop Dictation");
  return button;
}

async function stopAfterRecorderData(page: Page) {
  const button = page.locator(".composerCaptureButton");
  const originalButton = await button.elementHandle();
  if (!originalButton) throw new Error("Capture stop button was not rendered");
  await page.waitForTimeout(1_100);
  await expect.poll(() => page.evaluate(() => (window as any).__captureHarness.dataEvents), { timeout: 5_000 }).toBeGreaterThan(0);
  expect(await originalButton.evaluate((element) => element.isConnected && element === document.querySelector(".composerCaptureButton"))).toBe(true);
  await button.click();
}

function fulfillUpload(route: Route) {
  return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ ok: true, captureId: "capture-1" }) });
}

test.beforeEach(async ({ page }) => {
  await prepare(page);
});

test("renders recording and processing strokes with the approved warm palette", async ({ page }) => {
  let releaseInvocation!: () => void;
  const invocationGate = new Promise<void>((resolve) => { releaseInvocation = resolve; });
  await page.route("**/api/web-captures?**", fulfillUpload);
  await page.route("**/api/web-contributions/invoke", async (route) => {
    await invocationGate;
    await route.fulfill({ json: { ok: true, effects: [] } });
  });

  const approvedGold = { red: 0xd3, green: 0xae, blue: 0x75 };
  const approvedText = { red: 0xf0, green: 0xd9, blue: 0xae };
  const canvas = page.locator(".composerCaptureVisual");
  const countPalettePixels = (target: { red: number; green: number; blue: number }) => canvas.evaluate((element, color) => {
    const rendered = element as HTMLCanvasElement;
    const pixels = rendered.getContext("2d")!.getImageData(0, 0, rendered.width, rendered.height).data;
    let count = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] > 80
        && Math.abs(pixels[index] - color.red) <= 6
        && Math.abs(pixels[index + 1] - color.green) <= 6
        && Math.abs(pixels[index + 2] - color.blue) <= 6) count += 1;
    }
    return count;
  }, target);

  const placeholderOpacity = () => page.locator("#prompt").evaluate((element) => getComputedStyle(element, "::placeholder").opacity);

  await startRecording(page);
  await expect(canvas).toBeVisible();
  await expect.poll(placeholderOpacity).toBe("0");
  await expect.poll(() => countPalettePixels(approvedGold), { message: "recording canvas should contain #d3ae75 pixels" }).toBeGreaterThan(0);

  await stopAfterRecorderData(page);
  await expect(page.locator("#promptForm")).toHaveAttribute("data-capture-phase", "handoff");
  // Processing is a renderer view derived from the handoff clock, not a separate
  // lifecycle phase. Wait beyond the 650ms gather and assert both signal and
  // generated word strokes while the real invocation remains pending.
  await page.waitForTimeout(1_100);
  await expect.poll(placeholderOpacity).toBe("0");
  await expect.poll(() => countPalettePixels(approvedGold), { message: "decode gate should contain #d3ae75 signal pixels" }).toBeGreaterThan(0);
  await expect.poll(() => countPalettePixels(approvedText), { message: "decode gate should contain #f0d9ae word pixels" }).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Cancel transcription" }).click();
  await expect.poll(placeholderOpacity).toBe("1");
  await expect(page.locator("#prompt")).toHaveAttribute("placeholder", "Ask pi…");
  releaseInvocation();
});

test("inserted, typed, and restored text keep the composer expanded without forcing focus", async ({ page }) => {
  await page.route("**/api/web-captures?**", fulfillUpload);
  await page.route("**/api/web-contributions/invoke", (route) => route.fulfill({ json: {
    ok: true,
    effects: [{ type: "insert-composer-text", text: "captured words", placement: "selection" }],
  } }));

  const composer = page.locator("#promptForm");
  const prompt = page.locator("#prompt");
  await startRecording(page);
  await stopAfterRecorderData(page);
  await expect(prompt).toHaveValue("captured words");
  await expect(prompt).not.toBeFocused();
  await expect(composer).not.toHaveClass(/compactInactive/);

  await prompt.fill("manually typed words");
  await prompt.blur();
  await expect(composer).not.toHaveClass(/compactInactive/);

  await page.reload();
  await expect(prompt).toHaveValue("manually typed words");
  await expect(prompt).not.toBeFocused();
  await expect(composer).not.toHaveClass(/compactInactive/);
});

test("result handoff pins the rendered gate while the populated composer expands", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Frame-level transition sampling runs once in the touch layout");
  let releaseInvocation!: () => void;
  const invocationGate = new Promise<void>((resolveGate) => { releaseInvocation = resolveGate; });
  await page.route("**/api/web-captures?**", fulfillUpload);
  await page.route("**/api/web-contributions/invoke", async (route) => {
    await invocationGate;
    await route.fulfill({ json: { ok: true, effects: [{ type: "insert-composer-text", text: "captured result", placement: "selection" }] } });
  });

  const composer = page.locator("#promptForm");
  const canvas = page.locator(".composerCaptureVisual");
  // Use the real pointer behavior: capture controls prevent pointerdown focus.
  // The generic helper intentionally focuses controls for keyboard coverage.
  await page.locator(".composerCaptureButton").click();
  await expect(page.locator(".composerCaptureButton")).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(1_100);
  await expect.poll(() => page.evaluate(() => (window as any).__captureHarness.dataEvents)).toBeGreaterThan(0);
  await page.locator(".composerCaptureButton").click();
  await page.waitForTimeout(700);
  const before = await page.evaluate(() => {
    const rect = (selector: string) => {
      const value = document.querySelector(selector)!.getBoundingClientRect();
      return { x: value.x, y: value.y, width: value.width, height: value.height };
    };
    return { composer: rect("#promptForm"), model: rect("#modelControl"), canvas: rect(".composerCaptureVisual") };
  });
  // Sample every rendered browser frame rather than scheduling a few wall-clock
  // callbacks. Under CI load, delayed timers can all run after the 150ms reveal
  // and falsely report that the intermediate fade never happened.
  const sampling = page.evaluate(() => new Promise<Array<Record<string, any>>>((resolveSamples, reject) => {
    const form = document.querySelector<HTMLElement>("#promptForm")!;
    const prompt = document.querySelector<HTMLTextAreaElement>("#prompt")!;
    const visual = document.querySelector<HTMLCanvasElement>(".composerCaptureVisual")!;
    const model = document.querySelector<HTMLElement>("#modelControl")!;
    const colorSample = document.createElement("canvas");
    colorSample.width = colorSample.height = 1;
    const colorContext = colorSample.getContext("2d")!;
    const rect = (element: Element) => {
      const value = element.getBoundingClientRect();
      return { x: value.x, y: value.y, width: value.width, height: value.height };
    };
    const results: Array<Record<string, any>> = [];
    let startedAt = 0;
    let frame = 0;
    const collect = () => {
      const canvasStyle = getComputedStyle(visual), promptStyle = getComputedStyle(prompt);
      colorContext.clearRect(0, 0, 1, 1);
      colorContext.fillStyle = promptStyle.color;
      colorContext.fillRect(0, 0, 1, 1);
      const transformedAncestors: string[] = [];
      for (let node = visual.parentElement; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.transform !== "none" || style.contain !== "none" || style.filter !== "none") {
          transformedAncestors.push(`${node.id || node.className}:${style.transform}:${style.contain}:${style.filter}`);
        }
      }
      results.push({
        actualMs: performance.now() - startedAt,
        phase: form.dataset.capturePhase || "",
        composer: rect(form), prompt: rect(prompt), canvas: rect(visual), model: rect(model),
        canvasPosition: canvasStyle.position, canvasOpacity: Number(canvasStyle.opacity),
        canvasLeft: canvasStyle.left, canvasTop: canvasStyle.top, canvasRight: canvasStyle.right, canvasBottom: canvasStyle.bottom,
        promptColor: promptStyle.color, promptColorAlpha: colorContext.getImageData(0, 0, 1, 1).data[3]!,
        promptOpacity: Number(promptStyle.opacity), promptFocused: document.activeElement === prompt,
        draft: prompt.value, transformedAncestors,
      });
    };
    const timeout = window.setTimeout(() => {
      cancelAnimationFrame(frame);
      reject(new Error(`Capture resolving did not settle; last phase: ${form.dataset.capturePhase || "missing"}`));
    }, 2_000);
    const observer = new MutationObserver(() => {
      if (form.dataset.capturePhase !== "resolving") return;
      observer.disconnect();
      window.clearTimeout(timeout);
      startedAt = performance.now();
      // Capture the synchronous reveal state before the first animation frame.
      collect();
      const settleTimeout = window.setTimeout(() => {
        cancelAnimationFrame(frame);
        reject(new Error(`Capture resolving did not settle; last phase: ${form.dataset.capturePhase || "missing"}`));
      }, 2_000);
      const settleFrame = () => {
        collect();
        if (form.dataset.capturePhase === "idle") {
          window.clearTimeout(settleTimeout);
          resolveSamples(results);
        } else frame = requestAnimationFrame(settleFrame);
      };
      frame = requestAnimationFrame(settleFrame);
    });
    observer.observe(form, { attributes: true, attributeFilter: ["data-capture-phase"] });
  }));
  releaseInvocation();
  const samples = await sampling;

  const artifactDir = resolve(".pi/web/artifacts/decode-gate");
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(resolve(artifactDir, "handoff-metrics.json"), JSON.stringify({ before, samples }, null, 2));

  const pinned = samples.filter((sample) => sample.phase === "resolving") as Array<any>;
  const first = pinned[0] as any;
  expect(Math.abs(first.model.width - before.model.width)).toBeLessThanOrEqual(.5);
  expect(first.model.width).toBeGreaterThan(80);
  expect(Math.abs(first.model.x - before.model.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(first.model.y - before.model.y)).toBeLessThanOrEqual(1);
  expect(pinned.every((sample) => sample.canvasPosition === "fixed")).toBe(true);
  expect(Math.max(...pinned.map((sample) => sample.canvas.x)) - Math.min(...pinned.map((sample) => sample.canvas.x))).toBeLessThanOrEqual(.5);
  expect(Math.max(...pinned.map((sample) => sample.canvas.y)) - Math.min(...pinned.map((sample) => sample.canvas.y))).toBeLessThanOrEqual(.5);
  expect(pinned.map((sample) => sample.canvasOpacity)).toEqual([...pinned.map((sample) => sample.canvasOpacity)].sort((a, b) => b - a));
  expect(pinned.every((sample) => sample.draft === "captured result" && !sample.promptFocused)).toBe(true);
  const alphas = pinned.map((sample) => sample.promptColorAlpha as number);
  expect(alphas[0]).toBe(0);
  // Prove that text fades through a visible intermediate frame instead of
  // hard-popping from transparent to opaque, independent of frame cadence.
  expect(alphas.some((alpha) => alpha > 0 && alpha < 255)).toBe(true);
  expect(alphas).toEqual([...alphas].sort((a, b) => a - b));
  expect(Math.max(...alphas)).toBeGreaterThanOrEqual(250);
  const heights = samples.map((sample) => sample.composer.height);
  expect(heights).toEqual([...heights].sort((a, b) => a - b));
  expect(samples.at(-1)?.phase).toBe("idle");
  expect(samples.at(-1)?.promptColorAlpha).toBe(255);
  expect(samples.at(-1)?.promptFocused).toBe(false);
});

test("records with MediaRecorder and inserts the transcript into the captured selection without sending", async ({ page }) => {
  let promptRequests = 0;
  let uploadedBytes = 0;
  await page.route("**/api/prompt", async (route) => { promptRequests += 1; await route.continue(); });
  await page.route("**/api/web-captures?**", async (route) => {
    uploadedBytes = route.request().postDataBuffer()?.byteLength || 0;
    await fulfillUpload(route);
  });
  await page.route("**/api/web-contributions/invoke", (route) => route.fulfill({ json: {
    ok: true,
    effects: [{ type: "insert-composer-text", text: "pi", placement: "selection" }],
  } }));

  const prompt = page.locator("#prompt");
  await prompt.fill("hello world");
  await prompt.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(6, 11));
  await startRecording(page);
  await stopAfterRecorderData(page);

  await expect(prompt).toHaveValue("hello pi");
  expect(uploadedBytes).toBeGreaterThan(0);
  expect(promptRequests).toBe(0);
});

test("recovers a transcript without overwriting a draft edited during recording", async ({ page }) => {
  await page.route("**/api/web-captures?**", fulfillUpload);
  await page.route("**/api/web-contributions/invoke", (route) => route.fulfill({ json: {
    ok: true,
    effects: [{ type: "insert-composer-text", text: "recovered words", placement: "selection" }],
  } }));

  const prompt = page.locator("#prompt");
  await prompt.fill("original draft");
  await startRecording(page);
  await prompt.fill("user edit wins");
  await stopAfterRecorderData(page);

  await expect(prompt).toHaveValue("user edit wins");
  await expect(page.locator(".message.system.error").last()).toContainText("Recovered transcript");
  await expect(page.locator(".message.system.error").last()).toContainText("recovered words");
});

test("cancel while microphone permission is pending stops a stream that resolves late", async ({ page }) => {
  await page.evaluate(() => (window as any).__captureHarness.setPermissionMode("pending"));
  const button = page.locator(".composerCaptureButton");
  await button.focus();
  await button.click();
  await expect(page.locator(".composerCaptureStatus")).toHaveText("Microphone…");

  const cancelButton = page.getByRole("button", { name: "Cancel recording" });
  await cancelButton.focus();
  await cancelButton.click();
  await page.evaluate(() => (window as any).__captureHarness.resolvePermission());

  await expect(page.locator(".composerCaptureStatus")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__captureHarness.tracksStopped)).toBe(1);
  await expect(button).toBeEnabled();
});

test("cancel while transcribing aborts the request and ignores a late result", async ({ page }) => {
  let releaseInvocation!: () => void;
  const invocationGate = new Promise<void>((resolve) => { releaseInvocation = resolve; });
  await page.route("**/api/web-captures?**", fulfillUpload);
  await page.route("**/api/web-contributions/invoke", async (route) => {
    await invocationGate;
    try {
      await route.fulfill({ json: {
        ok: true,
        effects: [{ type: "insert-composer-text", text: "late transcript", placement: "selection" }],
      } });
    } catch {
      // The browser normally cancels the intercepted request before the late response is released.
    }
  });

  const prompt = page.locator("#prompt");
  await prompt.fill("keep this draft");
  await startRecording(page);
  await stopAfterRecorderData(page);
  await expect(page.locator(".composerCaptureStatus")).toHaveText("Transcribing…");
  const cancelButton = page.getByRole("button", { name: "Cancel transcription" });
  await cancelButton.focus();
  await cancelButton.click();
  releaseInvocation();

  await expect(page.locator(".composerCaptureStatus")).toHaveCount(0);
  await page.waitForTimeout(100);
  await expect(prompt).toHaveValue("keep this draft");
  await expect(page.locator(".message.system.error", { hasText: "late transcript" })).toHaveCount(0);
});
