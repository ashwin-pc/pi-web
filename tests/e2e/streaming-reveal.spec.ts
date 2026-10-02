import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { nextRealtimeHello } from "./helpers/realtimeReady.js";

async function startRevealFixture(page: Page, prompt = "streaming reveal fixture") {
  await page.request.post("/api/mock/reset");
  await page.goto("/");
  await page.evaluate(() => {
    const seen = new WeakSet<Element>();
    const words: string[] = [];
    const prefixes: string[] = [];
    const record = (element: Element) => {
      if (!element.classList.contains("streamingWordReveal") || seen.has(element)) return;
      seen.add(element);
      const revealText = element.textContent || "";
      words.push(revealText);
      const saveFirstReveal = () => {
        const key = revealText.includes("Rapid") ? "rapid"
          : revealText.includes("steady") ? "steady"
            : revealText.startsWith("Hello") ? "hello"
              : undefined;
        const text = element.firstChild;
        const animation = element.getAnimations()[0];
        const refs = (globalThis as typeof globalThis & {
          __streamingRevealRefs?: Record<string, { paragraph: Element; span: Element; text: ChildNode; animation: Animation; currentTime: number | null }>;
        }).__streamingRevealRefs;
        const paragraph = element.parentElement;
        if (key && text && animation && paragraph && !refs?.[key]) {
          (globalThis as typeof globalThis & {
            __streamingRevealRefs?: Record<string, { paragraph: Element; span: Element; text: ChildNode; animation: Animation; currentTime: number | null }>;
          }).__streamingRevealRefs = { ...refs, [key]: { paragraph, span: element, text, animation, currentTime: animation.currentTime } };
        }
      };
      saveFirstReveal();
      const samples = (globalThis as typeof globalThis & { __streamingRevealSamples?: { text: string; animationDelay: string; opacity: string; animationName: string }[] }).__streamingRevealSamples;
      const sample = () => samples?.push({
        text: element.textContent || "",
        animationDelay: getComputedStyle(element).animationDelay,
        opacity: getComputedStyle(element).opacity,
        animationName: getComputedStyle(element).animationName,
      });
      requestAnimationFrame(() => { saveFirstReveal(); sample(); requestAnimationFrame(sample); });
    };
    new MutationObserver((records) => {
      for (const recordMutation of records) {
        if (recordMutation.type === "attributes") record(recordMutation.target as Element);
        for (const node of recordMutation.addedNodes) {
          if (!(node instanceof Element)) continue;
          record(node);
          node.querySelectorAll(".streamingWordReveal").forEach(record);
        }
        const target = recordMutation.target instanceof Element ? recordMutation.target : recordMutation.target.parentElement;
        const body = target?.closest(".message.assistant .body");
        if (body?.textContent) prefixes.push(body.textContent);
      }
    }).observe(document.querySelector("#messages")!, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    (globalThis as typeof globalThis & { __streamingRevealWords?: string[] }).__streamingRevealWords = words;
    (globalThis as typeof globalThis & { __streamingRevealPrefixes?: string[] }).__streamingRevealPrefixes = prefixes;
    (globalThis as typeof globalThis & {
      __streamingRevealRefs?: Record<string, { paragraph: Element; span: Element; text: ChildNode; animation: Animation; currentTime: number | null }>;
    }).__streamingRevealRefs = {};
    (globalThis as typeof globalThis & { __streamingRevealSamples?: { text: string; animationDelay: string; opacity: string; animationName: string }[] }).__streamingRevealSamples = [];
  });
  await page.locator("#prompt").fill(prompt);
  await page.locator("#primaryButton").click();
  return page.locator(".message.assistant .body").last();
}

test("grapheme continuations retain their live glyph and animation without replaying settled text", async ({ page }) => {
  await page.goto("/");
  const bundle = await build({
    entryPoints: ["src/markdown/streamingReveal.ts"], bundle: true, write: false, format: "iife",
    globalName: "__graphemeReveal", platform: "browser",
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const results = await page.evaluate(async () => {
    const factory = (window as typeof window & { __graphemeReveal: typeof import("../../src/markdown/streamingReveal.js") }).__graphemeReveal;
    const cases = [["e", "e\u0301"], ["👨", "👨‍👩", "👨‍👩‍👧‍👦"], ["👍", "👍🏽"], ["❤", "❤️"], ["🇺", "🇺🇸"], ["\uD83D", "😀"]];
    const outcomes = [];
    for (const [first, ...continuations] of cases) {
      const body = document.createElement("div");
      document.body.append(body);
      const reveal = factory.createStreamingReveal();
      const render = (value: string) => {
        const fragment = document.createDocumentFragment();
        fragment.append(document.createTextNode(value));
        reveal.render(body, fragment);
      };
      render(first);
      const pendingSurrogateText = body.textContent;
      const span = body.querySelector(".streamingWordReveal");
      const text = span?.firstChild;
      const animation = span?.getAnimations()[0];
      animation?.pause();
      const steps = [];
      for (const value of continuations) {
        render(value);
        steps.push({ value, actual: body.textContent, sameSpan: span === body.querySelector(".streamingWordReveal"),
          sameText: text === span?.firstChild, sameAnimation: animation === span?.getAnimations()[0],
          count: body.querySelectorAll(".streamingWordReveal").length });
      }
      (body.querySelector(".streamingWordReveal"))?.dispatchEvent(new Event("animationend"));
      render(`${continuations.at(-1)} word`);
      const settledText = body.textContent;
      const newFade = [...body.querySelectorAll(".streamingWordReveal")].map(node => node.textContent);
      const oldSpanGone = !span?.isConnected;
      body.remove();
      const settledBody = document.createElement("div");
      document.body.append(settledBody);
      const settledReveal = factory.createStreamingReveal();
      const settledRender = (value: string) => {
        const fragment = document.createDocumentFragment();
        fragment.append(document.createTextNode(value));
        settledReveal.render(settledBody, fragment);
      };
      settledRender(first);
      const firstSpan = settledBody.querySelector(".streamingWordReveal");
      firstSpan?.dispatchEvent(new Event("animationend"));
      const settledNode = settledBody.firstChild;
      const selection = window.getSelection()!;
      if (settledNode instanceof Text && settledNode.length) {
        selection.setBaseAndExtent(settledNode, 0, settledNode, settledNode.length);
      }
      for (const value of continuations) settledRender(value);
      const settled: { actual: string | null; sameNode: boolean; fades: number; selection: string; finalMalformedCodeUnit?: number } = { actual: settledBody.textContent, sameNode: settledNode === settledBody.firstChild,
        fades: settledBody.querySelectorAll(".streamingWordReveal").length,
        selection: selection.toString() };
      selection.removeAllRanges();
      if (first === "\uD83D") {
        const incomplete = document.createElement("div");
        document.body.append(incomplete);
        const unfinished = factory.createStreamingReveal();
        const fragment = document.createDocumentFragment();
        fragment.append(document.createTextNode(first));
        unfinished.render(incomplete, fragment);
        unfinished.finish(incomplete);
        settled.finalMalformedCodeUnit = incomplete.textContent?.charCodeAt(0);
        incomplete.remove();
      }
      outcomes.push({ first, pendingSurrogateText, steps, settledText, newFade, oldSpanGone, settled });
      settledBody.remove();
    }
    return outcomes;
  });
  for (const outcome of results) {
    if (outcome.first === "\uD83D") expect(outcome.pendingSurrogateText).toBe("");
    for (const step of outcome.steps) {
      expect(step.actual).toBe(step.value);
      if (outcome.first !== "\uD83D") {
        expect(step.sameSpan).toBe(true);
        expect(step.sameText).toBe(true);
        expect(step.sameAnimation).toBe(true);
        expect(step.count).toBe(1);
      }
    }
    expect(outcome.settledText).toBe(`${outcome.steps.at(-1)?.value} word`);
    expect(outcome.newFade).toEqual([" word"]);
    expect(outcome.oldSpanGone).toBe(true);
    expect(outcome.settled.actual).toBe(outcome.steps.at(-1)?.value);
    if (outcome.first !== "\uD83D") {
      expect(outcome.settled.sameNode).toBe(true);
      expect(outcome.settled.fades).toBe(0);
      expect(outcome.settled.selection).toBe(outcome.steps.at(-1)?.value);
    } else expect(outcome.settled.finalMalformedCodeUnit).toBe(0xD83D);
  }
});

function revealTexts(page: Page) {
  return page.locator(".streamingWordReveal").allTextContents();
}

for (const [label, first, continuation] of [["acute", "e", "\u0301"], ["family", "👨", "‍👩‍👧‍👦"], ["surrogate", "\uD83D", "\uDE00"]]) {
  test(`real Markdown stream keeps ${label} in its paragraph through finalization`, async ({ page }) => {
    await page.request.post("/api/mock/reset");
    const hello = nextRealtimeHello(page);
    await page.goto("/");
    await hello;
    const publish = async (event: Record<string, unknown>) => {
      const response = await page.request.post("/api/mock/event", { data: { type: "agent_event", sessionId: "mock-current", event } });
      expect(response.ok()).toBe(true);
    };
    if (first !== "\uD83D") {
      await page.evaluate(value => {
        const observer = new MutationObserver(() => {
          const span = [...document.querySelectorAll(".message.assistant p .streamingWordReveal")].find(node => node.textContent === value);
          if (!span) return;
          (window as typeof window & { __graphemeApp?: { paragraph: Element; span: Element; text: ChildNode; animation?: Animation } }).__graphemeApp =
            { paragraph: span.parentElement!, span, text: span.firstChild!, animation: span.getAnimations()[0] };
          observer.disconnect();
        });
        observer.observe(document.body, { childList: true, subtree: true });
      }, first);
    }
    await publish({ type: "agent_start" });
    await publish({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
    await publish({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: first } });
    const body = page.locator(".message.assistant .body").last();
    if (first !== "\uD83D") {
      await page.waitForFunction(() => Boolean((window as typeof window & { __graphemeApp?: unknown }).__graphemeApp));
    } else {
      // An empty paragraph proves the batch rendered without exposing a lone surrogate.
      await expect(body.locator("p")).toHaveCount(1);
      await expect(body.locator("p")).toHaveText("");
    }
    await publish({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: continuation } });
    const complete = first + continuation;
    await expect(body.locator("p")).toHaveText(complete);
    if (first !== "\uD83D") {
      expect(await body.evaluate(element => {
        const saved = (window as typeof window & { __graphemeApp?: { paragraph: Element; span: Element; text: ChildNode; animation?: Animation } }).__graphemeApp!;
        const spans = element.querySelectorAll(".streamingWordReveal");
        return saved.paragraph.isConnected && saved.paragraph === element.querySelector("p")
          && (saved.span.isConnected
            ? spans.length === 1 && spans[0] === saved.span && saved.span.firstChild === saved.text && saved.span.getAnimations()[0] === saved.animation
            : spans.length === 0 && saved.text.parentElement === saved.paragraph);
      })).toBe(true);
    }
    await publish({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: complete } });
    await expect(body.locator("p")).toHaveText(complete);
    await expect(body.locator(".streamingWordReveal")).toHaveCount(0);
    // Mock events aren't durable history; settling can replace them with the server snapshot.
    await publish({ type: "agent_settled" });
    await expect(page.locator("#stopButton")).toBeHidden();
  });
}

test("nested Markdown nodes restore a withheld surrogate after unchanged reparses and finalization", async ({ page }) => {
  await page.goto("/");
  const bundle = await build({ entryPoints: ["src/markdown/streamingReveal.ts"], bundle: true, write: false, format: "iife", globalName: "__graphemeReveal", platform: "browser" });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(() => {
    const factory = (window as typeof window & { __graphemeReveal: typeof import("../../src/markdown/streamingReveal.js") }).__graphemeReveal;
    const body = document.createElement("div");
    document.body.append(body);
    const reveal = factory.createStreamingReveal();
    const render = (last: string) => {
      const fragment = document.createDocumentFragment();
      const stable = document.createElement("p");
      stable.textContent = "Stable";
      const changing = document.createElement("p");
      changing.append(document.createTextNode(last));
      fragment.append(stable, changing);
      reveal.render(body, fragment);
    };
    render("\uD83D");
    const first = body.textContent;
    const stableNode = body.firstChild;
    const decoration = document.createElement("button");
    decoration.textContent = "Preview";
    stableNode?.appendChild(decoration);
    render("\uD83D");
    const repeated = body.textContent;
    reveal.finish(body);
    const finalText = body.textContent;
    const finalCodeUnit = body.lastChild?.textContent?.charCodeAt(0);
    const stablePreserved = stableNode === body.firstChild && decoration.parentNode === stableNode;
    body.remove();
    return { first, repeated, finalText, finalCodeUnit, stablePreserved };
  });
  expect(result).toEqual({ first: "Stable", repeated: "StablePreview", finalText: "StablePreview\uD83D", finalCodeUnit: 0xD83D, stablePreserved: true });
});

test("live words gently fade once, remain settled through Markdown reconciliation, and clean up at finalization", async ({ page }) => {
  const body = await startRevealFixture(page);
  await expect.poll(() => page.evaluate(() => (globalThis as typeof globalThis & {
    __streamingRevealSamples?: { text: string; opacity: string; animationName: string }[];
  }).__streamingRevealSamples || [])).toContainEqual(expect.objectContaining({
    text: expect.stringContaining("Hello"), animationName: expect.stringContaining("streamingWordFade"),
  }));
  const helloSamples = await page.evaluate(() => (globalThis as typeof globalThis & {
    __streamingRevealSamples?: { text: string; opacity: string; animationName: string }[];
  }).__streamingRevealSamples || []).then((samples) => samples.filter((sample) => sample.text.includes("Hello")));
  const helloOpacities = helloSamples.map((sample) => Number(sample.opacity));
  expect(helloOpacities.some((opacity) => opacity >= 0 && opacity < 1)).toBe(true);

  // The observer retains the brief incomplete-inline render without depending
  // on a test-side wait landing inside that streaming interval.
  await expect.poll(() => page.evaluate(() => (globalThis as typeof globalThis & {
    __streamingRevealPrefixes?: string[];
  }).__streamingRevealPrefixes || [])).toContainEqual(expect.stringContaining("Hello **bold"));

  // Closing **bold** reparses the paragraph. Old words must not get a second
  // reveal while the genuinely appended "world" tail is allowed to reveal.
  await expect(body).toContainText("Hello bold world", { timeout: 2_000 });
  await expect.poll(() => page.evaluate(() => (globalThis as typeof globalThis & { __streamingRevealWords?: string[] }).__streamingRevealWords || [])).toContainEqual(expect.stringContaining("world"));
  expect((await revealTexts(page)).join("")).not.toContain("Hello");
  expect((await revealTexts(page)).join("")).not.toContain("bold");

  await expect(page.locator("#stopButton")).toBeHidden({ timeout: 5_000 });
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  await expect(body.locator("strong")).toHaveText("bold");
  await expect(body).toContainText("Hello bold world");
  await expect(body).toContainText("Final tail.");
  await expect(body.locator(".streamingWordReveal")).toHaveCount(0);
});

test("a 120ms rapid tail delta preserves the live paragraph, text, span, and animation", async ({ page }) => {
  const body = await startRevealFixture(page, "streaming reveal rapid");
  await expect(body).toContainText("Rapid");
  await expect.poll(() => page.evaluate(() => Boolean((globalThis as typeof globalThis & {
    __streamingRevealRefs?: Record<string, unknown>;
  }).__streamingRevealRefs?.rapid))).toBe(true);

  // The mock's second delta arrives 120ms later, before the 350ms fade ends.
  await expect(body).toContainText("Rapid update");
  await expect.poll(() => page.evaluate(() => {
    const saved = (globalThis as typeof globalThis & {
      __streamingRevealRefs?: Record<string, { paragraph: Element; span: Element; text: ChildNode; animation: Animation; currentTime: number | null }>;
    }).__streamingRevealRefs?.rapid;
    if (!saved) return false;
    const current = saved.span.getAnimations()[0];
    return saved.paragraph.isConnected
      && saved.span.isConnected
      && saved.text.isConnected
      && saved.span.parentElement === saved.paragraph
      && saved.span.firstChild === saved.text
      && current === saved.animation
      && (saved.currentTime === null || current.currentTime === null || current.currentTime > saved.currentTime);
  })).toBe(true);

  // The saved nodes remain attached while their original fade can still run.
  expect(await page.evaluate(() => {
    const saved = (globalThis as typeof globalThis & {
      __streamingRevealRefs?: Record<string, { paragraph: Element; span: Element; text: ChildNode; animation: Animation }>;
    }).__streamingRevealRefs?.rapid;
    return Boolean(saved?.paragraph.isConnected && saved.span.isConnected && saved.text.isConnected);
  })).toBe(true);
  await expect(page.locator("#stopButton")).toBeHidden({ timeout: 5_000 });
  await expect(body.locator(".streamingWordReveal")).toHaveCount(0);
});

test("an append-only paragraph stays first when a later duplicate paragraph appears", async ({ page }) => {
  const body = await startRevealFixture(page, "streaming reveal duplicate");
  await expect.poll(() => page.evaluate(() => Boolean((globalThis as typeof globalThis & {
    __streamingRevealRefs?: Record<string, unknown>;
  }).__streamingRevealRefs?.hello))).toBe(true);

  await expect(body.locator("p")).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => {
    const saved = (globalThis as typeof globalThis & {
      __streamingRevealRefs?: Record<string, { paragraph: Element; span: Element; text: ChildNode; animation: Animation; currentTime: number | null }>;
    }).__streamingRevealRefs?.hello;
    if (!saved) return false;
    const bodies = document.querySelectorAll(".message.assistant .body");
    const paragraphs = bodies[bodies.length - 1]?.querySelectorAll("p");
    const current = saved.span.getAnimations()[0];
    return paragraphs?.[0] === saved.paragraph
      && paragraphs[1] !== saved.paragraph
      && paragraphs[1].textContent === "Hello"
      && saved.span.isConnected
      && saved.text.isConnected
      && saved.span.firstChild === saved.text
      && current === saved.animation
      && (saved.currentTime === null || current.currentTime === null || current.currentTime > saved.currentTime);
  })).toBe(true);
  await expect(page.locator("#stopButton")).toBeHidden({ timeout: 5_000 });
  await expect(body.locator("p").first()).toHaveText("Hello more");
  await expect(body.locator("p").nth(1)).toHaveText("Hello");
});

test("a late reference definition preserves a live strong sibling after inserting its link", async ({ page }) => {
  const body = await startRevealFixture(page, "streaming reveal reference");
  await expect.poll(() => page.evaluate(() => Boolean((globalThis as typeof globalThis & {
    __streamingRevealRefs?: Record<string, unknown>;
  }).__streamingRevealRefs?.steady))).toBe(true);

  await expect(body.locator('a[href="https://example.com"]')).toHaveText("link");
  await expect.poll(() => page.evaluate(() => {
    const saved = (globalThis as typeof globalThis & {
      __streamingRevealRefs?: Record<string, { paragraph: Element; span: Element; text: ChildNode; animation: Animation; currentTime: number | null }>;
    }).__streamingRevealRefs?.steady;
    if (!saved) return false;
    const current = saved.span.getAnimations()[0];
    return saved.paragraph.isConnected
      && saved.span.isConnected
      && saved.text.isConnected
      && saved.paragraph.firstChild === saved.span
      && saved.span.firstChild === saved.text
      && current === saved.animation
      && (saved.currentTime === null || current.currentTime === null || current.currentTime > saved.currentTime);
  })).toBe(true);
  await expect(page.locator("#stopButton")).toBeHidden({ timeout: 5_000 });
  await expect(body.locator("strong")).toHaveText("steady");
  await expect(body.locator(".streamingWordReveal")).toHaveCount(0);
});

test("settling a reveal span preserves a selection inside its text", async ({ page }) => {
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const observer = new MutationObserver(() => {
        const span = document.querySelector(".streamingWordReveal");
        const text = span?.firstChild;
        if (!text || !text.textContent?.startsWith("Hello")) return;
        getSelection()?.setBaseAndExtent(text, 0, text, 5);
        (globalThis as typeof globalThis & { __revealSelectionMade?: boolean }).__revealSelectionMade = true;
        observer.disconnect();
      });
      observer.observe(document.querySelector("#messages")!, { subtree: true, childList: true });
    });
  });
  const body = await startRevealFixture(page);
  await expect.poll(() => page.evaluate(() => (globalThis as typeof globalThis & { __revealSelectionMade?: boolean }).__revealSelectionMade)).toBe(true);
  await expect(body.locator(".streamingWordReveal", { hasText: "Hello" })).toHaveCount(0);
  expect(await page.evaluate(() => getSelection()?.toString())).toBe("Hello");
  await expect(page.locator("#stopButton")).toBeHidden({ timeout: 5_000 });
});

test("a settled text selection survives a later delta in the same paragraph", async ({ page }) => {
  await page.request.post("/api/mock/reset");
  const hello = nextRealtimeHello(page);
  await page.goto("/");
  await hello;
  await expect(page.locator("#prompt")).toBeVisible();
  const publish = async (event: Record<string, unknown>) => {
    const response = await page.request.post("/api/mock/event", { data: {
      type: "agent_event", sessionId: "mock-current", event,
    } });
    expect(response.ok()).toBe(true);
  };
  const prefix = "Hello **bold";
  const suffix = "** world";
  await publish({ type: "agent_start" });
  await publish({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  await publish({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: prefix } });
  const body = page.locator(".message.assistant .body").last();
  await expect(body).toContainText(prefix);
  // Hold the prefix until its real fade has settled and the selection is made.
  // The next delta is test-controlled, not a transient 420ms opportunity.
  await expect(body.locator(".streamingWordReveal")).toHaveCount(0);
  await body.locator("p").evaluate(paragraph => {
    const text = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT).nextNode();
    if (!(text instanceof Text) || !text.data.startsWith("Hello")) throw new Error("settled selection text missing");
    getSelection()?.setBaseAndExtent(text, 0, text, 5);
    (globalThis as typeof globalThis & { __settledSelection?: { paragraph: Element; text: Text } }).__settledSelection = { paragraph, text };
  });
  expect(await page.evaluate(() => getSelection()?.toString())).toBe("Hello");

  await publish({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: suffix } });
  await expect(body).toContainText("Hello bold world");
  expect(await page.evaluate(() => {
    const saved = (globalThis as typeof globalThis & { __settledSelection?: { paragraph: Element; text: Text } }).__settledSelection;
    return saved?.paragraph.isConnected
      && saved.text.isConnected
      && saved.text.parentElement === saved.paragraph
      && getSelection()?.toString() === "Hello";
  })).toBe(true);
  await publish({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: prefix + suffix } });
  await expect(body.locator("strong")).toHaveText("bold");
  await expect(body.locator(".streamingWordReveal")).toHaveCount(0);
  await publish({ type: "agent_settled" });
  await expect(page.locator("#stopButton")).toBeHidden({ timeout: 5_000 });
});

test("switching to reduced motion during a reveal settles it and prevents later reveal spans", async ({ page }) => {
  const body = await startRevealFixture(page, "streaming reveal rapid");
  await expect(body.locator(".streamingWordReveal", { hasText: "Rapid" })).toHaveCount(1);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(body.locator(".streamingWordReveal")).toHaveCount(0);
  await expect(body).toContainText("Rapid update");
  await expect(body.locator(".streamingWordReveal")).toHaveCount(0);
  expect(await body.evaluate(element => getComputedStyle(element).opacity)).toBe("1");
  await expect(page.locator("#stopButton")).toBeHidden({ timeout: 5_000 });
});

test("historical assistant Markdown never receives streaming reveal spans", async ({ page }) => {
  await page.request.post("/api/mock/reset");
  await page.goto("/");
  await page.locator("#prompt").fill("please return markdown");
  await page.locator("#primaryButton").click();
  await expect(page.locator("#stopButton")).toBeHidden({ timeout: 5_000 });

  const historical = page.locator(".message.assistant", { hasText: "Here is bold markdown" }).last();
  await expect(historical.locator("strong")).toHaveText("bold");
  await expect(historical.locator(".streamingWordReveal")).toHaveCount(0);
});

test("reduced motion leaves live text fully opaque without a reveal animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const body = await startRevealFixture(page);
  await expect(body).toContainText("Hello");

  await expect(body.locator(".streamingWordReveal")).toHaveCount(0);
  expect(await body.evaluate(element => getComputedStyle(element).opacity)).toBe("1");

  await expect(page.locator("#stopButton")).toBeHidden({ timeout: 5_000 });
  await expect(body.locator(".streamingWordReveal")).toHaveCount(0);
});
