import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockHarness } from "../server/mock.js";
import { createPiAdapter } from "../server/session/adapters/pi/index.js";
import { LocalSessionService } from "../server/session/service.js";
import { NativeBindings } from "../server/session/nativeBindings.js";
import type { AdapterPromptInput, SessionAdapter, SessionHandle } from "../server/session/adapter.js";
import type { HarnessDescriptorDto, InteractionResponseDto, SessionServiceEvent, SessionSnapshotDto } from "../server/session/dto.js";
import { SessionActivity } from "../server/session/activity.js";
import { createHostSessionEventHandler } from "../server/session/hostEvents.js";

const roots: string[] = [];
const services: LocalSessionService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.disposeAll()));
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const harness: HarnessDescriptorDto = { id: "codex", name: "Codex fixture", enabled: true, available: true,
  capabilities: { harness: "codex", queue: false, steering: false, followUp: false, thinkingLevel: false, tree: false,
    compaction: false, retry: false, bash: false, extensions: false, interactions: true, models: false, context: false, attachments: false } };

/** Core admission/identity fixture, NOT evidence of native protocol conformance. */
class Handle implements SessionHandle {
  readonly harnessId = "codex" as const;
  readonly listeners = new Set<(event: SessionServiceEvent) => void>();
  disposed = 0;
  prompts: AdapterPromptInput[] = [];
  snapshot: SessionSnapshotDto;
  constructor(readonly sessionId: string, cwd: string, nativeId = randomUUID(), ephemeral = false) {
    this.snapshot = { sessionId, cwd, sessionTitle: "Native fixture", harnessId: "codex", phase: "idle", activity: "idle",
      nativeSession: { harnessId: "codex", sessionId: nativeId, persistence: ephemeral ? "ephemeral" : "persistent", status: ephemeral ? "live-only" : "unmaterialized" },
      pendingInteractions: [], capabilities: harness.capabilities, isStreaming: false, isRetrying: false, isCompacting: false,
      stats: { userMessages: 0, assistantMessages: 0, toolResults: 0, totalMessages: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  }
  state() { return structuredClone(this.snapshot); }
  async messages() { return []; }
  emit(event: SessionServiceEvent) { for (const listener of this.listeners) listener(event); }
  update(patch: Partial<SessionSnapshotDto>) { Object.assign(this.snapshot, patch); this.emit({ type: "state", state: this.state() }); }
  async prompt(input: AdapterPromptInput) {
    this.prompts.push(input);
    this.update({ phase: "starting", activity: "working", activeExecution: { id: input.executionId, owner: "host" } });
    return { sessionId: this.sessionId, executionId: input.executionId, acknowledgement: "pending" as const };
  }
  async interrupt(expectedExecutionId: string) {
    if (this.snapshot.activeExecution?.id !== expectedExecutionId) throw new Error("stale execution");
    return { sessionId: this.sessionId, executionId: expectedExecutionId, acknowledged: true as const };
  }
  respondInteraction(response: InteractionResponseDto) {
    const request = this.snapshot.pendingInteractions.find((request) => request.id === response.id);
    if (response.sessionId !== this.sessionId || !request?.choices?.some((choice) => choice.id === response.choiceID)) return false;
    this.snapshot.pendingInteractions = this.snapshot.pendingInteractions.filter((request) => request.id !== response.id);
    this.emit({ type: "interaction_resolved", sessionId: this.sessionId, id: response.id, reason: "responded" });
    return true;
  }
  cancelInteractions() {
    for (const request of this.snapshot.pendingInteractions) this.emit({ type: "interaction_resolved", sessionId: this.sessionId, id: request.id, reason: "cancelled" });
    this.snapshot.pendingInteractions = [];
  }
  subscribe(listener: (event: SessionServiceEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async dispose() { this.cancelInteractions(); this.disposed++; }
}

async function fixture(options: { enabled?: boolean; cwd?: string; ephemeral?: boolean } = {}) {
  const cwd = options.cwd || await mkdtemp(join(tmpdir(), "pi-web-adapter-service-"));
  if (!options.cwd) roots.push(cwd);
  vi.stubEnv("PI_WEB_SETTINGS_FILE", join(cwd, "settings.json"));
  const mock = createMockHarness({ piCwd: cwd });
  const pi = createPiAdapter({ modelRuntime: {} as any,
    peer: { create: async ({ path }) => ({ session: mock.createMockSession(path) }), list: async () => mock.mockSessions, newSessionAfterCreate: true },
    additionalExtensionPaths: () => [], defaultsFor: async () => ({}), globalCwd: () => cwd, clientCount: () => 1 });
  const handles: Handle[] = [];
  const open = vi.fn(async (input) => { const handle = new Handle(input.sessionId, input.cwd, input.nativeSession.sessionId); handles.push(handle); return handle; });
  const adapter: SessionAdapter = { harness, create: async (input) => { const handle = new Handle(input.sessionId!, input.cwd, undefined, options.ephemeral); handles.push(handle); return handle; }, open, list: async () => [] };
  const service = new LocalSessionService({ pi, adapters: [adapter], multiHarnessEnabled: options.enabled ?? true,
    nativeBindingsFile: join(cwd, "native.json"), globalCwd: () => cwd, finalizeCreatedSession: async () => undefined });
  services.push(service);
  await service.initialize();
  return { service, cwd, handles, open, adapter };
}

describe("single-handle core routing", () => {
  it("keeps Pi identity, requires native opt-in, and never falls back on invalid selection", async () => {
    const { service } = await fixture({ enabled: false });
    const pi = await service.create(undefined);
    expect(pi.harnessId).toBe("pi");
    expect(pi.nativeSession.sessionId).toBe(pi.sessionId);
    expect(service.catalog().harnesses.find((item) => item.id === "codex")?.enabled).toBe(false);
    const count = service.lifecycleSnapshot().liveSessions.length;
    await expect(service.create(undefined, undefined, "codex")).rejects.toMatchObject({ status: 503 });
    await expect(service.create(undefined, undefined, "typo" as any)).rejects.toMatchObject({ status: 400 });
    expect(service.lifecycleSnapshot().liveSessions).toHaveLength(count);
  });

  it("rejects adapter identity/path impersonation and disposes only the returned handle", async () => {
    const { service, cwd, adapter } = await fixture();
    const wrong = new Handle("wrong-web-id", cwd);
    const create = vi.spyOn(adapter, "create").mockResolvedValue(wrong);
    await expect(service.create(undefined, undefined, "codex")).rejects.toThrow("different session identity");
    expect(wrong.disposed).toBe(1);
    expect(service.sessionForId("wrong-web-id")).toBeUndefined();
    create.mockImplementation(async (input) => {
      const handle = new Handle(input.sessionId!, cwd);
      handle.snapshot.sessionFile = "/not-a-native-routing-key";
      return handle;
    });
    await expect(service.create(undefined, undefined, "codex")).rejects.toThrow("Adapter identity mismatch");
    expect(service.lifecycleSnapshot().liveSessions.every((entry) => entry.harnessId === "pi")).toBe(true);
  });

  it("separates web/native/execution IDs and enforces unsupported operations", async () => {
    const { service } = await fixture();
    const state = await service.create(undefined, undefined, "codex");
    expect(state.sessionId).not.toBe(state.nativeSession.sessionId);
    expect(state).not.toHaveProperty("sessionFile");
    expect(state.stats).not.toHaveProperty("cost");
    for (const call of [() => service.tree(state.sessionId), () => service.context(state.sessionId), () => service.models(state.sessionId),
      () => service.setModel(state.sessionId, "pi", "model"), () => service.retry(state.sessionId), () => service.executeShell(state.sessionId, "pwd", false),
      () => service.executeCommand(state.sessionId, "/compact"), () => service.invokePanel(state.sessionId, { key: "pi-only" })]) {
      await expect(call()).rejects.toMatchObject({ status: 400 });
    }
    const input = { message: "hello", mode: "prompt", attachments: [] };
    await expect(service.prompt(state.sessionId, { ...input, mode: "steer" })).rejects.toMatchObject({ status: 400 });
    await expect(service.prompt(state.sessionId, { ...input, attachments: [{ type: "file" } as any] })).rejects.toMatchObject({ status: 400 });
    const receipt = await service.prompt(state.sessionId, input);
    expect(receipt.acknowledgement).toBe("pending");
    expect(receipt).not.toHaveProperty("nativeExecutionId");
    await expect(service.prompt(state.sessionId, input)).rejects.toMatchObject({ status: 409 });
    await expect(service.abort(state.sessionId)).rejects.toMatchObject({ status: 400 });
    await expect(service.abort(state.sessionId, "stale")).rejects.toMatchObject({ status: 409 });
    expect(await service.abort(state.sessionId, receipt.executionId)).toMatchObject({ acknowledged: true });
    expect((await service.state(state.sessionId)).phase).toBe("starting"); // ack is not idle
  });

  it("does not publish or retain a native binding when creation's durable write fails", async () => {
    const { service, cwd, adapter } = await fixture();
    let failedHandle!: Handle;
    vi.spyOn(adapter, "create").mockImplementation(async (input) => {
      failedHandle = new Handle(input.sessionId!, cwd);
      const subscribe = failedHandle.subscribe.bind(failedHandle);
      failedHandle.subscribe = (listener) => { listener({ type: "state", state: failedHandle.state() }); return subscribe(listener); };
      return failedHandle;
    });
    const events: SessionServiceEvent[] = [];
    service.subscribe((event) => events.push(event));
    const put = vi.spyOn(NativeBindings.prototype, "put").mockRejectedValue(new Error("synthetic disk failure"));
    try {
      await expect(service.create(undefined, undefined, "codex")).rejects.toThrow("synthetic disk failure");
      expect(put).toHaveBeenCalledTimes(1); // no registration/early-event fire-and-forget write
    } finally { put.mockRestore(); }
    expect(failedHandle.disposed).toBe(1);
    expect(service.sessionForId(failedHandle.sessionId)).toBeUndefined();
    expect((await service.list()).some((entry) => entry.id === failedHandle.sessionId)).toBe(false);
    expect(events.some((event) => event.type === "state" && event.state.sessionId === failedHandle.sessionId)).toBe(false);
    await expect(readFile(join(cwd, "native.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(service.state(failedHandle.sessionId)).rejects.toMatchObject({ status: 404 });
  });

  it("does not misreport submitted native input as rejected when metadata persistence fails", async () => {
    const { service } = await fixture();
    const state = await service.create(undefined, undefined, "codex");
    const events: SessionServiceEvent[] = [];
    service.subscribe((event) => events.push(event));
    const save = vi.spyOn(NativeBindings.prototype, "put").mockRejectedValue(new Error("disk unavailable"));
    try {
      const receipt = await service.prompt(state.sessionId, { message: "submitted once", mode: "prompt", attachments: [] });
      expect(receipt.acknowledgement).toBe("pending");
      expect(events).toContainEqual(expect.objectContaining({ type: "error", error: expect.stringContaining("Prompt submitted") }));
      await expect(service.prompt(state.sessionId, { message: "do not replay", mode: "prompt", attachments: [] })).rejects.toMatchObject({ status: 409 });
    } finally { save.mockRestore(); }
  });

  it("reuses live ephemeral handles; restart is unavailable, never native resume or Pi fallback", async () => {
    const first = await fixture({ ephemeral: true });
    const state = await first.service.create(undefined, undefined, "codex");
    await first.service.open(state.sessionId);
    expect(first.open).not.toHaveBeenCalled();
    await first.service.disposeAll();
    const second = await fixture({ cwd: first.cwd });
    await expect(second.service.open(state.sessionId)).rejects.toMatchObject({ status: 410 });
    expect(second.open).not.toHaveBeenCalled();
    expect(await second.service.delete(state.sessionId)).toMatchObject({ disposition: "deleted" });
    await expect(second.service.open(state.sessionId)).rejects.toMatchObject({ status: 410 });
  });

  it("recovers a dead persistent process only on explicit open, with one resume and no prompt replay", async () => {
    const { service, handles, open, cwd } = await fixture();
    const state = await service.create(undefined, undefined, "codex");
    await service.prompt(state.sessionId, { message: "already submitted", mode: "prompt", attachments: [] });
    const previous = handles[0];
    previous.update({ phase: "unavailable", activity: "idle", activeExecution: undefined,
      nativeSession: { ...state.nativeSession, status: "resumable" } });
    await service.state(state.sessionId); await service.state(state.sessionId);
    expect(open).not.toHaveBeenCalled();
    const [first, second] = await Promise.all([service.open(state.sessionId), service.open(state.sessionId)]);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith({ sessionId: state.sessionId, cwd, nativeSession: { ...state.nativeSession, status: "resumable" } });
    expect(first.sessionId).toBe(state.sessionId); expect(second.sessionId).toBe(state.sessionId);
    expect(previous.disposed).toBe(1);
    expect(previous.prompts).toHaveLength(1);
    expect(handles[1].prompts).toHaveLength(0);
    expect((await service.state(state.sessionId)).phase).toBe("idle");
  });

  it("does not respawn on state polls after failed recovery; another explicit open may retry", async () => {
    const { service, handles, open } = await fixture();
    const state = await service.create(undefined, undefined, "codex");
    handles[0].update({ phase: "unavailable", nativeSession: { ...state.nativeSession, status: "resumable" } });
    open.mockRejectedValueOnce(new Error("native resume unavailable"));
    await expect(service.open(state.sessionId)).rejects.toThrow("native resume unavailable");
    await expect(service.state(state.sessionId)).rejects.toMatchObject({ status: 503 });
    await expect(service.state(state.sessionId)).rejects.toMatchObject({ status: 503 });
    expect(open).toHaveBeenCalledTimes(1);
    await service.open(state.sessionId);
    expect(open).toHaveBeenCalledTimes(2);
    expect(handles.at(-1)!.prompts).toHaveLength(0);
  });

  it("does not try to resume a cached unavailable ephemeral process", async () => {
    const { service, handles, open } = await fixture({ ephemeral: true });
    const state = await service.create(undefined, undefined, "codex");
    handles[0].update({ phase: "unavailable" });
    await expect(service.open(state.sessionId)).rejects.toMatchObject({ status: 410 });
    await expect(service.open(state.sessionId)).rejects.toMatchObject({ status: 410 });
    expect(open).not.toHaveBeenCalled();
  });

  it("resumes the exact persistent native identity without paths, transcript storage or prompt replay", async () => {
    const first = await fixture();
    const state = await first.service.create(undefined, undefined, "codex");
    first.handles[0].update({ nativeSession: { ...state.nativeSession, status: "resumable" } });
    await first.service.disposeAll();
    const second = await fixture({ cwd: first.cwd });
    const opened = await second.service.open(state.sessionId);
    expect(second.open).toHaveBeenCalledWith({ sessionId: state.sessionId, cwd: first.cwd, nativeSession: { ...state.nativeSession, status: "resumable" } });
    expect(opened.sessionId).toBe(state.sessionId);
    expect(second.handles[0].prompts).toHaveLength(0);
    const saved = JSON.parse(await readFile(join(first.cwd, "native.json"), "utf8"));
    expect(saved.sessions[0]).not.toHaveProperty("messages");
    expect(saved.sessions[0]).not.toHaveProperty("sessionFile");
  });

  it("relays neutral streams and reconciles request-scoped controls through the same host subscription", async () => {
    const { service, handles } = await fixture();
    const state = await service.create(undefined, undefined, "codex");
    const activity = new SessionActivity((id) => service.sessionForPath(id)?.state());
    const wire: any[] = [];
    service.subscribe(createHostSessionEventHandler({ sessionForId: (id) => service.sessionForId(id), projectState: (handle) => service.projectState(handle),
      webUiEntries: (handle) => service.webUiEntries(handle), sessionActivity: activity, broadcast: (value) => wire.push(value), markSessionUnreadCompleted: () => undefined }));
    const event: SessionServiceEvent = { type: "message_delta", sessionId: state.sessionId, messageId: "message", partId: "part", delta: "hello" };
    handles[0].emit(event);
    expect(wire[0]).toEqual(event);
    const request = { id: "request", sessionId: state.sessionId, source: "approval" as const, kind: "command", payload: {}, timeout: 5000,
      choices: [{ id: "decline-once", label: "Decline and continue", meaning: "decline" as const }] };
    handles[0].update({ phase: "running", activity: "waiting-approval", pendingInteractions: [request] });
    handles[0].emit({ type: "interaction", request });
    expect((await service.state(state.sessionId)).pendingInteractions).toEqual([request]);
    expect(service.respondInteraction({ id: request.id, choiceID: "decline-once" })).toBe(false);
    expect(service.respondInteraction({ sessionId: "foreign", id: request.id, choiceID: "decline-once" })).toBe(false);
    expect(service.respondInteraction({ sessionId: state.sessionId, id: request.id, choiceID: "allow-broader" })).toBe(false);
    expect(service.respondInteraction({ sessionId: state.sessionId, id: request.id, choiceID: "decline-once" })).toBe(true);
    expect(service.respondInteraction({ sessionId: state.sessionId, id: request.id, choiceID: "decline-once" })).toBe(false);
    expect(wire).toContainEqual({ type: "interaction_resolved", sessionId: state.sessionId, id: request.id, reason: "responded" });
  });
});

describe("native binding file", () => {
  it("rejects corrupt/conflicting identity metadata rather than ignoring it", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-web-bindings-")); roots.push(cwd);
    const path = join(cwd, "native.json");
    await writeFile(path, "broken");
    await expect(new NativeBindings(path).ready).rejects.toThrow();
    const row = { id: "web", cwd, created: "now", modified: "now", nativeSession: { harnessId: "codex", sessionId: "native", persistence: "persistent", status: "resumable" } };
    await writeFile(path, JSON.stringify({ version: 1, sessions: [row, { ...row, id: "other-web" }] }));
    await expect(new NativeBindings(path).ready).rejects.toThrow("Conflicting native session identity");
  });
});
