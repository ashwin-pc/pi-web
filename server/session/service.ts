import { randomUUID } from "node:crypto";
import { EphemeralCaptureStore } from "../extensions/captureStore.js";
import { isSessionReferenceId, type SessionReference } from "../shared/sessionReference.js";
import type { SessionReadResult } from "./referenceTools.js";
import { boundReferenceText, canonicalTextReference } from "./referenceProjection.js";
import { resolve } from "node:path";
import { assertDirectory } from "../shared/fsList.js";
import type { SessionAdapter, SessionHandle, AdapterOpenInput, AdapterSessionInfo } from "./adapter.js";
import type { BaseSessionStateDto, DeleteSessionResultDto, HarnessCatalogDto, HarnessDescriptorDto, HarnessId, InteractionResponseDto, JsonValue, NavigationResult, PromptInputDto, SessionInfoDto, SessionService, SessionServiceEvent, SessionSnapshotDto } from "./dto.js";
import { jsonRoundTrip } from "./dto.js";
import { PiAdapter, PiSessionHandle } from "./adapters/pi/index.js";
import { NativeBindings, type NativeBinding } from "./nativeBindings.js";
import { SessionServiceError } from "./errors.js";
export { SessionServiceError } from "./errors.js";

export interface LocalSessionServiceDependencies {
  pi: PiAdapter;
  adapters?: SessionAdapter[];
  nativeBindingsFile: string;
  multiHarnessEnabled?: boolean;
  unavailableHarnesses?: HarnessDescriptorDto[];
  finalizeCreatedSession(sessionId: string): Promise<unknown>;
  globalCwd(): string;
}

type WorkLeaseKind = "general" | "retry";
type WorkLeaseToken = { sessionKey: string; key: symbol };
type WorkLease = { id: number; label: string; kind: WorkLeaseKind; acquiredAt: number; watchdogTimer?: ReturnType<typeof setTimeout> };
type LiveSessionEntry = {
  handle: SessionHandle;
  unsubscribe?: () => void;
  viewerClientIds: Set<string>;
  workLeases: Map<symbol, WorkLease>;
  disposeTimer?: ReturnType<typeof setTimeout>;
  disposing?: boolean;
  dispatching?: boolean;
};
type ViewerLease = { sessionKey: string; sockets: Set<symbol>; releaseTimer?: ReturnType<typeof setTimeout> };
const envMs = (key: string, fallback: number) => {
  const value = Number(process.env[key] || fallback);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};
const running = (state: BaseSessionStateDto) => state.phase
  ? ["starting", "running", "settling"].includes(state.phase)
  : Boolean(state.isStreaming || state.isRetrying || state.isCompacting);

/** One handle cache, event relay, admission path and lifecycle for every harness. */
export class LocalSessionService implements SessionService {
  private readonly listeners = new Set<(event: SessionServiceEvent) => void>();
  private readonly liveSessions = new Map<string, LiveSessionEntry>();
  private readonly openingById = new Map<string, Promise<SessionHandle | undefined>>();
  private readonly adapters = new Map<HarnessId, SessionAdapter>();
  private readonly piLocations = new Map<string, AdapterOpenInput>();
  private readonly piNames = new Map<string, string | undefined>();
  private readonly knownSessionCwds = new Set<string>();
  private readonly viewerLeases = new Map<string, ViewerLease>();
  private readonly viewerConnections = new Map<symbol, string>();
  private readonly sessionListRequests = new Map<string, Promise<SessionInfoDto[]>>();
  private currentSessionId?: string;
  private nextWorkLeaseId = 1;
  private readonly bindings: NativeBindings;
  private readonly idleGraceMs = envMs("PI_WEB_SESSION_IDLE_GRACE_MS", 24 * 60 * 60 * 1000);
  private readonly viewerGraceMs = envMs("PI_WEB_VIEWER_LEASE_GRACE_MS", Math.min(30_000, this.idleGraceMs));
  private readonly workLeaseWatchdogMs = envMs("PI_WEB_WORK_LEASE_WATCHDOG_MS", 3 * 60 * 1000);
  readonly settingsStore;
  private readonly captureStore = new EphemeralCaptureStore();

  constructor(private readonly deps: LocalSessionServiceDependencies) {
    this.bindings = new NativeBindings(deps.nativeBindingsFile);
    // Preserve rejection for every native operation without an unhandled startup promise.
    void this.bindings.ready.catch(() => undefined);
    this.settingsStore = deps.pi.settingsStore;
    this.knownSessionCwds.add(resolve(deps.globalCwd()));
    for (const adapter of [deps.pi, ...(deps.adapters || [])]) {
      if (this.adapters.has(adapter.harness.id)) throw new Error(`Duplicate harness ${adapter.harness.id}`);
      this.adapters.set(adapter.harness.id, adapter);
    }
    deps.pi.bindHost({
      captureStore: this.captureStore,
      readSession: (reference, tail) => this.readSession(reference, tail),
      register: (handle) => { this.register(handle); },
      failed: (handle) => { void this.disposeLiveSession(handle.sessionId, "reset", true); },
      create: (cwd, previousSessionFile) => this.createWithAdapter("pi", cwd, previousSessionFile),
      withWorkLease: (handle, label, kind, operation) => this.withWorkLease(handle, label, kind, operation),
      clearWorkLeases: (handle, reason) => this.clearWorkLeases(handle, reason),
      hasWork: (id) => this.hasActiveWorkForPath(id),
    });
  }

  catalog(): HarnessCatalogDto {
    const descriptions = [...this.adapters.values()].map((adapter) => adapter.harness);
    for (const description of this.deps.unavailableHarnesses || []) if (!this.adapters.has(description.id)) descriptions.push(description);
    return jsonRoundTrip({ multiHarnessEnabled: Boolean(this.deps.multiHarnessEnabled), defaultHarnessId: "pi",
      harnesses: descriptions.map((item) => item.id === "pi" || this.deps.multiHarnessEnabled ? item : {
        ...item, enabled: false, unavailableReason: "Set PI_WEB_MULTI_HARNESS=1 to enable native harnesses",
      }) });
  }
  private adapter(id: string): SessionAdapter {
    if (!["pi", "codex", "claude"].includes(id)) throw new SessionServiceError(`Unknown harness: ${id}`, 400);
    const description = this.catalog().harnesses.find((item) => item.id === id);
    const adapter = this.adapters.get(id as HarnessId);
    if (!adapter || !description?.enabled || !description.available) throw new SessionServiceError(description?.unavailableReason || `Harness ${id} is unavailable`, 503);
    return adapter;
  }
  subscribe(listener: (event: SessionServiceEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(event: SessionServiceEvent) {
    const safe = jsonRoundTrip(event);
    for (const listener of this.listeners) {
      try { listener(safe); } catch (error) { console.warn("Session service event listener failed:", error); }
    }
  }
  private register(handle: SessionHandle) {
    const existing = this.liveSessions.get(handle.sessionId);
    if (existing?.handle === handle) return handle;
    if (existing) throw new SessionServiceError("Session is already open", 409);
    const state = handle.state();
    if (state.sessionId !== handle.sessionId || state.harnessId !== handle.harnessId) throw new Error("Adapter identity mismatch");
    const entry: LiveSessionEntry = { handle, viewerClientIds: new Set(), workLeases: new Map() };
    this.liveSessions.set(handle.sessionId, entry);
    this.remember(state);
    entry.unsubscribe = handle.subscribe((event) => {
      if (this.liveSessions.get(handle.sessionId) !== entry || entry.disposing && event.type !== "interaction_resolved") return;
      const eventSessionId = event.type === "state" ? event.state.sessionId : event.type === "interaction" ? event.request.sessionId : "sessionId" in event ? event.sessionId : undefined;
      if (eventSessionId && eventSessionId !== handle.sessionId) {
        console.warn("Rejected cross-session adapter event", { harness: handle.harnessId, type: event.type });
        return;
      }
      if (event.type === "state") this.remember(event.state);
      this.emit(event);
      this.scheduleLiveSessionCleanup(handle.sessionId);
    });
    queueMicrotask(() => this.scheduleLiveSessionCleanup(handle.sessionId));
    return handle;
  }
  private remember(state: BaseSessionStateDto) {
    this.knownSessionCwds.add(resolve(state.cwd));
    if (state.harnessId === "pi") {
      if (state.sessionFile) {
        this.piLocations.set(state.sessionId, { sessionId: state.sessionId, cwd: state.cwd, sessionFile: state.sessionFile, nativeSession: state.nativeSession! });
        this.piNames.set(state.sessionFile, state.sessionName);
      }
    } else if (state.nativeSession && state.harnessId) {
      void this.saveNative(state).catch((error) => this.emit({ type: "error", sessionId: state.sessionId, error: `Could not persist native binding: ${String(error)}` }));
    }
  }
  private async saveNative(state: BaseSessionStateDto) {
    await this.bindings.ready;
    const previous = this.bindings.get(state.sessionId);
    if (previous?.deleted || !state.nativeSession) return;
    const now = new Date().toISOString();
    await this.bindings.put({ id: state.sessionId, cwd: state.cwd, nativeSession: state.nativeSession,
      name: previous?.name ?? state.sessionName, firstMessage: previous?.firstMessage,
      created: previous?.created || now, modified: now });
  }
  async initialize(path?: string) {
    await this.bindings.ready;
    const handle = await this.deps.pi.initialize(path);
    this.setCurrentSession(handle);
    return handle;
  }
  setCurrentSession(handle: SessionHandle) { this.currentSessionId = handle.sessionId; this.register(handle); }
  async resetWith(handle: SessionHandle) { await this.disposeAll("reset"); this.setCurrentSession(handle); }
  async disposeAll(reason: "reset" | "idle" = "reset") {
    await Promise.all([...this.liveSessions.keys()].map((id) => this.disposeLiveSession(id, reason, true)));
    await this.captureStore.dispose();
    await this.bindings.flush();
  }
  sessionForId(id: string) { return this.liveSessions.get(id)?.handle; }
  /** Pi-only compatibility lookup for existing tool timing/extension callers. Native routing is ID-only. */
  sessionForPath(path: string) {
    return this.sessionForId(path) || [...this.liveSessions.values()].find((entry) => entry.handle.harnessId === "pi" && entry.handle.state().sessionFile === path)?.handle;
  }
  private keyFor(value: string) { return this.sessionForPath(value)?.sessionId || value; }
  hasActiveWorkForPath(key: string) { return Boolean(this.liveSessions.get(this.keyFor(key))?.workLeases.size); }
  hasActiveRetryForPath(key: string) { return [...(this.liveSessions.get(this.keyFor(key))?.workLeases.values() || [])].some((lease) => lease.kind === "retry"); }
  cwdForSession(handle: SessionHandle) { return handle.state().cwd; }
  async cwdForSessionId(id: string) {
    const handle = this.sessionForId(id);
    if (handle) return handle.state().cwd;
    const input = await this.location(id);
    if (!input) throw new SessionServiceError("Session not found", 404);
    return input.cwd;
  }
  knownCwds() { return new Set([resolve(this.deps.globalCwd()), ...this.knownSessionCwds]); }
  projectState(handle: SessionHandle): SessionSnapshotDto {
    const state = handle.state();
    const row = handle.harnessId === "pi" ? undefined : this.bindings.get(handle.sessionId);
    return jsonRoundTrip(row?.name !== undefined ? { ...state, sessionName: row.name || undefined, sessionTitle: row.name || state.sessionTitle } : state);
  }
  async find(id: string): Promise<SessionHandle | undefined> {
    if (!id) return;
    const existing = this.sessionForId(id);
    if (existing) return existing;
    const pending = this.openingById.get(id);
    if (pending) return pending;
    const opening = (async () => {
      const location = await this.location(id);
      if (!location) return;
      const adapter = this.adapter(location.nativeSession.harnessId);
      if (location.nativeSession.persistence === "ephemeral") throw new SessionServiceError("Ephemeral native session expired; it cannot resume after process loss", 410);
      const handle = await adapter.open(location);
      if (handle.sessionId !== id) { await handle.dispose(); throw new SessionServiceError("Adapter returned a different session identity", 409); }
      this.register(handle);
      if (handle.harnessId !== "pi") await this.saveNative(handle.state());
      return handle;
    })();
    this.openingById.set(id, opening);
    try { return await opening; } finally { this.openingById.delete(id); }
  }
  async require(id?: string) {
    const handle = id ? await this.find(id) : this.currentSessionId ? this.sessionForId(this.currentSessionId) : undefined;
    if (!handle) throw new SessionServiceError("Session not found", 404);
    return handle;
  }
  private async location(id: string, cwd?: string): Promise<AdapterOpenInput | undefined> {
    await this.bindings.ready;
    const native = this.bindings.get(id);
    if (native) {
      if (native.deleted) throw new SessionServiceError("Session binding was removed", 410);
      return { sessionId: id, cwd: native.cwd, nativeSession: native.nativeSession };
    }
    const known = this.piLocations.get(id);
    if (known) return known;
    const info = await this.deps.pi.find(id, [...new Set([...(cwd ? [resolve(cwd)] : []), ...this.knownCwds()])]);
    if (!info) return;
    const location = { sessionId: id, cwd: info.cwd, nativeSession: info.nativeSession, sessionFile: info.sessionFile };
    this.piLocations.set(id, location);
    this.knownSessionCwds.add(info.cwd);
    return location;
  }
  async state(id: string) { return this.projectState(await this.require(id)); }
  async messages(id: string) { return jsonRoundTrip(await (await this.require(id)).messages()); }
  /** Read transcript text without navigating a branch or prompting a runtime. */
  async readSession(reference: SessionReference, tail: number): Promise<SessionReadResult> {
    if (!isSessionReferenceId(reference.sessionId) || reference.entryId !== undefined && !isSessionReferenceId(reference.entryId)) throw new SessionServiceError("Invalid session reference");
    const live = this.sessionForId(reference.sessionId);
    const location = live ? undefined : await this.location(reference.sessionId);
    let source: SessionReadResult["source"] = "active branch";
    let messages;
    if (!live && location?.nativeSession.harnessId === "pi") {
      source = "saved history (may include alternate branches)";
      messages = await this.deps.pi.readHistory(location);
    } else if (live instanceof PiSessionHandle && reference.entryId) {
      source = "saved history (may include alternate branches)";
      messages = live.readHistoryEntry(reference.entryId);
    } else {
      messages = await (await this.require(reference.sessionId)).messages();
    }
    if (reference.entryId) messages = messages.filter((message) => (message.entryId || message.id) === reference.entryId);
    if (reference.entryId && !messages.length) throw new SessionServiceError("Session entry not found", 404);
    const entries = messages.flatMap((message) => {
      const entry = canonicalTextReference(message, !reference.entryId);
      return entry ? [entry] : [];
    });
    if (reference.entryId && !entries.length) throw new SessionServiceError("Referenced entry has no readable text", 404);
    return { reference, source, ...boundReferenceText(entries, reference.entryId ? 1 : tail) };
  }
  async stats(id: string) { const state = await this.state(id); return { sessionId: state.sessionId, stats: state.stats }; }
  private pi(handle: SessionHandle, capability?: keyof BaseSessionStateDto["capabilities"]): PiSessionHandle {
    if (!(handle instanceof PiSessionHandle) || capability && handle.state().capabilities[capability] !== true) throw new SessionServiceError(`Operation is Pi-only or unavailable for ${handle.harnessId}`, 400);
    return handle;
  }
  async context(id: string) { return this.pi(await this.require(id), "context").context(); }
  async tree(id: string) { return this.pi(await this.require(id), "tree").tree(); }
  async models(id: string) { return this.pi(await this.require(id), "models").models(); }
  async commands(id: string) { const handle = await this.require(id); return handle.harnessId === "pi" ? this.pi(handle).commands() : []; }
  async setModel(id: string, provider: string, model: string, thinkingLevel?: string) { return this.pi(await this.require(id), "models").setModel(provider, model, thinkingLevel); }
  async executeShell(id: string, command: string, exclude: boolean) { return this.pi(await this.require(id), "bash").executeShell(command, exclude); }
  async executeCommand(id: string, command: string) { return this.pi(await this.require(id)).executeCommand(command); }
  async retry(id: string) { return this.pi(await this.require(id), "retry").retry(); }
  async abortCompaction(id: string) { return this.pi(await this.require(id), "compaction").abortCompaction(); }
  async abortBranchSummary(id: string) { return this.pi(await this.require(id), "tree").abortBranchSummary(); }
  async navigate(id: string, target: string, options: Record<string, unknown>): Promise<NavigationResult> { return this.pi(await this.require(id), "tree").navigate(target, options); }
  async prompt(id: string, input: PromptInputDto) {
    const handle = await this.require(id);
    const state = handle.state();
    const entry = this.liveSessions.get(handle.sessionId)!;
    const attachments = input.attachments || [];
    if (attachments.length && state.capabilities.attachments === false) throw new SessionServiceError("Attachments are not supported by this harness", 400);
    let executionId: string = randomUUID();
    if (handle.harnessId !== "pi") {
      this.adapter(handle.harnessId);
      if (input.mode !== "prompt" && input.mode !== "steer") throw new SessionServiceError("Input mode is not supported by this harness", 400);
      if (input.mode === "steer") {
        if (!state.capabilities.steering) throw new SessionServiceError("Steering is not supported by this harness", 400);
        if (!input.expectedExecutionId || input.expectedExecutionId !== state.activeExecution?.id || !running(state)) throw new SessionServiceError("Execution is no longer active", 409);
        executionId = input.expectedExecutionId;
      } else if (entry.dispatching || running(state) || state.activeExecution) throw new SessionServiceError("Wait for the active execution to settle", 409);
      if (state.phase === "unavailable") throw new SessionServiceError("Native session is unavailable", 410);
    } else if (input.expectedExecutionId && input.expectedExecutionId !== state.activeExecution?.id) throw new SessionServiceError("Execution is no longer active", 409);
    entry.dispatching = true;
    try {
      const receipt = await handle.prompt({ ...input, attachments, executionId });
      if (handle.harnessId !== "pi") {
        await this.saveNative(handle.state());
        const row = this.bindings.get(handle.sessionId);
        if (row && !row.firstMessage) await this.bindings.put({ ...row, firstMessage: input.message.slice(0, 500) });
      }
      return receipt;
    } finally { entry.dispatching = false; this.scheduleLiveSessionCleanup(handle.sessionId); }
  }
  async abort(id: string, expectedExecutionId?: string) {
    const handle = await this.require(id);
    if (handle.harnessId !== "pi" && !expectedExecutionId) throw new SessionServiceError("expectedExecutionId is required", 400);
    if (expectedExecutionId && handle.state().activeExecution?.id !== expectedExecutionId) throw new SessionServiceError("Execution is no longer active", 409);
    return handle.interrupt(expectedExecutionId || handle.state().activeExecution?.id || "");
  }
  async rename(id: string, name: string) {
    const handle = await this.require(id);
    if (handle.harnessId === "pi") {
      const state = await this.pi(handle).rename(name); this.remember(state); return state;
    }
    await this.saveNative(handle.state());
    const row = this.bindings.get(id)!;
    await this.bindings.put({ ...row, name });
    const state = this.projectState(handle); this.emit({ type: "state", state }); return state;
  }
  respondInteraction(response: InteractionResponseDto) {
    if (response.sessionId) {
      const handle = this.sessionForId(response.sessionId);
      return handle ? handle.respondInteraction(response) : false;
    }
    // Legacy Pi dialogs predate sessionId in responses. Native requests require it.
    for (const { handle } of this.liveSessions.values()) if (handle.harnessId === "pi" && handle.respondInteraction(response)) return true;
    return false;
  }
  cancelInteractions() { for (const { handle } of this.liveSessions.values()) handle.cancelInteractions("disconnect"); }
  webUiEntries(handle: SessionHandle) { return handle.harnessId === "pi" ? this.pi(handle).webUiEntries() : { webContributions: [] }; }
  settingsSchemas() { return this.deps.pi.webUiBridge.settingsSchemas(); }
  settingsSchemaEntry(id: string) { return this.deps.pi.webUiBridge.settingsSchemaEntry(id); }
  notifySettingsChanged(id: string, values: Record<string, unknown>) { return this.deps.pi.webUiBridge.notifySettingsChanged(id, values); }
  modelOptionTokens() { return this.deps.pi.modelOptionTokens(); }
  async storeCapture(id: string | undefined, key: unknown, registrationId: unknown, input: { mimeType: string; durationMs: number; bytes: Uint8Array }) {
    const handle = this.pi(await this.require(id), "extensions");
    const registration = handle.captureRegistration(key, registrationId);
    if (!registration) throw new SessionServiceError("Composer capture registration is stale or missing", 409);
    return this.captureStore.store({ sessionId: handle.sessionId, contributionKey: registration.key, registrationId: registration.registrationId, policy: registration.policy, ...input });
  }
  async invokeContribution(id: string | undefined, input: Record<string, unknown>, signal?: AbortSignal) {
    const handle = this.pi(await this.require(id), "extensions");
    const invoke = () => handle.invokeContribution(input, signal);
    return input.slot === "composer-input" ? this.withWorkLease(handle, "composer-capture", "general", invoke) : invoke();
  }
  async invokeHeaderAction(id: string | undefined, key: unknown) { return this.pi(await this.require(id), "extensions").invokeHeaderAction(key); }
  async invokeArtifactAction(id: string | undefined, input: Record<string, unknown>) { return this.pi(await this.require(id), "extensions").invokeArtifactAction(input); }
  async invokeGitTab(id: string | undefined, input: Record<string, unknown>) { return this.pi(await this.require(id), "extensions").invokeGitTab(input); }
  async invokePanel(id: string | undefined, input: Record<string, unknown>) { return this.pi(await this.require(id), "extensions").invokePanel(input); }
  extensionStatus(id: string) { const handle = this.sessionForId(id); if (!handle) throw new SessionServiceError("Session is not currently open", 404); return this.pi(handle, "extensions").extensionStatus(); }
  async reloadExtensions(id: string) { return this.pi(await this.require(id), "extensions").reloadExtensions(); }

  async create(previousId: string | undefined, cwd?: string, harnessId: HarnessId = "pi") {
    this.adapter(harnessId); // Validate before creating/looking up anything; no fallback.
    const previous = previousId ? await this.find(previousId) : this.currentSessionId ? this.sessionForId(this.currentSessionId) : undefined;
    return this.createWithAdapter(harnessId, cwd || previous?.state().cwd || this.deps.globalCwd(), previous?.harnessId === "pi" ? previous.state().sessionFile : undefined);
  }
  private async createWithAdapter(id: HarnessId, cwd: string, previousSessionFile?: string) {
    const adapter = this.adapter(id);
    const targetCwd = await assertDirectory(cwd, this.deps.globalCwd());
    const handle = await adapter.create({ cwd: targetCwd, ...(id === "pi" ? { previousSessionFile } : { sessionId: randomUUID() }) });
    this.register(handle);
    try {
      if (id !== "pi") await this.saveNative(handle.state());
      await this.deps.finalizeCreatedSession(handle.sessionId);
      return this.projectState(handle);
    } catch (error) { await this.disposeLiveSession(handle.sessionId, "reset", true); throw error; }
  }
  async open(id: string, cwd?: string) {
    if (cwd && !this.sessionForId(id)) await this.location(id, cwd);
    return this.projectState(await this.require(id));
  }
  async switchCwd(id: string, cwd: string) {
    const handle = await this.require(id);
    if (handle.harnessId !== "pi") throw new SessionServiceError("Choose a working directory when creating a native session", 400);
    if (running(handle.state())) throw new SessionServiceError("Wait for the current response to finish before changing the working directory", 409);
    if ((await handle.messages()).some((message) => message.role === "user")) throw new SessionServiceError("Working directory can only be changed before the first message", 400);
    return this.createWithAdapter("pi", cwd, handle.state().sessionFile);
  }
  async delete(id: string, cwd?: string): Promise<DeleteSessionResultDto> {
    if (process.env.PI_WEB_NO_SESSION === "1") throw new SessionServiceError("Sessions are disabled.");
    const location = await this.location(id, cwd);
    if (!location) throw new SessionServiceError("Session not found", 404);
    const live = this.liveSessions.get(id);
    if (live && this.isLiveSessionBusy(live)) throw new SessionServiceError("Wait for the session to finish before deleting it.", 409);
    if (live) await this.disposeLiveSession(id, "delete", true);
    if (location.nativeSession.harnessId === "pi") {
      const disposition = await this.deps.pi.remove(location);
      this.piLocations.delete(id); if (location.sessionFile) this.piNames.delete(location.sessionFile);
      return { id, disposition };
    }
    await this.bindings.put({ ...this.bindings.get(id)!, deleted: true });
    return { id, disposition: "deleted" }; // Web metadata only; native history is untouched.
  }
  private async listInfo(adapter: SessionAdapter, info: AdapterSessionInfo): Promise<SessionInfoDto | undefined> {
    if (!info.nativeSession.sessionId) return;
    let id = info.nativeSession.sessionId;
    let name = info.name;
    if (adapter.harness.id === "pi") {
      this.piLocations.set(id, { sessionId: id, cwd: info.cwd, nativeSession: info.nativeSession, sessionFile: info.sessionFile });
      if (info.sessionFile && this.piNames.has(info.sessionFile)) name = this.piNames.get(info.sessionFile);
    } else {
      const existing = this.bindings.byNative(info.nativeSession);
      if (existing?.deleted) return;
      id = existing?.id || randomUUID();
      name = existing?.name ?? name;
      await this.bindings.put({ id, nativeSession: info.nativeSession, cwd: info.cwd, name, firstMessage: info.firstMessage,
        created: existing?.created || info.created, modified: info.modified });
    }
    const candidate = this.sessionForId(id)?.state();
    const live = adapter.harness.id !== "pi" || candidate?.sessionFile === info.sessionFile ? candidate : undefined;
    return { id, ...(info.sessionFile && adapter.harness.id === "pi" ? { path: info.sessionFile } : {}), harnessId: adapter.harness.id,
      nativeSession: live?.nativeSession || info.nativeSession, name: live && adapter.harness.id === "pi" ? live.sessionName : name,
      firstMessage: info.firstMessage, created: info.created, modified: info.modified, cwd: live?.cwd || info.cwd,
      messageCount: live?.stats.totalMessages ?? info.messageCount, isCurrent: false };
  }
  async list(extraCwds: string[] = []): Promise<SessionInfoDto[]> {
    if (process.env.PI_WEB_NO_SESSION === "1") return [];
    await this.bindings.ready;
    const cwds = [...new Set([...this.knownCwds(), ...extraCwds.filter((cwd) => typeof cwd === "string" && cwd.trim()).map((cwd) => resolve(cwd))])].sort();
    const key = cwds.join("\n"); const pending = this.sessionListRequests.get(key); if (pending) return pending;
    const request = (async () => {
      const rows: SessionInfoDto[] = [];
      for (const adapter of this.adapters.values()) {
        if (adapter.harness.id !== "pi" && !this.deps.multiHarnessEnabled) continue;
        for (const cwd of cwds) {
          try { for (const info of await adapter.list(cwd)) { const row = await this.listInfo(adapter, info); if (row) rows.push(row); } }
          catch (error) { if (adapter.harness.id !== "pi") console.warn(`Could not list ${adapter.harness.id} sessions:`, error instanceof Error ? error.message : "unavailable"); }
        }
      }
      const seen = new Set(rows.filter((row) => row.harnessId !== "pi").map((row) => row.id));
      for (const binding of this.bindings.list()) {
        if (binding.deleted || seen.has(binding.id)) continue;
        const live = this.sessionForId(binding.id)?.state();
        rows.push({ id: binding.id, harnessId: binding.nativeSession.harnessId, nativeSession: live?.nativeSession || binding.nativeSession,
          cwd: binding.cwd, name: binding.name, firstMessage: binding.firstMessage, created: binding.created, modified: binding.modified,
          messageCount: live?.stats.totalMessages, isCurrent: false });
      }
      return jsonRoundTrip(rows.sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified)));
    })();
    this.sessionListRequests.set(key, request);
    try { return await request; } finally { this.sessionListRequests.delete(key); }
  }

  acquireViewer(id: string, clientId: string) {
    const entry = this.liveSessions.get(id); if (!entry || !clientId) return;
    let lease = this.viewerLeases.get(clientId); this.clearTimer(lease?.releaseTimer);
    if (!lease) { lease = { sessionKey: id, sockets: new Set() }; this.viewerLeases.set(clientId, lease); }
    else if (lease.sessionKey !== id) { const previous = lease.sessionKey; this.liveSessions.get(previous)?.viewerClientIds.delete(clientId); this.scheduleLiveSessionCleanup(previous); lease.sessionKey = id; }
    entry.viewerClientIds.add(clientId); this.cancelLiveSessionCleanup(entry);
    if (!lease.sockets.size) this.scheduleViewerLeaseRelease(clientId);
  }
  connectViewer(clientId: string) {
    const lease = this.viewerLeases.get(clientId); if (!lease) return;
    this.clearTimer(lease.releaseTimer); lease.releaseTimer = undefined;
    const connection = Symbol(clientId); lease.sockets.add(connection); this.viewerConnections.set(connection, clientId); return connection;
  }
  disconnectViewer(connection: symbol) {
    const clientId = this.viewerConnections.get(connection); if (!clientId) return;
    this.viewerConnections.delete(connection);
    const lease = this.viewerLeases.get(clientId); if (!lease || !lease.sockets.delete(connection) || lease.sockets.size) return;
    this.releaseViewer(clientId);
  }
  releaseViewer(clientId: string) {
    const lease = this.viewerLeases.get(clientId); if (!lease) return;
    this.clearTimer(lease.releaseTimer); this.viewerLeases.delete(clientId);
    for (const socket of lease.sockets) this.viewerConnections.delete(socket);
    const entry = this.liveSessions.get(lease.sessionKey);
    if (entry) { entry.viewerClientIds.delete(clientId); this.scheduleLiveSessionCleanup(lease.sessionKey); }
  }
  lifecycleSnapshot() {
    return { liveSessions: [...this.liveSessions.values()].map((entry) => {
      const state = entry.handle.state();
      return { sessionId: state.sessionId, sessionFile: state.sessionFile, harnessId: state.harnessId,
        viewerLeases: entry.viewerClientIds.size, workLeases: entry.workLeases.size,
        retryLeases: [...entry.workLeases.values()].filter((lease) => lease.kind === "retry").length,
        leases: [...entry.workLeases.values()].map(({ id, label, kind, acquiredAt }) => ({ id, label, kind, acquiredAt: new Date(acquiredAt).toISOString(), heldForMs: Math.max(0, Date.now() - acquiredAt) })),
        hasDisposeTimer: Boolean(entry.disposeTimer), isStreaming: state.isStreaming, isCompacting: state.isCompacting };
    }), viewerLeases: [...this.viewerLeases].map(([clientId, lease]) => ({ clientId, sessionKey: lease.sessionKey, sockets: lease.sockets.size, hasReleaseTimer: Boolean(lease.releaseTimer) })) };
  }
  private acquireWorkLease(handle: SessionHandle, label: string, kind: WorkLeaseKind): WorkLeaseToken | undefined {
    const entry = this.liveSessions.get(handle.sessionId); if (!entry) return;
    const key = Symbol(label); const lease: WorkLease = { id: this.nextWorkLeaseId++, label, kind, acquiredAt: Date.now() };
    if (this.workLeaseWatchdogMs > 0) {
      lease.watchdogTimer = setTimeout(() => { if (entry.workLeases.has(key)) console.warn("Session work lease watchdog: lease remains active", { sessionId: handle.sessionId, leaseId: lease.id, label, kind, acquiredAt: new Date(lease.acquiredAt).toISOString(), heldForMs: Date.now() - lease.acquiredAt }); }, this.workLeaseWatchdogMs);
      lease.watchdogTimer.unref?.();
    }
    entry.workLeases.set(key, lease); this.cancelLiveSessionCleanup(entry); this.emitWorkRuntime(handle);
    return { sessionKey: handle.sessionId, key };
  }
  private releaseWorkLease(handle: SessionHandle, token?: WorkLeaseToken) {
    if (!token) return;
    const entry = this.liveSessions.get(token.sessionKey); const lease = entry?.workLeases.get(token.key); if (!entry || !lease) return;
    this.clearTimer(lease.watchdogTimer); entry.workLeases.delete(token.key); this.scheduleLiveSessionCleanup(token.sessionKey); this.emitWorkRuntime(handle);
  }
  private async withWorkLease<T>(handle: SessionHandle, label: string, kind: WorkLeaseKind, operation: () => T | Promise<T>) {
    const token = this.acquireWorkLease(handle, label, kind);
    try { return await operation(); } finally { this.releaseWorkLease(handle, token); }
  }
  private clearWorkLeases(handle: SessionHandle, reason: string) {
    const entry = this.liveSessions.get(handle.sessionId); if (!entry?.workLeases.size) return;
    for (const lease of entry.workLeases.values()) this.clearTimer(lease.watchdogTimer);
    entry.workLeases.clear(); console.warn("Cleared session work leases", { sessionId: handle.sessionId, reason }); this.scheduleLiveSessionCleanup(handle.sessionId); this.emitWorkRuntime(handle);
  }
  private emitWorkRuntime(handle: SessionHandle) {
    const state = handle.state();
    if (handle.harnessId === "pi") this.emit({ type: "runtime", sessionId: handle.sessionId, sessionFile: state.sessionFile || "", action: "changed" });
  }
  private clearTimer(timer?: ReturnType<typeof setTimeout>) { if (timer) clearTimeout(timer); }
  private cancelLiveSessionCleanup(entry: LiveSessionEntry) { this.clearTimer(entry.disposeTimer); entry.disposeTimer = undefined; }
  private isLiveSessionBusy(entry: LiveSessionEntry) { return Boolean(entry.dispatching || running(entry.handle.state()) || entry.workLeases.size); }
  private shouldKeepLiveSession(entry: LiveSessionEntry) { return entry.handle.sessionId === this.currentSessionId || entry.viewerClientIds.size > 0 || this.isLiveSessionBusy(entry); }
  private scheduleLiveSessionCleanup(id: string) {
    const entry = this.liveSessions.get(id); if (!entry || entry.disposing) return;
    if (this.shouldKeepLiveSession(entry)) { this.cancelLiveSessionCleanup(entry); return; }
    if (entry.disposeTimer) return;
    entry.disposeTimer = setTimeout(() => { entry.disposeTimer = undefined; void this.disposeLiveSession(id, "idle"); }, this.idleGraceMs);
    entry.disposeTimer.unref?.();
  }
  private scheduleViewerLeaseRelease(clientId: string) {
    const lease = this.viewerLeases.get(clientId); if (!lease || lease.sockets.size) return;
    this.clearTimer(lease.releaseTimer); lease.releaseTimer = setTimeout(() => this.releaseViewer(clientId), this.viewerGraceMs); lease.releaseTimer.unref?.();
  }
  private async disposeLiveSession(id: string, reason: "idle" | "delete" | "reset", force = false) {
    const entry = this.liveSessions.get(id); if (!entry || entry.disposing || !force && this.shouldKeepLiveSession(entry)) return;
    entry.disposing = true; this.cancelLiveSessionCleanup(entry);
    for (const lease of entry.workLeases.values()) this.clearTimer(lease.watchdogTimer); entry.workLeases.clear();
    for (const [clientId, lease] of this.viewerLeases) if (lease.sessionKey === id) this.releaseViewer(clientId);
    const state = entry.handle.state();
    try { await entry.handle.dispose(); } catch (error) { console.warn(`Could not dispose session after ${reason}:`, error); }
    entry.unsubscribe?.(); this.liveSessions.delete(id);
    if (entry.handle.harnessId !== "pi") {
      await this.bindings.ready; const row = this.bindings.get(id);
      if (row && row.nativeSession.persistence === "ephemeral") await this.bindings.put({ ...row, nativeSession: { ...row.nativeSession, status: "unavailable" } });
    }
    this.emit({ type: "shutdown", sessionId: id, sessionFile: state.sessionFile, sessionKey: id });
  }
}
