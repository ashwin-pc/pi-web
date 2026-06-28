import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { blurActiveEditableOnMobile, focusIfKeyboardFriendly, isEditableElement } from "../src/app/focus.js";

class MockHTMLElement {
  focusCalls = 0;
  blurCalls = 0;
  isContentEditable = false;

  focus() {
    this.focusCalls += 1;
  }

  blur() {
    this.blurCalls += 1;
  }
}

class MockInputElement extends MockHTMLElement {
  constructor(public type = "text") {
    super();
  }
}
class MockTextAreaElement extends MockHTMLElement {}
class MockSelectElement extends MockHTMLElement {}

function installDomGlobals(options: { touch?: boolean; activeElement?: unknown } = {}) {
  const touch = Boolean(options.touch);
  const windowMock: Record<string, unknown> = {
    matchMedia: vi.fn(() => ({ matches: touch })),
  };
  if (touch) windowMock.ontouchstart = vi.fn();

  vi.stubGlobal("window", windowMock);
  vi.stubGlobal("navigator", { maxTouchPoints: touch ? 1 : 0 });
  vi.stubGlobal("document", { activeElement: options.activeElement ?? null });
  vi.stubGlobal("HTMLElement", MockHTMLElement);
  vi.stubGlobal("HTMLInputElement", MockInputElement);
  vi.stubGlobal("HTMLTextAreaElement", MockTextAreaElement);
  vi.stubGlobal("HTMLSelectElement", MockSelectElement);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mobile focus helpers", () => {
  it("allows programmatic text input focus on desktop", () => {
    installDomGlobals();
    const input = new MockInputElement();

    expect(focusIfKeyboardFriendly(input as unknown as HTMLElement)).toBe(true);
    expect(input.focusCalls).toBe(1);
  });

  it("skips programmatic text input focus on touch devices", () => {
    installDomGlobals({ touch: true });
    const input = new MockInputElement();

    expect(focusIfKeyboardFriendly(input as unknown as HTMLElement)).toBe(false);
    expect(input.focusCalls).toBe(0);
  });

  it("blurs an active editable field on touch devices", () => {
    const input = new MockInputElement();
    installDomGlobals({ touch: true, activeElement: input });

    expect(blurActiveEditableOnMobile()).toBe(true);
    expect(input.blurCalls).toBe(1);
  });

  it("leaves non-editable active elements alone on touch devices", () => {
    const button = new MockHTMLElement();
    installDomGlobals({ touch: true, activeElement: button });

    expect(blurActiveEditableOnMobile()).toBe(false);
    expect(button.blurCalls).toBe(0);
  });

  it("does not classify file inputs as keyboard editables", () => {
    installDomGlobals({ touch: true });
    const fileInput = new MockInputElement("file");

    expect(isEditableElement(fileInput as unknown as Element)).toBe(false);
    expect(focusIfKeyboardFriendly(fileInput as unknown as HTMLElement)).toBe(true);
    expect(fileInput.focusCalls).toBe(1);
  });
});

describe("mobile focus wiring", () => {
  it("keeps submit refocus mobile-safe while preserving explicit editor focus", () => {
    const composer = readFileSync(new URL("../src/composer/composer.ts", import.meta.url), "utf8");

    expect(composer).toContain("function settlePromptFocusAfterSubmit()");
    expect(composer.match(/settlePromptFocusAfterSubmit\(\);/g) || []).toHaveLength(3);
    expect(composer).toContain("function setPromptText(text: string)");
    expect(composer).toContain("    elements.promptEl.focus();\n  }\n\n  function slashCommandName");
  });

  it("blurs mobile editables before opening panels and popovers", () => {
    const files = [
      "../src/sessions/sessionDrawer.ts",
      "../src/settings/settings.ts",
      "../src/models/modelSettings.ts",
      "../src/composer/contextMeter.ts",
      "../src/git/panel.ts",
      "../src/tree/conversationTree.ts",
    ];

    for (const file of files) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source, file).toContain("blurActiveEditableOnMobile");
    }
  });
});
