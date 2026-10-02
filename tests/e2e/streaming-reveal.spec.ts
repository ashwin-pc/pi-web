import { expect, test, type Page } from "@playwright/test";
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

function revealTexts(page: Page) {
  return page.locator(".streamingWordReveal").allTextContents();
}

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
