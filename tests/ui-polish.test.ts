import { describe, expect, it } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { createContextMeter } from "../src/composer/contextMeter.js";
import { createModelSettings, modelSummaryParts, thinkingLevelFill } from "../src/models/modelSettings.js";
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
  selectedOptions: Array<{ textContent?: string | null; dataset?: Record<string, string> }> = [];
  append(...nodes: unknown[]) {
    this.children.push(...nodes);
    this.textContent += nodes.map((node) => typeof node === "object" && node && "textContent" in node ? String(node.textContent || "") : String(node)).join("");
  }
  appendChild(node: unknown) { this.append(node); return node; }
  replaceChildren(...nodes: unknown[]) {
    this.children = [];
    this.textContent = "";
    this.append(...nodes);
  }
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
  it("splits provider/model labels for the compact summary", () => {
    expect(modelSummaryParts("aws-bedrock/us.anthropic.claude-3-7-sonnet (Claude 3.7 Sonnet)")).toEqual({
      fullLabel: "aws-bedrock/us.anthropic.claude-3-7-sonnet (Claude 3.7 Sonnet)",
      model: "Claude 3.7 Sonnet",
      provider: "aws-bedrock",
      id: "us.anthropic.claude-3-7-sonnet",
      name: "Claude 3.7 Sonnet",
    });
    expect(modelSummaryParts("mock/model")).toEqual({ fullLabel: "mock/model", model: "model", provider: "mock", id: "model", name: "" });
    expect(modelSummaryParts("custom/model (preview)", { provider: "custom", id: "model (preview)" })).toEqual({
      fullLabel: "custom/model (preview)",
      model: "model (preview)",
      provider: "custom",
      id: "model (preview)",
      name: "",
    });
  });

  it("uses the selected model option instead of deriving a No model label", () => {
    const modelSettingsLabel = new MockElement();
    const modelSettingsThinking = new MockElement();
    const modelSettingsButton = new MockElement();
    const modelSelectEl = new MockElement();
    modelSelectEl.selectedOptions = [{ textContent: "aws-bedrock/us.anthropic.claude-3-7-sonnet", dataset: { provider: "aws-bedrock", modelId: "us.anthropic.claude-3-7-sonnet" } }];
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

    expect(modelSettingsLabel.title).toBe("aws-bedrock/us.anthropic.claude-3-7-sonnet");
    expect(modelSettingsLabel.children).toMatchObject([
      { className: "modelSettingsModelName", textContent: "us.anthropic.claude-3-7-sonnet" },
    ]);
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

describe("tool card expand chevrons", () => {
  const css = readFileSync(new URL("../src/styles/toolCards.css", import.meta.url), "utf8");

  it("keeps tool and thinking expand/collapse chevrons white instead of accent-colored", () => {
    const toggleBlock = css.match(/\.toolCardExpandToggle,\n\.toolCardCollapseToggle \{[\s\S]*?\n\}/)?.[0] || "";
    expect(toggleBlock).toContain("color: #fff;");
    expect(toggleBlock).not.toContain("color: var(--accent);");
    expect(css).toContain(".toolCardCollapseToggle:focus-visible { color: #fff; border: none; }");
  });
});

describe("connected transcript and header styling", () => {
  const toolCss = readFileSync(new URL("../src/styles/toolCards.css", import.meta.url), "utf8");
  const messagesCss = readFileSync(new URL("../src/styles/messages.css", import.meta.url), "utf8");
  const statusCss = readFileSync(new URL("../src/styles/statusBar.css", import.meta.url), "utf8");

  it("uses the midnight and champagne treatment for adjacent tool cards", () => {
    expect(toolCss).toContain(".toolCard--success { background: #15201e; }");
    expect(toolCss).toContain(".toolCard--thinking { background: #171b25; }");
    expect(toolCss).toContain("--tool-stitch-metal: #c7a86d;");
    expect(toolCss).toContain("width: 60px;");
  });

  it("keeps artifact headers compact with a pinstripe treatment", () => {
    expect(messagesCss).toContain("min-height: 16px;");
    expect(messagesCss).toContain("padding: 0 16px;");
    expect(messagesCss).toContain("repeating-linear-gradient(\n      90deg,");
  });

  it("lets the session title use free header space before truncating", () => {
    expect(statusCss).toContain(".statusTitle {\n  flex: 1 1 auto;\n  min-width: 0;");
    expect(statusCss).not.toContain("max-width: 240px;");
    expect(statusCss).not.toContain("max-width: 28vw;");
  });
});

describe("configurable accent color", () => {
  const baseCss = readFileSync(new URL("../src/styles/base.css", import.meta.url), "utf8");
  const composerCss = readFileSync(new URL("../src/styles/composer.css", import.meta.url), "utf8");
  const sessionsCss = readFileSync(new URL("../src/styles/sessions.css", import.meta.url), "utf8");
  const settingsHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const settingsTs = readFileSync(new URL("../src/settings/settings.ts", import.meta.url), "utf8");

  it("keeps the accent setting to one row with a preview/save popover", () => {
    expect(baseCss).toContain("--accent: #e2b15f;");
    expect(settingsHtml).toContain('id="settingAccentMenuButton"');
    expect(settingsHtml).toContain('id="settingAccentPopover" class="settingsAccentPopover"');
    expect(settingsHtml).toContain('class="settingsAccentSwatch"');
    expect(settingsHtml).toContain('Antique Gold');
    expect(settingsHtml).toContain('Nocturne Sky');
    expect(settingsHtml).toContain('Velvet Orchid');
    expect(settingsHtml).toContain('Palladium');
    expect(settingsHtml).toContain('Slate Smoke');
    expect(settingsHtml).toContain('class="settingsAccentSwatchLabel"');
    expect(settingsHtml).toContain('id="settingAccentColorInput" type="text"');
    expect(settingsHtml).toContain('id="settingAccentPreviewButton" type="button"');
    expect(settingsHtml).toContain('id="settingAccentCancelButton" type="button"');
    expect(settingsHtml).toContain('id="settingAccentApplyButton" type="button"');
    expect(settingsTs).toContain('setDocumentAccent(accentColor)');
    expect(settingsTs).toContain('querySelectorAll<HTMLButtonElement>(".settingsAccentSwatch")');
    expect(settingsTs).toContain("previewAccentColor(button.dataset.accentColor)");
    expect(settingsTs).toContain("closeAccentPopover({ restorePreview: true");
    expect(settingsTs).toContain("Save accent");
  });

  it("routes primary accent UI through the configurable token", () => {
    expect(composerCss).toContain(".primaryAction {\n  background: color-mix(in srgb, var(--accent)");
    expect(composerCss).toContain("box-shadow: inset 0 0 0 2px var(--accent);");
    expect(composerCss).toContain(".contextMeter.active .contextMeterFill { background: var(--accent); }");
    expect(composerCss).toContain("--thinking-accent: var(--accent);");
    expect(sessionsCss).toContain(".sessionUnreadDot {");
    expect(sessionsCss).toContain("background: var(--accent);");
    expect(sessionsCss).toContain(".sessionBarTab.active {\n  border-top-color: var(--accent);");
  });

  it("offers selectable running session tab loading animations", () => {
    expect(settingsHtml).toContain('id="settingLoadingAnimationSelect"');
    expect(settingsHtml).toContain('<option value="fireworks">Micro fireworks</option>');
    expect(settingsHtml).toContain('<option value="glow">Ember glow</option>');
    expect(settingsHtml).toContain('<option value="pulse">Pulse</option>');
    expect(settingsTs).toContain('document.documentElement.dataset.loadingAnimation');
    expect(settingsTs).toContain('patchSettings({ appearance: { loadingAnimation: elements.settingLoadingAnimationSelect.value } })');
    expect(sessionsCss).toContain("/* Running session tab loading animations */");
    expect(sessionsCss).toContain("@keyframes sessionBarRunFireworkSpark");
    expect(sessionsCss).toContain("@keyframes sessionBarRunPulse");
    expect(sessionsCss).toContain("@keyframes sessionBarRunFlame");
    expect(sessionsCss).toContain(':root[data-loading-animation="fireworks"] .sessionBarTab.running .sessionBarTabSpark');
    expect(sessionsCss).toContain(':root[data-loading-animation="pulse"] .sessionBarTab.running::before');
    expect(sessionsCss).toContain(':root[data-loading-animation="glow"] .sessionBarTab.running::after');
    expect(sessionsCss).not.toContain("linear-gradient(\n    60deg,");
  });
});

describe("new session empty state", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/styles/folderPicker.css", import.meta.url), "utf8");
  const sessionsTs = readFileSync(new URL("../src/sessions/sessionDrawer.ts", import.meta.url), "utf8");

  it("shows and replays the restored new-chat animation after transcript loading", () => {
    expect(statSync(new URL("../public/new-chat-loading.mp4", import.meta.url)).size).toBeGreaterThan(0);
    expect(html).toContain('class="newChatLoadingAnimation"');
    expect(html).toContain('src="/new-chat-loading.mp4"');
    expect(css).toContain(".newChatLoadingAnimation.resetting");
    expect(sessionsTs).toContain("function finishTranscriptLoading()");
    expect(sessionsTs).toContain("video.currentTime = 0;");
    expect(sessionsTs).toContain("void video.play()");
  });

  it("makes the working directory a compact accessible control", () => {
    expect(html).toContain('class="emptyCwdButton" aria-label="Change working directory"');
    expect(html).toContain('class="emptyCwdPath"');
    expect(css).toContain("text-overflow: ellipsis;");
    expect(css).toContain("max-width: min(330px, 65vw);");
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

  it("uses the configurable accent for context usage over 50%", () => {
    expect(css).toContain(".contextMeter.active .contextMeterFill { background: var(--accent); }");
  });

  it("renders a dynamic clipped brain overlay for thinking level", () => {
    expect(css).toContain("--thinking-fill: 0%;");
    expect(css).toContain("--thinking-accent: var(--accent);");
    expect(css).toContain(".modelSettingsThinkingIcon::before {");
    expect(css).toContain("height: var(--thinking-fill, 0%)");
    expect(css).toContain(".modelSettingsThinkingIconFill {");
    expect(css).toContain("clip-path: inset(calc(100% - var(--thinking-fill, 0%)) 0 0 0)");
    expect(css).not.toContain('data-thinking-level="low"');
    expect(css).not.toContain('data-thinking-level="xhigh"');
    expect(css).toContain(".modelSettingsThinkingText { display: none; }");
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
    expect(css).toContain("width: fit-content;");
    expect(css).toContain("display: inline-flex;");
    expect(css).toContain("justify-content: flex-start;");
    expect(css).toContain(".modelSettingsModelName,");
    expect(css).toContain(".modelSettingsCurrent {");
    expect(css).toContain(".modelSettingsCurrentValue {");
    expect(css).toContain(`${compactSelector} #attachButton,\n${compactSelector} #stopButton {`);
    expect(css).not.toContain(`${compactSelector} #stopButton {\n  display: none !important;`);
  });

  it("keeps compact model settings popover within the viewport", () => {
    expect(css).toContain(`${compactSelector} .modelSettingsPopover,\n.composer:has(.modelSettingsButton[aria-expanded="true"]) .modelSettingsPopover {\n  position: fixed;\n  left: 50%;`);
    expect(css).toContain("width: min(560px, calc(100vw - 32px));");
    expect(css).toContain("transform: translateX(-50%);");
  });

  it("preserves model label width and thinking icon in compact mobile layout", () => {
    const responsiveCss = readFileSync(new URL("../src/styles/responsive.css", import.meta.url), "utf8");
    expect(responsiveCss).toContain(`${compactSelector} .modelControl {\n    flex: 0 1 auto;\n    width: fit-content;\n    max-width: clamp(104px, 34vw, 170px);\n  }`);
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
