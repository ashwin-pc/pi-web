import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { WebUiExtensionService, type ExtensionUiServiceEvent, type WebUiSession } from "../server/extensions/webUi.js";
import type { PiWebUi } from "../src/extensions.js";

function createHarness() {
  const broadcasts: unknown[] = [];
  const requests: ExtensionUiServiceEvent[] = [];
  let bindings: unknown;
  const session: WebUiSession = {
    sessionId: "session-1",
    sessionFile: "/repo/.pi/session.jsonl",
    agent: { waitForIdle: async () => undefined },
    bindExtensions: async (value) => { bindings = value; },
    navigateTree: async () => ({ cancelled: false }),
  };
  let nextId = 0;
  const service = new WebUiExtensionService({
    broadcast: (value) => broadcasts.push(value),
    emitExtensionUiEvent: (event) => requests.push(event),
    clientCount: () => 1,
    acquireWorkLease: () => () => undefined,
    sessionCwd: () => "/repo",
    createNewSession: async () => session,
    currentStateWithThinkingLevels: () => ({ sessionId: "session-1" }),
  }, () => `request-${++nextId}`);
  return { broadcasts, requests, session, service, getBindings: () => bindings as { uiContext: ExtensionUIContext & { web: PiWebUi } } };
}

describe("web extension UI service", () => {
  it("projects footer, header action, and git tab state through JSON", () => {
    const { broadcasts, session, service } = createHarness();
    const ui = service.createPiWebUi(session);
    ui.setFooter("footer key", { kind: "text", lines: ["line one", "line two"] });
    ui.setHeaderAction("run", { title: "Run extension", label: "Run", invoke: () => ({ markdown: "done" }) });
    ui.setGitTab("review", { title: "Review", label: "Diff", render: () => ({ html: "<p>review</p>" }) });

    expect(JSON.parse(JSON.stringify(service.footerEntries(session)))).toEqual([
      { key: "footer-key", footer: { kind: "text", lines: ["line one", "line two"] } },
    ]);
    expect(JSON.parse(JSON.stringify(service.headerActionEntries(session)))).toEqual([
      { key: "run", title: "Run extension", label: "Run" },
    ]);
    expect(JSON.parse(JSON.stringify(service.gitTabEntries(session)))).toEqual([
      { key: "review", title: "Review", label: "Diff" },
    ]);
    expect(broadcasts.map((event) => (event as { type: string }).type)).toEqual([
      "web_footer_changed",
      "web_header_actions_changed",
      "web_git_tabs_changed",
    ]);
  });

  it("emits serializable dialog requests and resolves explicit responses", async () => {
    const { requests, service, session, getBindings } = createHarness();
    await service.bindWebExtensions(session);
    const ui = getBindings().uiContext;
    const selected = ui.select("Choose", ["one", "two"]);

    expect(JSON.parse(JSON.stringify(requests))).toEqual([
      {
        type: "extension_ui_request",
        id: "request-1",
        method: "select",
        sessionId: "session-1",
        sessionFile: "/repo/.pi/session.jsonl",
        title: "Choose",
        options: ["one", "two"],
      },
    ]);
    expect(service.respondExtensionUi({ id: "missing", value: "one" })).toBe(false);
    expect(service.respondExtensionUi(JSON.parse(JSON.stringify({ id: "request-1", value: "two" })))).toBe(true);
    await expect(selected).resolves.toBe("two");
  });
});
