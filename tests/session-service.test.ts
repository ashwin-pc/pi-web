import { mkdir, mkdtemp, open, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonRoundTrip, type MessageDto, type SessionServiceEvent } from "../server/session/dto.js";
import { SessionActivity } from "../server/session/activity.js";
import { shallowSessionCwd } from "../server/session/shallowList.js";
import { createHostSessionEventHandler, decorateHostMessages, resolveWebSocketHelloSession } from "../server/session/hostEvents.js";
import { mapPiEvent } from "../server/session/piEventMap.js";
import { parseAttachmentMarkup } from "../server/shared/attachments.js";
import { pi087Events } from "./fixtures/pi-0.87-events.js";
import { LocalSessionService, SessionServiceError, type LocalSessionFactory, type LocalSessionServiceDependencies } from "../server/session/service.js";
import type { PiWebSession } from "../server/types.js";
import { PiSessionHandle } from "../server/session/piHandle.js";
import { savedTranscriptLimits } from "../server/session/savedTranscript.js";
import { createSessionDraftStore } from "../src/drafts/sessionDraftStore.js";
import { createSessionUiStateStore } from "../server/sessionUiState.js";
import { internalViewerPrincipal } from "../server/session/viewerLeases.js";

const MIB = 1024 * 1024;

describe("owned Pi runtime handle", () => {
  it.each([false, true])("publishes disposal before reentrant cleanup (shutdown=%s)", async (shutdown) => {
    const fixture = fixtureSession("/workspace");
    const handle = new PiSessionHandle(fixture.session);
    const order: string[] = [];
    const reentrant: Promise<void>[] = [];
    if (shutdown) fixture.session.extensionRunner = {
      hasHandlers: () => true,
      emit: () => { order.push("shutdown"); const promise = handle.dispose("reset"); reentrant.push(promise); return promise; },
    } as PiWebSession["extensionRunner"];
    fixture.session.subscribe = () => () => { order.push("unsubscribe"); reentrant.push(handle.dispose("reset")); };
    (fixture.session as PiWebSession & { dispose(): void }).dispose = () => { order.push("dispose"); reentrant.push(handle.dispose("reset")); };
    handle.subscribe(() => undefined);
    const disposal = handle.dispose("reset");
    expect(order).toEqual(shutdown ? ["shutdown", "unsubscribe", "dispose"] : ["unsubscribe", "dispose"]);
    await disposal;
    expect(reentrant.every((promise) => promise === disposal)).toBe(true);
    expect(handle.dispose("reset")).toBe(disposal);
  });

  it("releases a late subscription when synchronous notification disposes the handle", async () => {
    const fixture = fixtureSession("/workspace");
    const handle = new PiSessionHandle(fixture.session);
    const unsubscribe = vi.fn();
    let disposal!: Promise<void>;
    fixture.session.subscribe = (listener) => { listener({ type: "agent_end" }); return unsubscribe; };
    const release = handle.subscribe(() => { disposal = handle.dispose("reset"); });
    expect(unsubscribe).toHaveBeenCalledOnce();
    release();
    await disposal;
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(fixture.disposeCalls).toBe(1);
  });

  it("rejects subscriptions during shutdown and after disposal without SDK ingress", async () => {
    const fixture = fixtureSession("/workspace");
    const handle = new PiSessionHandle(fixture.session);
    let finish!: () => void;
    fixture.session.extensionRunner = { hasHandlers: () => true, emit: () => new Promise<void>((resolve) => { finish = resolve; }) } as PiWebSession["extensionRunner"];
    const subscribe = vi.spyOn(fixture.session, "subscribe");
    const disposal = handle.dispose("reset");
    expect(() => handle.subscribe(() => undefined)).toThrow("closing or disposed");
    finish();
    await disposal;
    expect(() => handle.subscribe(() => undefined)).toThrow("closing or disposed");
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("removes failed subscription records before cleanup", async () => {
    const fixture = fixtureSession("/workspace");
    const handle = new PiSessionHandle(fixture.session);
    fixture.session.subscribe = () => { throw new Error("subscribe failed"); };
    expect(() => handle.subscribe(() => undefined)).toThrow("subscribe failed");
    const unsubscribe = vi.fn();
    fixture.session.subscribe = () => unsubscribe;
    handle.subscribe(() => undefined);
    await handle.dispose("reset");
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(fixture.disposeCalls).toBe(1);
  });
  it("preserves projection, prompt options, interruption and event ingress", async () => {
    const fixture = fixtureSession("/workspace");
    const handle = new PiSessionHandle(fixture.session);
    const events: unknown[] = [];
    const release = handle.subscribe((event) => events.push(event));
    const prompt = vi.spyOn(fixture.session, "prompt");
    const abort = vi.spyOn(fixture.session, "abort");
    await handle.prompt("steer", { streamingBehavior: "steer" });
    expect(prompt).toHaveBeenCalledWith("steer", { streamingBehavior: "steer" });
    expect(events).toHaveLength(1);
    expect(handle.state("/workspace").sessionId).toBe("current");
    expect(handle.messages().at(-1)?.entryId).toBe("user-2");
    await handle.interrupt();
    expect(abort).toHaveBeenCalledOnce();
    release();
    fixture.emit({ type: "agent_end" });
    expect(events).toHaveLength(1);
    await handle.dispose("reset");
    expect(fixture.disposeCalls).toBe(1);
  });

  it("owns shutdown/unsubscribe/disposal ordering and disposes once on hook failure", async () => {
    const fixture = fixtureSession("/workspace");
    const order: string[] = [];
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fixture.session.extensionRunner = {
      hasHandlers: () => true,
      emit: async () => { order.push("shutdown"); throw new Error("hook failed"); },
    } as PiWebSession["extensionRunner"];
    fixture.session.subscribe = () => () => { order.push("unsubscribe"); throw new Error("release failed"); };
    (fixture.session as PiWebSession & { dispose(): void }).dispose = () => { order.push("dispose"); };
    const handle = new PiSessionHandle(fixture.session);
    handle.subscribe(() => undefined);
    try {
      await Promise.all([handle.dispose("reset"), handle.dispose("reset")]);
      expect(order).toEqual(["shutdown", "unsubscribe", "dispose"]);
      expect(warning).toHaveBeenCalledTimes(2);
    } finally { warning.mockRestore(); }
  });
});

const tempDirs: string[] = [];
let fixtureSessionSequence = 0;
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function fixtureSession(cwd: string, id = "current", path = join(cwd, `${id}.jsonl`), initialEntries?: any[]) {
  const entries: any[] = initialEntries || [
    { id: "call", parentId: null, type: "message", timestamp: "2026-01-01T00:00:00Z", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "secret" } }], timestamp: "2026-01-01T00:00:00Z" } },
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
    sessionId: id, sessionFile: path, sessionName: "Fixture", isStreaming: false, isCompacting: false,
    model, thinkingLevel: "medium", systemPrompt: "Fixture effective prompt", messages: [], agent: { state: { messages: [] } },
    sessionManager: {
      newSession() {
        session.sessionId = `created-${++fixtureSessionSequence}`;
        session.sessionFile = join(cwd, `${session.sessionId}.jsonl`);
        entries.splice(0);
        syncMessages();
      },
      buildSessionContext: () => ({ messages: entries.map((entry) => entry.message) }),
      getEntry: (entryId: string) => entries.find((entry) => entry.id === entryId),
      getBranch: () => entries,
      getLeafId: () => entries.at(-1)?.id || null,
      getTree: () => entries.length ? [{ entry: entries[0], children: entries.slice(1).map((entry) => ({ entry, children: [] })) }] : [],
      getSessionName: () => session.sessionName,
      getCwd: () => cwd,
    } as PiWebSession["sessionManager"],
    modelRuntime: { getAvailableSnapshot: () => [model], getModel: () => model },
    extensionRunner: { getRegisteredCommands: () => [] }, promptTemplates: [], resourceLoader: { getSkills: () => ({ skills: [] }) },
    bindExtensions: async (options) => { extensionOptions = options; },
    getActiveToolNames: () => ["read"], getAllTools: () => [{ name: "read", description: "Read files", sourceInfo: { source: "built-in" } }],
    getAvailableThinkingLevels: () => ["off", "medium"], getSessionName: () => session.sessionName, getContextUsage: () => ({ tokens: 1, contextWindow: 1000, percent: 0.1 }),
    setSessionName: (name) => { session.sessionName = name || undefined; },
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
  modelRuntime?: LocalSessionServiceDependencies["modelRuntime"];
  isMock?: boolean;
  finalizeCreatedSession?: (sessionId: string) => Promise<unknown>;
  list?: LocalSessionFactory["list"];
  remove?: LocalSessionFactory["remove"];
  defaultsFor?: LocalSessionServiceDependencies["sessionConfig"]["defaultsFor"];
  openError?: Error;
  clientCount?: number | (() => number);
  beforeCreate?: (input: Parameters<LocalSessionFactory["create"]>[0]) => Promise<void>;
  loadEntriesFromPath?: boolean;
};

async function fixtureService(options: FixtureServiceOptions = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-service-"));
  tempDirs.push(cwd);
  const sessions = new Map<string, ReturnType<typeof fixtureSession>>();
  const creates: Array<{ cwd: string; path?: string; reason?: string; previous?: string }> = [];
  const factory: LocalSessionFactory = {
    isMock: options.isMock,
    async create(input) {
      if (input.path && options.openError) throw options.openError;
      await options.beforeCreate?.(input);
      creates.push({ cwd: input.cwd, path: input.path, reason: input.sessionStartEvent?.reason, previous: input.sessionStartEvent?.previousSessionFile });
      const id = input.path ? input.path.split("/").at(-1)?.replace(/\.jsonl$/, "") || "opened" : creates.length === 1 ? "current" : `factory-${creates.length}`;
      let loadedEntries: unknown[] | undefined;
      if (input.path && options.loadEntriesFromPath) {
        const source = await readFile(input.path, "utf8").catch(() => "");
        loadedEntries = source.split("\n").flatMap((line) => {
          if (!line.trim()) return [];
          try {
            const record = JSON.parse(line);
            return record?.type === "message" ? [record] : [];
          } catch { return []; }
        });
      }
      const value = fixtureSession(input.cwd, id, input.path, loadedEntries);
      if (options.modelRuntime) value.session.modelRuntime = options.modelRuntime;
      sessions.set(id, value);
      return { session: value.session };
    },
    list: options.list || (async () => []),
    remove: options.remove,
  };
  const deps: LocalSessionServiceDependencies = {
    modelRuntime: options.modelRuntime || {} as LocalSessionServiceDependencies["modelRuntime"],
    sessionFactory: factory,
    additionalExtensionPaths: () => [],
    sessionConfig: {
      defaultsFor: options.defaultsFor || (async () => ({})),
      finalizeCreatedSession: options.finalizeCreatedSession || (async () => undefined),
    },
    globalCwd: () => cwd,
    clientCount: () => typeof options.clientCount === "function" ? options.clientCount() : options.clientCount ?? 0,
  };
  const service = new LocalSessionService(deps);
  const initial = await service.initialize();
  return { service, initial, fixture: sessions.get("current")!, creates, cwd };
}

describe("model catalog refresh", () => {
  function runtimeFixture() {
    let models = [{ provider: "available", id: "cached", name: "Cached", reasoning: false, contextWindow: 1000, maxTokens: 100 }];
    const refresh = vi.fn(async (_options: { providers?: readonly string[]; force?: boolean; signal?: AbortSignal }) => ({ aborted: false, errors: new Map<string, Error>() }));
    const runtime = {
      getAvailableSnapshot: () => models,
      getProviders: () => [{ id: "available" }, { id: "configured" }, { id: "unconfigured" }],
      hasConfiguredAuth: (id: string) => id === "configured",
      refresh,
    } as unknown as LocalSessionServiceDependencies["modelRuntime"];
    return { runtime, refresh, addModel: () => { models = [...models, { ...models[0], id: "discovered" }]; } };
  }

  it("keeps normal reads local and refreshes only available/configured providers on opt-in", async () => {
    vi.stubEnv("PI_OFFLINE", undefined);
    const { runtime, refresh, addModel } = runtimeFixture();
    const { service, initial } = await fixtureService({ modelRuntime: runtime });
    expect((await service.models(initial.sessionId)).models.map((model) => model.id)).toEqual(["cached"]);
    expect(refresh).not.toHaveBeenCalled();
    refresh.mockImplementationOnce(async () => { addModel(); return { aborted: false, errors: new Map() }; });
    expect((await service.models(initial.sessionId, { refresh: true })).models.map((model) => model.id)).toEqual(["cached", "discovered"]);
    expect(refresh).toHaveBeenCalledWith({ providers: ["available", "configured"], allowNetwork: true, force: false, signal: expect.any(AbortSignal) });
    await service.models(initial.sessionId, { force: true });
    expect(refresh.mock.lastCall?.[0].force).toBe(true);
  });

  it("joins concurrent refreshes across sessions without delaying normal reads", async () => {
    vi.stubEnv("PI_OFFLINE", undefined);
    const { runtime, refresh, addModel } = runtimeFixture();
    let finish!: () => void;
    refresh.mockImplementationOnce(() => new Promise((resolve) => { finish = () => { addModel(); resolve({ aborted: false, errors: new Map() }); }; }));
    const { service, initial, cwd } = await fixtureService({ modelRuntime: runtime });
    const second = await service.create(cwd);
    const firstRequest = service.models(initial.sessionId, { refresh: true });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    const secondRequest = service.models(second.sessionId, { force: true });
    expect((await service.models(initial.sessionId)).models).toHaveLength(1);
    finish();
    expect((await firstRequest).models).toHaveLength(2);
    expect((await secondRequest).models).toHaveLength(2);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it.each(["", "1", "0"])("honors PI_OFFLINE=%j even for manual refresh", async (offline) => {
    vi.stubEnv("PI_OFFLINE", offline);
    const { runtime, refresh } = runtimeFixture();
    const { service, initial } = await fixtureService({ modelRuntime: runtime });
    expect((await service.models(initial.sessionId, { force: true })).models).toHaveLength(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("keeps cached models on thrown errors and exposes partial refreshes with a warning", async () => {
    vi.stubEnv("PI_OFFLINE", undefined);
    const { runtime, refresh, addModel } = runtimeFixture();
    const { service, initial } = await fixtureService({ modelRuntime: runtime });
    refresh.mockRejectedValueOnce(new Error("offline"));
    const failed = await service.models(initial.sessionId, { refresh: true });
    expect(failed.models).toHaveLength(1);
    expect(failed.catalogRefreshFailed).toBe(true);
    refresh.mockImplementationOnce(async () => { addModel(); return { aborted: false, errors: new Map([["available", new Error("failed")]]) }; });
    const partial = await service.models(initial.sessionId, { force: true });
    expect(partial.models).toHaveLength(2);
    expect(partial.catalogRefreshFailed).toBe(true);
  });

  it("skips catalog networking for mock session factories", async () => {
    vi.stubEnv("PI_OFFLINE", undefined);
    const { service, initial } = await fixtureService({ isMock: true });
    const result = await service.models(initial.sessionId, { force: true });
    expect(result.models).toHaveLength(1);
    expect(result.catalogRefreshFailed).toBe(false);
  });

  it("bounds refresh waits to ten seconds and keeps timed-out work deduplicated", async () => {
    vi.stubEnv("PI_OFFLINE", undefined);
    const { runtime, refresh } = runtimeFixture();
    const { service, initial } = await fixtureService({ modelRuntime: runtime });
    vi.useFakeTimers();
    refresh.mockImplementationOnce(() => new Promise(() => {}));
    const request = service.models(initial.sessionId, { refresh: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await request).models).toHaveLength(1);
    expect(refresh.mock.lastCall?.[0].signal?.aborted).toBe(true);
    expect((await service.models(initial.sessionId, { force: true })).models).toHaveLength(1);
    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe("LocalSessionService contract", () => {
  it("substitutes a non-mock factory for create/open/list/remove while keeping host defaults, binding and events", async () => {
    const remove = vi.fn(async () => "trashed" as const);
    const defaultsFor = vi.fn(async () => ({ model: { provider: "test", id: "model" }, thinkingLevel: "medium" }));
    const finalize = vi.fn(async () => undefined);
    let savedCwd = "";
    const list = vi.fn(async () => [{
      id: "saved", path: join(savedCwd, "saved.jsonl"), cwd: savedCwd,
      name: "Saved", firstMessage: "hello", allMessagesText: "hello", messageCount: 1,
      created: new Date("2026-01-01T00:00:00Z"), modified: new Date("2026-01-01T00:00:00Z"),
    }]);
    const { service, fixture, cwd, creates } = await fixtureService({
      list, remove, defaultsFor, finalizeCreatedSession: finalize,
    });
    savedCwd = cwd;
    expect(fixture.extensionOptions).toBeDefined();
    expect(defaultsFor).not.toHaveBeenCalled(); // Opening/initializing does not apply new-session defaults.
    expect(finalize).not.toHaveBeenCalled();
    expect((await service.list())[0]).toMatchObject({ id: "saved", name: "Saved" });
    const opened = await service.open("saved", cwd);
    expect(opened.sessionId).toBe("saved");
    expect(creates.at(-1)).toMatchObject({ path: join(cwd, "saved.jsonl"), cwd });
    await service.open("saved", cwd);
    expect(creates).toHaveLength(2); // A second open reuses the owned live session.
    const events: SessionServiceEvent[] = [];
    const unsubscribe = service.subscribe((event) => events.push(event));
    await fixture.session.prompt("factory event");
    expect(events.some((event) => event.type === "committed" && event.sessionId === "current")).toBe(true);
    const created = await service.create("current", cwd);
    expect(creates.at(-1)).toMatchObject({ reason: "new", previous: fixture.session.sessionFile, cwd });
    expect(finalize).toHaveBeenCalledWith(created.sessionId);
    expect(defaultsFor).toHaveBeenCalledWith(cwd);
    const createdSession = service.sessionForPath(created.sessionFile)!;
    expect(createdSession.setModel).toHaveBeenCalled();
    expect(createdSession.setThinkingLevel).toHaveBeenCalledWith("medium");
    expect(await service.delete("saved", cwd)).toEqual({ id: "saved", disposition: "trashed" });
    expect(remove).toHaveBeenCalledWith("saved", join(cwd, "saved.jsonl"));
    unsubscribe();
    await service.disposeAll();
  });

  it("refuses protected and busy deletes while preserving saved idle deletion", async () => {
    const remove = vi.fn(async () => "trashed" as const);
    const { service, initial } = await fixtureService({ remove });

    await expect(service.delete(initial.sessionId)).rejects.toMatchObject({
      status: 409,
      message: "This session is the server's default session and cannot be deleted while pi-web is running.",
    });

    const streaming = await service.create(undefined);
    service.sessionForId(streaming.sessionId)!.isStreaming = true;
    await expect(service.delete(streaming.sessionId)).rejects.toMatchObject({ status: 409 });
    service.sessionForId(streaming.sessionId)!.isStreaming = false;

    const compacting = await service.create(undefined);
    service.sessionForId(compacting.sessionId)!.isCompacting = true;
    await expect(service.delete(compacting.sessionId)).rejects.toMatchObject({ status: 409 });
    service.sessionForId(compacting.sessionId)!.isCompacting = false;

    const working = await service.create(undefined);
    const workingSession = service.sessionForId(working.sessionId)!;
    let finishNavigate!: () => void;
    let enteredNavigate!: () => void;
    const entered = new Promise<void>((resolve) => { enteredNavigate = resolve; });
    workingSession.navigateTree = () => {
      enteredNavigate();
      return new Promise((resolve) => { finishNavigate = () => resolve({ cancelled: false }); });
    };
    const navigation = service.navigate(working.sessionId, "result", {});
    await entered;
    await expect(service.delete(working.sessionId)).rejects.toMatchObject({ status: 409 });
    finishNavigate();
    await navigation;

    await expect(service.delete(working.sessionId)).resolves.toEqual({ id: working.sessionId, disposition: "trashed" });
    expect(remove).toHaveBeenCalledWith(working.sessionId, working.sessionFile);
  });

  it.each([
    "not json\n",
    JSON.stringify({ type: "message" }),
    JSON.stringify({ type: "session" }),
    JSON.stringify({ type: "session", cwd: "" }),
    JSON.stringify({ type: "session", cwd: 123 }),
  ])("rejects invalid headers in strict lookup but keeps tolerant reads", async (contents) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-web-header-"));
    tempDirs.push(cwd);
    const path = join(cwd, "broken.jsonl");
    await writeFile(path, contents);
    await expect(shallowSessionCwd(path)).resolves.toBeUndefined();
    await expect(shallowSessionCwd(path, { strict: true })).rejects.toThrow("Invalid session header");
  });

  it("returns 404 only for a genuinely absent session", async () => {
    const { service, creates } = await fixtureService();
    await expect(service.open("missing")).rejects.toMatchObject({ status: 404 });
    expect(creates).toHaveLength(1);
  });

  it.each([
    new Error("SDK hydration failed"),
    Object.assign(new Error("permission denied"), { code: "EACCES" }),
    Object.assign(new Error("unrelated SDK file missing"), { code: "ENOENT" }),
  ])("does not classify hydration failure %s as absence", async (openError) => {
    const { service, cwd, creates } = await fixtureService({
      openError,
      list: async () => [{ id: "cold", path: "/cold.jsonl", cwd: "/", created: new Date(), modified: new Date(), messageCount: 0, firstMessage: "" }],
    });
    await expect(service.open("cold", cwd)).rejects.toMatchObject({ status: 500, message: openError.message });
    expect(creates).toHaveLength(1);
  });

  it("does not retry a remembered location after a hydration failure", async () => {
    const list = vi.fn(async () => [{ id: "cold", path: "/cold.jsonl", cwd: "/", created: new Date(), modified: new Date(), messageCount: 0, firstMessage: "" }]);
    const { service } = await fixtureService({ list, openError: new Error("hydration failed") });
    await expect(service.open("cold")).rejects.toMatchObject({ status: 500 });
    await expect(service.open("cold")).rejects.toMatchObject({ status: 500 });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("preserves an existing service error status", async () => {
    const openError = new SessionServiceError("busy", 409);
    const { service } = await fixtureService({
      openError,
      list: async () => [{ id: "cold", path: "/cold.jsonl", cwd: "/", created: new Date(), modified: new Date(), messageCount: 0, firstMessage: "" }],
    });
    await expect(service.open("cold")).rejects.toBe(openError);
  });

  it.each(["EACCES", "EIO"])("propagates lookup %s instead of claiming absence", async (code) => {
    const error = Object.assign(new Error("lookup failed"), { code });
    const { service } = await fixtureService({ list: async () => { throw error; } });
    await expect(service.open("cold")).rejects.toMatchObject({ status: 500 });
  });

  it("projects effective context and persisted tool call counts", async () => {
    const { service, initial } = await fixtureService();
    const context = await service.context(initial.sessionId);
    expect(context.systemPrompt).toBe("Fixture effective prompt");
    expect(context.provenance.encoding).toBe("utf-16");
    expect(context.provenance.spans).toEqual([{ start: 0, end: 24, source: { kind: "unknown", label: "Unattributed prompt text" }, confidence: "unknown" }]);
    expect(context.provenance.coverage).toEqual({ exact: 0, derived: 0, unknown: 24, total: 24 });
    expect(context.tools).toMatchObject({ activeNames: ["read"], callsByName: { read: 1 } });
    expect(context.tools.configured).toContainEqual(expect.objectContaining({ name: "read", callCount: 1 }));
    expect(context.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("attributes observable prompt fragments and leaves gaps unknown", async () => {
    const { service, initial } = await fixtureService();
    (initial as any).systemPrompt = "core😀\nContext body\nTool guidance\ntail";
    initial.resourceLoader = {
      getSkills: () => ({ skills: [] }),
      getAgentsFiles: () => ({ agentsFiles: [{ path: "/project/AGENTS.md", content: "Context body" }] }),
    };
    initial.getAllTools = () => [{ name: "read", description: "Tool guidance", sourceInfo: { path: "<built-in>" } }];
    const { provenance } = await service.context(initial.sessionId);
    expect(provenance.spans.map(({ start, end, source, confidence }) => ["core😀\nContext body\nTool guidance\ntail".slice(start, end), source.kind, confidence])).toEqual([
      ["core😀\n", "unknown", "unknown"],
      ["Context body", "context-file", "exact"],
      ["\n", "unknown", "unknown"],
      ["Tool guidance", "tool", "exact"],
      ["\ntail", "unknown", "unknown"],
    ]);
    expect(provenance.spans.at(-1)?.end).toBe((initial as any).systemPrompt.length);
    expect(provenance.coverage.total).toBe((initial as any).systemPrompt.length);
  });

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

  it("uses a comments-specific fallback for comment-only prompts", async () => {
    const { service, initial } = await fixtureService();
    const prompt = vi.fn(async () => undefined);
    initial.prompt = prompt;
    const comment = {
      type: "quote-reply" as const,
      id: "quote-reply-1",
      label: "Excerpt 1",
      quote: "Use the shared attachment lifecycle.",
      question: "Why is this important?",
      source: { messageId: "entry-42", startOffset: 12, endOffset: 48 },
    };

    await service.prompt(initial.sessionId, { message: "", mode: "steer", attachments: [comment] });
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    expect(parseAttachmentMarkup(prompt.mock.calls[0][0])).toMatchObject({
      text: "Please review the submitted comments.",
      attachments: [comment],
    });
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

  it("returns serializable navigation data after releasing its lease", async () => {
    const { service, initial } = await fixtureService();
    const result = await service.navigate(initial.sessionId, "result", {});
    expect(jsonRoundTrip(result)).toStrictEqual(result);
    expect(service.hasActiveWorkForPath(initial.sessionFile)).toBe(false);
    expect(result).not.toHaveProperty("finish");
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

  it("lists every remembered root, including deleted roots, with storage deduplication and bounded concurrency", async () => {
    const listed: string[] = [];
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { service, cwd } = await fixtureService({
      list: async (listedCwd) => {
        listed.push(listedCwd);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await gate;
        active -= 1;
        return [];
      },
    });
    const extras = [
      join(cwd, "same-path"),
      join(cwd, "same:path"),
      ...Array.from({ length: 10 }, (_, index) => join(cwd, `extra-${index}`)),
    ];
    await Promise.all(extras.slice(0, 2).map((path) => mkdir(path)));
    const request = service.list(extras);
    await vi.waitFor(() => expect(maxActive).toBe(4));
    release();
    await request;
    expect(maxActive).toBe(4);
    expect(listed).toHaveLength(12); // global cwd + one aliased store + all ten remembered roots
    expect(listed.filter((path) => path === extras[0] || path === extras[1])).toHaveLength(1);
    expect(listed).toContain(extras.at(-1));
    await service.disposeAll();
  });

  it("keeps authoritative renamed and cleared names after live-session disposal", async () => {
    const modified = new Date("2026-01-02T00:00:00Z");
    const { service, initial, cwd } = await fixtureService({
      list: async (listedCwd) => [{
        id: "current",
        path: join(listedCwd, "current.jsonl"),
        name: "Stale shallow name",
        created: modified,
        modified,
        messageCount: 1,
        cwd: listedCwd,
      }],
    });

    await service.rename(initial.sessionId, "Renamed");
    await service.disposeAll("reset");
    expect(await service.list()).toContainEqual(expect.objectContaining({ id: "current", name: "Renamed", cwd }));

    await service.open("current");
    await service.rename("current", "");
    await service.disposeAll("reset");
    expect((await service.list()).find((info) => info.id === "current")?.name).toBeUndefined();
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

  it("keeps seven true externals including the optional scoped extension transport", async () => {
    const source = await readFile(new URL("../server/session/service.ts", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("export interface LocalSessionServiceDependencies"), source.indexOf("}\n\ntype WorkLeaseKind"));
    expect(body.match(/^  \w+[^\n]*;/gm)).toHaveLength(7);
    expect(body).toContain("extensionHttp?");
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

  it("carries extension interactions through the typed service request/respond contract", async () => {
    const { service, fixture } = await fixtureService({ clientCount: 1 });
    const events: SessionServiceEvent[] = [];
    service.subscribe((event) => events.push(event));
    const answer = fixture.extensionOptions.uiContext.confirm("Allow?", "Run tool", { timeout: 1_000 });
    const interaction = events.find((event) => event.type === "interaction");
    expect(interaction).toMatchObject({
      type: "interaction",
      request: { source: "extension", kind: "confirm", payload: { title: "Allow?", message: "Run tool" }, timeout: 1_000 },
    });
    if (!interaction || interaction.type !== "interaction") throw new Error("Missing interaction request");
    expect(service.lifecycleSnapshot().liveSessions[0]?.leases).toEqual([
      expect.objectContaining({ label: "extension-interaction:confirm", kind: "general" }),
    ]);
    expect(service.respondInteraction({ id: interaction.request.id, confirmed: true })).toBe(true);
    await expect(answer).resolves.toBe(true);
    expect(service.lifecycleSnapshot().liveSessions[0]?.leases).toEqual([]);
  });

  it("denies timed-out and disconnected interactions through the service boundary", async () => {
    vi.useFakeTimers();
    let clients = 1;
    const { service, fixture } = await fixtureService({ clientCount: () => clients });
    const timedOut = fixture.extensionOptions.uiContext.confirm("Timed", "Wait", { timeout: 10 });
    await vi.advanceTimersByTimeAsync(10);
    await expect(timedOut).resolves.toBe(false);

    const disconnected = fixture.extensionOptions.uiContext.confirm("Disconnected", "Wait", { timeout: 1_000 });
    clients = 0;
    service.cancelInteractions();
    await expect(disconnected).resolves.toBe(false);
  });

  it("carries unknown harness events through the service and host wire unchanged", async () => {
    const { service, initial } = await fixtureService();
    const activity = new SessionActivity((path) => service.sessionForPath(path));
    const wire: any[] = [];
    const handler = createHostSessionEventHandler({
      sessionForId: (id) => service.sessionForId(id),
      projectState: (value) => service.projectState(value),
      webUiEntries: (value) => service.webUiEntries(value),
      sessionActivity: activity,
      broadcast: (value) => wire.push(value),
      markSessionUnreadCompleted: () => undefined,
    });
    handler({
      type: "agent", sessionId: initial.sessionId, sessionFile: initial.sessionFile,
      event: { type: "harness_event", harness: "future", payload: { type: "new_event", value: 1 } },
    });
    expect(wire[0]).toEqual({
      type: "agent_event", sessionId: initial.sessionId, sessionFile: initial.sessionFile,
      event: { type: "harness_event", harness: "future", payload: { type: "new_event", value: 1 } },
    });
    expect(wire[1]).toMatchObject({ type: "session_runtime_changed", sessionId: initial.sessionId });
  });

  it("replays the recorded pi 0.84 event fixture through the service/host wire boundary", async () => {
    const { service, initial } = await fixtureService();
    const activity = new SessionActivity((path) => service.sessionForPath(path));
    const wire: any[] = [];
    const handler = createHostSessionEventHandler({
      sessionForId: (id) => service.sessionForId(id), projectState: (value) => service.projectState(value),
      webUiEntries: (value) => service.webUiEntries(value), sessionActivity: activity,
      broadcast: (value) => wire.push(value), markSessionUnreadCompleted: () => undefined,
    });
    const mapped = pi087Events.map(mapPiEvent).filter((item) => item.kind === "event");
    for (const item of mapped) {
      if (item.kind === "event") handler({ type: "agent", sessionId: initial.sessionId, sessionFile: initial.sessionFile, event: item.event });
    }
    expect(wire.filter((event) => event.type === "agent_event")).toHaveLength(mapped.length);
    expect(wire.find((event) => event.type === "agent_event" && event.event.type === "message_update")?.event).not.toHaveProperty("assistantMessageEvent.partial");
    for (let index = 0; index < wire.length; index += 1) {
      if (wire[index]?.type === "agent_event") expect(wire[index + 1]?.type).toBe("session_runtime_changed");
    }
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

  it("clears aborted work without marking unread or sending completion push", async () => {
    const { service, initial } = await fixtureService();
    const activity = new SessionActivity((path) => service.sessionForPath(path));
    const transitions: string[] = [];
    const handler = createHostSessionEventHandler({
      sessionForId: (id) => service.sessionForId(id), projectState: (value) => service.projectState(value),
      webUiEntries: (value) => service.webUiEntries(value), sessionActivity: activity, broadcast: () => undefined,
      markSessionUnreadCompleted: () => transitions.push("unread"), notifySessionCompleted: () => transitions.push("notification"),
    });
    activity.ensureStarted(initial);
    handler({ type: "runtime", action: "completed", sessionId: initial.sessionId, sessionFile: initial.sessionFile, aborted: true });
    expect(transitions).toEqual([]);
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
  it("reuses one runtime and admits queued distinct openings in FIFO order", async () => {
    const ids = Array.from({ length: 6 }, (_, index) => `cold-${index}`);
    const unblock: Array<() => void> = [];
    const opened: string[] = [];
    const { service, cwd, creates } = await fixtureService({
      list: async () => ids.map((id) => ({
        id, path: join(cwd, `${id}.jsonl`), cwd, created: new Date(), modified: new Date(), messageCount: 0,
      })),
      beforeCreate: async (input) => {
        if (!input.path) return;
        opened.push(input.path);
        await new Promise<void>((resolve) => unblock.push(resolve));
      },
    });
    const firstRequests = [
      service.open(ids[0]),
      service.open(ids[0]),
      service.open(ids[1]),
      service.open(ids[2]),
      service.open(ids[3]),
    ];
    await vi.waitFor(() => expect(opened).toHaveLength(4));
    const queued = [service.open(ids[4]), service.open(ids[5])];
    expect(opened).toHaveLength(4);
    unblock.shift()?.();
    await vi.waitFor(() => expect(opened.at(-1)).toBe(join(cwd, `${ids[4]}.jsonl`)));
    unblock.shift()?.();
    await vi.waitFor(() => expect(opened.at(-1)).toBe(join(cwd, `${ids[5]}.jsonl`)));
    unblock.splice(0).forEach((resolve) => resolve());
    await Promise.all([...firstRequests, ...queued]);
    expect(creates.filter((entry) => entry.path?.endsWith(`${ids[0]}.jsonl`))).toHaveLength(1);
    await service.open(ids[0]);
    expect(creates).toHaveLength(7); // initial runtime plus six distinct cold runtimes
    await service.disposeAll();
  });

  it("queues five-plus parallel creates until allocation slots are available", async () => {
    let initialized = false;
    let active = 0;
    let maxActive = 0;
    const unblock: Array<() => void> = [];
    const { service, creates } = await fixtureService({
      beforeCreate: async () => {
        if (!initialized) {
          initialized = true;
          return;
        }
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => unblock.push(() => {
          active -= 1;
          resolve();
        }));
      },
    });
    const requests = Array.from({ length: 6 }, () => service.create(undefined));
    await vi.waitFor(() => expect(unblock).toHaveLength(4));
    expect(maxActive).toBe(4);
    unblock.splice(0).forEach((resolve) => resolve());
    await vi.waitFor(() => expect(unblock).toHaveLength(2));
    unblock.splice(0).forEach((resolve) => resolve());
    const states = await Promise.all(requests);
    expect(new Set(states.map((state) => state.sessionId))).toHaveLength(6);
    expect(creates).toHaveLength(7); // initial runtime plus every queued create
    await service.disposeAll();
  });

  it("allows protected, viewed, and busy worker fan-outs above the idle residency target", async () => {
    const coldId = "over-cap";
    const { service, initial, cwd } = await fixtureService({
      list: async () => [{
        id: coldId, path: join(cwd, `${coldId}.jsonl`), cwd, created: new Date(), modified: new Date(), messageCount: 0,
      }],
    });
    const admitted = [];
    for (let index = 0; index < 15; index += 1) {
      const state = await service.create(undefined);
      admitted.push(state);
      if (index < 7) service.acquireViewer(state.sessionId, `viewer-${index}`, internalViewerPrincipal);
      else service.sessionForPath(state.sessionFile)!.isStreaming = true;
    }
    expect(service.lifecycleSnapshot().liveSessions).toHaveLength(16);
    expect(service.sessionForId(initial.sessionId)).toBe(initial);
    await expect(service.open(coldId)).resolves.toMatchObject({ sessionId: coldId });
    expect(service.lifecycleSnapshot().liveSessions).toHaveLength(17);
    expect(service.sessionForId(initial.sessionId)).toBe(initial);
    await service.disposeAll();
  });

  it("does not evict an idle runtime when an unknown session ID cannot be resolved", async () => {
    const { service, initial } = await fixtureService({ list: async () => [] });
    const admitted = [];
    for (let index = 0; index < 15; index += 1) admitted.push(await service.create(undefined));
    const idle = admitted[0];
    for (const [index, state] of admitted.slice(1).entries()) service.acquireViewer(state.sessionId, `kept-${index}`, internalViewerPrincipal);

    await expect(service.open("unknown")).rejects.toMatchObject({ status: 404 });
    expect(service.lifecycleSnapshot().liveSessions).toHaveLength(16);
    expect(service.sessionForId(idle.sessionId)).toBeDefined();
    expect(service.sessionForId(initial.sessionId)).toBe(initial);
    await service.disposeAll();
  });

  it("evicts only an idle runtime before admitting a replacement at the resident cap", async () => {
    const coldId = "replacement";
    const { service, initial, cwd } = await fixtureService({
      list: async () => [{
        id: coldId, path: join(cwd, `${coldId}.jsonl`), cwd, created: new Date(), modified: new Date(), messageCount: 0,
      }],
    });
    const admitted = [];
    for (let index = 0; index < 15; index += 1) admitted.push(await service.create(undefined));
    const idle = admitted[0];
    for (const [index, state] of admitted.slice(1).entries()) service.acquireViewer(state.sessionId, `kept-${index}`, internalViewerPrincipal);

    await expect(service.open(coldId)).resolves.toMatchObject({ sessionId: coldId });
    expect(service.lifecycleSnapshot().liveSessions).toHaveLength(16);
    expect(service.sessionForId(idle.sessionId)).toBeUndefined();
    expect(service.sessionForId(initial.sessionId)).toBe(initial);
    for (const state of admitted.slice(1)) expect(service.sessionForId(state.sessionId)).toBeDefined();
    await service.disposeAll();
  });

  it("evicts only runtime state while durable transcript, browser draft, unread, and session UI state survive reopening", async () => {
    const listed: Array<{ id: string; path: string; cwd: string; created: Date; modified: Date; messageCount: number }> = [];
    const { service, initial, cwd, creates } = await fixtureService({ list: async () => listed, loadEntriesFromPath: true });
    const evictedId = "eviction-target";
    const evictedPath = join(cwd, `${evictedId}.jsonl`);
    const mediumRecords = Array.from({ length: 256 }, (_, index) => ({
      type: "message", id: `message-${index}`, parentId: index ? `message-${index - 1}` : null,
      message: { role: "assistant", content: `durable transcript message ${index} ${"x".repeat(256)}` },
    }));
    const transcript = [
      JSON.stringify({ type: "session", id: evictedId, cwd }),
      ...mediumRecords.map((record) => JSON.stringify(record)),
      "",
    ].join("\n");
    await writeFile(evictedPath, transcript);
    listed.push({
      id: evictedId, path: evictedPath, cwd, created: new Date(), modified: new Date(), messageCount: mediumRecords.length,
    });
    const replacementId = "eviction-replacement";
    listed.push({
      id: replacementId, path: join(cwd, `${replacementId}.jsonl`), cwd, created: new Date(), modified: new Date(), messageCount: 0,
    });
    await service.open(evictedId);
    const residentMessages = await service.messages(evictedId);
    expect(residentMessages.at(-1)).toMatchObject({ entryId: "message-255", text: expect.stringContaining("durable transcript message 255") });
    const admitted = [];
    for (let index = 0; index < 14; index += 1) admitted.push(await service.create(undefined));
    for (const [index, state] of admitted.entries()) service.acquireViewer(state.sessionId, `kept-${index}`, internalViewerPrincipal);

    class MemoryStorage {
      private readonly values = new Map<string, string>();
      getItem(key: string) { return this.values.get(key) ?? null; }
      setItem(key: string, value: string) { this.values.set(key, value); }
      removeItem(key: string) { this.values.delete(key); }
    }
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      addEventListener: () => undefined,
    });
    const browserStorage = new MemoryStorage();
    createSessionDraftStore(browserStorage).update(evictedId, { text: "draft survives runtime eviction" }, true);
    const uiStateFile = join(cwd, "session-ui-state.json");
    await createSessionUiStateStore(uiStateFile).patch({
      expectedRevision: 0,
      initialize: true,
      lanes: [{ sessionId: evictedId, lane: "parked", cwd, since: "2026-01-01T00:00:00.000Z" }],
      sessionNotes: [{ sessionId: evictedId, note: "durable UI state", updatedAt: "2026-01-01T00:00:00.000Z" }],
      sessionUnreadStates: [{ sessionId: evictedId, unreadAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
    });

    await service.open(replacementId);
    expect(service.lifecycleSnapshot().liveSessions).toHaveLength(16);
    expect(service.sessionForId(evictedId)).toBeUndefined();
    expect(service.sessionForId(initial.sessionId)).toBe(initial);
    expect(await readFile(evictedPath, "utf8")).toBe(transcript);
    await expect(service.readSession({ sessionId: evictedId }, 20)).resolves.toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ entryId: "message-255", text: expect.stringContaining("durable transcript message 255") }),
      ]),
    });
    expect(createSessionDraftStore(browserStorage).get(evictedId).text).toBe("draft survives runtime eviction");
    const reloadedUiState = await createSessionUiStateStore(uiStateFile).read();
    expect(reloadedUiState.lanes).toContainEqual(expect.objectContaining({ sessionId: evictedId, lane: "parked" }));
    expect(reloadedUiState.sessionNotes).toContainEqual(expect.objectContaining({ sessionId: evictedId, note: "durable UI state" }));
    expect(reloadedUiState.sessionUnreadStates).toContainEqual(expect.objectContaining({ sessionId: evictedId }));

    const createsBeforeReopen = creates.length;
    await expect(service.open(evictedId)).resolves.toMatchObject({ sessionId: evictedId });
    expect(creates).toHaveLength(createsBeforeReopen + 1);
    expect(service.sessionForId(evictedId)).toBeDefined();
    expect(await service.messages(evictedId)).toEqual(residentMessages);
    expect(await readFile(evictedPath, "utf8")).toBe(transcript);
    await service.disposeAll();
  });

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
    service.acquireViewer(viewed.sessionId, "viewer", internalViewerPrincipal);
    await vi.advanceTimersByTimeAsync(19);
    expect(service.lifecycleSnapshot().viewerLeases).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(service.lifecycleSnapshot().viewerLeases).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(30);
    expect(service.sessionForId(viewed.sessionId)).toBeUndefined();

    const working = await service.create(undefined);
    await service.navigate(working.sessionId, "result", {});
    await vi.advanceTimersByTimeAsync(29);
    expect(service.sessionForId(working.sessionId)).toBeDefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(service.sessionForId(working.sessionId)).toBeUndefined();
  });

  it("exposes per-lease diagnostics and warns without expiring long work", async () => {
    vi.stubEnv("PI_WEB_WORK_LEASE_WATCHDOG_MS", "20");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { service, initial } = await fixtureService();
    let finishNavigate!: () => void;
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    initial.navigateTree = () => { markEntered(); return new Promise((resolve) => { finishNavigate = () => resolve({ cancelled: false }); }); };
    vi.useFakeTimers();

    const navigation = service.navigate(initial.sessionId, "result", {});
    await entered;
    expect(service.lifecycleSnapshot().liveSessions[0]).toMatchObject({
      workLeases: 1,
      retryLeases: 0,
      leases: [{ label: "navigate", kind: "general", heldForMs: 0 }],
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(warn).toHaveBeenCalledWith("Session work lease watchdog: lease remains active", expect.objectContaining({ label: "navigate", heldForMs: 20 }));
    expect(service.hasActiveWorkForPath(initial.sessionFile)).toBe(true);

    finishNavigate();
    await navigation;
    expect(service.lifecycleSnapshot().liveSessions[0]?.leases).toEqual([]);
    warn.mockRestore();
  });

  it("lets abort recover a gated lease and ignores its late scoped release", async () => {
    const { service, initial } = await fixtureService();
    let finishNavigate!: () => void;
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    initial.navigateTree = () => { markEntered(); return new Promise((resolve) => { finishNavigate = () => resolve({ cancelled: false }); }); };
    const events: SessionServiceEvent[] = [];
    service.subscribe((event) => events.push(event));

    const navigation = service.navigate(initial.sessionId, "result", {});
    await entered;
    expect(service.hasActiveWorkForPath(initial.sessionFile)).toBe(true);
    await service.abort(initial.sessionId);
    expect(service.hasActiveWorkForPath(initial.sessionFile)).toBe(false);
    const changedAfterAbort = events.filter((event) => event.type === "runtime" && event.action === "changed").length;

    finishNavigate();
    await navigation;
    expect(service.hasActiveWorkForPath(initial.sessionFile)).toBe(false);
    expect(events.filter((event) => event.type === "runtime" && event.action === "changed")).toHaveLength(changedAfterAbort);
  });

  it("orders viewer acquisitions per client and retains legacy acquisitions", async () => {
    const { service, initial } = await fixtureService();
    const second = await service.create(undefined);
    service.acquireViewer(initial.sessionId, "client", internalViewerPrincipal, 20);
    const connection = service.connectViewer("client", internalViewerPrincipal)!;
    const snapshot = () => service.lifecycleSnapshot().liveSessions;
    service.acquireViewer(second.sessionId, "client", internalViewerPrincipal, 19);
    expect(snapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: initial.sessionId, viewerLeases: 1 }),
      expect.objectContaining({ sessionId: second.sessionId, viewerLeases: 0 }),
    ]));
    service.acquireViewer(second.sessionId, "client", internalViewerPrincipal, 21);
    expect(snapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: initial.sessionId, viewerLeases: 0 }),
      expect.objectContaining({ sessionId: second.sessionId, viewerLeases: 1 }),
    ]));
    service.acquireViewer(initial.sessionId, "other-client", internalViewerPrincipal, 0);
    expect(snapshot().find((entry) => entry.sessionId === initial.sessionId)?.viewerLeases).toBe(1);
    service.acquireViewer(initial.sessionId, "client", internalViewerPrincipal);
    service.acquireViewer(second.sessionId, "client", internalViewerPrincipal, 20);
    expect(snapshot().find((entry) => entry.sessionId === initial.sessionId)?.viewerLeases).toBe(2);
    service.disconnectViewer(connection);
    service.releaseViewer("other-client", internalViewerPrincipal);
  });

  it("isolates equal client ids by credential principal and scopes lifecycle diagnostics", async () => {
    const { service, initial, cwd } = await fixtureService();
    const second = await service.create(undefined);
    const browser = "identity:external:alice";
    const automation = "identity:token:automation";

    service.acquireViewer(initial.sessionId, "same-client", browser, 10);
    service.acquireViewer(second.sessionId, "same-client", automation, 999);
    service.acquireViewer(second.sessionId, "same-client", browser, 9);

    expect(service.lifecycleSnapshot(browser).viewerLeases).toEqual([
      expect.objectContaining({ clientId: "same-client", sessionId: initial.sessionId }),
    ]);
    expect(service.lifecycleSnapshot(automation).viewerLeases).toEqual([
      expect.objectContaining({ clientId: "same-client", sessionId: second.sessionId }),
    ]);
    expect(JSON.stringify(service.lifecycleSnapshot(browser))).not.toContain(cwd);

    service.acquireViewer(second.sessionId, "same-client", browser, 11);
    expect(service.lifecycleSnapshot(browser).viewerLeases[0]?.sessionId).toBe(second.sessionId);
    service.releaseViewer("same-client", automation);
    expect(service.lifecycleSnapshot(browser).viewerLeases).toHaveLength(1);
  });

  it("drops sequence ceilings with expired leases", async () => {
    vi.stubEnv("PI_WEB_VIEWER_LEASE_GRACE_MS", "20");
    const { service, initial } = await fixtureService();
    vi.useFakeTimers();

    service.acquireViewer(initial.sessionId, "client", internalViewerPrincipal, 100);
    await vi.advanceTimersByTimeAsync(20);
    expect(service.lifecycleSnapshot(internalViewerPrincipal).viewerLeases).toEqual([]);

    expect(service.acquireViewer(initial.sessionId, "client", internalViewerPrincipal, 1)).toBe(true);
    expect(service.lifecycleSnapshot(internalViewerPrincipal).viewerLeases).toHaveLength(1);
  });

  it("does not let an obsolete acquisition extend the viewer release timer", async () => {
    vi.stubEnv("PI_WEB_VIEWER_LEASE_GRACE_MS", "100");
    const { service, initial } = await fixtureService();
    vi.useFakeTimers();
    service.acquireViewer(initial.sessionId, "client", internalViewerPrincipal, 2);
    await vi.advanceTimersByTimeAsync(75);
    service.acquireViewer(initial.sessionId, "client", internalViewerPrincipal, 1);
    await vi.advanceTimersByTimeAsync(25);
    expect(service.lifecycleSnapshot().viewerLeases).toEqual([]);
    await service.disposeAll("reset");
  });

  it("attaches an obsolete WebSocket to the existing lease without repointing or resetting its sequence", async () => {
    const { service, initial } = await fixtureService();
    const second = await service.create(undefined);
    service.acquireViewer(initial.sessionId, "client", internalViewerPrincipal, 2);
    expect(service.acquireViewer(second.sessionId, "client", internalViewerPrincipal, 1)).toBe(false);
    const connection = service.connectViewer("client", internalViewerPrincipal)!;
    expect(service.lifecycleSnapshot(internalViewerPrincipal).viewerLeases[0]).toMatchObject({
      sessionId: initial.sessionId,
      sockets: 1,
    });

    expect(service.acquireViewer(second.sessionId, "client", internalViewerPrincipal, 1)).toBe(false);
    expect(service.lifecycleSnapshot(internalViewerPrincipal).viewerLeases[0]?.sessionId).toBe(initial.sessionId);
    expect(service.acquireViewer(second.sessionId, "client", internalViewerPrincipal, 3)).toBe(true);
    expect(service.lifecycleSnapshot(internalViewerPrincipal).viewerLeases[0]).toMatchObject({
      sessionId: second.sessionId,
      sockets: 1,
    });
    service.disconnectViewer(connection);
  });

  it("does not let a stale socket release a replacement viewer lease", async () => {
    const { service, cwd } = await fixtureService();
    const first = await service.create(undefined);
    service.acquireViewer(first.sessionId, "client", internalViewerPrincipal);
    const staleConnection = service.connectViewer("client", internalViewerPrincipal)!;

    await service.disposeAll("reset");
    const replacement = fixtureSession(cwd, "replacement").session;
    service.setCurrentSession(replacement);
    service.acquireViewer(replacement.sessionId, "client", internalViewerPrincipal);
    const activeConnection = service.connectViewer("client", internalViewerPrincipal)!;

    service.disconnectViewer(staleConnection);
    expect(service.lifecycleSnapshot().viewerLeases).toEqual([
      expect.objectContaining({ clientId: "client", sockets: 1 }),
    ]);
    expect(service.lifecycleSnapshot().liveSessions).toEqual([
      expect.objectContaining({ sessionId: "replacement", viewerLeases: 1 }),
    ]);
    service.disconnectViewer(activeConnection);
  });

  it("does not acquire a lease when a socket closes during delayed resolution", async () => {
    const { service, initial } = await fixtureService();
    const second = await service.create(undefined);
    const principal = "identity:external:alice";
    const socket = {
      OPEN: 1,
      readyState: 1,
      once: vi.fn(),
    };
    let finishResolution!: () => void;
    const resolution = new Promise<PiWebSession | undefined>((resolve) => {
      finishResolution = () => resolve(service.sessionForId(second.sessionId));
    });

    const pending = (async () => {
      const target = await resolution;
      if (socket.readyState !== socket.OPEN) return;
      service.acquireViewer((target || initial).sessionId, "client", principal, 1);
      const connection = service.connectViewer("client", principal);
      if (connection) socket.once("close", () => service.disconnectViewer(connection));
    })();
    socket.readyState = 3;
    finishResolution();
    await pending;
    expect(service.lifecycleSnapshot(principal).viewerLeases).toEqual([]);
    expect(socket.once).not.toHaveBeenCalled();
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
    service.acquireViewer(initial.sessionId, "mock-client", internalViewerPrincipal);
    service.connectViewer("mock-client", internalViewerPrincipal);
    const replacementFixture = fixtureSession(cwd, "mock-reset");

    await service.resetWith(replacementFixture.session);

    expect(fixture.disposeCalls).toBe(1);
    expect(service.sessionForId(initial.sessionId)).toBeUndefined();
    expect(service.sessionForId("mock-reset")).toBe(replacementFixture.session);
    expect(service.lifecycleSnapshot().viewerLeases).toEqual([]);
  });

  it("reads cold exact entries without opening another runtime and labels an archive tail", async () => {
    let coldPath = "";
    const { service, initial, cwd, creates } = await fixtureService({
      list: async () => coldPath ? [{
        id: "cold-session", path: coldPath, cwd, name: "", firstMessage: "root", allMessagesText: "root",
        created: new Date("2026-01-01T00:00:00Z"), modified: new Date("2026-01-01T00:00:00Z"), messageCount: 200,
      }] : [],
    });
    coldPath = join(cwd, "cold-session.jsonl");
    const records = [
      { type: "session", version: 3, id: "cold-session", cwd },
      { type: "message", id: "root", parentId: null, message: { role: "user", content: "root" } },
      { type: "message", id: "old", parentId: "root", message: { role: "assistant", content: "old branch " + "x".repeat(7_000) } },
      { type: "message", id: "active", parentId: "root", message: { role: "assistant", content: "active branch" } },
      ...Array.from({ length: 197 }, (_, index) => ({
        type: "message", id: `tail-${index}`, parentId: index ? `tail-${index - 1}` : "active",
        message: { role: "assistant", content: `tail ${index}` },
      })),
    ];
    const original = records.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    await writeFile(coldPath, original);

    const live = await service.readSession({ sessionId: initial.sessionId }, 20);
    expect(live).toMatchObject({ source: "active branch", entries: expect.arrayContaining([expect.objectContaining({ entryId: "result", text: expect.stringContaining("✓ read: ok") })]) });
    expect(live.entries[0]?.text).toContain("→ read(path: secret)");

    const exact = await service.readSession({ sessionId: "cold-session", entryId: "old" }, 200);
    expect(exact).toMatchObject({ source: "saved history (may include alternate branches)", entries: [expect.objectContaining({ entryId: "old" })], truncated: true });
    expect(exact.entries[0]?.text).toMatch(/…$/);

    const tail = await service.readSession({ sessionId: "cold-session" }, 200);
    expect(tail.source).toBe("saved history (may include alternate branches)");
    expect(tail.truncated).toBe(true);
    expect(tail.entries).toHaveLength(200);
    expect(tail.entries.map((entry) => entry.entryId)).toEqual(["root", "old", "active", ...Array.from({ length: 197 }, (_, index) => `tail-${index}`)]);
    expect(creates).toHaveLength(1);
    expect(await readFile(coldPath, "utf8")).toBe(original);
  });

  it("projects a roughly 4.6 MiB cold tool result with a sized inline-image omission", async () => {
    let coldPath = "";
    const { service, cwd, creates } = await fixtureService({
      list: async () => coldPath ? [{
        id: "image-cold", path: coldPath, cwd, created: new Date(), modified: new Date(), messageCount: 1,
      }] : [],
    });
    coldPath = join(cwd, "image-cold.jsonl");
    const imageBytes = 4_606_572;
    const toolResult = JSON.stringify({
      type: "message", id: "large-tool-result", parentId: null,
      message: {
        role: "toolResult", toolCallId: "tool-1", toolName: "inspect_image", isError: false,
        content: [
          { type: "text", text: "ordinary tool output survived" },
          { type: "image", mimeType: "image/png", data: "a".repeat(imageBytes) },
        ],
      },
    });
    expect(Buffer.byteLength(toolResult)).toBeGreaterThan(imageBytes);
    expect(Buffer.byteLength(toolResult)).toBeLessThan(savedTranscriptLimits.maxRecordBytes);
    await writeFile(coldPath, [
      JSON.stringify({ type: "session", id: "image-cold", cwd }),
      toolResult,
      "",
    ].join("\n"));

    const tail = await service.readSession({ sessionId: "image-cold" }, 20);
    expect(tail.entries).toEqual([expect.objectContaining({
      entryId: "large-tool-result",
      text: "  ✓ inspect_image: ordinary tool output survived\n[omitted saved transcript image/png base64 image data: 4606572 bytes]",
    })]);
    const exact = await service.readSession({ sessionId: "image-cold", entryId: "large-tool-result" }, 20);
    expect(exact.entries).toEqual([expect.objectContaining({
      entryId: "large-tool-result",
      text: "  ✓ inspect_image: ordinary tool output survived\n[omitted saved transcript image/png base64 image data: 4606572 bytes]",
    })]);
    expect(creates).toHaveLength(1);
    await service.disposeAll();
  });

  it("streams and skips a 64 MiB garbage record with bounded buffering, then returns later cold records", async () => {
    let coldPath = "";
    const { service, cwd, creates } = await fixtureService({
      list: async () => coldPath ? [{
        id: "bounded-cold", path: coldPath, cwd, created: new Date(), modified: new Date(), messageCount: 1,
      }] : [],
    });
    coldPath = join(cwd, "bounded-cold.jsonl");
    const handle = await open(coldPath, "w");
    try {
      await handle.write(`${JSON.stringify({ type: "session", id: "bounded-cold", cwd })}\n`);
      const garbageChunk = Buffer.alloc(MIB, 0x78);
      for (let index = 0; index < 64; index += 1) await handle.write(garbageChunk);
      await handle.write(`\n${JSON.stringify({
        type: "message", id: "after-garbage", parentId: null,
        message: { role: "assistant", content: "small record after pathological line" },
      })}\n`);
    } finally {
      await handle.close();
    }
    await expect(service.readSession({ sessionId: "bounded-cold", entryId: "after-garbage" }, 20)).resolves.toMatchObject({
      entries: [expect.objectContaining({ entryId: "after-garbage", text: expect.stringContaining("small record after pathological line") })],
      truncated: true,
    });
    await expect(service.readSession({ sessionId: "bounded-cold" }, 20)).resolves.toMatchObject({
      entries: [expect.objectContaining({ entryId: "after-garbage" })],
      truncated: true,
    });
    expect(creates).toHaveLength(1);
    await service.disposeAll();
  });

  it("streams a sparse transcript beyond the former total-file ceiling", async () => {
    let coldPath = "";
    const { service, cwd, creates } = await fixtureService({
      list: async () => coldPath ? [{
        id: "large-cold", path: coldPath, cwd, created: new Date(), modified: new Date(), messageCount: 1,
      }] : [],
    });
    coldPath = join(cwd, "large-cold.jsonl");
    const handle = await open(coldPath, "w");
    try {
      await handle.write(`${JSON.stringify({ type: "session", id: "large-cold", cwd })}\n`);
      await handle.truncate(128 * 1024 * 1024 + 1);
      await handle.write(`\n${JSON.stringify({
        type: "message", id: "target", parentId: null,
        message: { role: "assistant", content: "found after sparse oversized record" },
      })}\n`, 128 * 1024 * 1024 + 1);
    } finally {
      await handle.close();
    }
    await expect(service.readSession({ sessionId: "large-cold", entryId: "target" }, 20)).resolves.toMatchObject({
      entries: [expect.objectContaining({ entryId: "target", text: expect.stringContaining("found after sparse oversized record") })],
      truncated: true,
    });
    expect(creates).toHaveLength(1);
    await service.disposeAll();
  });

  it("omits excluded shell commands and output from live and cold session reads", async () => {
    let coldPath = "";
    const { service, initial, cwd } = await fixtureService({
      list: async () => coldPath ? [{
        id: "hidden-shell", path: coldPath, cwd, name: "", firstMessage: "", allMessagesText: "",
        created: new Date("2026-01-01T00:00:00Z"), modified: new Date("2026-01-01T00:00:00Z"), messageCount: 2,
      }] : [],
    });
    const hidden = {
      type: "message", id: "hidden", parentId: null,
      message: { role: "bashExecution", command: "printf TOP-SECRET-COMMAND", output: "TOP-SECRET-OUTPUT", excludeFromContext: true },
    };
    const visible = {
      type: "message", id: "visible", parentId: "hidden",
      message: { role: "bashExecution", command: "printf normal", output: "normal-output", excludeFromContext: false },
    };
    initial.sessionManager.getBranch = () => [hidden, visible] as any;
    initial.sessionManager.getEntry = (id: string) => [hidden, visible].find((entry) => entry.id === id) as any;

    const live = await service.readSession({ sessionId: initial.sessionId }, 20);
    expect(JSON.stringify(live)).not.toContain("TOP-SECRET");
    expect(live.entries).toEqual([expect.objectContaining({ entryId: "visible", text: expect.stringContaining("normal-output") })]);
    await expect(service.readSession({ sessionId: initial.sessionId, entryId: "hidden" }, 1)).rejects.toMatchObject({ status: 404 });

    coldPath = join(cwd, "hidden-shell.jsonl");
    await writeFile(coldPath, [
      JSON.stringify({ type: "session", version: 3, id: "hidden-shell", cwd }),
      JSON.stringify(hidden),
      JSON.stringify(visible),
      "",
    ].join("\n"));
    const cold = await service.readSession({ sessionId: "hidden-shell" }, 20);
    expect(JSON.stringify(cold)).not.toContain("TOP-SECRET");
    expect(cold.entries).toEqual([expect.objectContaining({ entryId: "visible", text: expect.stringContaining("normal-output") })]);
    await expect(service.readSession({ sessionId: "hidden-shell", entryId: "hidden" }, 1)).rejects.toMatchObject({ status: 404 });
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

  it("keeps navigation lease finalization inside the service and exposes lifecycle diagnostics", async () => {
    const source = await readFile(new URL("../server.ts", import.meta.url), "utf8");
    const start = source.indexOf('url.pathname === "/api/session/tree/navigate"');
    const route = source.slice(start, source.indexOf('url.pathname === "/api/session/tree/abort-summary"', start));
    expect(route).toContain("sessionService.navigate");
    expect(route).not.toContain("finish");
    expect(source).toContain('url.pathname === "/api/session/lifecycle"');
    expect(source).toContain("sessionService.lifecycleSnapshot(requestViewerPrincipal)");
    expect(route).not.toContain("setTimeout");
  });

  it("binds viewer sockets only after resolution and an open-state check", async () => {
    const source = await readFile(new URL("../server.ts", import.meta.url), "utf8");
    const resolved = source.indexOf("targetSession = await resolveWebSocketHelloSession");
    const openCheck = source.indexOf("realtimeWs.readyState !== realtimeWs.OPEN", resolved);
    const acquire = source.indexOf("sessionService.acquireViewer", openCheck);
    const connect = source.indexOf("sessionService.connectViewer", acquire);
    const registerClose = source.indexOf('realtimeWs.once("close"', connect);
    expect([resolved, openCheck, acquire, connect, registerClose].every((index) => index >= 0)).toBe(true);
    expect(resolved).toBeLessThan(openCheck);
    expect(openCheck).toBeLessThan(acquire);
    expect(acquire).toBeLessThan(connect);
    expect(connect).toBeLessThan(registerClose);
  });
});
