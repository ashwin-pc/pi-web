import { readFile } from "node:fs/promises";
import { getAgentDir, type SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { join, resolve, dirname } from "node:path";
import type { PiWebSession } from "../../../types.js";
import { createWebUiBridge } from "../../../extensions/webUi.js";
import { createSettingsStore } from "../../../settings.js";
import { assertDirectory } from "../../../shared/fsList.js";
import { PiSessionFactory, piSessionDirectory, type LocalSessionInfo } from "../../piFactory.js";
import { SessionServiceError } from "../../errors.js";
import { simplifyMessage } from "../../projection.js";
import type { SessionAdapter, AdapterCreateInput, AdapterOpenInput, AdapterSessionInfo } from "../../adapter.js";
import type { HarnessDescriptorDto } from "../../dto.js";
import { PiSessionHandle, type PiAdapterDependencies, type PiAdapterHost } from "./index.js";

/** Pi resources retain the current factory; only handle binding lives here. */
export class PiAdapter implements SessionAdapter {
  readonly webIdentity = "native" as const;
  readonly harness: HarnessDescriptorDto = {
    id: "pi", name: "Pi", enabled: true, available: true,
    capabilities: { harness: "pi", queue: true, steering: true, followUp: true, thinkingLevel: true,
      tree: true, compaction: true, retry: true, bash: true, extensions: true, interactions: true,
      models: true, context: true, attachments: true, historyFork: false, cwdChange: true },
  };
  readonly settingsStore = createSettingsStore(process.env.PI_WEB_SETTINGS_FILE || join(getAgentDir(), "pi-web-settings.json"));
  readonly blockedModelIds = new Set<string>();
  readonly webUiBridge;
  private readonly handles = new WeakMap<object, PiSessionHandle>();
  private readonly factory: PiSessionFactory;
  private readonly bridgeSinks = new Map<string, (event: Record<string, unknown>) => void>();
  host!: PiAdapterHost;
  constructor(readonly deps: PiAdapterDependencies) {
    this.factory = new PiSessionFactory({
      noSession: process.env.PI_WEB_NO_SESSION === "1", modelRuntime: deps.modelRuntime,
      additionalExtensionPaths: deps.additionalExtensionPaths,
      sessionCwd: (manager) => manager.getCwd() || deps.globalCwd(), rememberCwd: (cwd) => this.host.rememberCwd(cwd),
      readSession: (reference, tail) => this.host.readSession(reference, tail),
    });
    const handleFor = (raw: object) => {
      const handle = this.handles.get(raw);
      if (!handle) throw new Error("Pi session has not been bound");
      return handle;
    };
    this.webUiBridge = createWebUiBridge({
      extensionHttp: deps.extensionHttp,
      captureStore: {
        consume: (...args) => this.host.captureStore.consume(...args),
        releasePath: (path) => this.host.captureStore.releasePath(path),
        releaseOwner: (id) => this.host.captureStore.releaseOwner(id),
      },
      emit: (input) => {
        const value = input as Record<string, unknown>;
        const emit = this.bridgeSinks.get(String(value.sessionId || ""));
        if (emit) emit(value);
        else if (value.type === "web_settings_schemas_changed") this.bridgeSinks.values().next().value?.(value);
      },
      clientCount: deps.clientCount,
      withWorkLease: (raw, label, operation) => this.host.withWorkLease(handleFor(raw), label, "general", operation),
      createNewSession: (cwd, previous) => this.host.create(cwd, previous),
      sessionCwd: (raw) => handleFor(raw).state().cwd,
      state: (raw) => handleFor(raw).state() as unknown as Record<string, unknown>,
      settingsStore: this.settingsStore,
      modelOptions: () => this.modelOptionTokens(),
    });
  }
  releaseBridge(id: string) { this.bridgeSinks.delete(id); }
  bindHost(host: PiAdapterHost) { this.host = host; }
  modelOptionTokens() {
    return new Set(this.deps.modelRuntime.getAvailableSnapshot().flatMap((model) => model?.provider && model?.id ? [`${model.provider}:${model.id}`] : []));
  }
  private async make(input: AdapterCreateInput, path?: string, sessionStartEvent?: SessionStartEvent): Promise<PiSessionHandle> {
    const cwd = await assertDirectory(input.cwd, this.deps.globalCwd());
    if (!path) await this.factory.ensureStorage(cwd);
    const result = await (this.deps.peer || this.factory).create({ cwd, path, sessionStartEvent });
    const raw = result.session;
    if (!path && sessionStartEvent?.reason === "new" && this.deps.peer?.newSessionAfterCreate) {
      raw.sessionManager.newSession(); raw.agent.state.messages = raw.sessionManager.buildSessionContext().messages;
    }
    if (result.modelFallbackMessage) console.warn(result.modelFallbackMessage);
    if (path && input.sessionId && raw.sessionId !== input.sessionId) {
      // Preserve full Pi cleanup even on identity rejection.
      const handle = new PiSessionHandle(raw, this, this.factory.loaderFor(raw));
      await handle.dispose(); throw new SessionServiceError("Session location did not match requested ID", 409);
    }
    const handle = new PiSessionHandle(raw, this, this.factory.loaderFor(raw));
    this.handles.set(raw, handle);
    this.bridgeSinks.set(handle.sessionId, (event) => handle.bridgeEvent(event));
    this.host.register(handle, sessionStartEvent?.reason === "new");
    try {
      await this.webUiBridge.bind(raw);
      if (sessionStartEvent?.reason === "new") {
        const defaults = await this.deps.defaultsFor(handle.state().cwd);
        if (defaults.model) {
          const model = raw.modelRuntime.getModel(defaults.model.provider, defaults.model.id);
          if (model) await raw.setModel(model);
        }
        if (defaults.thinkingLevel && raw.getAvailableThinkingLevels().includes(defaults.thinkingLevel)) raw.setThinkingLevel(defaults.thinkingLevel);
      }
      return handle;
    } catch (error) { await handle.dispose(); this.host.failed(handle); throw error; }
  }
  initialize(path?: string) { return this.make({ cwd: this.deps.globalCwd() }, path); }
  create(input: AdapterCreateInput) { return this.make(input, undefined, { type: "session_start", reason: "new", previousSessionFile: input.previousSessionFile }); }
  open(input: AdapterOpenInput) {
    if (!input.sessionFile) throw new SessionServiceError("Pi session path is missing", 404);
    if (!this.deps.peer && dirname(resolve(input.sessionFile)) !== piSessionDirectory(input.cwd)) throw new SessionServiceError("Invalid Pi session location", 400);
    return this.make(input, input.sessionFile);
  }
  async readHistory(input: AdapterOpenInput) {
    if (!input.sessionFile) throw new SessionServiceError("Pi session path is missing", 404);
    try {
      const records = (await readFile(input.sessionFile, "utf8")).split("\n").flatMap((line): unknown[] => {
        try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; }
      });
      const header = records[0] as Record<string, unknown> | undefined;
      if (header?.type !== "session" || header.id !== input.sessionId) throw new Error("Session identity mismatch");
      return records.slice(1).flatMap((value) => {
        const entry = value as Record<string, unknown>;
        if (entry?.type !== "message" || typeof entry.id !== "string") return [];
        const message = simplifyMessage(entry.message, { entryId: entry.id });
        return message ? [message] : [];
      });
    } catch { throw new SessionServiceError("Session not found", 404); }
  }
  private info(row: LocalSessionInfo): AdapterSessionInfo {
    return { nativeSession: { harnessId: "pi", sessionId: row.id, persistence: "persistent", status: "resumable" },
      cwd: row.cwd, sessionFile: row.path, name: row.name, firstMessage: row.firstMessage,
      created: row.created.toISOString(), modified: row.modified.toISOString(), messageCount: row.messageCount };
  }
  async list(cwd: string): Promise<AdapterSessionInfo[]> {
    if (process.env.PI_WEB_NO_SESSION === "1") return [];
    return (await (this.deps.peer?.list ? this.deps.peer.list(cwd) : this.factory.list(cwd))).map((row) => this.info(row));
  }
  async find(id: string, cwds: string[]): Promise<AdapterSessionInfo | undefined> {
    if (!id || process.env.PI_WEB_NO_SESSION === "1") return;
    if (this.deps.peer?.list) {
      for (const cwd of cwds) { const row = (await this.list(cwd)).find((item) => item.nativeSession.sessionId === id); if (row) return row; }
      return;
    }
    const location = await this.factory.locate(id, cwds[0] || this.deps.globalCwd(), cwds);
    return location ? { nativeSession: { harnessId: "pi", sessionId: id, persistence: "persistent", status: "resumable" },
      cwd: location.cwd, sessionFile: location.path, modified: "" } : undefined;
  }
  remove(input: AdapterOpenInput): Promise<"trashed" | "deleted"> {
    if (!input.sessionFile) throw new SessionServiceError("Pi session path is missing", 404);
    return (this.deps.peer?.remove || this.factory.remove.bind(this.factory))(input.sessionId, input.sessionFile);
  }
}
export function createPiAdapter(deps: PiAdapterDependencies) { return new PiAdapter(deps); }
