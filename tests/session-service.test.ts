import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonRoundTrip, type MessageDto, type SessionServiceEvent } from "../server/session/dto.js";
import { SessionActivity } from "../server/session/activity.js";
import { createHostSessionEventHandler, decorateHostMessages, resolveWebSocketHelloSession } from "../server/session/hostEvents.js";
import { LocalSessionService, type LocalSessionFactory, type LocalSessionServiceDependencies } from "../server/session/service.js";
import type { PiWebSession } from "../server/types.js";

const tempDirs: string[] = [];
let fixtureSessionSequence = 0;
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function fixtureSession(cwd: string, id = "current", path = join(cwd, `${id}.jsonl`)) {
  const entries: any[] = [
    { id: "call", parentId: null, type: "message", timestamp: "2026-01-01T00:00:00Z", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", toolName: "read", arguments: { path: "secret" } }], timestamp: "2026-01-01T00:00:00Z" } },
    { id: "result", parentId: "call", type: "message", timestamp: "2026-01-01T00:00:01Z", message: { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, timestamp: "2026-01-01T00:00:01Z" } },
  ];
  const listeners = new Set<(event: unknown) => void>();
  const model = { provider: "test", id: "model", name: "Model", reasoning: true, contextWindow: 1000, maxTokens: 100 };
  let session: PiWebSession;
  let extensionOptions: any;
  let disposeCalls = 0;
  const syncMessages = () => {
    const messages = entries.map((entry) => entry.message);
    session.messages = messages;
    session.agent.state.messages = messages;
  };
  session = {
    sessionId: id, sessionFile: path, isStreaming: false, isCompacting: false,
    model, thinkingLevel: "medium", messages: [], agent: { state: { messages: [] } },
    sessionManager: {
      newSession() {
        session.sessionId = `created-${++fixtureSessionSequence}`;
        session.sessionFile = join(cwd, `${session.sessionId}.jsonl`);
        entries.splice(0);
        syncMessages();
      },
      buildSessionContext: () => ({ messages: entries.map((entry) => entry.message) }),
      getBranch: () => entries,
      getLeafId: () => entries.at(-1)?.id || null,
      getTree: () => entries.length ? [{ entry: entries[0], children: entries.slice(1).map((entry) => ({ entry, children: [] })) }] : [],
      getSessionName: () => "Fixture",
      getCwd: () => cwd,
    } as PiWebSession["sessionManager"],
    modelRuntime: { getAvailableSnapshot: () => [model], getModel: () => model },
    extensionRunner: { getRegisteredCommands: () => [] }, promptTemplates: [], resourceLoader: { getSkills: () => ({ skills: [] }) },
    bindExtensions: async (options) => { extensionOptions = options; },
    getAvailableThinkingLevels: () => ["off", "medium"], getSessionName: () => "Fixture", getContextUsage: () => ({ tokens: 1, contextWindow: 1000, percent: 0.1 }),
    setSessionName: (name) => { session.sessionName = name; },
    setModel: vi.fn(async () => undefined), setThinkingLevel: vi.fn(), abort: async () => undefined,
    navigateTree: async () => ({ cancelled: false, editorText: "draft" }),
    prompt: async (message) => {
      const eventMessage = { role: "user", content: message, timestamp: "2026-01-01T00:00:02Z" };
      entries.push({ id: `user-${entries.length}`, parentId: entries.at(-1)?.id || null, type: "message", timestamp: eventMessage.timestamp, message: eventMessage });
      syncMessages();
      listeners.forEach((listener) => listener({ type: "message_end", message: eventMessage }));
    },
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  (session as any).dispose = () => { disposeCalls++; };
  syncMessages();
  return {
    session,
    emit(event: unknown) { listeners.forEach((listener) => listener(event)); },
    get extensionOptions() { return extensionOptions; },
    get disposeCalls() { return disposeCalls; },
  };
}

type FixtureServiceOptions = {
  isMock?: boolean;
  finalizeCreatedSession?: (sessionId: string) => Promise<unknown>;
  list?: LocalSessionFactory["list"];
};

async function fixtureService(options: FixtureServiceOptions = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-service-"));
  tempDirs.push(cwd);
  const sessions = new Map<string, ReturnType<typeof fixtureSession>>();
  const creates: Array<{ cwd: string; path?: string; reason?: string; previous?: string }> = [];
  const factory: LocalSessionFactory = {
    isMock: options.isMock,
    async create(input) {
      creates.push({ cwd: input.cwd, path: input.path, reason: input.sessionStartEvent?.reason, previous: input.sessionStartEvent?.previousSessionFile });
      const id = input.path ? input.path.split("/").at(-1)?.replace(/\.jsonl$/, "") || "opened" : creates.length === 1 ? "current" : `factory-${creates.length}`;
      const value = fixtureSession(input.cwd, id, input.path);
      sessions.set(id, value);
      return { session: value.session };
    },
    list: options.list || (async () => []),
  };
  const deps: LocalSessionServiceDependencies = {
    modelRuntime: {} as LocalSessionServiceDependencies["modelRuntime"],
    sessionFactory: factory,
    additionalExtensionPaths: () => [],
    sessionConfig: {
      defaultsFor: async () => ({}),
      finalizeCreatedSession: options.finalizeCreatedSession || (async () => undefined),
    },
    globalCwd: () => cwd,
    clientCount: () => 0,
  };
  const service = new LocalSessionService(deps);
  const initial = await service.initialize();
  return { service, initial, fixture: sessions.get("current")!, creates, cwd };
}

describe("LocalSessionService contract", () => {
  it("constructs and works standalone without importing server.ts", async () => {
    const { service, initial } = await fixtureService();
    const events: SessionServiceEvent[] = [];
    service.subscribe((event) => events.push(event));

    const created = await service.create(initial.sessionId);
    await service.prompt(created.sessionId, { message: "hello", mode: "steer", images: [] });

    expect(await service.state(created.sessionId)).toMatchObject({
      sessionId: created.sessionId,
      capabilities: { harness: "pi", queue: true, tree: true, interactions: true },
    });
    expect(await service.messages(created.sessionId)).toContainEqual(expect.objectContaining({ role: "user", text: "hello" }));
    expect(events.map((event) => event.type)).toContain("agent");
    expect(events.map((event) => event.type)).toContain("stats");
    expect(events).toContainEqual(expect.objectContaining({
      type: "committed",
      sessionId: created.sessionId,
      message: expect.objectContaining({ role: "user", text: "hello", entryId: "user-2" }),
    }));

    initial.prompt = async () => { throw new Error("prompt failed"); };
    await service.prompt(initial.sessionId, { message: "fail", mode: "steer", images: [] });
    await vi.waitFor(() => expect(events.map((event) => event.type)).toContain("error"));
    await service.disposeAll("reset");
    expect(events.map((event) => event.type)).toContain("shutdown");
    for (const event of events) expect(jsonRoundTrip(event)).toStrictEqual(event);
  });

  it("returns JSON-round-trip-stable projection results and events", async () => {
    const { service, fixture, initial } = await fixtureService();
    const events: SessionServiceEvent[] = [];
    service.subscribe((event) => events.push(event));
    fixture.emit({ type: "session_info_changed", name: "Renamed" });
    fixture.emit({ type: "message_end", message: { role: "assistant", model: "blocked", errorMessage: "model_not_supported" } });

    const results = await Promise.all([
      service.state(initial.sessionId), service.stats(initial.sessionId), service.tree(initial.sessionId),
      service.messages(initial.sessionId), service.models(initial.sessionId), service.commands(initial.sessionId),
      service.setModel(initial.sessionId, "test", "model"), service.rename(initial.sessionId, "Renamed"),
      service.open(initial.sessionId), service.create(initial.sessionId),
    ]);
    for (const result of results) expect(jsonRoundTrip(result)).toStrictEqual(result);
    expect(events.map((event) => event.type)).toEqual(["agent", "state", "agent", "stats", "models"]);
    for (const event of events) expect(jsonRoundTrip(event)).toStrictEqual(event);
  });

  it("keeps navigation data serializable and its finalizer serving-side", async () => {
    const { service, initial } = await fixtureService();
    const { finish, ...result } = await service.navigate(initial.sessionId, "result", {});
    expect(jsonRoundTrip(result)).toStrictEqual(result);
    expect(finish).toEqual(expect.any(Function));
    finish();
  });

  it("maps unavailable conversation trees to the legacy 400 status", async () => {
    const { service, initial } = await fixtureService();
    initial.sessionManager.getTree = undefined;
    await expect(service.tree(initial.sessionId)).rejects.toMatchObject({ status: 400 });
  });

  it("preserves message args and empty thinking-level behavior", async () => {
    const { service, initial } = await fixtureService();
    const messages = await service.messages(initial.sessionId);
    expect(messages[1].toolArgs).toEqual({ path: "secret" });
    await service.setModel(initial.sessionId, "test", "model", "");
    expect(initial.setThinkingLevel).toHaveBeenCalledWith("");
  });

  it("implicitly inherits the current session but lets unknown sources fall back globally", async () => {
    const { service, initial, creates, cwd } = await fixtureService();
    const currentCwd = await mkdtemp(join(cwd, "current-cwd-"));
    initial.sessionManager.getCwd = () => currentCwd;
    await service.create(undefined);
    await service.create("missing");
    expect(creates.slice(1)).toEqual([
      { cwd: currentCwd, path: undefined, reason: "new", previous: initial.sessionFile },
      { cwd, path: undefined, reason: "new", previous: undefined },
    ]);
  });

  it("delegates artifact actions for the implicitly resolved current session", async () => {
    const { service, fixture } = await fixtureService();
    const invoke = vi.fn(() => ({ message: "downloaded" }));
    fixture.extensionOptions.uiContext.web.setArtifactAction("download", { invoke });
    const input = { key: "download", name: "report.md", path: "/api/artifacts/report.md", kind: "markdown" };
    await expect(service.invokeArtifactAction(undefined, input)).resolves.toEqual({ label: "download", message: "downloaded" });
    expect(invoke).toHaveBeenCalledWith({ name: "report.md", path: "/api/artifacts/report.md", kind: "markdown" });
  });

  it("preserves duplicate session IDs returned by different cwd listings", async () => {
    const modified = new Date("2026-01-02T00:00:00Z");
    const { service, cwd } = await fixtureService({
      list: async (listedCwd) => [{ id: "duplicate", path: join(listedCwd, "duplicate.jsonl"), created: modified, modified, messageCount: 1, cwd: listedCwd }],
    });
    const extraCwd = await mkdtemp(join(cwd, "extra-cwd-"));
    expect((await service.list([extraCwd])).map((info) => info.id)).toEqual(["duplicate", "duplicate"]);
  });

  it("runs the host post-create finalizer before extension-created state publication", async () => {
    const order: string[] = [];
    const { service, fixture } = await fixtureService({
      finalizeCreatedSession: async () => { order.push("session_ui_state_changed"); },
    });
    service.subscribe((event) => {
      if (event.type === "wire" && (event.value as any).type === "state_changed") order.push("state_changed");
    });
    await fixture.extensionOptions.commandContextActions.newSession();
    expect(order).toEqual(["session_ui_state_changed", "state_changed"]);
  });

  it("keeps the dependency surface to six true externals", async () => {
    const source = await readFile(new URL("../server/session/service.ts", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("export interface LocalSessionServiceDependencies"), source.indexOf("}\n\ntype LiveSessionEntry"));
    expect(body.match(/^  \w+[^\n]*;/gm)).toHaveLength(6);
    expect(body).not.toContain("decorateState");
    expect(body).not.toContain("resolve(sessionId");
  });

  it("executes the synchronous service-to-host event pipeline with exact wire payloads", async () => {
    const { service, fixture, initial } = await fixtureService();
    const activity = new SessionActivity((path) => service.sessionForPath(path));
    const wire: any[] = [];
    service.subscribe(createHostSessionEventHandler({
      sessionForId: (id) => service.sessionForId(id),
      projectState: (value) => service.projectState(value),
      webUiEntries: (value) => service.webUiEntries(value),
      sessionActivity: activity,
      broadcast: (value) => wire.push(value),
      markSessionUnreadCompleted: () => undefined,
    }));

    initial.isStreaming = true;
    const startedAt = "2026-02-01T00:00:00.000Z";
    const firstActivityAt = "2026-02-01T00:00:01.000Z";
    fixture.emit({ type: "agent_start", startedAt, lastActivityAt: firstActivityAt });
    expect(wire).toEqual([
      { type: "agent_event", sessionId: initial.sessionId, sessionFile: initial.sessionFile, event: { type: "agent_start", startedAt, lastActivityAt: firstActivityAt } },
      { type: "session_runtime_changed", sessionId: initial.sessionId, sessionFile: initial.sessionFile, runtime: activity.runtimeForPath(initial.sessionFile) },
    ]);

    wire.length = 0;
    fixture.emit({ type: "session_info_changed", name: "Renamed" });
    const { thinkingLevels: _thinkingLevels, ...stateWithoutThinkingLevels } = service.projectState(initial);
    expect(wire).toEqual([
      { type: "agent_event", sessionId: initial.sessionId, sessionFile: initial.sessionFile, event: { type: "session_info_changed", name: "Renamed" } },
      { type: "session_runtime_changed", sessionId: initial.sessionId, sessionFile: initial.sessionFile, runtime: activity.runtimeForPath(initial.sessionFile) },
      {
        type: "state_changed",
        ...stateWithoutThinkingLevels,
        runtimeStartedAt: startedAt,
        runtimeLastActivityAt: firstActivityAt,
        runtime: activity.runtimeForPath(initial.sessionFile),
        webContributions: [],
      },
    ]);

    wire.length = 0;
    const messageAt = "2026-02-01T00:00:02.000Z";
    const message = { role: "assistant", model: "model", errorMessage: "model_not_supported", timestamp: messageAt };
    fixture.emit({ type: "message_end", message, timestamp: messageAt });
    expect(wire).toEqual([
      {
        type: "agent_event",
        sessionId: initial.sessionId,
        sessionFile: initial.sessionFile,
        event: { type: "message_end", message, timestamp: messageAt, lastActivityAt: messageAt },
      },
      { type: "session_runtime_changed", sessionId: initial.sessionId, sessionFile: initial.sessionFile, runtime: activity.runtimeForPath(initial.sessionFile) },
      { type: "session_stats_changed", sessionId: initial.sessionId, sessionFile: initial.sessionFile, stats: (await service.stats(initial.sessionId)).stats },
      { type: "models_updated", sessionId: initial.sessionId, models: [] },
    ]);
  });

  it("marks unread and sends exactly one notification from the same final completion transition", async () => {
    const { service, initial } = await fixtureService();
    const activity = new SessionActivity((path) => service.sessionForPath(path));
    const transitions: string[] = [];
    const handler = createHostSessionEventHandler({
      sessionForId: (id) => service.sessionForId(id),
      projectState: (value) => service.projectState(value),
      webUiEntries: (value) => service.webUiEntries(value),
      sessionActivity: activity,
      broadcast: () => undefined,
      markSessionUnreadCompleted: () => transitions.push("unread"),
      notifySessionCompleted: () => transitions.push("notification"),
    });
    activity.ensureStarted(initial);
    const completed: SessionServiceEvent = {
      type: "runtime",
      action: "completed",
      sessionId: initial.sessionId,
      sessionFile: initial.sessionFile,
    };

    handler(completed);
    handler(completed);

    expect(transitions).toEqual(["unread", "notification"]);
    expect(activity.hasStarted(initial.sessionFile)).toBe(false);
  });

  it("propagates WebSocket open failures but keeps unknown-ID fallback eligible", async () => {
    const { initial } = await fixtureService();
    await expect(resolveWebSocketHelloSession("unknown", initial, async () => undefined)).resolves.toBeUndefined();
    await expect(resolveWebSocketHelloSession("corrupt", initial, async () => { throw new Error("corrupt session"); })).rejects.toThrow("corrupt session");
  });

  it("decorates ID-less tool calls by their matching content position", () => {
    const activity = new SessionActivity(() => undefined);
    const sessionFile = "/tmp/id-less.jsonl";
    activity.enrichEvent({ sessionFile, sessionId: "id-less" } as PiWebSession, { type: "tool_execution_start", toolName: "read", startedAt: "2026-03-01T00:00:00.000Z" });
    const messages: MessageDto[] = [{
      role: "assistant",
      isError: false,
      toolCalls: [{ toolName: "read", args: {} }],
      raw: { role: "assistant", content: [{ type: "toolCall", toolName: "read", arguments: {} }] },
    }];
    expect(decorateHostMessages(messages, sessionFile, activity)[0].toolCalls).toEqual([
      { toolName: "read", args: {}, startedAt: "2026-03-01T00:00:00.000Z" },
    ]);
  });
});

describe("LocalSessionService standalone lifecycle", () => {
  it("keeps agent_end running and uses agent_settled as the idle boundary", async () => {
    const { service, fixture, initial } = await fixtureService();
    const activity = new SessionActivity(
      (path) => service.sessionForPath(path),
      (path) => service.hasActiveWorkForPath(path),
      (path) => service.hasActiveRetryForPath(path),
    );
    initial.isStreaming = true;
    fixture.emit({ type: "agent_start" });
    fixture.emit({ type: "agent_end", messages: [], willRetry: false });
    expect(activity.runtimeForEvent(initial.sessionFile, { type: "agent_end", willRetry: false })).toMatchObject({ isRunning: true });

    initial.isStreaming = false;
    fixture.emit({ type: "agent_settled" });
    expect(activity.runtimeForEvent(initial.sessionFile, { type: "agent_settled" })).toMatchObject({ isRunning: false });
  });

  it("reports a gated retry as running, rejects a concurrent retry, and settles once", async () => {
    const { service, initial } = await fixtureService();
    let releaseRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
    initial.retryFromFailure = vi.fn(() => retryGate);
    const activity = new SessionActivity(
      (path) => service.sessionForPath(path),
      (path) => service.hasActiveWorkForPath(path),
      (path) => service.hasActiveRetryForPath(path),
    );
    const events: SessionServiceEvent[] = [];
    service.subscribe((event) => events.push(event));

    await service.retry(initial.sessionId);
    expect(service.hasActiveWorkForPath(initial.sessionFile)).toBe(true);
    expect(activity.runtimeForPath(initial.sessionFile)).toMatchObject({ isRunning: true, isStreaming: false });
    expect(activity.runtimeForEvent(initial.sessionFile, { type: "agent_end" })).toMatchObject({ isRunning: true });
    await expect(service.retry(initial.sessionId)).rejects.toMatchObject({ status: 409 });
    expect(initial.retryFromFailure).toHaveBeenCalledTimes(1);

    releaseRetry();
    await vi.waitFor(() => expect(service.hasActiveWorkForPath(initial.sessionFile)).toBe(false));
    expect(activity.runtimeForPath(initial.sessionFile)).toMatchObject({ isRunning: false });
    expect(events.filter((event) => event.type === "runtime" && event.action === "completed")).toHaveLength(1);
  });

  it("honors viewer and work leases through their grace timers", async () => {
    vi.stubEnv("PI_WEB_SESSION_IDLE_GRACE_MS", "30");
    vi.stubEnv("PI_WEB_VIEWER_LEASE_GRACE_MS", "20");
    const { service } = await fixtureService();
    vi.useFakeTimers();

    const viewed = await service.create(undefined);
    service.acquireViewer(viewed.sessionId, "viewer");
    await vi.advanceTimersByTimeAsync(19);
    expect(service.lifecycleSnapshot().viewerLeases).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(service.lifecycleSnapshot().viewerLeases).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(30);
    expect(service.sessionForId(viewed.sessionId)).toBeUndefined();

    const working = await service.create(undefined);
    const navigation = await service.navigate(working.sessionId, "result", {});
    await vi.advanceTimersByTimeAsync(100);
    expect(service.sessionForId(working.sessionId)).toBeDefined();
    navigation.finish();
    await vi.advanceTimersByTimeAsync(30);
    expect(service.sessionForId(working.sessionId)).toBeUndefined();
  });

  it("does not let a stale socket release a replacement viewer lease", async () => {
    const { service, cwd } = await fixtureService();
    const first = await service.create(undefined);
    service.acquireViewer(first.sessionId, "client");
    const staleConnection = service.connectViewer("client")!;

    await service.disposeAll("reset");
    const replacement = fixtureSession(cwd, "replacement").session;
    service.setCurrentSession(replacement);
    service.acquireViewer(replacement.sessionId, "client");
    const activeConnection = service.connectViewer("client")!;

    service.disconnectViewer(staleConnection);
    expect(service.lifecycleSnapshot().viewerLeases).toEqual([
      expect.objectContaining({ clientId: "client", sockets: 1 }),
    ]);
    expect(service.lifecycleSnapshot().liveSessions).toEqual([
      expect.objectContaining({ sessionId: "replacement", viewerLeases: 1 }),
    ]);
    service.disconnectViewer(activeConnection);
  });

  it("isolates concurrent disposal and disposes each runtime once", async () => {
    const { service, initial, fixture } = await fixtureService();
    let releaseShutdown!: () => void;
    const shutdown = new Promise<void>((resolve) => { releaseShutdown = resolve; });
    const emit = vi.fn(() => shutdown);
    initial.extensionRunner = { hasHandlers: () => true, emit } as any;

    const first = service.disposeAll("reset");
    const second = service.disposeAll("reset");
    await Promise.resolve();
    expect(emit).toHaveBeenCalledTimes(1);
    releaseShutdown();
    await Promise.all([first, second]);
    expect(fixture.disposeCalls).toBe(1);
  });

  it("resets mock lifecycle state, leases, and registrations standalone", async () => {
    const { service, initial, fixture, cwd } = await fixtureService({ isMock: true });
    service.acquireViewer(initial.sessionId, "mock-client");
    service.connectViewer("mock-client");
    const replacementFixture = fixtureSession(cwd, "mock-reset");

    await service.resetWith(replacementFixture.session);

    expect(fixture.disposeCalls).toBe(1);
    expect(service.sessionForId(initial.sessionId)).toBeUndefined();
    expect(service.sessionForId("mock-reset")).toBe(replacementFixture.session);
    expect(service.lifecycleSnapshot().viewerLeases).toEqual([]);
  });

  it("captures operation paths and clears both registration and current paths on shutdown", async () => {
    const { service, initial } = await fixtureService();
    const activity = new SessionActivity((path) => service.sessionForPath(path));
    const wire: unknown[] = [];
    service.subscribe(createHostSessionEventHandler({
      sessionForId: (id) => service.sessionForId(id),
      projectState: (value) => service.projectState(value),
      webUiEntries: (value) => service.webUiEntries(value),
      sessionActivity: activity,
      broadcast: (value) => wire.push(value),
      markSessionUnreadCompleted: () => undefined,
    }));

    let finishPrompt!: () => void;
    initial.prompt = () => new Promise<void>((resolve) => { finishPrompt = resolve; });
    const events: SessionServiceEvent[] = [];
    service.subscribe((event) => events.push(event));
    const originalFile = initial.sessionFile;
    await service.prompt(initial.sessionId, { message: "move", mode: "steer", images: [] });
    const movedFile = join(originalFile, "moved.jsonl");
    initial.sessionFile = movedFile;
    finishPrompt();
    await vi.waitFor(() => expect(events.some((event) => event.type === "runtime" && event.action === "completed")).toBe(true));
    expect(events).toContainEqual(expect.objectContaining({
      type: "runtime", action: "completed", sessionFile: movedFile, activitySessionFile: originalFile,
    }));

    activity.noteEvent(originalFile, { type: "agent_start", startedAt: "2026-04-01T00:00:00.000Z" });
    activity.noteEvent(movedFile, { type: "agent_start", startedAt: "2026-04-01T00:00:00.000Z" });
    await service.disposeAll("reset");
    expect(activity.hasStarted(originalFile)).toBe(false);
    expect(activity.hasStarted(movedFile)).toBe(false);
  });
});

describe("session route boundary", () => {
  it("does not access PiWebSession members directly in HTTP route bodies", async () => {
    const source = await readFile(new URL("../server.ts", import.meta.url), "utf8");
    const routes = source.slice(source.indexOf("const server = createServer"));
    expect(routes).not.toContain("targetSession.");
  });

  it("writes a navigation response before calling its serving-side finalizer", async () => {
    const source = await readFile(new URL("../server.ts", import.meta.url), "utf8");
    const start = source.indexOf('url.pathname === "/api/session/tree/navigate"');
    const route = source.slice(start, source.indexOf('url.pathname === "/api/session/tree/abort-summary"', start));
    expect(route.indexOf("sendJson(res, 200")).toBeGreaterThan(-1);
    expect(route.indexOf("sendJson(res, 200")).toBeLessThan(route.indexOf("finish();"));
    expect(route).not.toContain("setTimeout");
  });
});
