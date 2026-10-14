import { expect, test } from "@playwright/test";
import { build } from "esbuild";

test("collapsed tool cards defer detail rendering and authenticated images until expansion", async ({ page }) => {
  const bundle = await build({
    stdin: { contents: `import hljs from 'highlight.js/lib/common';
      import { createToolCards } from './src/tools/toolCards.ts';
      const counts = { highlight: 0, auto: 0, fetch: 0 };
      const highlight = hljs.highlight.bind(hljs);
      hljs.highlight = (...args) => { counts.highlight++; return highlight(...args); };
      const auto = hljs.highlightAuto.bind(hljs);
      hljs.highlightAuto = (...args) => { counts.auto++; return auto(...args); };
      globalThis.fetch = async () => { counts.fetch++; return new Response(new Blob(['image'])); };
      globalThis.toolFixture = { createToolCards, counts };`, resolveDir: process.cwd() },
    bundle: true, write: false, format: "iife", platform: "browser",
  });
  await page.setContent('<div id="messages"></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(async () => {
    const fixture = (window as typeof window & { toolFixture: {
      createToolCards: typeof import("../../src/tools/toolCards.js").createToolCards;
      counts: { highlight: number; auto: number; fetch: number };
    } }).toolFixture;
    document.documentElement.dataset.density = "compact";
    const messages = document.querySelector<HTMLDivElement>("#messages")!;
    const tools = fixture.createToolCards(messages, () => {}, () => ({ Authorization: "Bearer fixture" }));
    tools.addToolHistoryCard("write", false, { content: [{ type: "text", text: "saved" }, { type: "image", imageUrl: "/api/messages/image?imageId=fixture" }] }, { path: "sample.ts", content: "const answer = 42;\nconsole.log(answer);" });
    const card = messages.lastElementChild as HTMLDivElement;
    const collapsed = { ...fixture.counts, children: card.children.length };
    const toggle = card.querySelector<HTMLButtonElement>(".toolCardExpandToggle")!;
    toggle.click();
    const expanded = { ...fixture.counts, args: card.querySelectorAll(".toolCardArgs").length, images: card.querySelectorAll("img").length, body: card.querySelector(".toolCardBody")?.textContent };
    toggle.click(); toggle.click();
    const repeated = { ...fixture.counts };
    // Unknown output and oversized arguments remain text, not auto-detection.
    tools.addToolHistoryCard("write", false, "<script>unsafe</script>\nlog", { path: "large.ts", content: "const long = 1;\n".repeat(500) });
    const large = messages.lastElementChild as HTMLDivElement;
    large.querySelector<HTMLButtonElement>(".toolCardExpandToggle")!.click();
    const bounded = { ...fixture.counts, text: large.querySelector("code")?.textContent, scripts: large.querySelectorAll("script").length };
    // Activity summaries restore visibility directly after rebuilding history.
    tools.addToolHistoryCard("read", false, "restored result", { path: "restored.txt" });
    const restoredCard = messages.lastElementChild as HTMLDivElement;
    const beforeRestore = restoredCard.querySelectorAll(".toolCardBody").length;
    restoredCard.classList.remove("toolCard--compactCollapsed");
    restoredCard.dispatchEvent(new Event("activity-card-visibility-restored"));
    restoredCard.dispatchEvent(new Event("activity-card-visibility-restored"));
    const restored = { before: beforeRestore, bodies: restoredCard.querySelectorAll(".toolCardBody").length, text: restoredCard.querySelector(".toolCardBody")?.textContent };
    // Streaming stays readable and completion replaces the partial output.
    const live = tools.addToolCard("bash", { command: "printf first\nprintf second" });
    tools.updateToolProgress(undefined, "bash");
    tools.startTool("live", "bash", { command: "echo live" });
    const running = messages.lastElementChild as HTMLDivElement;
    tools.updateToolProgress("live", "bash", { output: "first partial" });
    const partial = running.querySelector(".toolCardPartialBody")?.textContent;
    running.querySelector<HTMLButtonElement>(".toolCardExpandToggle")!.click();
    tools.endTool("live", "bash", false, { output: "final output" });
    const completed = running.querySelector(".toolCardBody")?.textContent;
    // Switching density exposes pending details without needing a toggle click.
    tools.addToolHistoryCard("read", false, "comfortable result", { path: "file.txt" });
    const densityCard = messages.lastElementChild as HTMLDivElement;
    document.documentElement.dataset.density = "comfortable";
    await new Promise((resolve) => setTimeout(resolve, 0));
    const comfortable = densityCard.querySelector(".toolCardBody")?.textContent;
    tools.updateToolCard(live, "bash", false, "done");
    tools.addToolHistoryCard("bash", true, { message: "Permission denied", technicalDetails: "Error stack\nline two" }, { command: "restricted command" });
    const errorCard = messages.lastElementChild as HTMLDivElement;
    const errorHidden = errorCard.querySelectorAll(".toolCardBody").length;
    errorCard.querySelector<HTMLButtonElement>(".toolCardExpandToggle")!.click();
    const errorExpanded = errorCard.querySelectorAll(".toolCardBody").length;
    tools.addRuntimeErrorCard({ title: "Runtime error", technicalDetails: "Visible runtime details" });
    const runtime = messages.lastElementChild?.querySelector(".toolCardBody")?.textContent;
    tools.clearActiveToolCards();
    return { collapsed, expanded, repeated, bounded, restored, partial, completed, comfortable, errorHidden, errorExpanded, runtime };
  });
  expect(result.collapsed).toEqual({ highlight: 0, auto: 0, fetch: 0, children: 1 });
  expect(result.expanded).toEqual({ highlight: 1, auto: 0, fetch: 1, args: 1, images: 1, body: "saved\n[image]" });
  expect(result.repeated).toEqual({ highlight: 1, auto: 0, fetch: 1 });
  expect(result.bounded.highlight).toBe(1);
  expect(result.bounded.auto).toBe(0);
  expect(result.bounded.scripts).toBe(0);
  expect(result.bounded.text).toHaveLength(8000);
  expect(result.restored).toEqual({ before: 0, bodies: 1, text: "restored result" });
  expect(result.partial).toBe("first partial");
  expect(result.completed).toBe("final output");
  expect(result.comfortable).toBe("comfortable result");
  expect(result.errorHidden).toBe(0);
  expect(result.errorExpanded).toBe(1);
  expect(result.runtime).toBe("Visible runtime details");
});
