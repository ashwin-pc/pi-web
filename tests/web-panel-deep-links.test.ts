import { describe, expect, it } from "vitest";
import { openPanelDeepLink, parsePanelDeepLink, type WebPanelEvent } from "../src/extensions/webPanels.js";

describe("panel deep links", () => {
  it("parses a panel key and query payload", () => {
    expect(parsePanelDeepLink("#panel:global-notepad:note=oncall/w34&task=t-3f2a")).toEqual({
      key: "global-notepad",
      payload: { note: "oncall/w34", task: "t-3f2a" },
    });
  });

  it("decodes URL-encoded keys and values while keeping the contribution key literal", () => {
    expect(parsePanelDeepLink("#panel:global-notepad:note=oncall%2Fw34&h=scanner+status%3F")).toEqual({
      key: "global-notepad",
      payload: { note: "oncall/w34", h: "scanner status?" },
    });
  });

  it("opens the panel and dispatches a deep-link event whose returned task view is highlighted", () => {
    let panelOpen = false;
    let panelKey = "";
    let received: WebPanelEvent | undefined;
    let returnedHtml = "";
    const renderExtension = (event: WebPanelEvent) => {
      const payload = event.payload as { note: string; task: string };
      return `<div id="task-${payload.task}" data-web-panel-highlight>${payload.note}</div>`;
    };
    const anchor = {
      href: "#panel:global-notepad:note=oncall%2Fw34&task=t-3f2a",
      click() {
        return openPanelDeepLink(this.href, (key, event) => {
          panelOpen = true;
          panelKey = key;
          received = event;
          returnedHtml = renderExtension(event);
        });
      },
    };

    expect(anchor.click()).toBe(true);
    expect(panelOpen).toBe(true);
    expect(panelKey).toBe("global-notepad");
    expect(received).toEqual({ action: "deep-link", payload: { note: "oncall/w34", task: "t-3f2a" } });
    expect(returnedHtml).toContain('id="task-t-3f2a" data-web-panel-highlight');
  });

  it.each([
    "https://example.com/#panel:notes:note=one",
    "#panel:",
    "#panel::note=one",
    "#panel:notes:",
    "#panel:notes:note",
    "#panel:notes:=one",
    "#panel:notes:note=%E0%A4%A",
    "#panel:notes:note=one&&task=t-1",
  ])("leaves malformed or unrelated hrefs inert: %s", (href) => {
    expect(parsePanelDeepLink(href)).toBeUndefined();
  });
});
