import { randomUUID } from "node:crypto";
import type { EphemeralCaptureStore } from "../../../extensions/captureStore.js";
import type { ReadSession } from "../../referenceTools.js";
import { simplifyMessage } from "../../projection.js";
import type { PiAdapter } from "./adapter.js";
export { PiAdapter, createPiAdapter } from "./adapter.js";
import { existsSync } from "node:fs";
import { formatSkillsForPrompt, type AgentSessionEvent, type ModelRuntime, type SessionStartEvent } from "@earendil-works/pi-coding-agent";
import type { PiWebSession, PiWebSessionInfo } from "../../../types.js";
import type { ResilientResourceLoader } from "../../../extensions/resilientLoader.js";
import { serializeAttachmentMarkup } from "../../../shared/attachments.js";
import { mapPiEvent } from "../../piEventMap.js";
import { SessionServiceError } from "../../errors.js";
import type { SessionHandle, AdapterPromptInput } from "../../adapter.js";
import type { ActiveExecutionDto, BaseSessionStateDto, SessionSnapshotDto, HarnessDescriptorDto, MessageDto, JsonValue, InteractionRequestDto, InteractionResponseDto, PromptReceiptDto, InterruptReceiptDto, SessionServiceEvent, SlashCommandDto, AttachmentDto, SessionContextDto, PromptProvenanceDto, PromptProvenanceSourceKind, NavigationResult } from "../../dto.js";
import { conversationTreeForSession, getSessionSlashCommands, isAssistantAbortedMessage, isAssistantFailureMessage, isIncompleteToolResultMessage, projectCommittedMessage, projectMessages, projectSessionState, sessionStats, simplifyModel } from "../../projection.js";

type RetrySessionTarget =
  | { kind: "failure" | "aborted" | "toolResult"; messages: any[]; index: number; message: any };
type PendingPromptCorrelation = { clientMessageId: string; sourceClientId: string; createdAt: number };

/** A test peer enters at Pi's SDK subscription/binding ingress, never at browser broadcast. */
export interface PiSessionPeer {
  create(input: { path?: string; cwd: string; sessionStartEvent?: SessionStartEvent }): Promise<{ session: PiWebSession; modelFallbackMessage?: string }>;
  list?(cwd: string): Promise<PiWebSessionInfo[]>;
  remove?(id: string, path: string): Promise<"trashed" | "deleted">;
  newSessionAfterCreate?: boolean;
}
export interface PiAdapterDependencies {
  modelRuntime: ModelRuntime;
  peer?: PiSessionPeer;
  extensionHttp?: Pick<import("../../../auth/extensionHttp.js").ExtensionHttpRegistry, "createClient" | "revokeOwner">;
  additionalExtensionPaths(cwd: string): string[];
  defaultsFor(cwd: string): Promise<{ model?: { provider: string; id: string }; thinkingLevel?: string }>;
  globalCwd(): string;
  clientCount(): number;
}
export interface PiAdapterHost {
  captureStore: EphemeralCaptureStore;
  readSession: ReadSession;
  register(handle: PiSessionHandle): void;
  failed(handle: PiSessionHandle): void;
  create(cwd: string, previousSessionFile?: string): Promise<SessionSnapshotDto>;
  withWorkLease<T>(handle: SessionHandle, label: string, kind: "general" | "retry", operation: () => T | Promise<T>): Promise<T>;
  clearWorkLeases(handle: SessionHandle, reason: string): void;
  hasWork(sessionId: string): boolean;
}

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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function interactionRequestFromWire(value: Record<string, unknown>): InteractionRequestDto | undefined {
  if (value.type !== "interaction_request" || typeof value.id !== "string" || typeof value.source !== "string" || typeof value.kind !== "string" || typeof value.sessionId !== "string") return undefined;
  if (!["extension", "approval", "clarify", "sudo", "secret"].includes(value.source) || !value.payload || typeof value.payload !== "object" || Array.isArray(value.payload)) return undefined;
  return {
    id: value.id,
    source: value.source as InteractionRequestDto["source"],
    kind: value.kind,
    payload: jsonSafe(value.payload) as InteractionRequestDto["payload"],
    sessionId: value.sessionId,
    ...(typeof value.sessionFile === "string" ? { sessionFile: value.sessionFile } : {}),
    timeout: Number(value.timeout) || 120_000,
  };
}

type ProvenanceCandidate = {
  text: string;
  source: { kind: PromptProvenanceSourceKind; label: string; path?: string };
  confidence?: "exact" | "derived";
};

/** Project only text we can observe; everything else stays explicitly unknown. */
function projectPromptProvenance(prompt: string, candidates: ProvenanceCandidate[]): PromptProvenanceDto {
  if (prompt.length === 0) return { encoding: "utf-16", spans: [], coverage: { exact: 0, derived: 0, unknown: 0, total: 0 } };
  const matches: Array<{ start: number; end: number; candidate: ProvenanceCandidate }> = [];
  for (const candidate of candidates.filter(({ text }) => text.length > 0).sort((a, b) => b.text.length - a.text.length)) {
    let from = 0;
    while (from <= prompt.length - candidate.text.length) {
      const start = prompt.indexOf(candidate.text, from);
      if (start < 0) break;
      const end = start + candidate.text.length;
      if (!matches.some((match) => start < match.end && end > match.start)) matches.push({ start, end, candidate });
      from = start + Math.max(1, candidate.text.length);
    }
  }
  matches.sort((a, b) => a.start - b.start);
  const spans: PromptProvenanceDto["spans"] = [];
  let cursor = 0;
  for (const match of matches) {
    if (cursor < match.start) spans.push({ start: cursor, end: match.start, source: { kind: "unknown", label: "Unattributed prompt text" }, confidence: "unknown" });
    spans.push({ start: match.start, end: match.end, source: match.candidate.source, confidence: match.candidate.confidence || "exact" });
    cursor = match.end;
  }
  if (cursor < prompt.length) spans.push({ start: cursor, end: prompt.length, source: { kind: "unknown", label: "Unattributed prompt text" }, confidence: "unknown" });
  const coverage = { exact: 0, derived: 0, unknown: 0, total: prompt.length };
  for (const span of spans) coverage[span.confidence] += span.end - span.start;
  return { encoding: "utf-16", spans, coverage };
}



/** Pi-only operations remain explicit here; native handles never impersonate them. */
export class PiSessionHandle implements SessionHandle {
  readonly harnessId = "pi" as const;
  private readonly listeners = new Set<(event: SessionServiceEvent) => void>();
  private readonly pendingEvents: SessionServiceEvent[] = [];
  private readonly pendingPromptCorrelations = new Map<string, PendingPromptCorrelation[]>();
  private readonly pendingInteractions = new Map<string, InteractionRequestDto>();
  private activeExecution?: ActiveExecutionDto;
  private readonly unsubscribe?: () => void;
  private disposed = false;
  constructor(private readonly raw: PiWebSession, private readonly adapter: PiAdapter, private readonly loader?: ResilientResourceLoader) {
    this.unsubscribe = raw.subscribe?.((event) => this.handlePiEvent(raw, event));
  }
  get sessionId() { return this.raw.sessionId; }
  private sessionCwd(value: PiWebSession) { return String((value.sessionManager as any)?.getCwd?.() || this.adapter.deps.globalCwd()); }
  state(): SessionSnapshotDto {
    const base = projectSessionState(this.raw, this.sessionCwd(this.raw));
    return jsonSafe({ ...base, harnessId: "pi", nativeSession: { harnessId: "pi", sessionId: this.sessionId,
      persistence: this.raw.sessionFile ? "persistent" : "ephemeral",
      status: this.raw.sessionFile ? (existsSync(this.raw.sessionFile) || this.adapter.deps.peer ? "resumable" : "unmaterialized") : "live-only" },
      phase: base.isStreaming || base.isRetrying || base.isCompacting ? "running" : this.activeExecution ? "settling" : "idle",
      activity: this.pendingInteractions.size ? "waiting-input" : base.isCompacting ? "compacting" : base.isRetrying ? "retrying" : base.isStreaming || this.activeExecution ? "working" : "idle",
      activeExecution: this.activeExecution, pendingInteractions: [...this.pendingInteractions.values()],
      capabilities: { ...base.capabilities, models: true, context: true, attachments: true, historyFork: false },
      runtimeStartedAt: (this.raw as any).runtimeStartedAt, runtimeLastActivityAt: (this.raw as any).runtimeLastActivityAt,
    });
  }
  private projectState(_value: PiWebSession = this.raw): SessionSnapshotDto { return this.state(); }
  async messages() { return jsonSafe(projectMessages(this.raw)); }
  readHistoryEntry(entryId: string): MessageDto[] {
    const entry = this.raw.sessionManager.getEntry?.(entryId);
    if (entry?.type !== "message") return [];
    const message = simplifyMessage(entry.message, { entryId });
    return message ? [message] : [];
  }
  subscribe(listener: (event: SessionServiceEvent) => void) {
    this.listeners.add(listener);
    for (const event of this.pendingEvents.splice(0)) listener(event);
    return () => this.listeners.delete(listener);
  }
  private emit(event: SessionServiceEvent) {
    if (this.disposed) return;
    const safe = jsonSafe(event);
    if (!this.listeners.size) { this.pendingEvents.push(safe); return; }
    for (const listener of this.listeners) listener(safe);
  }
  bridgeEvent(value: Record<string, unknown>) {
    const request = interactionRequestFromWire(value);
    if (request) { this.pendingInteractions.set(request.id, request); this.emit({ type: "interaction", request }); }
    else if (value.type === "interaction_resolved" && typeof value.id === "string") {
      this.pendingInteractions.delete(value.id);
      this.emit({ type: "interaction_resolved", sessionId: this.sessionId, id: value.id, reason: value.reason as "responded" });
    } else if (value.type === "settlement_dependencies" && Array.isArray(value.childIds)) {
      this.emit({ type: "settlement_dependencies", sessionId: this.sessionId, childIds: value.childIds.filter((id): id is string => typeof id === "string") });
    } else if (value.type === "state_changed") this.emit({ type: "state", state: this.state() });
    else this.emit({ type: "wire", value: value as JsonValue });
  }
  async prompt(input: AdapterPromptInput): Promise<PromptReceiptDto> {
    if (!this.activeExecution) this.activeExecution = { id: input.executionId, owner: "host" };
    await this.startSessionPrompt(this.raw, input);
    return { sessionId: this.sessionId, executionId: this.activeExecution?.id || input.executionId, acknowledgement: "not-exposed" };
  }
  async interrupt(expectedExecutionId: string): Promise<InterruptReceiptDto> {
    if (expectedExecutionId && this.activeExecution?.id !== expectedExecutionId) throw new SessionServiceError("Execution is no longer active", 409);
    const executionId = this.activeExecution?.id || expectedExecutionId;
    await this.abortSession(this.raw);
    if (!this.raw.isStreaming && !this.raw.isCompacting) this.activeExecution = undefined;
    this.emit({ type: "state", state: this.state() });
    return { sessionId: this.sessionId, executionId, acknowledged: true };
  }
  async retry() {
    try { this.assertCanRetry(this.raw); } catch (error) { throw new SessionServiceError(errorMessage(error), 409); }
    this.activeExecution = { id: randomUUID(), owner: "host" };
    try { await this.startSessionRetry(this.raw); } catch (error) { this.activeExecution = undefined; throw error; }
    return { sessionId: this.sessionId };
  }
  respondInteraction(response: InteractionResponseDto) {
    return (!response.sessionId || response.sessionId === this.sessionId) && this.pendingInteractions.has(response.id)
      && this.adapter.webUiBridge.respond(response.id, response);
  }
  cancelInteractions(_reason: "timeout" | "disconnect" | "disposed") { this.adapter.webUiBridge.cancelPendingInteractions(this.sessionId); }
  webUiEntries() { return this.adapter.webUiBridge.entries(this.raw); }
  captureRegistration(key: unknown, registrationId: unknown) { return this.adapter.webUiBridge.captureRegistration(this.raw, key, registrationId); }
  invokeContribution(input: Record<string, unknown>, signal?: AbortSignal) { return this.adapter.webUiBridge.invokeContribution(this.raw, input, signal); }
  invokeHeaderAction(key: unknown) { return this.adapter.webUiBridge.invokeHeaderAction(this.raw, key); }
  invokeArtifactAction(input: Record<string, unknown>) { return this.adapter.webUiBridge.invokeArtifactAction(this.raw, input); }
  invokeGitTab(input: Record<string, unknown>) { return this.adapter.webUiBridge.invokeGitTab(this.raw, input); }
  invokePanel(input: Record<string, unknown>) { return this.adapter.webUiBridge.invokePanel(this.raw, input); }
  extensionStatus() {
    if (!this.loader) throw new SessionServiceError("Extension status is not available for this session.", 404);
    return this.extensionStatusFor(this.raw, this.loader);
  }
  async dispose() {
    if (this.disposed) return;
    this.cancelInteractions("disposed");
    const runner = this.raw.extensionRunner as any;
    try { if (runner?.hasHandlers?.("session_shutdown")) await runner.emit({ type: "session_shutdown", reason: "quit" }); }
    finally { this.disposed = true; this.unsubscribe?.(); (this.raw as any).dispose?.(); this.adapter.webUiBridge.releaseSessionSettings(this.raw); this.adapter.releaseBridge(this.sessionId); this.listeners.clear(); }
  }
  async context(): Promise<SessionContextDto> {
    const value = this.raw;
    const loader = value.resourceLoader;
    const callsByName: Record<string, number> = {};
    for (const message of value.messages as any[]) {
      if (message?.role !== "assistant") continue;
      for (const block of Array.isArray(message.content) ? message.content : []) {
        const toolName = typeof block?.name === "string" ? block.name : typeof block?.toolName === "string" ? block.toolName : undefined;
        if (block?.type !== "toolCall" || !toolName) continue;
        callsByName[toolName] = (callsByName[toolName] || 0) + 1;
      }
    }
    const skillsResult = loader?.getSkills?.() || { skills: [], diagnostics: [] };
    const extensionsResult = loader?.getExtensions?.() || { extensions: [], errors: [] };
    const promptsResult = loader?.getPrompts?.() || { prompts: [], diagnostics: [] };
    const allTools = value.getAllTools?.() || [];
    const activeNames = [...(value.getActiveToolNames?.() || [])];
    const activeToolSet = new Set(activeNames);
    const configured = allTools.map((tool: any) => ({
      name: String(tool.name || tool.definition?.name || ""),
      ...(typeof tool.description === "string" || typeof tool.definition?.description === "string" ? { description: String(tool.description || tool.definition.description) } : {}),
      ...(tool.sourceInfo ? { sourceInfo: jsonSafe(tool.sourceInfo) as JsonValue } : {}),
      callCount: callsByName[String(tool.name || tool.definition?.name || "")] || 0,
    })).filter((tool) => tool.name);
    const contributionCount = (value: unknown) => value instanceof Map ? value.size : Array.isArray(value) ? value.length : value && typeof value === "object" ? Object.keys(value).length : 0;
    const handlerCount = (value: unknown) => value instanceof Map
      ? [...value.values()].reduce((sum, handlers) => sum + (Array.isArray(handlers) ? handlers.length : 0), 0)
      : contributionCount(value);
    const candidates: ProvenanceCandidate[] = [];
    const addCandidate = (text: unknown, kind: PromptProvenanceSourceKind, label: string, path?: string, confidence: "exact" | "derived" = "exact") => {
      if (typeof text === "string" && text.length > 0) candidates.push({ text, source: { kind, label, ...(path ? { path } : {}) }, confidence });
    };
    const systemPromptSource = loader?.getSystemPromptSource?.();
    addCandidate(loader?.getSystemPrompt?.(), "system-prompt", "System prompt", systemPromptSource?.path);
    for (const file of loader?.getAgentsFiles?.().agentsFiles || []) addCandidate(file.content, "context-file", file.path, file.path);
    for (const skill of skillsResult.skills as any[]) {
      if (skill.disableModelInvocation) continue;
      const label = String(skill.name || skill.filePath || "Skill");
      const formatted = formatSkillsForPrompt([skill]);
      const entry = formatted.match(/<skill>[\s\S]*?<\/skill>/)?.[0];
      addCandidate(entry, "skill", label, skill.filePath, "derived");
    }
    for (const tool of allTools) {
      const definition = tool.definition || tool;
      const name = String(definition.name || tool.name || "Tool");
      if (!activeToolSet.has(name)) continue;
      const sourceInfo = tool.sourceInfo && typeof tool.sourceInfo === "object" ? tool.sourceInfo as Record<string, unknown> : undefined;
      const path = typeof sourceInfo?.path === "string" ? sourceInfo.path : undefined;
      const declaration = value.systemPrompt.split("\n").find((line) => line.startsWith(`- ${name}: `));
      addCandidate(declaration, "tool", name, path, "derived");
      addCandidate(definition.description || tool.description, "tool", name, path);
      for (const guideline of definition.promptGuidelines || tool.promptGuidelines || []) addCandidate(guideline, "tool", name, path);
    }
    const appendValues = loader?.getAppendSystemPrompt?.() || [];
    const appendSources = loader?.getAppendSystemPromptSources?.() || [];
    appendValues.forEach((text, index) => {
      const path = appendSources[index]?.path;
      const isWeb = !path && (text.includes("pi-web extension documentation") || text.includes("pi-web-attachments-v2"));
      addCandidate(text, isWeb ? "pi-web" : "append-prompt", isWeb ? "pi-web injected context" : path || `Append prompt ${index + 1}`, path);
    });
    const provenance = projectPromptProvenance(value.systemPrompt, candidates);
    const diagnostics = [
      ...(skillsResult.diagnostics || []),
      ...(promptsResult.diagnostics || []),
      ...(extensionsResult.errors || []),
      ...(loader?.getStatus?.().errors || []),
    ].map((item) => jsonSafe(item) as JsonValue);
    return {
      sessionId: value.sessionId,
      systemPrompt: value.systemPrompt,
      provenance,
      capturedAt: new Date().toISOString(),
      tools: { activeNames, configured, callsByName },
      resources: {
        skills: (skillsResult.skills as any[]).map((skill) => jsonSafe({ name: String(skill.name || ""), description: skill.description, filePath: skill.filePath, disableModelInvocation: skill.disableModelInvocation, sourceInfo: skill.sourceInfo }) as SessionContextDto["resources"]["skills"][number]),
        extensions: (extensionsResult.extensions as any[]).map((extension) => ({
          path: String(extension.path || ""), resolvedPath: extension.resolvedPath, hidden: extension.hidden,
          ...(extension.sourceInfo ? { sourceInfo: jsonSafe(extension.sourceInfo) as JsonValue } : {}),
          contributions: {
            tools: contributionCount(extension.tools),
            commands: contributionCount(extension.commands),
            handlers: handlerCount(extension.handlers),
            renderers: contributionCount(extension.messageRenderers) + contributionCount(extension.entryRenderers) + (extension.markdownTransformer ? 1 : 0),
            flags: contributionCount(extension.flags),
            shortcuts: contributionCount(extension.shortcuts),
          },
        })),
        contextFiles: (loader?.getAgentsFiles?.().agentsFiles || []).map((file) => file.path),
        ...(loader?.getSystemPromptSource?.()?.path ? { systemPromptSource: loader.getSystemPromptSource()!.path } : {}),
        appendSystemPromptSources: (loader?.getAppendSystemPromptSources?.() || []).map((source) => source.path),
        diagnostics,
      },
    };
  }

  async tree() {
    const value = this.raw;
    try { return jsonSafe(conversationTreeForSession(value)); }
    catch (error) { throw new SessionServiceError(errorMessage(error), 400); }
  }

  async commands() {
    return jsonSafe([...webSlashCommands, ...getSessionSlashCommands(this.raw)]);
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
    return value.modelRuntime.getAvailableSnapshot().filter((model) => !this.adapter.blockedModelIds.has(model.id) && (!allowed || allowed.has(model.id)));
  }

  async models() {
    const value = this.raw;
    return jsonSafe({
      cwd: this.sessionCwd(value),
      current: simplifyModel(value.model),
      thinkingLevel: value.thinkingLevel,
      thinkingLevels: value.getAvailableThinkingLevels(),
      models: this.availableModels(value).map(simplifyModel).filter((model) => model !== undefined),
    });
  }

  async setModel(provider: string, id: string, thinkingLevel?: string) {
    const value = this.raw;
    const model = value.modelRuntime.getModel(provider, id);
    if (!model) throw new SessionServiceError("Model not found", 404);
    await value.setModel(model);
    if (thinkingLevel !== undefined) value.setThinkingLevel(thinkingLevel);
    return this.projectState(value);
  }

  async executeShell(command: string, excludeFromContext: boolean) {
    const value = this.raw;
    if (!value.executeBash) throw new SessionServiceError("Bash execution is not available in this session.");
    return jsonSafe({ command, cwd: this.sessionCwd(value), ...await value.executeBash(command, undefined, { excludeFromContext }), excludeFromContext });
  }

  async executeCommand(command: string) {
    return this.executeSlashCommand(command, this.raw);
  }

  async abortCompaction() {
    const value = this.raw;
    if (!value.abortCompaction) throw new SessionServiceError("Compaction cancellation is not available");
    value.abortCompaction();
    return { sessionId: value.sessionId };
  }

  async abortBranchSummary() {
    const value = this.raw;
    value.abortBranchSummary?.();
    return { sessionId: value.sessionId };
  }

  async rename(name: string) {
    const value = this.raw;
    if (!value.setSessionName) throw new SessionServiceError("Renaming sessions is not available");
    value.setSessionName(name);
    return this.projectState(value);
  }

  async navigate(targetId: string, options: Record<string, unknown>): Promise<NavigationResult> {
    const value = this.raw;
    if (value.isStreaming) throw new SessionServiceError("Wait for the current response to finish before navigating the tree", 409);
    if (value.isCompacting) throw new SessionServiceError("Wait for the current compaction to finish before navigating the tree", 409);
    if (!value.navigateTree) throw new SessionServiceError("Tree navigation is not available");
    return this.adapter.host.withWorkLease(this, "navigate", "general", async () => {
      const result = await value.navigateTree!(targetId, options as any);
      const state = this.projectState(value);
      this.emit({ type: "state", state, includeThinkingLevels: true });
      return { ...jsonSafe(result as Record<string, JsonValue>), leafId: value.sessionManager.getLeafId?.() || null, state };
    });
  }

  private extensionStatusFor(value: PiWebSession, loader: ResilientResourceLoader) {
    const status = loader.getStatus();
    const runtimeErrors = this.adapter.webUiBridge.runtimeErrors(value);
    if (!runtimeErrors.length) return { ...status, runtimeErrors };
    return {
      ...status,
      state: status.state === "loading" ? status.state : "degraded" as const,
      runtimeErrors,
      message: `${status.message} ${runtimeErrors.length} recent runtime error${runtimeErrors.length === 1 ? "" : "s"}.`,
    };
  }

  async reloadExtensions() {
    const value = this.raw;
    if (value.isStreaming) throw new SessionServiceError("Wait for the current response to finish before retrying extensions.", 409);
    if (value.isCompacting) throw new SessionServiceError("Wait for compaction to finish before retrying extensions.", 409);
    const loader = this.loader;
    if (!loader || typeof value.reload !== "function") throw new SessionServiceError("Extension reload is not available for this session.", 404);
    await value.reload();
    const status = this.extensionStatusFor(value, loader);
    this.emit({ type: "wire", value: { type: "extensions_reloaded", sessionId: value.sessionId, status } as JsonValue });
    return status;
  }

  private handlePiEvent(value: PiWebSession, event: unknown) {
    const e = event as AgentSessionEvent;
    const sessionId = value.sessionId;
    const sessionFile = value.sessionFile;
    const mapped = mapPiEvent(e);
    const raw = event as any;
    if (raw?.type === "agent_start" && !this.activeExecution) this.activeExecution = { id: randomUUID(), owner: "host" };
    if (raw?.type === "agent_settled") this.activeExecution = undefined;
    if (mapped.kind === "entry") {
      this.emit({ type: "entry", sessionId, sessionFile, entryId: mapped.entryId, parentId: mapped.parentId, entryKind: mapped.entryKind });
      return;
    }
    const correlation = this.takePromptCorrelation(this.sessionId, e);
    this.emit({
      type: "agent",
      sessionId,
      sessionFile,
      event: mapped.event,
      ...(correlation ? { clientMessageId: correlation.clientMessageId, sourceClientId: correlation.sourceClientId } : {}),
    });
    if (raw?.type === "message_end") {
      const committed = raw.message;
      // agent-core inserts this object before notifying listeners; the agent
      // relay persists its entry after listeners return, while idle custom
      // messages persist before emitting. Defer so both paths expose entry metadata.
      queueMicrotask(() => {
        const message = projectCommittedMessage(value, committed);
        if (message) this.emit({ type: "committed", sessionId, sessionFile: value.sessionFile, message });
      });
    }
    if (["session_info_changed", "agent_start", "agent_settled", "compaction_start", "compaction_end", "auto_retry_start", "auto_retry_end", "queue_update"].includes(raw?.type)) {
      this.emit({ type: "state", state: this.projectState(value) });
    }
    if (raw?.type === "message_end" || raw?.type === "agent_end" || raw?.type === "compaction_end") {
      this.emit({ type: "stats", sessionId, sessionFile, stats: sessionStats(value) });
    }
    if (raw?.type === "message_end" || raw?.type === "turn_end") {
      const message = raw?.message ?? raw?.toolResults?.[0];
      const error: string = message?.errorMessage || message?.message?.errorMessage || "";
      const modelId: string = message?.model || message?.message?.model || "";
      if (modelId && (error.includes("model_not_supported") || error.includes("model_not_available")) && !this.adapter.blockedModelIds.has(modelId)) {
        this.adapter.blockedModelIds.add(modelId);
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

  private emitRuntime(value: PiWebSession, action: "ensure" | "clear" | "changed" | "completed", activitySessionFile?: string, aborted = false) {
    this.emit({
      type: "runtime",
      sessionId: value.sessionId,
      sessionFile: value.sessionFile,
      action,
      ...(activitySessionFile && activitySessionFile !== value.sessionFile ? { activitySessionFile } : {}),
      ...(action === "completed" ? { aborted } : {}),
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
      case "new": return { message: "New session.", state: await this.adapter.host.create(this.sessionCwd(value), value.sessionFile) };
      case "clear":
        if (value.isStreaming) throw new Error("Wait for the current response to finish before clearing.");
        if (value.isCompacting) throw new Error("Wait for compaction to finish before clearing.");
        return { message: "Cleared tab. Previous session remains in history.", state: await this.adapter.host.create(this.sessionCwd(value), value.sessionFile) };
      case "compact": {
        if (value.isStreaming) throw new Error("Wait for the current response to finish before compacting.");
        if (value.isCompacting) throw new Error("Compaction is already running.");
        if (!value.compact) throw new Error("Compaction is not available in this session.");
        this.emitRuntime(value, "ensure");
        void this.adapter.host.withWorkLease(this, "compact", "general", () => value.compact!(args || undefined)).catch((error) => {
          this.emitRuntime(value, "clear");
          this.emitError(value, error);
        });
        return { message: "Compaction started.", state: state() };
      }
      case "abort": case "stop":
        await this.abortSession(value);
        return { message: "Aborted.", state: state() };
      default: throw new Error(`Unknown slash command: /${name}. Try /help.`);
    }
  }

  private abortSession(value: PiWebSession) {
    const wasSdkActive = Boolean(value.isStreaming || value.isCompacting);
    const aborting = value.abort().catch((error) => this.emitError(value, error));
    if (!wasSdkActive) this.adapter.host.clearWorkLeases(this, "abort while SDK idle");
    else void aborting.then(() => {
      if (!value.isStreaming && !value.isCompacting) this.adapter.host.clearWorkLeases(this, "active abort settled");
    });
    return aborting;
  }

  private async startSessionPrompt(value: PiWebSession, input: { message: string; mode: string; attachments: AttachmentDto[]; clientMessageId?: string; sourceClientId?: string }) {
    const promptText = serializeAttachmentMarkup(input.message || "Please review the attached file.", input.attachments);
    if (input.clientMessageId && input.sourceClientId) this.rememberPromptCorrelation(this.sessionId, { clientMessageId: input.clientMessageId, sourceClientId: input.sourceClientId, createdAt: Date.now() });
    if (!value.isStreaming && !value.isCompacting) this.emitRuntime(value, "ensure");
    const promptSessionFile = value.sessionFile;
    void this.adapter.host.withWorkLease(this, "prompt", "general", () => value.prompt(promptText, {
      ...(value.isStreaming ? { streamingBehavior: input.mode } : {}),
    })).catch((error) => {
      if (input.clientMessageId) this.forgetPromptCorrelation(this.sessionId, input.clientMessageId);
      this.emitError(value, error, input.clientMessageId);
    }).finally(() => {
      const lastMessage = Array.isArray(value.agent?.state?.messages) ? value.agent.state.messages.at(-1) : undefined;
      if (!value.isStreaming && !value.isCompacting) this.activeExecution = undefined;
      this.emitRuntime(value, "completed", promptSessionFile, isAssistantAbortedMessage(lastMessage));
      this.emit({ type: "state", state: this.state() });
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
    if (this.adapter.host.hasWork(this.sessionId)) throw new Error("Wait for the current response to finish before retrying.");
    if (value.isStreaming) throw new Error("Wait for the current response to finish before retrying.");
    if (value.isCompacting) throw new Error("Wait for compaction to finish before retrying.");
    if (!this.trailingRetryTarget(value)) throw new Error("There is no failed or incomplete response to retry.");
  }

  private async retryFromFailure(value: PiWebSession) {
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
    const usesCompatibilityFallback = !value.retryFromFailure;
    void this.adapter.host.withWorkLease(this, "retry", "retry", () => this.retryFromFailure(value)).catch((error) => {
      this.emitRuntime(value, "clear", retrySessionFile);
      this.emitError(value, error);
    }).finally(() => {
      // The private SDK fallback bypasses AgentSession._runAgentPrompt(), so it
      // cannot emit pi's authoritative idle event itself. Translate settlement
      // only after releasing the compatibility lease.
      if (usesCompatibilityFallback) this.handlePiEvent(value, { type: "agent_settled" });
      const lastMessage = Array.isArray(value.agent?.state?.messages) ? value.agent.state.messages.at(-1) : undefined;
      if (!value.isStreaming && !value.isCompacting) this.activeExecution = undefined;
      this.emitRuntime(value, "completed", retrySessionFile, isAssistantAbortedMessage(lastMessage));
      this.emit({ type: "state", state: this.state() });
    });
  }
}
