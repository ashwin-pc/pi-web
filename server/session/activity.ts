import type { BaseSessionStateDto, ModelDto } from "./dto.js";
type ActivitySession = Pick<BaseSessionStateDto, "sessionId" | "sessionFile" | "isStreaming"> & {
  isRetrying?: boolean; isCompacting?: boolean; phase?: BaseSessionStateDto["phase"];
  pendingMessageCount?: number; queue?: { steering: string[]; followUp: string[] }; model?: ModelDto;
  runtimeStartedAt?: string; runtimeLastActivityAt?: string;
};

export interface EnrichedSessionEvent {
  event: any;
  sessionId: string;
  sessionFile?: string;
}

export class SessionActivity {
  private readonly runtimeStartedAts = new Map<string, string>();
  private readonly runtimeLastActivityAts = new Map<string, string>();
  private readonly toolStartedAts = new Map<string, Map<string, string>>();

  constructor(
    private readonly liveSessionForPath: (path: string) => ActivitySession | undefined,
    private readonly hasActiveWorkForPath: (path: string) => boolean = () => false,
    private readonly hasActiveRetryForPath: (path: string) => boolean = () => false,
  ) {}

  private readonly aliases = new Map<string, string>();
  private key(path: string): string {
    const live = this.liveSessionForPath(path);
    if (live?.sessionId) {
      if (live.sessionFile) this.aliases.set(live.sessionFile, live.sessionId);
      return live.sessionId;
    }
    return this.aliases.get(path) || path;
  }
  sessionPathKey(value: Pick<ActivitySession, "sessionId" | "sessionFile">): string {
    if (value.sessionFile) this.aliases.set(value.sessionFile, value.sessionId);
    return value.sessionId;
  }

  toolRuntimeKey(toolCallId: unknown, toolName: unknown): string {
    const id = typeof toolCallId === "string" ? toolCallId.trim() : "";
    if (id) return id;
    return typeof toolName === "string" && toolName.trim() ? toolName.trim() : "";
  }

  toolStartedAtFor(sessionFile: string | undefined, toolCallId: unknown, toolName: unknown): string | undefined {
    const key = this.toolRuntimeKey(toolCallId, toolName);
    return sessionFile && key ? this.toolStartedAts.get(this.key(sessionFile))?.get(key) : undefined;
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

  hasStarted(path: string): boolean {
    return this.runtimeStartedAts.has(this.key(path));
  }

  startedAtForPath(path: string, isRunning: boolean): string | undefined {
    if (!isRunning) return undefined;
    const liveStartedAt = (this.liveSessionForPath(path) as any)?.runtimeStartedAt;
    return typeof liveStartedAt === "string" && liveStartedAt.trim() ? liveStartedAt : this.runtimeStartedAts.get(this.key(path));
  }

  lastActivityAtForPath(path: string, isRunning: boolean): string | undefined {
    if (!isRunning) return undefined;
    const liveLastActivityAt = (this.liveSessionForPath(path) as any)?.runtimeLastActivityAt;
    return typeof liveLastActivityAt === "string" && liveLastActivityAt.trim()
      ? liveLastActivityAt
      : this.runtimeLastActivityAts.get(this.key(path)) || this.startedAtForPath(path, isRunning);
  }

  ensureStarted(targetSession: any, startedAt = new Date().toISOString()): string {
    const key = this.sessionPathKey(targetSession);
    const existing = key ? this.runtimeStartedAts.get(key) : undefined;
    const value = typeof targetSession?.runtimeStartedAt === "string" ? targetSession.runtimeStartedAt : existing || startedAt;
    if (key) {
      this.runtimeStartedAts.set(key, value);
      if (!this.runtimeLastActivityAts.has(key)) this.runtimeLastActivityAts.set(key, value);
    }
    if (targetSession && typeof targetSession === "object") {
      targetSession.runtimeStartedAt = value;
      if (typeof targetSession.runtimeLastActivityAt !== "string") targetSession.runtimeLastActivityAt = value;
    }
    return value;
  }

  mark(targetSession: any, activityAt = new Date().toISOString(), sessionFile = this.sessionPathKey(targetSession)): string {
    if (sessionFile) this.runtimeLastActivityAts.set(this.key(sessionFile), activityAt);
    if (targetSession && typeof targetSession === "object") targetSession.runtimeLastActivityAt = activityAt;
    return activityAt;
  }

  clearStarted(targetSession: any, sessionFile = this.sessionPathKey(targetSession)): void {
    if (sessionFile) {
      this.runtimeStartedAts.delete(this.key(sessionFile));
      this.runtimeLastActivityAts.delete(this.key(sessionFile));
    }
    if (targetSession && typeof targetSession === "object") {
      delete targetSession.runtimeStartedAt;
      delete targetSession.runtimeLastActivityAt;
    }
  }

  clearSession(key: string, value: any): void {
    this.runtimeStartedAts.delete(key);
    this.runtimeLastActivityAts.delete(key);
    this.toolStartedAts.delete(key);
    const file = typeof value?.sessionFile === "string" ? value.sessionFile : "";
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
    // Work leases cover operations (notably the SDK continuation fallback) that
    // execute an agent run without updating AgentSession.isStreaming.
    const isRunning = Boolean(live?.phase && ["starting", "running", "settling"].includes(live.phase)) || isStreaming || isRetrying || isCompacting || this.hasActiveWorkForPath(path);
    return {
      loaded: Boolean(live),
      isRunning,
      isStreaming,
      isRetrying,
      isCompacting,
      startedAt: this.startedAtForPath(path, isRunning),
      lastActivityAt: this.lastActivityAtForPath(path, isRunning),
      pendingMessageCount: Number(live?.pendingMessageCount || (live?.queue ? live.queue.steering.length + live.queue.followUp.length : 0)),
      model: live?.model,
    };
  }

  stoppedRuntimeForPath(path: string) {
    const live = this.liveSessionForPath(path);
    return {
      loaded: Boolean(live),
      isRunning: false,
      isStreaming: false,
      isRetrying: false,
      isCompacting: false,
      startedAt: undefined,
      lastActivityAt: undefined,
      pendingMessageCount: Number(live?.pendingMessageCount || (live?.queue ? live.queue.steering.length + live.queue.followUp.length : 0)),
      model: live?.model,
    };
  }

  runtimeForEvent(path: string, event: any) {
    if ((event?.type === "agent_end" || event?.type === "compaction_end") && event?.willRetry) {
      return this.runtimeForPath(path, { isRetrying: true });
    }
    if (event?.type === "agent_settled") {
      // pi emits this only after the run and all post-run continuations finish.
      return this.hasActiveRetryForPath(path) ? this.runtimeForPath(path) : this.stoppedRuntimeForPath(path);
    }
    return this.runtimeForPath(path);
  }

  isActivityEvent(event: any): boolean {
    return ["agent_start", "compaction_start", "message_update", "message_end", "turn_end", "tool_execution_start", "tool_execution_update", "tool_execution_end", "auto_retry_start", "auto_retry_end"].includes(event?.type);
  }

  activityTimestamp(event: any, fallback = new Date().toISOString()): string {
    for (const value of [event?.lastActivityAt, event?.timestamp, event?.startedAt]) {
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return fallback;
  }

  noteEvent(sessionFile: string, event: any): void {
    if (!sessionFile) return;
    sessionFile = this.key(sessionFile);
    switch (event?.type) {
      case "agent_start":
      case "compaction_start": {
        const startedAt = typeof event.startedAt === "string" && event.startedAt.trim() ? event.startedAt.trim() : new Date().toISOString();
        this.runtimeStartedAts.set(sessionFile, startedAt);
        this.runtimeLastActivityAts.set(sessionFile, this.activityTimestamp(event, startedAt));
        return;
      }
      case "agent_settled":
      case "compaction_end":
        if (!event.willRetry) {
          this.runtimeStartedAts.delete(this.key(sessionFile));
          this.runtimeLastActivityAts.delete(this.key(sessionFile));
        }
        return;
      default:
        if (this.isActivityEvent(event)) this.runtimeLastActivityAts.set(sessionFile, this.activityTimestamp(event));
    }
  }

  enrichEvent(targetSession: ActivitySession, event: unknown): EnrichedSessionEvent {
    const e = event as any;
    const sessionFile = this.sessionPathKey(targetSession);
    let eventForClient = e;
    if (e?.type === "agent_start" || e?.type === "compaction_start") {
      eventForClient = { ...e, startedAt: this.ensureStarted(targetSession, typeof e.startedAt === "string" ? e.startedAt : undefined) };
    } else if ((e?.type === "agent_settled" || e?.type === "compaction_end") && !e.willRetry) {
      this.clearStarted(targetSession, sessionFile);
    }

    if (e?.type === "tool_execution_start") {
      const toolKey = this.toolRuntimeKey(e.toolCallId, e.toolName);
      const startedAt = typeof e.startedAt === "string" ? e.startedAt : new Date().toISOString();
      if (toolKey) {
        let starts = this.toolStartedAts.get(this.key(sessionFile));
        if (!starts) this.toolStartedAts.set(sessionFile, starts = new Map());
        starts.set(toolKey, startedAt);
      }
      eventForClient = { ...eventForClient, startedAt };
    } else if (e?.type === "tool_execution_update" || e?.type === "tool_execution_end") {
      const toolKey = this.toolRuntimeKey(e.toolCallId, e.toolName);
      const startedAt = toolKey ? this.toolStartedAts.get(this.key(sessionFile))?.get(toolKey) : undefined;
      if (startedAt) eventForClient = { ...eventForClient, startedAt };
      if (e?.type === "tool_execution_end" && toolKey) this.toolStartedAts.get(this.key(sessionFile))?.delete(toolKey);
    }

    if (this.isActivityEvent(e)) {
      eventForClient = { ...eventForClient, lastActivityAt: this.mark(targetSession, this.activityTimestamp(eventForClient), sessionFile) };
    }
    return { event: eventForClient, sessionId: targetSession.sessionId, sessionFile: targetSession.sessionFile };
  }
}
