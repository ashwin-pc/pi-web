import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { streamingMarkdownFixtureBlocks } from "../../server/mock.js";

type Variant = "plain" | "batched";
type Profile = "paced" | "bursty";
type BrowserMetrics = {
  elapsedMs: number;
  firstDomMutationMs: number | null;
  firstReceivedDeltaMs: number | null;
  firstAssistantOutputMs: number | null;
  firstFormattedContentMs: number | null;
  lastMutationMs: number | null;
  mutationCallbacks: number;
  mutationRecords: number;
  addedNodes: number;
  characterDataRecords: number;
  markdownSnapshots: number;
  maxFrameGapMs: number;
  p95FrameGapMs: number;
  longTasks: { duration: number; startTime: number }[];
};

declare global {
  interface Window {
    __PI_WEB_STREAMING_MARKDOWN_TEST_OPTIONS__?: { streamingMarkdown?: boolean; streamingBatchMs?: number };
    __streamFirstDeltaAt?: number;
    __streamBench?: {
      start: number;
      firstMutation: number | null;
      firstAssistant: number | null;
      firstFormatted: number | null;
      lastMutation: number | null;
      callbacks: number;
      records: number;
      addedNodes: number;
      characterData: number;
      markdownSnapshots: number;
      frames: number[];
      longTasks: { duration: number; startTime: number }[];
      stop(): BrowserMetrics;
    };
  }
}

async function configureVariant(page: Page, variant: Variant) {
  await page.addInitScript((enabled) => {
    globalThis.__PI_WEB_STREAMING_MARKDOWN_TEST_OPTIONS__ = { streamingMarkdown: enabled, streamingBatchMs: 75 };
    const NativeWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = class extends NativeWebSocket {
      constructor(...args: any[]) {
        super(...args as [string | URL, (string | string[])?]);
        this.addEventListener("message", (event) => {
          try {
            const raw = String(event.data);
            JSON.parse(raw);
            if (raw.includes('"message_update"') && raw.includes('"text_delta"')) globalThis.__streamFirstDeltaAt ??= performance.now();
          } catch { /* non-JSON frame */ }
        });
      }
    } as typeof WebSocket;
  }, variant === "batched");
}

async function startMetrics(page: Page) {
  await page.evaluate(() => {
    const root = document.querySelector("#messages");
    if (!root) throw new Error("messages root missing");
    globalThis.__streamFirstDeltaAt = undefined;
    const existingAssistantBodies = new Set(document.querySelectorAll(".message.assistant .body"));
    const state = {
      start: performance.now(), firstMutation: null as number | null, firstAssistant: null as number | null,
      firstFormatted: null as number | null, lastMutation: null as number | null,
      callbacks: 0, records: 0, addedNodes: 0, characterData: 0, markdownSnapshots: 0,
      frames: [] as number[], longTasks: [] as { duration: number; startTime: number }[], stopped: false,
    };
    const mutations = new MutationObserver((records) => {
      const now = performance.now();
      state.firstMutation ??= now;
      state.lastMutation = now;
      state.callbacks += 1;
      state.records += records.length;
      state.addedNodes += records.reduce((sum, record) => sum + record.addedNodes.length, 0);
      state.characterData += records.filter((record) => record.type === "characterData").length;
      if (document.querySelector(".message.assistant .body.markdownBody:not([data-markdown-rendered])")) state.markdownSnapshots += 1;
      const liveAssistant = Array.from(document.querySelectorAll<HTMLElement>(".message.assistant .body")).find((body) => !existingAssistantBodies.has(body));
      if (liveAssistant?.textContent?.trim()) state.firstAssistant ??= now;
      if (liveAssistant?.querySelector("h1,h2,strong,pre,table,a")) state.firstFormatted ??= now;
    });
    mutations.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class", "data-markdown-rendered"] });
    let previous = performance.now();
    const frame = (now: number) => { state.frames.push(now - previous); previous = now; if (!state.stopped) requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
    const longTaskObserver = typeof PerformanceObserver === "function" ? new PerformanceObserver((list) => {
      state.longTasks.push(...list.getEntries().map((entry) => ({ duration: entry.duration, startTime: entry.startTime })));
    }) : null;
    try { longTaskObserver?.observe({ type: "longtask", buffered: true }); } catch { /* unsupported */ }
    window.__streamBench = { ...state, stop: () => {
      state.stopped = true; mutations.disconnect(); longTaskObserver?.disconnect();
      const sortedFrames = [...state.frames].sort((a, b) => a - b);
      return {
        elapsedMs: performance.now() - state.start,
        firstDomMutationMs: state.firstMutation === null ? null : state.firstMutation - state.start,
        firstReceivedDeltaMs: globalThis.__streamFirstDeltaAt === undefined ? null : globalThis.__streamFirstDeltaAt - state.start,
        firstAssistantOutputMs: state.firstAssistant === null ? null : state.firstAssistant - state.start,
        firstFormattedContentMs: state.firstFormatted === null ? null : state.firstFormatted - state.start,
        lastMutationMs: state.lastMutation === null ? null : state.lastMutation - state.start,
        mutationCallbacks: state.callbacks, mutationRecords: state.records, addedNodes: state.addedNodes,
        characterDataRecords: state.characterData, markdownSnapshots: state.markdownSnapshots,
        maxFrameGapMs: sortedFrames.at(-1) || 0,
        p95FrameGapMs: sortedFrames[Math.floor(sortedFrames.length * 0.95)] || 0,
        longTasks: state.longTasks.filter((entry) => entry.startTime >= state.start),
      };
    } };
  });
}

async function runStream(page: Page, profile: Profile, suffix = "") {
  await expect(page.locator("#prompt")).toBeVisible();
  await startMetrics(page);
  await page.locator("#prompt").fill(`streaming markdown benchmark ${profile} ${suffix}`);
  await page.locator("#primaryButton").click();
  await expect(page.locator("#stopButton")).toBeVisible();
  await expect(page.locator("#stopButton")).toBeHidden({ timeout: 20_000 });
  await expect(page.locator(".message.assistant", { hasText: "Final line confirms" })).toBeVisible();
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  return page.evaluate(() => window.__streamBench!.stop());
}

async function assertFinalConversation(page: Page) {
  const joined = (await page.locator(".message.assistant .body").allTextContents()).join("\n");
  expect(joined).toContain("This deliberately long response mixes strong emphasis");
  expect(joined).toContain("Final line confirms every pending batch is flushed before settlement.");
  expect(joined).toContain("Item 12: a paced or bursty fragment");
  expect(streamingMarkdownFixtureBlocks[0].length + streamingMarkdownFixtureBlocks[1].length).toBeGreaterThan(5_000);
  await expect(page.locator(".message.assistant h1", { hasText: "Streaming renderer benchmark" })).toHaveCount(1);
  expect(await page.locator(".message.assistant table").count()).toBeGreaterThanOrEqual(1);
  await expect(page.locator(".message.assistant pre code.language-ts", { hasText: "accumulate" })).toHaveCount(1);
  const benchmarkMessages = page.locator("#messages > .message.assistant").filter({ hasText: /Streaming renderer benchmark|After the tool call/ });
  await expect(benchmarkMessages).toHaveCount(2);
  await expect(benchmarkMessages.nth(0)).toContainText("Streaming renderer benchmark");
  await expect(benchmarkMessages.nth(1)).toContainText("After the tool call");
  await expect(page.locator(".toolCard", { hasText: "read" })).toBeVisible();
  const diagram = page.locator(".message.assistant .mermaidDiagram");
  await diagram.scrollIntoViewIfNeeded();
  await expect(diagram.locator(":scope > svg")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".message.assistant .htmlPreview iframe").contentFrame().locator(".ok")).toHaveText("Sandboxed preview");
  expect(await page.evaluate(() => (globalThis as typeof globalThis & { __streamingUnsafe?: boolean }).__streamingUnsafe)).not.toBe(true);
  await expect(page.locator(".message.assistant script")).toHaveCount(0);
}

for (const variant of ["plain", "batched"] as const) {
  for (const profile of ["paced", "bursty"] as const) {
    test(`${variant} ${profile} stream settles to the complete rich markdown transcript`, async ({ page }) => {
      await configureVariant(page, variant);
      await page.request.post("/api/mock/reset");
      await page.goto("/");
      const metrics = await runStream(page, profile);
      await assertFinalConversation(page);
      expect(metrics.mutationCallbacks).toBeGreaterThan(0);
      expect(metrics.elapsedMs).toBeLessThan(20_000);
      if (variant === "batched") expect(metrics.markdownSnapshots).toBeGreaterThan(0);
      else expect(metrics.markdownSnapshots).toBe(0);
    });
  }
}

test("batched streaming preserves scroll-away intent and a selection in stable content", async ({ page }) => {
  await configureVariant(page, "batched");
  await page.request.post("/api/mock/reset");
  await page.goto("/");
  await page.locator("#prompt").fill("streaming markdown benchmark paced");
  await page.locator("#primaryButton").click();
  const stableText = page.locator(".message.assistant p", { hasText: "This deliberately long response" });
  await expect(stableText).toContainText("avoid executing unsafe markup", { timeout: 10_000 });
  const messages = page.locator("#messages");
  // An upward gesture on content that cannot scroll is intentionally a no-op.
  // Wait until this test can exercise real scroll-away intent on tall viewports.
  await expect.poll(() => messages.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(1);
  await messages.dispatchEvent("wheel", { deltaY: -600 });
  await stableText.evaluate((element) => {
    const node = element.firstChild;
    if (!node) throw new Error("selection text missing");
    const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, Math.min(24, node.textContent?.length || 0));
    const selection = getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    (globalThis as typeof globalThis & { __selectedStableParagraph?: Element }).__selectedStableParagraph = element;
  });
  const selected = await page.evaluate(() => getSelection()?.toString() || "");
  await expect(page.locator(".message.assistant", { hasText: "Paragraph 8 explains" })).toBeVisible({ timeout: 10_000 });
  expect(await page.evaluate(() => ({
    text: getSelection()?.toString() || "",
    sameNode: (globalThis as typeof globalThis & { __selectedStableParagraph?: Element }).__selectedStableParagraph?.isConnected === true,
  }))).toEqual({ text: selected, sameNode: true });
  await expect(page.locator(".jumpToLatestButton")).toBeVisible();
  await expect(page.locator("#stopButton")).toBeHidden({ timeout: 20_000 });
});

test("adjacent content indexes retain distinct assistant bodies without a tool boundary", async ({ page }) => {
  await configureVariant(page, "batched");
  await page.request.post("/api/mock/reset");
  await page.goto("/");
  await page.locator("#prompt").fill("streaming markdown adjacent indexes");
  await page.locator("#primaryButton").click();
  await expect(page.locator("#stopButton")).toBeHidden({ timeout: 10_000 });
  const blocks = page.locator("#messages > .message.assistant").filter({ hasText: /Adjacent block (zero|one)/ });
  await expect(blocks).toHaveCount(2);
  await expect(blocks.nth(0)).toContainText("First independent buffer");
  await expect(blocks.nth(0)).not.toContainText("Second independent buffer");
  await expect(blocks.nth(1)).toContainText("Second independent buffer");
});

test("live prefixes stay sanitized and resolve late references before settlement", async ({ page }) => {
  await configureVariant(page, "batched");
  await page.request.post("/api/mock/reset");
  await page.goto("/");
  await page.locator("#prompt").fill("streaming markdown benchmark paced interaction pause");
  await page.locator("#primaryButton").click();
  const live = page.locator(".message.assistant .body.markdownBody:not([data-markdown-rendered])").first();
  await expect(live.locator("table")).toBeVisible({ timeout: 15_000 });
  await expect(live.locator("code.language-ts")).toContainText("accumulate");
  await expect(live.locator('a[href="https://example.com/streaming"]')).toHaveText("reference link");
  await expect(live.locator("script")).toHaveCount(0);
  expect(await page.evaluate(() => (globalThis as typeof globalThis & { __streamingUnsafe?: boolean }).__streamingUnsafe)).not.toBe(true);
  await expect(page.locator("#stopButton")).toBeHidden({ timeout: 20_000 });
});

test("message_end flushes an unterminated batch and separates the next assistant round", async ({ page }) => {
  await configureVariant(page, "batched");
  await page.request.post("/api/mock/reset");
  await page.goto("/");
  await page.evaluate(() => {
    const state = globalThis as typeof globalThis & { __sawErrorBoundaryPrefix?: boolean };
    new MutationObserver(() => {
      if (document.querySelector("#messages")?.textContent?.includes("Pending text immediately before an error boundary")) state.__sawErrorBoundaryPrefix = true;
    }).observe(document.querySelector("#messages")!, { subtree: true, childList: true, characterData: true });
  });
  await page.locator("#prompt").fill("streaming markdown boundaries");
  await page.locator("#primaryButton").click();
  await expect(page.locator("#stopButton")).toBeHidden({ timeout: 10_000 });
  const first = page.locator(".message.assistant", { hasText: "First round without text_end" });
  const second = page.locator(".message.assistant", { hasText: "Second round" });
  await expect(first).toHaveCount(1);
  await expect(second).toHaveCount(1);
  await expect(first.locator("strong")).toHaveText("Markdown prefix");
  await expect(second.locator("h2")).toHaveText("Second round");
  await expect(page.getByText("Synthetic boundary error", { exact: false })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (globalThis as typeof globalThis & { __sawErrorBoundaryPrefix?: boolean }).__sawErrorBoundaryPrefix)).toBe(true);
});

test("diagnostic alternating A/B browser benchmark", async ({ page, browserName }) => {
  test.skip(process.env.PI_WEB_STREAMING_MARKDOWN_BENCHMARK !== "1", "manual diagnostic benchmark");
  test.skip(browserName !== "chromium", "Chromium metrics benchmark");
  await page.addInitScript(() => {
    globalThis.__PI_WEB_STREAMING_MARKDOWN_TEST_OPTIONS__ = { streamingMarkdown: !location.search.includes("streamBaseline=1"), streamingBatchMs: 75 };
    const NativeWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = class extends NativeWebSocket {
      constructor(...args: any[]) {
        super(...args as [string | URL, (string | string[])?]);
        this.addEventListener("message", (event) => {
          try {
            const raw = String(event.data);
            JSON.parse(raw);
            if (raw.includes('"message_update"') && raw.includes('"text_delta"')) globalThis.__streamFirstDeltaAt ??= performance.now();
          } catch { /* non-JSON frame */ }
        });
      }
    } as typeof WebSocket;
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const trials: Array<Record<string, unknown>> = [];
  const repeats = Math.max(2, Number(process.env.PI_WEB_STREAMING_MARKDOWN_REPEATS || 6));
  for (let index = 0; index < repeats * 2; index += 1) {
    const variant: Variant = index % 2 === 0 ? "plain" : "batched";
    const profile: Profile = Math.floor(index / 2) % 2 === 0 ? "paced" : "bursty";
    const stress = profile === "bursty";
    await page.request.post("/api/mock/reset");
    await page.goto(variant === "plain" ? "/?streamBaseline=1" : "/?streamBaseline=0");
    const before = await cdp.send("Performance.getMetrics");
    const metrics = await runStream(page, profile, stress ? "large stress" : "");
    const after = await cdp.send("Performance.getMetrics");
    const values = (response: typeof before) => Object.fromEntries(response.metrics.map(({ name, value }) => [name, value]));
    const a = values(after); const b = values(before);
    const costs = Object.fromEntries(["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration"].map((name) => [name, (a[name] || 0) - (b[name] || 0)]));
    trials.push({ index, variant, profile, stress, ...metrics, browserCostsSeconds: costs });
    await assertFinalConversation(page);
  }
  const outputDir = resolve(".pi/web/artifacts/streaming-markdown");
  await mkdir(outputDir, { recursive: true });
  await writeFile(resolve(outputDir, "raw-results.json"), JSON.stringify({ generatedAt: new Date().toISOString(), repeats, trials }, null, 2));
  expect(trials).toHaveLength(repeats * 2);
});
