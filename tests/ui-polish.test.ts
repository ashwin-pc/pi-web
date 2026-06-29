import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createContextMeter } from "../src/composer/contextMeter.js";
import { createModelSettings, thinkingLevelFill } from "../src/models/modelSettings.js";
import type { AppElements } from "../src/app/elements.js";
import type { AppState } from "../src/app/types.js";

class MockElement {
  className = "";
  textContent = "";
  title = "";
  hidden = false;
  disabled = false;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  style = { values: new Map<string, string>(), setProperty: (key: string, value: string) => this.style.values.set(key, value) };
  children: unknown[] = [];
  selectedOptions: Array<{ textContent?: string | null }> = [];
  append(...nodes: unknown[]) { this.children.push(...nodes); }
  appendChild(node: unknown) { this.children.push(node); return node; }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  addEventListener() {}
}

globalThis.document = {
  createElement: () => new MockElement(),
  createElementNS: () => new MockElement(),
  createTextNode: (text: string) => ({ textContent: text }),
  addEventListener: () => undefined,
} as unknown as Document;

function mockContextMeter(compacting: boolean) {
  const contextMeterEl = new MockElement();
  const contextMeterLabelEl = new MockElement();
  const contextMeterPopoverEl = new MockElement();
  const controller = createContextMeter({
    state: { isCompacting: compacting } as AppState,
    elements: {
      contextMeterEl,
      contextMeterLabelEl,
      contextMeterPopoverEl,
    } as unknown as AppElements,
  });
  return { controller, contextMeterEl, contextMeterLabelEl };
}

describe("context meter compaction polish", () => {
  it("shows a compacting label and class while compaction is running", () => {
    const { controller, contextMeterEl, contextMeterLabelEl } = mockContextMeter(true);

    controller.update({ contextUsage: { tokens: 82_000, contextWindow: 100_000 } });

    expect(contextMeterEl.className).toContain("compacting");
    expect(contextMeterEl.title).toBe("Compacting context…");
    expect(contextMeterEl.attributes.get("aria-label")).toBe("Compacting context…");
    expect(contextMeterLabelEl.textContent).toBe("compacting");
  });

  it("uses the normal ctx percentage label when not compacting", () => {
    const { controller, contextMeterEl, contextMeterLabelEl } = mockContextMeter(false);

    controller.update({ contextUsage: { tokens: 82_000, contextWindow: 100_000 } });

    expect(contextMeterEl.className).toBe("contextMeter warning");
    expect(contextMeterLabelEl.textContent).toBe("ctx 82%");
  });
});

describe("model settings summary", () => {
  it("uses the selected model option instead of deriving a No model label", () => {
    const modelSettingsLabel = new MockElement();
    const modelSettingsThinking = new MockElement();
    const modelSettingsButton = new MockElement();
    const modelSelectEl = new MockElement();
    modelSelectEl.selectedOptions = [{ textContent: "aws-bedrock/us.anthropic.claude-3-7-sonnet" }];
    const controller = createModelSettings({
      state: { currentModelDisplay: "", currentModelKey: "", currentThinkingLevel: "off" } as AppState,
      elements: {
        modelSettingsLabel,
        modelSettingsThinking,
        modelSettingsButton,
        modelSelectEl,
        thinkingSelectEl: { value: "off" },
      } as unknown as AppElements,
      api: { headers: () => ({}) } as any,
      updateMeta: () => undefined,
      addMessage: () => undefined,
    });

    controller.updateSummary();

    expect(modelSettingsLabel.textContent).toBe("aws-bedrock/us.anthropic.claude-3-7-sonnet");
  });

  it("stores dynamic thinking fill from the API-provided option order", () => {
    const modelSettingsThinking = new MockElement();
    const controller = createModelSettings({
      state: { currentModelDisplay: "mock/model", currentModelKey: "", currentThinkingLevel: "balanced" } as AppState,
      elements: {
        modelSettingsLabel: new MockElement(),
        modelSettingsThinking,
        modelSettingsButton: new MockElement(),
        modelSelectEl: new MockElement(),
        thinkingSelectEl: {
          value: "balanced",
          options: [{ value: "off" }, { value: "short" }, { value: "balanced" }, { value: "deep" }],
        },
      } as unknown as AppElements,
      api: { headers: () => ({}) } as any,
      updateMeta: () => undefined,
      addMessage: () => undefined,
    });

    controller.updateSummary();

    expect(modelSettingsThinking.dataset.thinkingLevel).toBe("balanced");
    expect(modelSettingsThinking.dataset.thinkingActive).toBe("true");
    expect(modelSettingsThinking.style.values.get("--thinking-fill")).toBe("67%");
  });

  it("calculates thinking fill without hard-coded level names", () => {
    expect(thinkingLevelFill("off", ["off", "minimal", "low", "medium", "high", "xhigh"])).toBe(0);
    expect(thinkingLevelFill("minimal", ["off", "minimal", "low", "medium", "high", "xhigh"])).toBeCloseTo(1 / 5);
    expect(thinkingLevelFill("xhigh", ["off", "minimal", "low", "medium", "high", "xhigh"])).toBe(1);
    expect(thinkingLevelFill("balanced", ["none", "short", "balanced", "deep"])).toBeCloseTo(2 / 3);
  });

  it("leaves the model label empty when no model information is available", () => {
    const modelSettingsLabel = new MockElement();
    const controller = createModelSettings({
      state: { currentModelDisplay: "", currentModelKey: "", currentThinkingLevel: "off" } as AppState,
      elements: {
        modelSettingsLabel,
        modelSettingsThinking: new MockElement(),
        modelSettingsButton: new MockElement(),
        modelSelectEl: new MockElement(),
        thinkingSelectEl: { value: "off" },
      } as unknown as AppElements,
      api: { headers: () => ({}) } as any,
      updateMeta: () => undefined,
      addMessage: () => undefined,
    });

    controller.updateSummary();

    expect(modelSettingsLabel.textContent).toBe("");
  });
});

describe("git status colors", () => {
  const css = readFileSync(new URL("../src/git/git.css", import.meta.url), "utf8");

  it("keeps git status badges on their legacy semantic colors", () => {
    expect(css).toContain(".gitStatusBadge { flex: 0 0 auto; min-width: 14px; text-align: center; color: #7dd3fc;");
    expect(css).toContain(".gitStatusBadge.modified, .gitStatusBadge.renamed { color: #7dd3fc; }");
    expect(css).toContain(".gitStatusBadge.untracked, .gitStatusBadge.added, .gitDiffLine.add { color: #86efac; }");
  });
});

describe("slash command compact styling", () => {
  const css = readFileSync(new URL("../src/styles/composer.css", import.meta.url), "utf8");

  it("keeps slash command rows compact", () => {
    expect(css).toContain("max-height: min(280px, 42vh)");
    expect(css).toContain("min-height: 30px");
    expect(css).toContain("padding: 5px 8px");
  });

  it("hides slash command descriptions until the active or hovered row", () => {
    expect(css).toContain(".slashCommandDescription {\n  display: none;");
    expect(css).toContain(".slashCommandItem.active .slashCommandDescription,\n.slashCommandItem:hover .slashCommandDescription { display: block; }");
  });

  it("uses the legacy blue for context usage over 50%", () => {
    expect(css).toContain(".contextMeter.active .contextMeterFill { background: #7dd3fc; }");
  });

  it("renders a dynamic clipped brain overlay for thinking level", () => {
    expect(css).toContain("--thinking-fill: 0%;");
    expect(css).toContain("--thinking-accent: #7dd3fc;");
    expect(css).toContain(".modelSettingsThinkingIcon::before {");
    expect(css).toContain("height: var(--thinking-fill, 0%)");
    expect(css).toContain(".modelSettingsThinkingIconFill {");
    expect(css).toContain("clip-path: inset(calc(100% - var(--thinking-fill, 0%)) 0 0 0)");
    expect(css).not.toContain('data-thinking-level="low"');
    expect(css).not.toContain('data-thinking-level="xhigh"');
  });

  it("animates the context meter while compacting with reduced-motion support", () => {
    expect(css).toContain(".contextMeter.compacting .contextMeterFill");
    expect(css).toContain("animation: contextMeterPulse 1.25s ease-in-out infinite");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });
});

describe("compact inactive composer styling", () => {
  const css = readFileSync(new URL("../src/styles/composer.css", import.meta.url), "utf8");
  const compactSelector = ".composer.compactInactive:not(:focus-within):not(.expanded):has(textarea:placeholder-shown):not(:has(.attachments:not(:empty)))";

  it("collapses the inactive empty composer into a single floating bar", () => {
    expect(css).toContain(`${compactSelector} {`);
    expect(css).toContain("grid-template-columns: minmax(0, 1fr) auto");
    expect(css).toContain("isolation: isolate;");
    expect(css).toContain("background: linear-gradient(180deg, #1b1b1b, #111 58%, #0d0d0d);");
    expect(css).toContain(`${compactSelector}::before {`);
    expect(css).toContain("radial-gradient(ellipse at center, rgba(255,255,255,.07)");
    expect(css).toContain("border-radius: 999px");
    expect(css).toContain(`${compactSelector} textarea {`);
    expect(css).toContain("height: 38px");
  });

  it("keeps model, thinking, attachment, and active stop controls available", () => {
    expect(css).toContain(`${compactSelector} .modelSettingsButton {`);
    expect(css).toContain(`${compactSelector} #attachButton,\n${compactSelector} #stopButton {`);
    expect(css).not.toContain(`${compactSelector} #stopButton {\n  display: none !important;`);
  });

  it("keeps compact model settings popover within the viewport", () => {
    expect(css).toContain(`${compactSelector} .modelSettingsPopover {\n  position: fixed;\n  left: 50%;`);
    expect(css).toContain("width: min(560px, calc(100vw - 32px));");
    expect(css).toContain("transform: translateX(-50%);");
  });

  it("preserves model label width and thinking icon in compact mobile layout", () => {
    const responsiveCss = readFileSync(new URL("../src/styles/responsive.css", import.meta.url), "utf8");
    expect(responsiveCss).toContain(`${compactSelector} .modelControl {\n    flex: 0 1 auto;\n    width: clamp(150px, 42vw, 240px);\n  }`);
    expect(responsiveCss).toContain(".modelSettingsThinking {\n    display: inline-flex;\n  }");
    expect(responsiveCss).toContain(".modelSettingsThinkingText {");
  });

  it("hides nonessential inactive controls until focus", () => {
    expect(css).toContain(`${compactSelector} .expandButton,\n${compactSelector} #queueToggle,\n${compactSelector} #primaryButton {\n  display: none !important;\n}`);
  });

  it("sets the compact inactive state during composer initialization", () => {
    const composer = readFileSync(new URL("../src/composer/composer.ts", import.meta.url), "utf8");
    expect(composer).toContain("function updateCompactInactive()");
    expect(composer).toContain("    updateCompactInactive();\n  }\n\n  return {");
  });

  it("routes compact actions through press handlers before focus expands the composer", () => {
    const composer = readFileSync(new URL("../src/composer/composer.ts", import.meta.url), "utf8");
    const compactInteractions = readFileSync(new URL("../src/composer/compactInteractions.ts", import.meta.url), "utf8");
    expect(composer).toContain("bindCompactInactiveAction(elements.attachButton");
    expect(composer).toContain("bindCompactInactiveAction(elements.stopButton");
    expect(compactInteractions).toContain("target.addEventListener(\"pointerdown\", handlePress)");
    expect(compactInteractions).toContain("target.addEventListener(\"mousedown\", handlePress)");
    expect(compactInteractions).toContain("target.addEventListener(\"touchstart\", handlePress, { passive: false })");
  });
});
