import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  getAgentDir,
  type ModelRuntime,
  SessionManager,
  type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { assertDirectory } from "../shared/fsList.js";
import type { PiWebSession, PiWebSessionInfo } from "../types.js";
import { createWebUiBridge } from "../extensions/webUi.js";
import { ResilientResourceLoader } from "../extensions/resilientLoader.js";
import type {
  BaseSessionStateDto,
  DeleteSessionResultDto,
  JsonValue,
  MessageDto,
  NavigationResult,
  SessionInfoDto,
  SessionService,
  SessionServiceEvent,
  SlashCommandDto,
} from "./dto.js";
import {
  conversationTreeForSession,
  getSessionSlashCommands,
  isAssistantAbortedMessage,
  isAssistantFailureMessage,
  isIncompleteToolResultMessage,
  projectCommittedMessage,
  projectMessages,
  projectSessionState,
  sessionStats,
  simplifyModel,
} from "./projection.js";

export class SessionServiceError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export interface SessionDefaults {
  model?: { provider: string; id: string };
  thinkingLevel?: string;
}

export interface LocalSessionFactoryInput {
  path?: string;
  cwd: string;
  sessionStartEvent?: SessionStartEvent;
}

export interface LocalSessionFactory {
  create(input: LocalSessionFactoryInput): Promise<{ session: PiWebSession; modelFallbackMessage?: string }>;
  list?(cwd: string): Promise<PiWebSessionInfo[]>;
  remove?(id: string, path: string): Promise<"trashed" | "deleted">;
  readonly isMock?: boolean;
}

/** Only box-external configuration is injected; lifecycle and operations live here. */
export interface LocalSessionConfiguration {
  defaultsFor(cwd: string): Promise<SessionDefaults>;
  finalizeCreatedSession(sessionId: string): Promise<unknown>;
}

export interface LocalSessionServiceDependencies {
  modelRuntime: ModelRuntime;
  sessionFactory?: LocalSessionFactory;
  additionalExtensionPaths(cwd: string): string[];
  sessionConfig: LocalSessionConfiguration;
  globalCwd(): string;
  clientCount(): number;
}

type LiveSessionEntry = {
  session: PiWebSession;
  unsubscribe?: () => void;
  viewerClientIds: Set<string>;
  workLeases: number;
  disposeTimer?: ReturnType<typeof setTimeout>;
  disposing?: boolean;
};

type ViewerLease = {
  sessionKey: string;
  sockets: Set<symbol>;
  releaseTimer?: ReturnType<typeof setTimeout>;
};

type RetrySessionTarget =
  | { kind: "failure"; messages: any[]; index: number; message: any }
  | { kind: "aborted"; messages: any[]; index: number; message: any }
  | { kind: "toolResult"; messages: any[]; index: number; message: any };

type PendingPromptCorrelation = {
  clientMessageId: string;
  sourceClientId: string;
  createdAt: number;
};

const webSlashCommands: SlashCommandDto[] = [
  { name: "help", description: "Show slash command help", source: "web", sourceInfo: { path: "<pi-web>", source: "pi-web", scope: "temporary", origin: "top-level" } },
  { name: "commands", description: "List available web, extension, prompt, and skill commands", source: "web", sourceInfo: { path: "<pi-web>", source: "pi-web", scope: "temporary", origin: "top-level" } },
  { name: "reload", description: "Reload pi resources, extensions, skills, prompts, and models", source: "web", sourceInfo: { path: "<pi-web>", source: "pi-web", scope: "temporary", origin: "top-level" } },
  { name: "model", description: "List models or switch with /model <provider/model-id>", source: "web", sourceInfo: { path: "<pi-web>", source: "pi-web", scope: "temporary", origin: "top-level" } },
  { name: "models", description: "List available models", source: "web", sourceInfo: { path: "<pi-web>", source: "pi-web", scope: "temporary", origin: "top-level" } },
  { name: "thinking", description: "Show or set reasoning level", source: "web", sourceInfo: { path: "<pi-web>", source: "pi-web", scope: "temporary", origin: "top-level" } },
  { name: "new", description: "Start a new session", source: "web", sourceInfo: { path: "<pi-web>", source: "pi-web", scope: "temporary", origin: "top-level" } },
  { name: "clear", description: "Release this session to history and start fresh in the same tab", source: "web", sourceInfo: { path: "<pi-web>", source: "pi-web", scope: "temporary", origin: "top-level" } },
  { name: "compact", description: "Compact conversation context; optional instructions after the command", source: "web", sourceInfo: { path: "<pi-web>", source: "pi-web", scope: "temporary", origin: "top-level" } },
  { name: "abort", description: "Stop the current response", source: "web", sourceInfo: { path: "<pi-web>", source: "pi-web", scope: "temporary", origin: "top-level" } },
  { name: "stop", description: "Stop the current response", source: "web", sourceInfo: { path: "<pi-web>", source: "pi-web", scope: "temporary", origin: "top-level" } },
  { name: "logout", description: "Clear the web UI token in this browser", source: "web", sourceInfo: { path: "<pi-web>", source: "pi-web", scope: "temporary", origin: "top-level" } },
];

const imageExtensions: Record<string, string> = {
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

const execFileAsync = promisify(execFile);

function envMs(name: string, fallback: number) {
  const raw = Number(process.env[name] || fallback);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

function sessionPathKey(value: Pick<PiWebSession, "sessionFile" | "sessionId">) {
  return String(value.sessionFile || value.sessionId || "");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function hasUserMessages(value: PiWebSession) {
  return value.messages.some((message: any) => message?.role === "user");
}

export class LocalSessionService implements SessionService {
  private readonly listeners = new Set<(event: SessionServiceEvent) => void>();
  private readonly liveSessions = new Map<string, LiveSessionEntry>();
  private readonly liveById = new Map<string, PiWebSession>();
  private readonly sessionLocations = new Map<string, { path: string; cwd: string }>();
  private readonly openingById = new Map<string, Promise<PiWebSession | undefined>>();
  private readonly sessionListRequests = new Map<string, Promise<SessionInfoDto[]>>();
  private readonly viewerLeases = new Map<string, ViewerLease>();
  private readonly viewerConnections = new Map<symbol, string>();
  private readonly extensionLoaders = new WeakMap<object, ResilientResourceLoader>();
  private readonly blockedModelIds = new Set<string>();
  private readonly pendingPromptCorrelations = new Map<string, PendingPromptCorrelation[]>();
  private readonly knownSessionCwds = new Set<string>();
  private readonly protectedSessionIds = new Set<string>();
  private readonly noSession = process.env.PI_WEB_NO_SESSION === "1";
  private readonly idleGraceMs = envMs("PI_WEB_SESSION_IDLE_GRACE_MS", 24 * 60 * 60 * 1000);
  private readonly viewerGraceMs = envMs("PI_WEB_VIEWER_LEASE_GRACE_MS", Math.min(30_000, this.idleGraceMs));
  private readonly webUiBridge;

  constructor(private readonly deps: LocalSessionServiceDependencies) {
    this.knownSessionCwds.add(resolve(deps.globalCwd()));
    this.webUiBridge = createWebUiBridge({
      emit: (value) => this.emit({ type: "wire", value: value as JsonValue }),
      clientCount: deps.clientCount,
      acquireWorkLease: (session) => this.acquireWorkLease(session),
      createNewSession: (cwd, previousSessionFile) => this.createNewLiveSession(cwd, previousSessionFile),
      sessionCwd: (session) => this.sessionCwd(session),
      state: (session) => this.projectState(session) as unknown as Record<string, unknown>,
    });
  }

  subscribe(listener: (event: SessionServiceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * The runner boundary intentionally normalizes values through JSON and
   * isolates listeners so one serving adapter cannot block the others.
   */
  private emit(event: SessionServiceEvent) {
    const serializableEvent = jsonSafe(event);
    for (const listener of this.listeners) {
      try { listener(serializableEvent); }
      catch (error) { console.warn("Session service event listener failed:", error); }
    }
  }

  async initialize(path?: string): Promise<PiWebSession> {
    const created = await this.makeAgentSession(path);
    if (created.modelFallbackMessage) console.warn(created.modelFallbackMessage);
    const value = this.registerLiveSession(created.session);
    this.setCurrentSession(value);
    return value;
  }

  setCurrentSession(value: PiWebSession) {
    this.protectedSessionIds.clear();
    this.protectedSessionIds.add(value.sessionId);
    this.registerLiveSession(value);
  }

  async resetWith(value: PiWebSession) {
    await this.disposeAll("reset");
    this.setCurrentSession(value);
  }

  async disposeAll(reason: "reset" | "idle" = "reset") {
    await Promise.all(Array.from(this.liveSessions.keys()).map((key) => this.disposeLiveSession(key, reason, true)));
  }

  sessionForPath(path: string) { return this.liveSessions.get(path)?.session; }
  sessionForId(id: string) { return this.liveById.get(id); }
  cwdForSession(value: PiWebSession) { return this.sessionCwd(value); }
  async cwdForSessionId(id: string) {
    const live = this.liveById.get(id);
    if (live) return this.sessionCwd(live);
    const info = await this.findSessionInfoById(id);
    if (!info) throw new SessionServiceError("Session not found", 404);
    return info.cwd || this.deps.globalCwd();
  }
  knownCwds() { return new Set([resolve(this.deps.globalCwd()), ...this.knownSessionCwds]); }
  webUiEntries(value: PiWebSession) { return this.webUiBridge.entries(value); }
  projectState(value: PiWebSession): BaseSessionStateDto { return jsonSafe(projectSessionState(value, this.sessionCwd(value))); }

  private currentSession() {
    for (const id of this.protectedSessionIds) {
      const value = this.liveById.get(id);
      if (value) return value;
    }
    return undefined;
  }

  async find(sessionId: string): Promise<PiWebSession | undefined> {
    if (!sessionId) return undefined;
    return this.getOrCreateLiveSessionById(sessionId);
  }

  async require(sessionId?: string): Promise<PiWebSession> {
    const value = sessionId ? await this.find(sessionId) : this.currentSession();
    if (!value) throw new SessionServiceError("Session not found", 404);
    return value;
  }

  async state(sessionId: string) { return this.projectState(await this.require(sessionId)); }

  async stats(sessionId: string) {
    const value = await this.require(sessionId);
    return jsonSafe({ sessionId: value.sessionId, stats: sessionStats(value) });
  }

  async tree(sessionId: string) {
    const value = await this.require(sessionId);
    try { return jsonSafe(conversationTreeForSession(value)); }
    catch (error) { throw new SessionServiceError(errorMessage(error), 400); }
  }

  async messages(sessionId: string): Promise<MessageDto[]> {
    return jsonSafe(projectMessages(await this.require(sessionId)));
  }

  async commands(sessionId: string) {
    return jsonSafe([...webSlashCommands, ...getSessionSlashCommands(await this.require(sessionId))]);
  }

  private copilotAllowedIds(value: PiWebSession): Set<string> | null {
    for (let index = value.messages.length - 1; index >= 0; index--) {
      const message = value.messages[index] as any;
      const error: string = message?.errorMessage || message?.message?.errorMessage || "";
      if (!error.includes("model_not_available_for_integrator")) continue;
      const match = error.match(/Available models: \[([^\]]+)\]/);
      if (match) return new Set(match[1].split(/\s+/).map((id: string) => id.trim()).filter(Boolean));
    }
    return null;
  }

  private availableModels(value: PiWebSession) {
    const allowed = this.copilotAllowedIds(value);
    return value.modelRuntime.getAvailableSnapshot().filter((model) => !this.blockedModelIds.has(model.id) && (!allowed || allowed.has(model.id)));
  }

  async models(sessionId: string) {
    const value = await this.require(sessionId);
    return jsonSafe({
      cwd: this.sessionCwd(value),
      current: simplifyModel(value.model),
      thinkingLevel: value.thinkingLevel,
      thinkingLevels: value.getAvailableThinkingLevels(),
      models: this.availableModels(value).map(simplifyModel).filter((model) => model !== undefined),
    });
  }

  async setModel(sessionId: string, provider: string, id: string, thinkingLevel?: string) {
    const value = await this.require(sessionId);
    const model = value.modelRuntime.getModel(provider, id);
    if (!model) throw new SessionServiceError("Model not found", 404);
    await value.setModel(model);
    if (thinkingLevel !== undefined) value.setThinkingLevel(thinkingLevel);
    return this.projectState(value);
  }

  async executeShell(sessionId: string, command: string, excludeFromContext: boolean) {
    const value = await this.require(sessionId);
    if (!value.executeBash) throw new SessionServiceError("Bash execution is not available in this session.");
    return jsonSafe({ command, cwd: this.sessionCwd(value), ...await value.executeBash(command, undefined, { excludeFromContext }), excludeFromContext });
  }

  async executeCommand(sessionId: string, command: string) {
    return this.executeSlashCommand(command, await this.require(sessionId));
  }

  async prompt(sessionId: string, input: { message: string; mode: string; images: Array<{ data: string; mimeType: string; name?: string }>; clientMessageId?: string; sourceClientId?: string }) {
    const value = await this.require(sessionId);
    await this.startSessionPrompt(value, input);
    return { sessionId: value.sessionId };
  }

  async retry(sessionId: string) {
    const value = await this.require(sessionId);
    await this.startSessionRetry(value);
    return { sessionId: value.sessionId };
  }

  async abort(sessionId: string) {
    const value = await this.require(sessionId);
    void value.abort().catch((error) => this.emitError(value, error));
    return { sessionId: value.sessionId };
  }

  async abortCompaction(sessionId: string) {
    const value = await this.require(sessionId);
    if (!value.abortCompaction) throw new SessionServiceError("Compaction cancellation is not available");
    value.abortCompaction();
    return { sessionId: value.sessionId };
  }

  async abortBranchSummary(sessionId: string) {
    const value = await this.require(sessionId);
    value.abortBranchSummary?.();
    return { sessionId: value.sessionId };
  }

  async rename(sessionId: string, name: string) {
    const value = await this.require(sessionId);
    if (!value.setSessionName) throw new SessionServiceError("Renaming sessions is not available");
    value.setSessionName(name);
    return this.projectState(value);
  }

  async navigate(sessionId: string, targetId: string, options: Record<string, unknown>): Promise<NavigationResult> {
    const value = await this.require(sessionId);
    if (value.isStreaming) throw new SessionServiceError("Wait for the current response to finish before navigating the tree", 409);
    if (value.isCompacting) throw new SessionServiceError("Wait for the current compaction to finish before navigating the tree", 409);
    if (!value.navigateTree) throw new SessionServiceError("Tree navigation is not available");
    const releaseWorkLease = this.acquireWorkLease(value);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      releaseWorkLease();
      this.emitRuntime(value, "changed");
    };
    try {
      const navigation = value.navigateTree(targetId, options as any);
      this.emitRuntime(value, "changed");
      const result = await navigation;
      const state = this.projectState(value);
      this.emit({ type: "state", state, includeThinkingLevels: true });
      return { ...jsonSafe(result as Record<string, JsonValue>), leafId: value.sessionManager.getLeafId?.() || null, state, finish };
    } catch (error) {
      finish();
      throw error;
    }
  }

  invokeHeaderAction(sessionId: string | undefined, key: unknown) {
    return this.require(sessionId).then((value) => this.webUiBridge.invokeHeaderAction(value, key));
  }

  invokeArtifactAction(sessionId: string | undefined, input: Record<string, unknown>) {
    return this.require(sessionId).then((value) => this.webUiBridge.invokeArtifactAction(value, input));
  }

  invokeGitTab(sessionId: string | undefined, input: Record<string, unknown>) {
    return this.require(sessionId).then((value) => this.webUiBridge.invokeGitTab(value, input));
  }

  respondExtensionUi(id: string, response: Record<string, unknown>) { return this.webUiBridge.respond(id, response); }

  extensionStatus(sessionId: string) {
    const value = this.openExtensionSession(sessionId);
    const loader = this.extensionLoaders.get(value);
    if (!loader) throw new SessionServiceError("Extension status is not available for this session.", 404);
    return loader.getStatus();
  }

  async reloadExtensions(sessionId: string) {
    const value = this.openExtensionSession(sessionId);
    if (value.isStreaming) throw new SessionServiceError("Wait for the current response to finish before retrying extensions.", 409);
    if (value.isCompacting) throw new SessionServiceError("Wait for compaction to finish before retrying extensions.", 409);
    const loader = this.extensionLoaders.get(value);
    if (!loader || typeof value.reload !== "function") throw new SessionServiceError("Extension reload is not available for this session.", 404);
    await value.reload();
    const status = loader.getStatus();
    this.emit({ type: "wire", value: { type: "extensions_reloaded", sessionId: value.sessionId, status } as JsonValue });
    return status;
  }

  async list(extraCwds: string[] = []): Promise<SessionInfoDto[]> {
    if (this.noSession) return [];
    const cwds = this.knownCwds();
    for (const cwd of extraCwds) if (typeof cwd === "string" && cwd.trim()) cwds.add(resolve(cwd));
    const orderedCwds = Array.from(cwds).sort();
    const key = orderedCwds.join("\n");
    const pending = this.sessionListRequests.get(key);
    if (pending) return pending;
    const request = (async () => {
      const groups = await Promise.all(orderedCwds.map(async (cwd) => {
        try {
          const infos = this.deps.sessionFactory?.list
            ? await this.deps.sessionFactory.list(cwd)
            : await SessionManager.list(cwd);
          return infos.map((info) => this.simplifySessionInfo(info, cwd));
        } catch { return []; }
      }));
      return groups.flat().sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
    })();
    this.sessionListRequests.set(key, request);
    try { return await request; }
    finally { this.sessionListRequests.delete(key); }
  }

  async create(sessionId: string | undefined, cwd?: string) {
    const previous = sessionId ? await this.getOrCreateLiveSessionById(sessionId) : this.currentSession();
    const created = await this.createNewLiveSession(cwd || (previous ? this.sessionCwd(previous) : this.deps.globalCwd()), previous?.sessionFile);
    return this.projectState(created);
  }

  async open(sessionId: string, cwd?: string) {
    try {
      const value = await this.getOrCreateLiveSessionById(sessionId, cwd);
      if (!value) throw new Error("Session not found");
      return this.projectState(value);
    } catch (error) { throw new SessionServiceError(errorMessage(error), 404); }
  }

  async delete(sessionId: string, cwd?: string): Promise<DeleteSessionResultDto> {
    if (this.noSession) throw new Error("Sessions are disabled.");
    const info = await this.findSessionInfoById(sessionId, cwd);
    if (!info) throw new SessionServiceError("Session not found", 404);
    const live = this.liveSessions.get(info.path);
    if (live?.session.isStreaming || live?.session.isCompacting) throw new SessionServiceError("Wait for the session to finish before deleting it.", 409);
    if (live) await this.disposeLiveSession(info.path, "delete", true);
    const disposition = this.deps.sessionFactory?.remove
      ? await this.deps.sessionFactory.remove(sessionId, info.path)
      : await this.trashOrRemoveSessionFile(info.path);
    return { id: sessionId, disposition };
  }

  async switchCwd(sessionId: string, cwd: string) {
    const value = await this.require(sessionId);
    if (value.isStreaming) throw new Error("Wait for the current response to finish before changing the working directory.");
    if (value.isCompacting) throw new Error("Wait for compaction to finish before changing the working directory.");
    if (hasUserMessages(value)) throw new Error("Working directory can only be changed before the first message.");
    return this.projectState(await this.createNewLiveSession(cwd, value.sessionFile));
  }

  acquireViewer(sessionId: string, clientId: string) {
    const value = this.liveById.get(sessionId);
    if (!clientId || !value) return;
    const key = sessionPathKey(value);
    const entry = this.liveSessions.get(key);
    if (!entry) return;
    let lease = this.viewerLeases.get(clientId);
    this.clearTimer(lease?.releaseTimer);
    if (!lease) {
      lease = { sessionKey: key, sockets: new Set() };
      this.viewerLeases.set(clientId, lease);
    } else if (lease.sessionKey !== key) {
      const previousKey = lease.sessionKey;
      this.liveSessions.get(previousKey)?.viewerClientIds.delete(clientId);
      this.scheduleLiveSessionCleanup(previousKey);
      lease.sessionKey = key;
    }
    entry.viewerClientIds.add(clientId);
    this.cancelLiveSessionCleanup(entry);
    if (lease.sockets.size === 0) this.scheduleViewerLeaseRelease(clientId);
  }

  connectViewer(clientId: string) {
    const lease = this.viewerLeases.get(clientId);
    if (!lease) return undefined;
    this.clearTimer(lease.releaseTimer);
    lease.releaseTimer = undefined;
    const connection = Symbol(clientId);
    lease.sockets.add(connection);
    this.viewerConnections.set(connection, clientId);
    return connection;
  }

  disconnectViewer(connection: symbol) {
    const clientId = this.viewerConnections.get(connection);
    if (!clientId) return;
    this.viewerConnections.delete(connection);
    const lease = this.viewerLeases.get(clientId);
    if (!lease || !lease.sockets.delete(connection) || lease.sockets.size > 0) return;
    this.releaseViewer(clientId);
  }

  releaseViewer(clientId: string) {
    const lease = this.viewerLeases.get(clientId);
    if (!lease) return;
    this.clearTimer(lease.releaseTimer);
    this.viewerLeases.delete(clientId);
    for (const connection of lease.sockets) this.viewerConnections.delete(connection);
    lease.sockets.clear();
    const entry = this.liveSessions.get(lease.sessionKey);
    if (entry) {
      entry.viewerClientIds.delete(clientId);
      this.scheduleLiveSessionCleanup(lease.sessionKey);
    }
  }

  lifecycleSnapshot() {
    return {
      liveSessions: Array.from(this.liveSessions.values()).map((entry) => ({
        sessionId: entry.session.sessionId,
        sessionFile: entry.session.sessionFile,
        viewerLeases: entry.viewerClientIds.size,
        workLeases: entry.workLeases,
        hasDisposeTimer: Boolean(entry.disposeTimer),
        isStreaming: Boolean(entry.session.isStreaming),
        isCompacting: Boolean(entry.session.isCompacting),
      })),
      viewerLeases: Array.from(this.viewerLeases.entries()).map(([clientId, lease]) => ({
        clientId,
        sessionKey: lease.sessionKey,
        sockets: lease.sockets.size,
        hasReleaseTimer: Boolean(lease.releaseTimer),
      })),
    };
  }

  private sessionCwd(value: PiWebSession | any) {
    return String(value?.sessionManager?.getCwd?.() || value?.cwd || this.deps.globalCwd());
  }

  private async ensureStorage(cwd: string) {
    const webDir = join(cwd, ".pi", "web");
    await mkdir(webDir, { recursive: true });
    const ignoreFile = join(webDir, ".gitignore");
    if (!existsSync(ignoreFile)) await writeFile(ignoreFile, "*\n");
  }

  private async makeAgentSession(path?: string, sessionStartEvent?: SessionStartEvent, cwd = this.deps.globalCwd()) {
    const targetCwd = await assertDirectory(cwd, this.deps.globalCwd());
    if (this.deps.sessionFactory) {
      const result = await this.deps.sessionFactory.create({ path, cwd: targetCwd, sessionStartEvent });
      await this.webUiBridge.bind(result.session);
      return result;
    }

    const manager = this.noSession
      ? SessionManager.inMemory(targetCwd)
      : path ? SessionManager.open(path) : SessionManager.create(targetCwd);
    if (!path && !this.noSession && sessionStartEvent?.reason === "new") manager.newSession();
    const resolvedCwd = this.sessionCwd({ sessionManager: manager });
    this.knownSessionCwds.add(resolve(resolvedCwd));
    await this.ensureStorage(resolvedCwd);
    const contextPath = fileURLToPath(new URL("../../contexts/web-ui.md", import.meta.url));
    const webUiContext = existsSync(contextPath) ? readFileSync(contextPath, "utf8") : "";
    const loader = new ResilientResourceLoader({
      loadTimeoutMs: envMs("PI_WEB_EXTENSION_LOAD_TIMEOUT_MS", 8_000),
      fetchTimeoutMs: envMs("PI_WEB_EXTENSION_FETCH_TIMEOUT_MS", 3_000),
      loaderOptions: {
        cwd: resolvedCwd,
        agentDir: getAgentDir(),
        additionalExtensionPaths: this.deps.additionalExtensionPaths(resolvedCwd),
        appendSystemPromptOverride: (base) => [...base, webUiContext].filter(Boolean),
      },
    });
    await loader.reload();
    const result = await createAgentSession({
      cwd: resolvedCwd,
      sessionManager: manager,
      modelRuntime: this.deps.modelRuntime,
      resourceLoader: loader,
      sessionStartEvent,
    });
    this.extensionLoaders.set(result.session, loader);
    await this.webUiBridge.bind(result.session);
    return { session: result.session as unknown as PiWebSession, modelFallbackMessage: result.modelFallbackMessage };
  }

  private async createNewLiveSession(cwd?: string, previousSessionFile?: string) {
    const targetCwd = cwd ? await assertDirectory(cwd, this.deps.globalCwd()) : resolve(this.deps.globalCwd());
    this.knownSessionCwds.add(targetCwd);
    await this.ensureStorage(targetCwd);
    const created = await this.makeAgentSession(undefined, { type: "session_start", reason: "new", previousSessionFile }, targetCwd);
    if (created.modelFallbackMessage) console.warn(created.modelFallbackMessage);
    const value = created.session;
    if (this.deps.sessionFactory?.isMock) {
      value.sessionManager.newSession();
      value.agent.state.messages = value.sessionManager.buildSessionContext().messages;
    }
    await this.applyDefaults(value);
    this.registerLiveSession(value);
    await this.deps.sessionConfig.finalizeCreatedSession(value.sessionId);
    return value;
  }

  private async applyDefaults(value: PiWebSession) {
    const defaults = await this.deps.sessionConfig.defaultsFor(this.sessionCwd(value));
    if (defaults.model) {
      const model = value.modelRuntime.getModel(defaults.model.provider, defaults.model.id);
      if (model) await value.setModel(model);
    }
    if (defaults.thinkingLevel && value.getAvailableThinkingLevels().includes(defaults.thinkingLevel)) value.setThinkingLevel(defaults.thinkingLevel);
  }

  private registerLiveSession(value: PiWebSession) {
    const key = sessionPathKey(value);
    if (!key || this.liveSessions.get(key)?.session === value) return value;
    const unsubscribe = value.subscribe?.((event) => this.handlePiEvent(value, event));
    this.liveSessions.set(key, { session: value, unsubscribe, viewerClientIds: new Set(), workLeases: 0 });
    this.liveById.set(value.sessionId, value);
    if (value.sessionFile) this.sessionLocations.set(value.sessionId, { path: resolve(value.sessionFile), cwd: resolve(this.sessionCwd(value)) });
    queueMicrotask(() => this.scheduleLiveSessionCleanup(key));
    return value;
  }

  private handlePiEvent(value: PiWebSession, event: unknown) {
    const e = event as any;
    const sessionId = value.sessionId;
    const sessionFile = value.sessionFile;
    const correlation = this.takePromptCorrelation(sessionPathKey(value), e);
    this.emit({
      type: "pi",
      sessionId,
      sessionFile,
      event: event as JsonValue,
      ...(correlation ? { clientMessageId: correlation.clientMessageId, sourceClientId: correlation.sourceClientId } : {}),
    });
    if (e?.type === "message_end") {
      const committed = e.message;
      // agent-core inserts this object before notifying listeners; the agent
      // relay persists its entry after listeners return, while idle custom
      // messages persist before emitting. Defer so both paths expose entry metadata.
      queueMicrotask(() => {
        const message = projectCommittedMessage(value, committed);
        if (message) this.emit({ type: "committed", sessionId, sessionFile: value.sessionFile, message });
      });
    }
    if (e?.type === "session_info_changed") this.emit({ type: "state", state: this.projectState(value) });
    if (e?.type === "message_end" || e?.type === "agent_end" || e?.type === "compaction_end") {
      this.emit({ type: "stats", sessionId, sessionFile, stats: sessionStats(value) });
    }
    if (e?.type === "message_end" || e?.type === "turn_end") {
      const message = e?.message ?? e?.toolResults?.[0];
      const error: string = message?.errorMessage || message?.message?.errorMessage || "";
      const modelId: string = message?.model || message?.message?.model || "";
      if (modelId && (error.includes("model_not_supported") || error.includes("model_not_available")) && !this.blockedModelIds.has(modelId)) {
        this.blockedModelIds.add(modelId);
        this.emit({ type: "models", sessionId, models: this.availableModels(value).map(simplifyModel).filter((model) => model !== undefined) });
      }
    }
  }

  private emitError(value: PiWebSession | undefined, error: unknown, clientMessageId?: string) {
    this.emit({
      type: "error",
      ...(value ? { sessionId: value.sessionId, sessionFile: value.sessionFile } : {}),
      error: errorMessage(error),
      ...(clientMessageId ? { clientMessageId } : {}),
    });
  }

  private emitRuntime(value: PiWebSession, action: "ensure" | "clear" | "changed" | "completed", activitySessionFile?: string) {
    this.emit({
      type: "runtime",
      sessionId: value.sessionId,
      sessionFile: value.sessionFile,
      action,
      ...(activitySessionFile && activitySessionFile !== value.sessionFile ? { activitySessionFile } : {}),
    });
  }

  private userMessageFromEvent(event: any) {
    const value = event?.message;
    const message = value?.message && typeof value.message === "object" ? value.message : value;
    const raw = message?.raw || message;
    return String(message?.role || raw?.role || "") === "user" ? raw : undefined;
  }

  private takePromptCorrelation(sessionKey: string, event: any) {
    if (event?.type !== "message_end" || !this.userMessageFromEvent(event)) return undefined;
    const pending = this.pendingPromptCorrelations.get(sessionKey);
    if (!pending?.length) return undefined;
    const cutoff = Date.now() - 60 * 60 * 1000;
    while (pending[0] && pending[0].createdAt < cutoff) pending.shift();
    const match = pending.shift();
    if (!pending.length) this.pendingPromptCorrelations.delete(sessionKey);
    return match;
  }

  private rememberPromptCorrelation(sessionKey: string, correlation: PendingPromptCorrelation) {
    const pending = this.pendingPromptCorrelations.get(sessionKey) || [];
    pending.push(correlation);
    this.pendingPromptCorrelations.set(sessionKey, pending);
  }

  private forgetPromptCorrelation(sessionKey: string, clientMessageId: string) {
    const pending = this.pendingPromptCorrelations.get(sessionKey)?.filter((item) => item.clientMessageId !== clientMessageId) || [];
    if (pending.length) this.pendingPromptCorrelations.set(sessionKey, pending);
    else this.pendingPromptCorrelations.delete(sessionKey);
  }

  private acquireWorkLease(value: PiWebSession) {
    const key = sessionPathKey(value);
    const entry = this.liveSessions.get(key);
    if (!entry) return () => undefined;
    entry.workLeases++;
    this.cancelLiveSessionCleanup(entry);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.workLeases = Math.max(0, entry.workLeases - 1);
      this.scheduleLiveSessionCleanup(key);
    };
  }

  private clearTimer(timer?: ReturnType<typeof setTimeout>) { if (timer) clearTimeout(timer); }
  private cancelLiveSessionCleanup(entry: LiveSessionEntry) { this.clearTimer(entry.disposeTimer); entry.disposeTimer = undefined; }
  private isLiveSessionBusy(entry: LiveSessionEntry) { return Boolean(entry.session.isStreaming || entry.session.isCompacting || entry.workLeases > 0); }
  private shouldKeepLiveSession(entry: LiveSessionEntry) { return this.protectedSessionIds.has(entry.session.sessionId) || entry.viewerClientIds.size > 0 || this.isLiveSessionBusy(entry); }

  private scheduleLiveSessionCleanup(key: string) {
    const entry = this.liveSessions.get(key);
    if (!entry || entry.disposing) return;
    if (this.shouldKeepLiveSession(entry)) { this.cancelLiveSessionCleanup(entry); return; }
    if (entry.disposeTimer) return;
    entry.disposeTimer = setTimeout(() => {
      entry.disposeTimer = undefined;
      void this.disposeLiveSession(key, "idle");
    }, this.idleGraceMs);
  }

  private scheduleViewerLeaseRelease(clientId: string) {
    const lease = this.viewerLeases.get(clientId);
    if (!lease || lease.sockets.size > 0) return;
    this.clearTimer(lease.releaseTimer);
    lease.releaseTimer = setTimeout(() => this.releaseViewer(clientId), this.viewerGraceMs);
  }

  private async emitSessionShutdown(value: any) {
    const runner = value?.extensionRunner;
    if (runner?.hasHandlers?.("session_shutdown")) await runner.emit({ type: "session_shutdown", reason: "quit" });
  }

  private async disposeLiveSession(key: string, reason: "idle" | "delete" | "reset", force = false) {
    const entry = this.liveSessions.get(key);
    if (!entry || entry.disposing || (!force && this.shouldKeepLiveSession(entry))) return;
    entry.disposing = true;
    this.cancelLiveSessionCleanup(entry);
    const value = entry.session;
    const sessionId = value.sessionId;
    const sessionFile = value.sessionFile || key;
    for (const [clientId, lease] of this.viewerLeases) {
      if (lease.sessionKey !== key) continue;
      this.clearTimer(lease.releaseTimer);
      this.viewerLeases.delete(clientId);
      for (const connection of lease.sockets) this.viewerConnections.delete(connection);
      lease.sockets.clear();
    }
    try { await this.emitSessionShutdown(value); }
    catch (error) { console.warn(`Could not emit session shutdown before ${reason}:`, error); }
    try { entry.unsubscribe?.(); }
    catch (error) { console.warn(`Could not unsubscribe session before ${reason}:`, error); }
    try { (value as any).dispose?.(); }
    catch (error) { console.warn(`Could not dispose session after ${reason}:`, error); }
    this.liveSessions.delete(key);
    this.pendingPromptCorrelations.delete(key);
    if (this.liveById.get(sessionId) === value) this.liveById.delete(sessionId);
    this.emit({ type: "shutdown", sessionId, sessionFile, sessionKey: key });
  }

  private rememberSessionLocation(info: { id: string; path: string; cwd?: string }, cwd = this.deps.globalCwd()) {
    if (info.id && info.path) this.sessionLocations.set(info.id, { path: resolve(info.path), cwd: resolve(info.cwd || cwd) });
  }

  private simplifySessionInfo(info: PiWebSessionInfo | Awaited<ReturnType<typeof SessionManager.list>>[number], cwd: string): SessionInfoDto {
    this.rememberSessionLocation(info, cwd);
    return jsonSafe({
      id: info.id,
      path: info.path,
      name: info.name,
      firstMessage: info.firstMessage,
      created: info.created.toISOString(),
      modified: info.modified.toISOString(),
      messageCount: info.messageCount,
      cwd: info.cwd || cwd,
      isCurrent: false as const,
    });
  }

  private async findSessionInfoById(id: string, cwd?: string) {
    if (!id || this.noSession) return undefined;
    if (this.deps.sessionFactory?.list) {
      const infos = await this.deps.sessionFactory.list(cwd || this.deps.globalCwd());
      return infos.find((info) => info.id === id);
    }
    if (cwd?.trim()) {
      const resolvedCwd = resolve(cwd);
      const info = (await SessionManager.list(resolvedCwd)).find((item) => item.id === id);
      if (info?.cwd) this.knownSessionCwds.add(resolve(info.cwd));
      if (info) return info;
    }
    for (const knownCwd of this.knownCwds()) {
      const info = (await SessionManager.list(knownCwd)).find((item) => item.id === id);
      if (info?.cwd) this.knownSessionCwds.add(resolve(info.cwd));
      if (info) return info;
    }
    const info = (await SessionManager.listAll()).find((item) => item.id === id);
    if (info?.cwd) this.knownSessionCwds.add(resolve(info.cwd));
    return info;
  }

  private defaultSessionDir(cwd: string) {
    const safePath = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    return join(getAgentDir(), "sessions", safePath);
  }

  private async resolveSessionLocation(id: string, cwd = this.deps.globalCwd()) {
    if (!id || this.noSession) return undefined;
    if (this.deps.sessionFactory?.list) {
      const info = (await this.deps.sessionFactory.list(cwd)).find((item) => item.id === id);
      if (info) this.rememberSessionLocation(info, info.cwd || cwd);
      return info ? this.sessionLocations.get(id) : undefined;
    }
    const suffix = `_${id}.jsonl`;
    for (const resolvedCwd of new Set([resolve(cwd), ...this.knownCwds()])) {
      let names: string[];
      try { names = await readdir(this.defaultSessionDir(resolvedCwd)); } catch { continue; }
      const name = names.find((entry) => entry.endsWith(suffix));
      if (!name) continue;
      const location = { path: join(this.defaultSessionDir(resolvedCwd), name), cwd: resolvedCwd };
      this.sessionLocations.set(id, location);
      this.knownSessionCwds.add(resolvedCwd);
      return location;
    }
    return undefined;
  }

  private async openSessionAtLocation(id: string, location: { path: string; cwd: string }) {
    if (!this.deps.sessionFactory && dirname(resolve(location.path)) !== this.defaultSessionDir(location.cwd)) throw new Error("Invalid session location");
    const value = await this.getOrCreateLiveSession(location.path);
    if (value.sessionId !== id) {
      if (!this.protectedSessionIds.has(value.sessionId)) await this.disposeLiveSession(sessionPathKey(value), "reset", true);
      throw new Error("Session location did not match requested ID");
    }
    this.sessionLocations.set(id, { path: resolve(location.path), cwd: resolve(location.cwd) });
    return value;
  }

  private async getOrCreateLiveSession(path: string) {
    const existing = this.liveSessions.get(path)?.session;
    if (existing) { this.scheduleLiveSessionCleanup(path); return existing; }
    const created = await this.makeAgentSession(path);
    if (created.modelFallbackMessage) console.warn(created.modelFallbackMessage);
    return this.registerLiveSession(created.session);
  }

  private async getOrCreateLiveSessionById(id: string, cwd?: string) {
    const existing = this.liveById.get(id);
    if (existing) return existing;
    const pending = this.openingById.get(id);
    if (pending) return pending;
    const opening = (async () => {
      const remembered = this.sessionLocations.get(id);
      if (remembered) {
        try { return await this.openSessionAtLocation(id, remembered); }
        catch { this.sessionLocations.delete(id); }
      }
      const location = await this.resolveSessionLocation(id, cwd);
      return location ? this.openSessionAtLocation(id, location) : undefined;
    })();
    this.openingById.set(id, opening);
    try { return await opening; }
    finally { this.openingById.delete(id); }
  }

  private async trashOrRemoveSessionFile(path: string) {
    try { await execFileAsync("trash", [path], { timeout: 15_000 }); return "trashed" as const; }
    catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      await rm(path, { force: true });
      return "deleted" as const;
    }
  }

  private getSlashCommands(value: PiWebSession) { return [...webSlashCommands, ...getSessionSlashCommands(value)]; }

  private formatSlashCommandList(commands: SlashCommandDto[]) {
    const groups: Array<[SlashCommandDto["source"], string]> = [["web", "Web"], ["extension", "Extensions"], ["prompt", "Prompts"], ["skill", "Skills"]];
    const lines = ["Available slash commands:"];
    for (const [source, label] of groups) {
      const matching = commands.filter((command) => command.source === source);
      if (!matching.length) continue;
      lines.push("", `${label}:`);
      for (const command of matching) lines.push(`/${command.name}${command.description ? ` - ${command.description}` : ""}`);
    }
    return lines.join("\n");
  }

  private slashHelp(value: PiWebSession) {
    return [
      "Type / in the composer to browse available commands.", "",
      "Web commands run in pi-web; extension, prompt, and skill commands are discovered from pi's extension/resource system.", "",
      this.formatSlashCommandList(this.getSlashCommands(value)),
    ].join("\n");
  }

  private formatModelList(value: PiWebSession) {
    return this.availableModels(value).map((model) => `${model.provider}/${model.id}${model.name && model.name !== model.id ? ` (${model.name})` : ""}`).join("\n");
  }

  private async executeSlashCommand(input: string, value: PiWebSession): Promise<{ message: string; state: BaseSessionStateDto }> {
    const [rawName = "", ...rest] = input.trim().replace(/^\/+/, "").split(/\s+/);
    const name = rawName.toLowerCase();
    const args = rest.join(" ").trim();
    const state = (session = value) => this.projectState(session);
    switch (name) {
      case "help": case "?": return { message: this.slashHelp(value), state: state() };
      case "commands": return { message: this.formatSlashCommandList(this.getSlashCommands(value)), state: state() };
      case "reload":
        if (value.isStreaming) throw new Error("Wait for the current response to finish before reloading.");
        if (value.isCompacting) throw new Error("Wait for compaction to finish before reloading.");
        if (!value.reload) throw new Error("Reload is not available in this session.");
        await value.reload();
        return { message: "Reloaded pi resources, extensions, and models.", state: state() };
      case "model": {
        if (!args) return { message: this.formatModelList(value) || "No models available.", state: state() };
        const slash = args.indexOf("/");
        if (slash <= 0) throw new Error("Usage: /model <provider/model-id>");
        const provider = args.slice(0, slash);
        const id = args.slice(slash + 1);
        const model = value.modelRuntime.getModel(provider, id);
        if (!model) throw new Error(`Model not found: ${args}`);
        await value.setModel(model);
        return { message: `Model set to ${provider}/${id}.`, state: state() };
      }
      case "models": return { message: this.formatModelList(value) || "No models available.", state: state() };
      case "thinking": {
        if (!args) return { message: `Thinking level: ${value.thinkingLevel}\nAvailable: ${value.getAvailableThinkingLevels().join(", ")}`, state: state() };
        const levels = value.getAvailableThinkingLevels();
        if (!levels.includes(args)) throw new Error(`Unknown thinking level: ${args}. Available: ${levels.join(", ")}`);
        value.setThinkingLevel(args);
        return { message: `Thinking level set to ${value.thinkingLevel}.`, state: state() };
      }
      case "new": return { message: "New session.", state: state(await this.createNewLiveSession(this.sessionCwd(value), value.sessionFile)) };
      case "clear":
        if (value.isStreaming) throw new Error("Wait for the current response to finish before clearing.");
        if (value.isCompacting) throw new Error("Wait for compaction to finish before clearing.");
        return { message: "Cleared tab. Previous session remains in history.", state: state(await this.createNewLiveSession(this.sessionCwd(value), value.sessionFile)) };
      case "compact": {
        if (value.isStreaming) throw new Error("Wait for the current response to finish before compacting.");
        if (value.isCompacting) throw new Error("Compaction is already running.");
        if (!value.compact) throw new Error("Compaction is not available in this session.");
        this.emitRuntime(value, "ensure");
        const release = this.acquireWorkLease(value);
        void value.compact(args || undefined).catch((error) => {
          this.emitRuntime(value, "clear");
          this.emitError(value, error);
        }).finally(release);
        return { message: "Compaction started.", state: state() };
      }
      case "abort": case "stop":
        await value.abort();
        return { message: "Aborted.", state: state() };
      default: throw new Error(`Unknown slash command: /${name}. Try /help.`);
    }
  }

  private async persistPromptImages(images: Array<{ data: string; mimeType: string; name?: string }>, cwd: string) {
    if (!images.length) return "";
    await this.ensureStorage(cwd);
    const uploadDir = join(cwd, ".pi", "web", "uploads");
    await mkdir(uploadDir, { recursive: true });
    const lines: string[] = [];
    for (const image of images) {
      const extension = imageExtensions[image.mimeType] || ".img";
      const safeName = String(image.name || "image").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
      const fileName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}-${safeName}${safeName.endsWith(extension) ? "" : extension}`;
      const filePath = join(uploadDir, fileName);
      await writeFile(filePath, Buffer.from(image.data, "base64"));
      lines.push(`- ${filePath}`);
    }
    return `\n\nAttached image file${images.length === 1 ? "" : "s"}:\n${lines.join("\n")}`;
  }

  private async startSessionPrompt(value: PiWebSession, input: { message: string; mode: string; images: Array<{ data: string; mimeType: string; name?: string }>; clientMessageId?: string; sourceClientId?: string }) {
    const imageNote = await this.persistPromptImages(input.images, this.sessionCwd(value));
    const promptText = `${input.message || "Please review the attached image."}${imageNote}`;
    if (!this.deps.sessionFactory?.isMock && input.clientMessageId && input.sourceClientId) this.rememberPromptCorrelation(sessionPathKey(value), { clientMessageId: input.clientMessageId, sourceClientId: input.sourceClientId, createdAt: Date.now() });
    if (!value.isStreaming && !value.isCompacting) this.emitRuntime(value, "ensure");
    const promptSessionFile = value.sessionFile;
    const release = this.acquireWorkLease(value);
    void value.prompt(promptText, {
      ...(value.isStreaming ? { streamingBehavior: input.mode } : {}),
      ...(input.images.length ? { images: input.images.map(({ data, mimeType }) => ({ type: "image", data, mimeType })) } : {}),
    }).catch((error) => {
      if (!this.deps.sessionFactory?.isMock && input.clientMessageId) this.forgetPromptCorrelation(sessionPathKey(value), input.clientMessageId);
      this.emitError(value, error, input.clientMessageId);
    }).finally(() => {
      this.emitRuntime(value, "completed", promptSessionFile);
      release();
    });
  }

  private trailingRetryTarget(value: PiWebSession): RetrySessionTarget | undefined {
    const messages = Array.isArray(value.agent?.state?.messages) ? value.agent.state.messages as any[] : [];
    const index = messages.length - 1;
    const message = messages[index];
    if (isAssistantFailureMessage(message)) return { kind: "failure", messages, index, message };
    if (isAssistantAbortedMessage(message)) return { kind: "aborted", messages, index, message };
    if (isIncompleteToolResultMessage(message)) return { kind: "toolResult", messages, index, message };
    return undefined;
  }

  private branchBeforeTrailingMessages(value: PiWebSession, shouldBranchBefore: (message: any) => boolean) {
    const manager = value.sessionManager;
    if (!manager.getBranch) return false;
    let branch: any[];
    try { branch = manager.getBranch(); } catch { return false; }
    if (!Array.isArray(branch)) return false;
    let last = -1;
    for (let index = branch.length - 1; index >= 0; index--) if (branch[index]?.type === "message") { last = index; break; }
    if (last < 0 || !shouldBranchBefore(branch[last]?.message)) return false;
    let first = last;
    while (first > 0 && branch[first - 1]?.type === "message" && shouldBranchBefore(branch[first - 1].message)) first--;
    const parentId = typeof branch[first]?.parentId === "string" ? branch[first].parentId : null;
    if (parentId && manager.branch) manager.branch(parentId);
    else if (!parentId && manager.resetLeaf) manager.resetLeaf();
    else return false;
    return true;
  }

  private syncAgentMessages(value: PiWebSession) {
    if (!value.sessionManager.buildSessionContext) return false;
    value.agent.state.messages = value.sessionManager.buildSessionContext().messages;
    return true;
  }

  private assertCanRetry(value: PiWebSession) {
    if (value.isStreaming) throw new Error("Wait for the current response to finish before retrying.");
    if (value.isCompacting) throw new Error("Wait for compaction to finish before retrying.");
    if (!this.trailingRetryTarget(value)) throw new Error("There is no failed or incomplete response to retry.");
  }

  private async retryFromFailure(value: PiWebSession) {
    this.assertCanRetry(value);
    if (value.retryFromFailure) return value.retryFromFailure();
    const target = this.trailingRetryTarget(value);
    if (!target) throw new Error("There is no failed or incomplete response to retry.");
    const internal = value as any;
    if (!internal.agent || typeof internal.agent.continue !== "function") throw new Error("Continuing is not available in this session.");
    if (target.kind === "failure") {
      if (!this.branchBeforeTrailingMessages(value, isAssistantFailureMessage) || !this.syncAgentMessages(value)) while (target.messages.length && isAssistantFailureMessage(target.messages.at(-1))) target.messages.pop();
    } else if (target.kind === "aborted") {
      if (!this.branchBeforeTrailingMessages(value, isAssistantAbortedMessage) || !this.syncAgentMessages(value)) if (isAssistantAbortedMessage(target.messages.at(-1))) target.messages.pop();
    }
    try {
      await internal.agent.continue();
      while (typeof internal._handlePostAgentRun === "function" && await internal._handlePostAgentRun()) await internal.agent.continue();
    } finally {
      internal._systemPromptOverride = undefined;
      internal._flushPendingBashMessages?.();
    }
  }

  private async startSessionRetry(value: PiWebSession) {
    try { this.assertCanRetry(value); } catch (error) { throw new SessionServiceError(errorMessage(error), 409); }
    this.emitRuntime(value, "ensure");
    const retrySessionFile = value.sessionFile;
    const release = this.acquireWorkLease(value);
    void this.retryFromFailure(value).catch((error) => {
      this.emitRuntime(value, "clear", retrySessionFile);
      this.emitError(value, error);
    }).finally(() => {
      this.emitRuntime(value, "completed", retrySessionFile);
      release();
    });
  }

  private openExtensionSession(sessionId: string) {
    const value = this.liveById.get(sessionId);
    if (!value) throw new SessionServiceError("Session is not currently open.", 404);
    return value;
  }
}
