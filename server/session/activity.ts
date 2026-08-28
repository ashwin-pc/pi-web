import type { HarnessEventDto } from "./piEventMap.js";
import type { ModelDto } from "./dto.js";

/** Host-facing snapshot of a live session. It deliberately contains no harness object. */
export interface SessionActivityView {
  sessionId: string;
  sessionFile: string;
  isStreaming: boolean;
  isRetrying: boolean;
  isCompacting: boolean;
  pendingMessageCount: number;
  model?: ModelDto;
  runtimeStartedAt?: string;
  runtimeLastActivityAt?: string;
}

export interface EnrichedSessionEvent {
  event: HarnessEventDto;
  sessionId: string;
  sessionFile: string;
}

export class SessionActivity {
  private readonly runtimeStartedAts = new Map<string, string>();
  private readonly runtimeLastActivityAts = new Map<string, string>();
  private readonly toolStartedAts = new Map<string, Map<string, string>>();

  constructor(
    private readonly liveSessionForPath: (path: string) => SessionActivityView | undefined,
    private readonly hasActiveWorkForPath: (path: string) => boolean = () => false,
    private readonly hasActiveRetryForPath: (path: string) => boolean = () => false,
  ) {}

  sessionPathKey(value: Pick<SessionActivityView, "sessionFile" | "sessionId">): string {
    return String(value.sessionFile || value.sessionId || "");
  }

  toolRuntimeKey(toolCallId: unknown, toolName: unknown): string {
    const id = typeof toolCallId === "string" ? toolCallId.trim() : "";
    if (id) return id;
    return typeof toolName === "string" && toolName.trim() ? toolName.trim() : "";
  }

  toolStartedAtFor(sessionFile: string | undefined, toolCallId: unknown, toolName: unknown): string | undefined {
    const key = this.toolRuntimeKey(toolCallId, toolName);
    return sessionFile && key ? this.toolStartedAts.get(sessionFile)?.get(key) : undefined;
  }

  decorateMessageContent(content: unknown, sessionFile?: string): unknown {
    if (!sessionFile || !Array.isArray(content)) return content;
    return content.map((part) => {
      if (!part || typeof part !== "object") return part;
      const value = part as Record<string, unknown>;
      if (value.type !== "toolCall") return part;
      const startedAt = this.toolStartedAtFor(sessionFile, value.id, value.toolName || value.name);
      return startedAt && !value.startedAt ? { ...value, startedAt } : part;
    });
  }

  hasStarted(path: string): boolean { return this.runtimeStartedAts.has(path); }

  startedAtForPath(path: string, isRunning: boolean): string | undefined {
    if (!isRunning) return undefined;
    const live = this.liveSessionForPath(path)?.runtimeStartedAt;
    return typeof live === "string" && live.trim() ? live : this.runtimeStartedAts.get(path);
  }

  lastActivityAtForPath(path: string, isRunning: boolean): string | undefined {
    if (!isRunning) return undefined;
    const live = this.liveSessionForPath(path)?.runtimeLastActivityAt;
    return typeof live === "string" && live.trim()
      ? live
      : this.runtimeLastActivityAts.get(path) || this.startedAtForPath(path, isRunning);
  }

  ensureStarted(target: Pick<SessionActivityView, "sessionFile" | "sessionId" | "runtimeStartedAt" | "runtimeLastActivityAt">, startedAt = new Date().toISOString()): string {
    const key = this.sessionPathKey(target);
    const value = target.runtimeStartedAt || (key ? this.runtimeStartedAts.get(key) : undefined) || startedAt;
    if (key) {
      this.runtimeStartedAts.set(key, value);
      if (!this.runtimeLastActivityAts.has(key)) this.runtimeLastActivityAts.set(key, target.runtimeLastActivityAt || value);
    }
    return value;
  }

  mark(_target: Pick<SessionActivityView, "sessionFile" | "sessionId">, activityAt = new Date().toISOString(), sessionFile = this.sessionPathKey(_target)): string {
    if (sessionFile) this.runtimeLastActivityAts.set(sessionFile, activityAt);
    return activityAt;
  }

  clearStarted(_target: Pick<SessionActivityView, "sessionFile" | "sessionId">, sessionFile = this.sessionPathKey(_target)): void {
    if (sessionFile) {
      this.runtimeStartedAts.delete(sessionFile);
      this.runtimeLastActivityAts.delete(sessionFile);
    }
  }

  clearSession(key: string, value: { sessionFile?: string }): void {
    this.runtimeStartedAts.delete(key);
    this.runtimeLastActivityAts.delete(key);
    this.toolStartedAts.delete(key);
    const file = typeof value.sessionFile === "string" ? value.sessionFile : "";
    if (file && file !== key) {
      this.runtimeStartedAts.delete(file);
      this.runtimeLastActivityAts.delete(file);
      this.toolStartedAts.delete(file);
    }
  }

  runtimeForPath(path: string, overrides: { isRetrying?: boolean } = {}) {
    const live = this.liveSessionForPath(path);
    const isStreaming = Boolean(live?.isStreaming);
    const isRetrying = overrides.isRetrying ?? Boolean(live?.isRetrying);
    const isCompacting = Boolean(live?.isCompacting);
    const isRunning = isStreaming || isRetrying || isCompacting || this.hasActiveWorkForPath(path);
    return {
      loaded: Boolean(live), isRunning, isStreaming, isRetrying, isCompacting,
      startedAt: this.startedAtForPath(path, isRunning),
      lastActivityAt: this.lastActivityAtForPath(path, isRunning),
      pendingMessageCount: Number(live?.pendingMessageCount || 0),
      model: live?.model,
    };
  }

  stoppedRuntimeForPath(path: string) {
    const live = this.liveSessionForPath(path);
    return {
      loaded: Boolean(live), isRunning: false, isStreaming: false, isRetrying: false, isCompacting: false,
      startedAt: undefined, lastActivityAt: undefined,
      pendingMessageCount: Number(live?.pendingMessageCount || 0), model: live?.model,
    };
  }

  runtimeForEvent(path: string, event: HarnessEventDto) {
    if ((event.type === "agent_end" || event.type === "compaction_end") && event.willRetry) return this.runtimeForPath(path, { isRetrying: true });
    if (event.type === "agent_settled") return this.hasActiveRetryForPath(path) ? this.runtimeForPath(path) : this.stoppedRuntimeForPath(path);
    return this.runtimeForPath(path);
  }

  isActivityEvent(event: HarnessEventDto): boolean {
    return ["agent_start", "compaction_start", "message_update", "message_end", "turn_end", "tool_execution_start", "tool_execution_update", "tool_execution_end", "auto_retry_start", "auto_retry_end"].includes(event.type);
  }

  activityTimestamp(event: HarnessEventDto, fallback = new Date().toISOString()): string {
    const value = event as Record<string, unknown>;
    for (const candidate of [value.lastActivityAt, value.timestamp, value.startedAt]) if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    return fallback;
  }

  noteEvent(sessionFile: string, event: HarnessEventDto): void {
    if (!sessionFile) return;
    if (event.type === "agent_start" || event.type === "compaction_start") {
      const raw = event as Record<string, unknown>;
      const startedAt = typeof raw.startedAt === "string" && raw.startedAt.trim() ? raw.startedAt.trim() : new Date().toISOString();
      this.runtimeStartedAts.set(sessionFile, startedAt);
      this.runtimeLastActivityAts.set(sessionFile, this.activityTimestamp(event, startedAt));
    } else if (event.type === "agent_settled" || event.type === "compaction_end") {
      if (event.type === "agent_settled" || !event.willRetry) { this.runtimeStartedAts.delete(sessionFile); this.runtimeLastActivityAts.delete(sessionFile); }
    } else if (this.isActivityEvent(event)) this.runtimeLastActivityAts.set(sessionFile, this.activityTimestamp(event));
  }

  enrichEvent(target: SessionActivityView, event: HarnessEventDto): EnrichedSessionEvent {
    const sessionFile = target.sessionFile;
    const raw = event as Record<string, unknown>;
    let eventForClient: HarnessEventDto = event;
    if (event.type === "agent_start" || event.type === "compaction_start") {
      eventForClient = { ...event, startedAt: this.ensureStarted(target, typeof raw.startedAt === "string" ? raw.startedAt : undefined) } as HarnessEventDto;
    } else if (event.type === "agent_settled" || event.type === "compaction_end" && !event.willRetry) this.clearStarted(target, sessionFile);

    if (event.type === "tool_execution_start") {
      const toolKey = this.toolRuntimeKey(raw.toolCallId, raw.toolName);
      const startedAt = typeof raw.startedAt === "string" ? raw.startedAt : new Date().toISOString();
      if (toolKey) {
        let starts = this.toolStartedAts.get(sessionFile);
        if (!starts) this.toolStartedAts.set(sessionFile, starts = new Map());
        starts.set(toolKey, startedAt);
      }
      eventForClient = { ...eventForClient, startedAt } as HarnessEventDto;
    } else if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
      const toolKey = this.toolRuntimeKey(raw.toolCallId, raw.toolName);
      const startedAt = toolKey ? this.toolStartedAts.get(sessionFile)?.get(toolKey) : undefined;
      if (startedAt) eventForClient = { ...eventForClient, startedAt } as HarnessEventDto;
      if (event.type === "tool_execution_end" && toolKey) this.toolStartedAts.get(sessionFile)?.delete(toolKey);
    }
    if (this.isActivityEvent(event)) eventForClient = { ...eventForClient, lastActivityAt: this.mark(target, this.activityTimestamp(eventForClient), sessionFile) } as HarnessEventDto;
    return { event: eventForClient, sessionId: target.sessionId, sessionFile };
  }
}
