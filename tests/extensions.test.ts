import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverExtensionEntryPaths, resolveBundledExtensionPaths } from "../server/extensions.js";
import { createWebUiBridge } from "../server/extensions/webUi.js";
import { SessionSettlementTracker } from "../server/session/settlement.js";
import { createSettlementDependencyStore } from "../src/sessions/settlementDependencies.js";
import artifactReferenceExtension from "../examples/pi-web-extensions/artifact-reference.js";
import { createGitFooterExtension } from "../examples/pi-web-extensions/git-footer.js";

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-extensions-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("bundled extension path discovery", () => {
  it("expands an extensions directory to concrete extension entry files", async () => {
    const root = await makeTempDir();
    const appDir = join(root, "app");
    const bundledExtensionsDir = join(appDir, ".pi", "extensions");
    await mkdir(join(bundledExtensionsDir, "nested"), { recursive: true });
    await writeFile(join(bundledExtensionsDir, "auto-session-name.ts"), "export default () => {};\n");
    await writeFile(join(bundledExtensionsDir, "status.js"), "export default () => {};\n");
    await writeFile(join(bundledExtensionsDir, "ignored.md"), "not an extension\n");
    await writeFile(join(bundledExtensionsDir, "nested", "index.ts"), "export default () => {};\n");

    const paths = resolveBundledExtensionPaths({
      piCwd: join(root, "project"),
      appDir,
      bundledExtensionsDir,
    });

    expect(paths).toEqual([
      join(bundledExtensionsDir, "auto-session-name.ts"),
      join(bundledExtensionsDir, "nested", "index.ts"),
      join(bundledExtensionsDir, "status.js"),
    ]);
    expect(paths).not.toContain(bundledExtensionsDir);
  });

  it("resolves package-style extension directories through their pi manifest", async () => {
    const root = await makeTempDir();
    const extensionsDir = join(root, "extensions");
    const packageDir = join(extensionsDir, "bundle");
    await mkdir(join(packageDir, "src"), { recursive: true });
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ pi: { extensions: ["./src/main.ts"] } }));
    await writeFile(join(packageDir, "src", "main.ts"), "export default () => {};\n");

    expect(discoverExtensionEntryPaths(extensionsDir)).toEqual([join(packageDir, "src", "main.ts")]);
  });

  it("does not add bundled extensions while running from the pi-web app directory", async () => {
    const root = await makeTempDir();
    const appDir = join(root, "app");
    const bundledExtensionsDir = join(appDir, ".pi", "extensions");
    await mkdir(bundledExtensionsDir, { recursive: true });
    await writeFile(join(bundledExtensionsDir, "auto-session-name.ts"), "export default () => {};\n");

    expect(resolveBundledExtensionPaths({ piCwd: appDir, appDir, bundledExtensionsDir })).toEqual([]);
  });

  it("registers the artifact reference example and safely formats untrusted context", async () => {
    const handlers = new Map<string, (event: unknown, context: any) => unknown>();
    artifactReferenceExtension({ on: (event: string, handler: (event: unknown, context: any) => unknown) => handlers.set(event, handler) } as any);
    const calls: Array<[string, any]> = [];
    const context = { ui: { web: { contribute: (key: string, contribution: unknown) => calls.push([key, contribution]) } } };

    await handlers.get("session_start")?.({}, context);
    const action = calls.at(-1)?.[1];
    expect(calls.at(-1)?.[0]).toBe("artifact-reference");
    expect(action).toMatchObject({
      slot: "artifact-action",
      kind: "rendered",
      title: "Copy an artifact reference",
      label: "Reference",
    });
    expect(await action.render({ context: { name: "report](bad).md", path: "/api/artifacts/report (final).md?raw", kind: "mark*down" } }))
      .toEqual({
        markdown: "**Artifact:** report\\]\\(bad\\)\\.md (mark\\*down)\n\n**API path:** /api/artifacts/report \\(final\\)\\.md?raw\n\n**Markdown link:**\n\n    [report\\]\\(bad\\)\\.md](/api/artifacts/report%20%28final%29.md%3Fraw)",
      });

    await handlers.get("session_shutdown")?.({}, context);
    expect(calls.at(-1)).toEqual(["artifact-reference", undefined]);
  });

  it("carries a real extension dependency declaration through server status and frontend hydration", async () => {
    const runtimes = new Map([
      ["parent", { sessionId: "parent", isRunning: false, pendingMessageCount: 0 }],
      ["worker", { sessionId: "worker", isRunning: true, pendingMessageCount: 0 }],
    ]);
    const tracker = new SessionSettlementTracker(async (id) => runtimes.get(id), () => undefined);
    const wireEvents: any[] = [];
    let ui: any;
    const bridge = createWebUiBridge({
      emit: (event: any) => {
        if (event.type === "settlement_dependencies") tracker.report(event.sessionId, event.childIds);
        wireEvents.push(event);
      },
      clientCount: () => 1,
      withWorkLease: (_session: any, _label: string, operation: () => Promise<any>) => operation(),
      createNewSession: async () => ({}), sessionCwd: () => process.cwd(), state: () => ({}),
    });
    const session = {
      sessionId: "parent", sessionFile: "/tmp/parent.jsonl", agent: { waitForIdle: async () => undefined },
      bindExtensions: async (options: any) => { ui = options.uiContext; },
    };
    await bridge.bind(session);

    ui.web.reportSettlementDependencies({ sessionIds: ["worker"] });
    expect(wireEvents.at(-1)).toEqual({
      type: "settlement_dependencies", sessionId: "parent", childIds: ["worker"],
    });
    const status = await tracker.status("parent");
    expect(status.trackedWorkers).toEqual([{ id: "worker", state: "running", settled: false }]);

    const clientState: Record<string, string[]> = {};
    const store = createSettlementDependencyStore(clientState);
    await expect(store.hydrate("parent", async () => status.trackedWorkers.map((worker) => worker.id))).resolves.toBe(true);
    expect(clientState).toEqual({ parent: ["worker"] });
  });

  it("serializes and securely invokes artifact actions through the web bridge", async () => {
    let ui: any;
    const emitted: any[] = [];
    const cwd = await makeTempDir();
    await mkdir(join(cwd, ".pi", "web", "artifacts"), { recursive: true });
    await writeFile(join(cwd, ".pi", "web", "artifacts", "page.html"), "page");
    await writeFile(join(cwd, ".pi", "web", "artifacts", "notes.md"), "notes");
    const bridge = createWebUiBridge({
      emit: (value) => emitted.push(value), clientCount: () => 1, withWorkLease: (_session: any, _label: string, operation: () => Promise<any>) => operation(),
      createNewSession: async () => ({}), sessionCwd: () => cwd, state: () => ({}),
    });
    const session = {
      sessionId: "session", sessionFile: "/tmp/session.jsonl", agent: { waitForIdle: async () => undefined },
      bindExtensions: async (options: any) => { ui = options.uiContext; },
    };
    await bridge.bind(session);
    ui.web.setArtifactAction("download", {
      title: "Download", kinds: ["html"], extensions: [".html"],
      invoke: ({ name }: { name: string }) => ({ download: { filename: `saved-${name}` } }),
    });

    expect(bridge.entries(session).webContributions).toEqual([{
      version: 1, key: "download", slot: "artifact-action", kind: "rendered", title: "Download", label: undefined,
      match: { kinds: ["html"], extensions: [".html"] },
    }]);
    expect(emitted.at(-1)).toMatchObject({ type: "web_contributions_changed", sessionId: "session" });
    await expect(bridge.invokeArtifactAction(session, { key: "download", name: "page.html", path: "/api/artifacts/page.html", kind: "html" }))
      .resolves.toMatchObject({ download: { path: "/api/session-artifacts/session/page.html", filename: "saved-page.html" } });
    await expect(bridge.invokeContribution(session, {
      slot: "artifact-action", key: "download",
      event: { context: { key: "another-action", name: "page.html", path: "/api/artifacts/page.html", kind: "html" } },
    })).resolves.toMatchObject({ download: { filename: "saved-page.html" } });
    await expect(bridge.invokeArtifactAction(session, { key: "download", name: "notes.md", path: "/api/artifacts/notes.md", kind: "markdown" }))
      .rejects.toThrow("does not match this artifact");
    await expect(bridge.invokeArtifactAction(session, { key: "download", name: "page.html", path: "/api/artifacts/other.html", kind: "html" }))
      .rejects.toThrow("Invalid artifact context");

    ui.web.setArtifactAction("malformed", {
      title: "Malformed filters", kinds: "html", extensions: ".html",
      invoke: () => ({ message: "invoked" }),
    } as any);
    await expect(bridge.invokeArtifactAction(session, { key: "malformed", name: "notes.md", path: "/api/artifacts/notes.md", kind: "markdown" }))
      .resolves.toMatchObject({ message: "invoked" });
  });

  it("serializes and invokes sandboxed artifact preview renderers", async () => {
    let ui: any;
    const cwd = await makeTempDir();
    await mkdir(join(cwd, ".pi", "web", "artifacts", "prints"), { recursive: true });
    await writeFile(join(cwd, ".pi", "web", "artifacts", "prints", "part.gcode"), "gcode");
    await writeFile(join(cwd, ".pi", "web", "artifacts", "part.stl"), "stl");
    const bridge = createWebUiBridge({
      emit: () => undefined, clientCount: () => 1, withWorkLease: (_session: any, _label: string, operation: () => Promise<any>) => operation(),
      createNewSession: async () => ({}), sessionCwd: () => cwd, state: () => ({}),
    });
    const session = {
      sessionId: "session", sessionFile: "/tmp/session.jsonl", agent: { waitForIdle: async () => undefined },
      bindExtensions: async (options: any) => { ui = options.uiContext; },
    };
    await bridge.bind(session);
    ui.web.setArtifactPreview("gcode", {
      title: "G-code viewer", kinds: ["file"], extensions: [".gcode"],
      render: ({ name }: { name: string }) => ({ html: `<!doctype html><title>${name}</title>` }),
    });

    expect(bridge.entries(session).webContributions).toEqual([{
      version: 1, key: "gcode", slot: "artifact-preview", kind: "rendered", title: "G-code viewer", label: undefined,
      match: { kinds: ["file"], extensions: [".gcode"] },
    }]);
    await expect(bridge.invokeContribution(session, {
      slot: "artifact-preview", key: "gcode",
      event: { context: { name: "part.gcode", path: "/api/session-artifacts/session/prints/part.gcode", kind: "file" } },
    })).resolves.toMatchObject({ html: "<!doctype html><title>part.gcode</title>" });
    await expect(bridge.invokeContribution(session, {
      slot: "artifact-preview", key: "gcode",
      event: { context: { name: "part.stl", path: "/api/artifacts/part.stl", kind: "file" } },
    })).rejects.toThrow("does not match this artifact");

    const etxHtml = `<!doctype html><script>const jazz="93\x03Vocal";window.parts=[jazz.indexOf("\x03"),jazz.split("\x03")];</script>`;
    ui.web.setArtifactPreview("gcode", { title: "G-code viewer", extensions: [".gcode"], render: () => ({ html: etxHtml }) });
    await expect(bridge.invokeContribution(session, {
      slot: "artifact-preview", key: "gcode",
      event: { context: { name: "part.gcode", path: "/api/artifacts/prints/part.gcode", kind: "file" } },
    })).resolves.toMatchObject({ html: etxHtml });

    const boundedUnicode = "界".repeat(333_333);
    ui.web.setArtifactPreview("gcode", { title: "G-code viewer", extensions: [".gcode"], render: () => ({ html: boundedUnicode }) });
    await expect(bridge.invokeContribution(session, {
      slot: "artifact-preview", key: "gcode",
      event: { context: { name: "part.gcode", path: "/api/artifacts/prints/part.gcode", kind: "file" } },
    })).resolves.toMatchObject({ html: boundedUnicode });
    ui.web.setArtifactPreview("gcode", { title: "G-code viewer", extensions: [".gcode"], render: () => ({ html: `${boundedUnicode}界` }) });
    await expect(bridge.invokeContribution(session, {
      slot: "artifact-preview", key: "gcode",
      event: { context: { name: "part.gcode", path: "/api/artifacts/prints/part.gcode", kind: "file" } },
    })).rejects.toThrow("byte limit");
  });

  it("keeps legacy surfaces isolated over one contribution registry", async () => {
    let ui: any;
    const emitted: any[] = [];
    const bridge = createWebUiBridge({
      emit: (value) => emitted.push(value), clientCount: () => 1, withWorkLease: (_session: any, _label: string, operation: () => Promise<any>) => operation(),
      createNewSession: async () => ({}), sessionCwd: () => process.cwd(), state: () => ({}),
    });
    const session = {
      sessionId: "session", sessionFile: "/tmp/session.jsonl", agent: { waitForIdle: async () => undefined },
      bindExtensions: async (options: any) => { ui = options.uiContext; },
    };
    await bridge.bind(session);

    ui.web.setFooter("first", "one");
    ui.web.setFooter("shared", "ready");
    ui.web.setFooter("last", "three");
    ui.web.setFooter("shared", "updated");
    ui.web.setHeaderAction("shared", { title: "Summary", invoke: () => ({ markdown: "# Done" }) });
    ui.web.setGitTab("shared", { title: "Issues", render: () => ({ html: "<p>Open</p>" }) });
    const broadcastsBeforeInvalidKey = emitted.length;
    ui.web.setFooter("", "ignored");
    ui.web.setFooter("", undefined);

    expect(emitted).toHaveLength(broadcastsBeforeInvalidKey);
    const contributions = () => bridge.entries(session).webContributions;
    expect(contributions().filter((entry: any) => entry.slot === "footer").map(({ key }: { key: string }) => key)).toEqual(["first", "shared", "last"]);
    expect(contributions()).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "first", slot: "footer", view: { kind: "text", lines: ["one"] } }),
      expect.objectContaining({ key: "shared", slot: "footer", view: { kind: "text", lines: ["updated"] } }),
      expect.objectContaining({ key: "last", slot: "footer", view: { kind: "text", lines: ["three"] } }),
      expect.objectContaining({ key: "shared", slot: "header-action", title: "Summary" }),
      expect.objectContaining({ key: "shared", slot: "git-tab", title: "Issues" }),
    ]));
    await expect(bridge.invokeHeaderAction(session, "shared")).resolves.toMatchObject({ markdown: "# Done" });
    await expect(bridge.invokeGitTab(session, { key: "shared" })).resolves.toMatchObject({ html: "<p>Open</p>" });

    ui.web.setHeaderAction("shared", undefined);
    expect(contributions().filter((entry: any) => entry.slot === "header-action")).toEqual([]);
    expect(contributions().filter((entry: any) => entry.slot === "footer")).toHaveLength(3);
    expect(contributions().filter((entry: any) => entry.slot === "git-tab")).toHaveLength(1);
    expect(emitted.at(-1)).toMatchObject({ type: "web_contributions_changed" });
  });

  it("uses the generic interaction request/respond envelope for extension dialogs", async () => {
    let ui: any;
    const emitted: any[] = [];
    const bridge = createWebUiBridge({
      emit: (value) => emitted.push(value), clientCount: () => 1, withWorkLease: (_session: any, _label: string, operation: () => Promise<any>) => operation(),
      createNewSession: async () => ({}), sessionCwd: () => process.cwd(), state: () => ({}),
    });
    await bridge.bind({
      sessionId: "session", sessionFile: "/tmp/session.jsonl", agent: { waitForIdle: async () => undefined },
      bindExtensions: async (options: any) => { ui = options.uiContext; },
    });

    const answer = ui.select("Choose", ["one", "two"], { timeout: 1_000 });
    expect(emitted.at(-1)).toMatchObject({
      type: "interaction_request", source: "extension", kind: "select",
      payload: { title: "Choose", options: ["one", "two"] }, sessionId: "session",
    });
    expect(bridge.respond(emitted.at(-1).id, { value: "two" })).toBe(true);
    await expect(answer).resolves.toBe("two");

    const disconnected = ui.confirm("Allow?", "Run tool", { timeout: 1_000 });
    bridge.cancelPendingInteractions();
    await expect(disconnected).resolves.toBe(false);

    vi.useFakeTimers();
    const timedOut = ui.input("Secret", "value", { timeout: 25 });
    await vi.advanceTimersByTimeAsync(25);
    await expect(timedOut).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it("publishes normalized contributions and emits pull invalidations", async () => {
    let ui: any;
    let bindOptions: any;
    const emitted: any[] = [];
    const bridge = createWebUiBridge({
      emit: (value) => emitted.push(value), clientCount: () => 1, withWorkLease: (_session: any, _label: string, operation: () => Promise<any>) => operation(),
      createNewSession: async () => ({}), sessionCwd: () => process.cwd(), state: () => ({}),
    });
    const session = {
      sessionId: "session", sessionFile: "/tmp/session.jsonl", agent: { waitForIdle: async () => undefined },
      bindExtensions: async (options: any) => { ui = options.uiContext; bindOptions = options; },
    };
    await bridge.bind(session);

    expect(ui.web.capabilities).toEqual({
      apiVersion: 1,
      slots: ["footer", "header-action", "artifact-action", "artifact-preview", "git-tab", "panel", "system-info", "fab", "composer-input"],
      kinds: ["static", "rendered", "capture"],
      effects: ["open-panel", "insert-composer-text", "add-composer-context"],
      artifactPreview: { assets: true, theme: true, interactions: true, viewport: true },
    });
    expect(Object.isFrozen(ui.web.capabilities)).toBe(true);
    expect(Object.isFrozen(ui.web.capabilities.slots)).toBe(true);

    bindOptions.onError({ extensionPath: "/tmp/broken.ts", eventName: "session_start", error: new Error("registration failed") });
    expect(bridge.runtimeErrors(session)).toEqual([
      expect.objectContaining({ path: "/tmp/broken.ts", event: "session_start", error: "registration failed" }),
    ]);
    for (let index = 0; index < 21; index++) bindOptions.onError({ extensionPath: "/tmp/noisy.ts", eventName: "turn_start", error: `failure ${index}` });
    expect(bridge.runtimeErrors(session)).toHaveLength(20);
    expect(bridge.runtimeErrors(session).at(-1)).toMatchObject({ error: "failure 20" });

    let revision = 1;
    ui.web.contribute("status", {
      slot: "panel", kind: "rendered", title: "Worker status",
      render: () => ({ html: `<p>Revision ${revision}</p>` }),
    });
    expect(bridge.entries(session).webContributions).toEqual([
      expect.objectContaining({ version: 1, key: "status", slot: "panel", kind: "rendered", title: "Worker status" }),
    ]);
    await expect(bridge.invokeContribution(session, { slot: "panel", key: "status" }))
      .resolves.toMatchObject({ html: "<p>Revision 1</p>" });

    revision += 1;
    ui.web.update("status");
    expect(emitted.at(-1)).toMatchObject({ type: "web_contribution_updated", sessionId: "session", key: "status" });
    const eventCount = emitted.length;
    ui.web.update("missing");
    expect(emitted).toHaveLength(eventCount);

    ui.web.contribute("status", { slot: "footer", kind: "static", view: "Ready" });
    expect(bridge.entries(session).webContributions).toEqual([
      expect.objectContaining({ key: "status", slot: "footer", kind: "static" }),
    ]);
    expect(() => ui.web.contribute("bad", { slot: "panel", kind: "static", view: {} })).toThrow("Unsupported contribution slot/kind");
    expect(() => ui.web.contribute("conflict", {
      slot: "panel", kind: "rendered", title: "Conflict", view: {}, render: () => ({ html: "" }),
    })).toThrow("conflicting or missing delivery fields");
    ui.web.contribute("status", undefined);
    expect(bridge.entries(session).webContributions).toEqual([]);
  });

  it("normalizes revision-bound artifact preview review interactions", async () => {
    let ui: any;
    const cwd = await makeTempDir();
    await mkdir(join(cwd, ".pi", "web", "artifacts"), { recursive: true });
    await writeFile(join(cwd, ".pi", "web", "artifacts", "song.song"), "song");
    await writeFile(join(cwd, ".pi", "web", "artifacts", "song.source"), "source");
    const bridge = createWebUiBridge({
      emit: () => undefined, clientCount: () => 1,
      withWorkLease: (_session: any, _label: string, operation: () => Promise<any>) => operation(),
      createNewSession: async () => ({}), sessionCwd: () => cwd, state: () => ({}),
    });
    const session = {
      sessionId: "session", sessionFile: "/tmp/session.jsonl", agent: { waitForIdle: async () => undefined },
      bindExtensions: async (options: any) => { ui = options.uiContext; },
    };
    await bridge.bind(session);
    const invoke = vi.fn(({ action, payload, context }: any) => ({
      status: "review",
      review: {
        title: "Review source edit",
        summary: `${action}:${payload.selection}`,
        effects: [
          { type: "insert-composer-text", text: `Edit ${payload.selection}`, placement: "end" },
          { type: "add-composer-context", context: {
            type: "reference", id: "artifact:song", label: "Song source", title: "Frozen source",
            reference: { provider: "artifact", path: "music/song.source", sha256: "a".repeat(64), snapshot: { revision: "7" }, ranges: [{ start: 2, end: 9, unit: "utf16", label: "passage" }] },
          } },
        ],
      },
    }));
    ui.web.setArtifactPreview("score.viewer", {
      title: "Score", extensions: [".song"], render: () => ({ html: "<p>score</p>" }),
      interactions: { actions: ["review-edit"], invoke },
    });
    const descriptor = bridge.entries(session).webContributions[0] as any;
    expect(descriptor.interaction.actions).toEqual(["review-edit"]);
    expect(descriptor.interaction.registrationId).toMatch(/^[a-f0-9-]{36}$/);
    const input = {
      slot: "artifact-preview", key: "score.viewer",
      event: {
        context: { name: "song.song", path: "/api/artifacts/song.song", kind: "file" },
        registrationId: descriptor.interaction.registrationId, action: "review-edit", payload: { selection: "bars 2-4" },
      },
    };
    await expect(bridge.invokeContribution(session, input)).resolves.toEqual({
      status: "review",
      review: {
        title: "Review source edit", summary: "review-edit:bars 2-4",
        effects: [
          { type: "insert-composer-text", text: "Edit bars 2-4", placement: "end" },
          { type: "add-composer-context", context: expect.objectContaining({ reference: expect.objectContaining({ provider: "artifact", path: "music/song.source", sha256: "a".repeat(64) }) }) },
        ],
      },
    });
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ action: "review-edit", context: { name: "song.song", path: "/api/session-artifacts/session/song.song", kind: "file" } }));
    await expect(bridge.invokeContribution(session, { ...input, event: { ...input.event, context: { ...input.event.context, path: "/api/artifacts/%73ong.song" } } }))
      .resolves.toMatchObject({ status: "review" });
    for (const path of [
      "/api/session-artifacts/foreign/song.song",
      "/api/artifacts/dir/../song.song",
      "/api/artifacts/%2e%2e/song.song",
      "/api/artifacts/dir%2Fsong.song",
      "/api/artifacts/dir%5Csong.song",
      "/api/artifacts/song.song?other=1",
      "/api/artifacts/song.song#other",
    ]) {
      await expect(bridge.invokeContribution(session, { ...input, event: { ...input.event, context: { ...input.event.context, path } } })).rejects.toThrow("Invalid artifact context");
    }
    await expect(bridge.invokeContribution(session, { ...input, event: { ...input.event, registrationId: "stale" } })).resolves.toMatchObject({ status: "stale" });
    await expect(bridge.invokeContribution(session, { ...input, event: { ...input.event, action: "undeclared" } })).resolves.toMatchObject({ status: "unsupported" });
    await expect(bridge.invokeContribution(session, { ...input, event: { ...input.event, payload: { value: "x".repeat(40_000) } } })).rejects.toThrow("too large");
    await expect(bridge.invokeContribution(session, { ...input, event: { ...input.event, payload: { value: "界".repeat(11_000) } } })).rejects.toThrow("too large");

    const validResult: any = invoke({ action: "review-edit", payload: { selection: "x" }, context: input.event.context });
    const malformed = [
      { ...validResult, extra: "no" },
      { ...validResult, review: { ...validResult.review, extra: "no" } },
      { ...validResult, review: { ...validResult.review, effects: [{ ...validResult.review.effects[0], extra: "no" }, validResult.review.effects[1]] } },
      { ...validResult, review: { ...validResult.review, effects: [{ ...validResult.review.effects[0], placement: "selection" }, validResult.review.effects[1]] } },
      { ...validResult, review: { ...validResult.review, effects: [validResult.review.effects[0], { ...validResult.review.effects[1], context: { ...validResult.review.effects[1].context, extra: "no" } }] } },
      { ...validResult, review: { ...validResult.review, effects: [validResult.review.effects[0], { ...validResult.review.effects[1], context: { ...validResult.review.effects[1].context, reference: { ...validResult.review.effects[1].context.reference, extra: "no" } } }] } },
      { ...validResult, review: { ...validResult.review, effects: [validResult.review.effects[0], { ...validResult.review.effects[1], context: { ...validResult.review.effects[1].context, reference: { ...validResult.review.effects[1].context.reference, snapshot: { revision: "7", extra: "no" } } } }] } },
      { ...validResult, review: { ...validResult.review, effects: [validResult.review.effects[0], { ...validResult.review.effects[1], context: { ...validResult.review.effects[1].context, reference: { ...validResult.review.effects[1].context.reference, ranges: [{ start: 2, end: 9, unit: "utf16", extra: "no" }] } } }] } },
    ];
    for (const result of malformed) {
      ui.web.setArtifactPreview("score.viewer", { title: "Score", extensions: [".song"], render: () => ({ html: "<p>score</p>" }), interactions: { actions: ["review-edit"], invoke: () => result } });
      const current = bridge.entries(session).webContributions[0] as any;
      await expect(bridge.invokeContribution(session, { ...input, event: { ...input.event, registrationId: current.interaction.registrationId } })).rejects.toThrow(/unsupported|no supported/);
    }
  });

  it("publishes and securely invokes generic composer audio capture contributions", async () => {
    let ui: any;
    let received: any;
    const released: string[] = [];
    let registrationId = "";
    const captureStore = {
      consume: vi.fn(async (_id: string, owner: any, policy: any) => {
        expect(owner).toEqual({ sessionId: "session", contributionKey: "voice.input", registrationId });
        expect(policy).toMatchObject({ maxSeconds: 30, maxBytes: 2_000_000 });
        return { path: "/private/capture", mimeType: "audio/webm", size: 42, durationMs: 900 };
      }),
      releasePath: vi.fn(async (path: string) => { released.push(path); }),
    };
    const bridge = createWebUiBridge({
      captureStore, emit: () => undefined, clientCount: () => 1,
      withWorkLease: (_session: any, _label: string, operation: () => Promise<any>) => operation(),
      createNewSession: async () => ({}), sessionCwd: () => process.cwd(), state: () => ({}),
    });
    const session = {
      sessionId: "session", sessionFile: "/tmp/session.jsonl", agent: { waitForIdle: async () => undefined },
      bindExtensions: async (options: any) => { ui = options.uiContext; },
    };
    await bridge.bind(session);
    ui.web.contribute("voice.input", {
      slot: "composer-input", kind: "capture", title: "Dictate", icon: "mic",
      capture: { media: "audio", maxSeconds: 30, maxBytes: 2_000_000, mimeTypes: ["audio/webm"] },
      invoke: ({ capture, signal }: any) => {
        expect(signal).toBeInstanceOf(AbortSignal);
        received = capture;
        return { effects: [{ type: "insert-composer-text", text: "transcript", placement: "selection" }] };
      },
    });

    const descriptor = bridge.entries(session).webContributions[0] as any;
    registrationId = descriptor.capture.registrationId;
    expect(registrationId).toMatch(/^[a-f0-9-]{36}$/);
    expect(descriptor).toEqual({
      version: 1, key: "voice.input", slot: "composer-input", kind: "capture", title: "Dictate", label: undefined, icon: "mic",
      capture: { media: "audio", maxSeconds: 30, maxBytes: 2_000_000, mimeTypes: ["audio/webm"], registrationId },
    });
    expect(bridge.captureRegistration(session, "voice.input", registrationId)).toEqual({
      key: "voice.input", registrationId, policy: { media: "audio", maxSeconds: 30, maxBytes: 2_000_000, mimeTypes: ["audio/webm"] },
    });
    await expect(bridge.invokeContribution(session, { slot: "composer-input", key: "voice.input", event: { captureId: "owned-id", capture: { path: "/attacker" } } }))
      .resolves.toEqual({ label: "Dictate", effects: [{ type: "insert-composer-text", text: "transcript", placement: "selection" }] });
    expect(received).toEqual({ path: "/private/capture", mimeType: "audio/webm", size: 42, durationMs: 900 });
    expect(captureStore.consume).toHaveBeenCalledWith("owned-id", { sessionId: "session", contributionKey: "voice.input", registrationId }, expect.any(Object));
    expect(released).toEqual(["/private/capture"]);

    ui.web.contribute("voice.input", {
      slot: "composer-input", kind: "capture", title: "Replacement",
      capture: { media: "audio", maxSeconds: 10 }, invoke: () => ({ effects: [{ type: "insert-composer-text", text: "new" }] }),
    });
    const replacement = (bridge.entries(session).webContributions[0] as any).capture.registrationId;
    expect(replacement).not.toBe(registrationId);
    expect(bridge.captureRegistration(session, "voice.input", registrationId)).toBeUndefined();

    const contribution = (mimeTypes: unknown) => ({
      slot: "composer-input", kind: "capture", title: "MIME validation",
      capture: { media: "audio", mimeTypes },
      invoke: () => ({ effects: [{ type: "insert-composer-text", text: "ok" }] }),
    });
    expect(() => ui.web.contribute("mime.nonarray", contribution("audio/webm"))).toThrow("non-empty array");
    expect(() => ui.web.contribute("mime.empty", contribution([]))).toThrow("between 1 and 20");
    expect(() => ui.web.contribute("mime.invalid", contribution(["text/plain", 7]))).toThrow("valid audio MIME");
    expect(() => ui.web.contribute("mime.mixed", contribution(["audio/webm", "bad"]))).toThrow("valid audio MIME");
    expect(() => ui.web.contribute("mime.first", contribution(["audio/!private"]))).toThrow("valid audio MIME");
    expect(() => ui.web.contribute("mime.long", contribution([`audio/${"a".repeat(128)}`]))).toThrow("valid audio MIME");
    expect(() => ui.web.contribute("mime.many", contribution(Array.from({ length: 21 }, () => "audio/webm")))).toThrow("between 1 and 20");
    ui.web.contribute("mime.normalized", contribution([
      " Audio/WebM; codecs=opus ", "audio/webm", "audio/x-private-", "audio/vnd.example.codec+json",
    ]));
    expect((bridge.entries(session).webContributions.find((entry: any) => entry.key === "mime.normalized") as any).capture.mimeTypes)
      .toEqual(["audio/webm", "audio/x-private-", "audio/vnd.example.codec+json"]);
  });

  it("aborts a non-cooperative capture invocation and releases its file", async () => {
    let ui: any;
    const releasePath = vi.fn(async () => undefined);
    const bridge = createWebUiBridge({
      captureStore: {
        consume: async () => ({ path: "/private/hung", mimeType: "audio/webm", size: 1, durationMs: 1 }),
        releasePath,
      },
      emit: () => undefined, clientCount: () => 1,
      withWorkLease: (_session: any, _label: string, operation: () => Promise<any>) => operation(),
      createNewSession: async () => ({}), sessionCwd: () => process.cwd(), state: () => ({}),
    });
    const session = { sessionId: "session", bindExtensions: async (options: any) => { ui = options.uiContext; } };
    await bridge.bind(session);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    ui.web.contribute("hung", {
      slot: "composer-input", kind: "capture", title: "Hung", capture: { media: "audio" },
      invoke: () => { markStarted(); return new Promise(() => undefined); },
    });
    const controller = new AbortController();
    const invoked = bridge.invokeContribution(session, { slot: "composer-input", key: "hung", event: { captureId: "id" } }, controller.signal);
    await started;
    controller.abort();
    await expect(invoked).rejects.toMatchObject({ status: 408 });
    expect(releasePath).toHaveBeenCalledWith("/private/hung");
  });

  it("registers, invokes, sanitizes, and clears system-info contributions", async () => {
    let ui: any;
    const emitted: any[] = [];
    const bridge = createWebUiBridge({
      emit: (value) => emitted.push(value), clientCount: () => 1, withWorkLease: (_session: any, _label: string, operation: () => Promise<any>) => operation(),
      createNewSession: async () => ({}), sessionCwd: () => process.cwd(), state: () => ({}),
    });
    const session = {
      sessionId: "session", sessionFile: "/tmp/session.jsonl", agent: { waitForIdle: async () => undefined },
      bindExtensions: async (options: any) => { ui = options.uiContext; },
    };
    await bridge.bind(session);

    let received: any;
    ui.web.setSystemInfo(" acme status! ", {
      title: "  Runtime\u0000 status  ", label: "  Status  ",
      render: (event: any) => {
        received = event;
        return { title: " Updated\u0000 title ", html: "<p>Ready\u0000</p>" };
      },
    });
    expect(bridge.entries(session).webContributions).toEqual([{
      version: 1, key: "acme-status-", slot: "system-info", kind: "rendered", title: "Runtime status", label: "Status",
    }]);
    expect(emitted.at(-1)).toMatchObject({ type: "web_contributions_changed", sessionId: "session" });

    await expect(bridge.invokeContribution(session, {
      slot: "system-info", key: "acme-status-", event: {
        action: " save\u0000 ", payload: { revision: 2 },
        fields: { " note\u0000 ": "ok\u0000", tags: ["one\u0000", 2], ignored: 3 },
      },
    })).resolves.toEqual({ title: "Updated title", html: "<p>Ready</p>" });
    expect(received).toEqual({ action: "save", payload: { revision: 2 }, fields: { note: "ok", tags: ["one"] } });

    ui.web.setSystemInfo("empty", { title: "Empty", render: () => ({ html: "" }) });
    await expect(bridge.invokeContribution(session, { slot: "system-info", key: "empty" }))
      .rejects.toThrow("System-info contribution returned no HTML");
    await expect(bridge.invokeContribution(session, { slot: "system-info", key: "missing" }))
      .rejects.toThrow("System-info contribution not found");

    ui.web.setSystemInfo("acme status!", undefined);
    expect(bridge.entries(session).webContributions.map((entry: any) => entry.key)).toEqual(["empty"]);
  });

  it("serializes and invokes FAB-backed web panels through the web bridge", async () => {
    let ui: any;
    const emitted: any[] = [];
    const bridge = createWebUiBridge({
      emit: (value) => emitted.push(value), clientCount: () => 1, withWorkLease: (_session: any, _label: string, operation: () => Promise<any>) => operation(),
      createNewSession: async () => ({}), sessionCwd: () => process.cwd(), state: () => ({}),
    } as any);
    const session = {
      sessionId: "session", sessionFile: "/tmp/session.jsonl", agent: { waitForIdle: async () => undefined },
      bindExtensions: async (options: any) => { ui = options.uiContext; },
    };
    await bridge.bind(session);
    let lastPanelEvent: any;
    ui.web.setPanel("notes", {
      title: "Global notes", label: "Notepad", icon: "notebook-pen",
      render: (event: any) => {
        lastPanelEvent = event;
        return { title: event?.action === "save" ? "Saved notes" : undefined, html: `<p>${event?.fields?.content || "empty"}</p>` };
      },
    });

    // Panels are pure surfaces: registering one contributes no FAB entry.
    expect(bridge.entries(session).webContributions).toEqual([
      { version: 1, key: "notes", slot: "panel", kind: "rendered", title: "Global notes", label: "Notepad", icon: "notebook-pen" },
    ]);
    expect(emitted.at(-1)).toMatchObject({ type: "web_contributions_changed", sessionId: "session" });

    // Entry points are explicit registrations that reference a panel.
    ui.web.setFabAction("notes-launcher", { title: "Notes", icon: "notebook-pen", opens: "notes" });
    expect(bridge.entries(session).webContributions).toContainEqual(
      { version: 1, key: "notes-launcher", slot: "fab", kind: "static", title: "Notes", label: undefined, icon: "notebook-pen", opens: "notes" },
    );
    expect(emitted.at(-1)).toMatchObject({ type: "web_contributions_changed", sessionId: "session" });
    ui.web.setFabAction("notes-launcher", undefined);
    expect(bridge.entries(session).webContributions.filter((entry: any) => entry.slot === "fab")).toEqual([]);

    const manyFields = Object.fromEntries(Array.from({ length: 130 }, (_, index) => [`field-${index}`, "value"]));
    await expect(bridge.invokeContribution(session, {
      slot: "panel", key: "notes", event: { action: "save", fields: { content: "remember me\n", ...manyFields } },
    })).resolves.toEqual({ title: "Saved notes", html: "<p>remember me\n</p>" });
    expect(lastPanelEvent.fields.content).toBe("remember me\n");
    expect(Object.keys(lastPanelEvent.fields)).toHaveLength(128);
    await expect(bridge.invokePanel(session, { key: "missing" })).rejects.toThrow("Panel not found");

    // Launchers are decoupled from panels: a header action can open one.
    ui.web.setHeaderAction("open-notes", { title: "Open notes", invoke: () => ({ effects: [{ type: "open-panel", key: "notes" }] }) });
    await expect(bridge.invokeContribution(session, { slot: "header-action", key: "open-notes" }))
      .resolves.toEqual({ label: "Open notes", effects: [{ type: "open-panel", key: "notes" }] });
    ui.web.setHeaderAction("open-missing", { title: "Broken", invoke: () => ({ effects: [{ type: "open-panel", key: "nope" }] }) });
    await expect(bridge.invokeHeaderAction(session, "open-missing")).rejects.toThrow('unknown panel "nope"');
  });

  it("re-emits a footer when the same session id gets a new runtime", async () => {
    vi.useFakeTimers();
    try {
      const handlers = new Map<string, Array<(event: unknown, context: any) => unknown>>();
      const extension = createGitFooterExtension({
        git: async (args) => {
          if (args[0] === "rev-parse") return { ok: true, output: "true" };
          if (args[0] === "branch") return { ok: true, output: "main" };
          return { ok: true, output: "" };
        },
      });
      extension({
        on(event: string, handler: (event: unknown, context: any) => unknown) {
          const list = handlers.get(event) || [];
          list.push(handler);
          handlers.set(event, list);
        },
      } as any);

      const makeContext = () => {
        const calls: Array<[string, unknown]> = [];
        const sessionManager = { getSessionId: () => "same-session", getCwd: () => process.cwd() };
        return {
          calls,
          context: {
            cwd: process.cwd(),
            sessionManager,
            ui: { web: { contribute: (key: string, contribution: unknown) => calls.push([key, contribution]) } },
          },
        };
      };
      const first = makeContext();
      const replacement = makeContext();
      const start = handlers.get("session_start")![0];
      const shutdown = handlers.get("session_shutdown")![0];

      await start({}, first.context);
      await vi.advanceTimersByTimeAsync(0);
      await start({}, replacement.context);
      await vi.advanceTimersByTimeAsync(0);
      expect(first.calls.at(-1)?.[1]).toMatchObject({ slot: "footer", kind: "static", view: { kind: "html" } });
      expect(replacement.calls.at(-1)?.[1]).toMatchObject({ slot: "footer", kind: "static", view: { kind: "html" } });

      await shutdown({}, first.context);
      expect(replacement.calls.at(-1)?.[1]).toMatchObject({ slot: "footer", kind: "static", view: { kind: "html" } });
      await shutdown({}, replacement.context);
      expect(replacement.calls.at(-1)).toEqual(["local-git-footer", undefined]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not overlap footer refreshes when a Git command stalls", async () => {
    vi.useFakeTimers();
    try {
      const handlers = new Map<string, (event: unknown, context: any) => unknown>();
      const git = vi.fn(() => new Promise<{ ok: boolean; output: string }>(() => undefined));
      createGitFooterExtension({ git, refreshMs: 10 })({
        on: (event: string, handler: (event: unknown, context: any) => unknown) => handlers.set(event, handler),
      } as any);
      const calls: Array<[string, unknown]> = [];
      const sessionManager = { getSessionId: () => "stalled-git", getCwd: () => process.cwd() };
      const context = {
        cwd: process.cwd(),
        sessionManager,
        ui: { web: { contribute: (key: string, contribution: unknown) => calls.push([key, contribution]) } },
      };

      handlers.get("session_start")?.({}, context);
      await vi.advanceTimersByTimeAsync(100);

      expect(git).toHaveBeenCalledTimes(1);
      expect(calls).toEqual([]);

      handlers.get("session_shutdown")?.({}, context);
      expect(calls).toEqual([["local-git-footer", undefined]]);
    } finally {
      vi.useRealTimers();
    }
  });
});
