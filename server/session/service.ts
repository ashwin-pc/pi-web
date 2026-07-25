import type { PiWebSession } from "../types.js";
import type { NavigationResult, SessionService, SlashCommandDto } from "./dto.js";
import { conversationTreeForSession, getSessionSlashCommands, messageEntryRefs, sessionStats, simplifyMessage, simplifyModel } from "./projection.js";

export class SessionServiceError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export interface LocalSessionServiceDependencies {
  currentSessionId(): string;
  globalCwd(): string;
  resolve(sessionId: string): Promise<PiWebSession | undefined>;
  cwd(session: PiWebSession): string;
  decorateState(session: PiWebSession): Record<string, unknown>;
  decorateMessageContent(content: unknown, sessionFile: string): unknown;
  availableModels(session: PiWebSession): unknown[];
  webCommands: SlashCommandDto[];
  list(extraCwds: string[]): Promise<Array<{ id: string } & Record<string, unknown>>>;
  create(cwd?: string, previousSessionFile?: string): Promise<PiWebSession>;
  open(sessionId: string, cwd?: string): Promise<PiWebSession>;
  delete(sessionId: string, cwd?: string): Promise<unknown>;
  switchCwd(session: PiWebSession, cwd: string): Promise<Record<string, unknown>>;
  executeCommand(command: string, session: PiWebSession): Promise<{ message: string; state: Record<string, unknown> }>;
  prompt(session: PiWebSession, input: { message: string; mode: string; images: Array<{ data: string; mimeType: string; name?: string }> }): Promise<void>;
  retry(session: PiWebSession): Promise<void>;
  navigate(session: PiWebSession, targetId: string, options: Record<string, unknown>): Promise<NavigationResult>;
  invokeHeaderAction(session: PiWebSession, key: unknown): Promise<Record<string, unknown>>;
  invokeArtifactAction(session: PiWebSession, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  invokeGitTab(session: PiWebSession, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  reportError(session: PiWebSession, error: unknown): void;
}

export class LocalSessionService implements SessionService {
  constructor(private readonly deps: LocalSessionServiceDependencies) {}

  defaultSessionId(): string { return this.deps.currentSessionId(); }

  async require(sessionId?: string): Promise<PiWebSession> {
    const id = sessionId || this.defaultSessionId();
    const session = await this.deps.resolve(id);
    if (!session) throw new SessionServiceError("Session not found", 404);
    return session;
  }

  async state(sessionId?: string) {
    return this.deps.decorateState(await this.require(sessionId));
  }

  async stats(sessionId?: string) {
    const session = await this.require(sessionId);
    return { sessionId: session.sessionId, stats: sessionStats(session) };
  }

  async tree(sessionId?: string) {
    const session = await this.require(sessionId);
    try { return conversationTreeForSession(session); }
    catch (error) { throw new SessionServiceError(error instanceof Error ? error.message : String(error), 400); }
  }

  async messages(sessionId?: string) {
    const session = await this.require(sessionId);
    const messages = session.messages;
    const toolCallArgs = new Map<string, Record<string, unknown>>();
    for (const message of messages as any[]) {
      if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (part?.type === "toolCall" && part.id) toolCallArgs.set(part.id, part.arguments || {});
      }
    }
    const refs = messageEntryRefs(session);
    return messages.map((message, index) => simplifyMessage(message, {
      toolCallArgs,
      decorateContent: (content) => this.deps.decorateMessageContent(content, session.sessionFile),
      entryId: refs[index]?.entryId,
    }));
  }

  async commands(sessionId?: string) {
    const session = await this.require(sessionId);
    return [...this.deps.webCommands, ...getSessionSlashCommands(session)];
  }

  async models(sessionId?: string) {
    const session = await this.require(sessionId);
    return {
      cwd: this.deps.cwd(session),
      current: simplifyModel(session.model),
      thinkingLevel: session.thinkingLevel,
      thinkingLevels: session.getAvailableThinkingLevels(),
      models: this.deps.availableModels(session).map(simplifyModel),
    };
  }

  async setModel(sessionId: string | undefined, provider: string, id: string, thinkingLevel?: string) {
    const session = await this.require(sessionId);
    const model = session.modelRuntime.getModel(provider, id);
    if (!model) throw new SessionServiceError("Model not found", 404);
    await session.setModel(model);
    if (thinkingLevel !== undefined) session.setThinkingLevel(thinkingLevel);
    return this.deps.decorateState(session);
  }

  async executeShell(sessionId: string | undefined, command: string, excludeFromContext: boolean) {
    const session = await this.require(sessionId);
    if (!session.executeBash) throw new SessionServiceError("Bash execution is not available in this session.");
    return { command, cwd: this.deps.cwd(session), ...await session.executeBash(command, undefined, { excludeFromContext }), excludeFromContext };
  }

  async executeCommand(sessionId: string | undefined, command: string) {
    return this.deps.executeCommand(command, await this.require(sessionId));
  }

  async prompt(sessionId: string | undefined, input: { message: string; mode: string; images: Array<{ data: string; mimeType: string; name?: string }> }) {
    const session = await this.require(sessionId);
    await this.deps.prompt(session, input);
    return { sessionId: session.sessionId };
  }

  async retry(sessionId?: string) {
    const session = await this.require(sessionId);
    await this.deps.retry(session);
    return { sessionId: session.sessionId };
  }

  async abort(sessionId?: string) {
    const session = await this.require(sessionId);
    void session.abort().catch((error) => this.deps.reportError(session, error));
    return { sessionId: session.sessionId };
  }

  async abortCompaction(sessionId?: string) {
    const session = await this.require(sessionId);
    if (!session.abortCompaction) throw new SessionServiceError("Compaction cancellation is not available");
    session.abortCompaction();
    return { sessionId: session.sessionId };
  }

  async abortBranchSummary(sessionId?: string) {
    const session = await this.require(sessionId);
    session.abortBranchSummary?.();
    return { sessionId: session.sessionId };
  }

  async rename(sessionId: string | undefined, name: string) {
    const session = await this.require(sessionId);
    if (!session.setSessionName) throw new SessionServiceError("Renaming sessions is not available");
    session.setSessionName(name);
    return this.deps.decorateState(session);
  }

  async navigate(sessionId: string | undefined, targetId: string, options: Record<string, unknown>) {
    return this.deps.navigate(await this.require(sessionId), targetId, options);
  }

  async invokeHeaderAction(sessionId: string | undefined, key: unknown) {
    return this.deps.invokeHeaderAction(await this.require(sessionId), key);
  }

  async invokeArtifactAction(sessionId: string | undefined, input: Record<string, unknown>) {
    return this.deps.invokeArtifactAction(await this.require(sessionId), input);
  }

  async invokeGitTab(sessionId: string | undefined, input: Record<string, unknown>) {
    return this.deps.invokeGitTab(await this.require(sessionId), input);
  }

  list(extraCwds: string[] = []) { return this.deps.list(extraCwds); }

  async create(sessionId?: string, cwd?: string) {
    const previous = await this.deps.resolve(sessionId || this.deps.currentSessionId());
    const created = await this.deps.create(cwd || (previous ? this.deps.cwd(previous) : this.deps.globalCwd()), previous?.sessionFile);
    return this.deps.decorateState(created);
  }

  async open(sessionId: string, cwd?: string) {
    try { return this.deps.decorateState(await this.deps.open(sessionId, cwd)); }
    catch (error) { throw new SessionServiceError(error instanceof Error ? error.message : String(error), 404); }
  }

  delete(sessionId: string, cwd?: string) { return this.deps.delete(sessionId, cwd); }
  async switchCwd(sessionId: string | undefined, cwd: string) { return this.deps.switchCwd(await this.require(sessionId), cwd); }
}
