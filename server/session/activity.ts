export type SessionEvent = Record<string, unknown>;

export interface RuntimeSessionTarget {
  sessionId?: string;
  sessionFile?: string;
  runtimeStartedAt?: string;
  runtimeLastActivityAt?: string;
}

function asRecord(value: unknown): SessionEvent | undefined {
  return value && typeof value === "object" ? value as SessionEvent : undefined;
}

export function toolRuntimeKey(toolCallId: unknown, toolName: unknown): string {
  const id = typeof toolCallId === "string" ? toolCallId.trim() : "";
  if (id) return id;
  return typeof toolName === "string" && toolName.trim() ? toolName.trim() : "";
}

export function contentWithToolStartedAts(
  content: unknown,
  startedAtFor: (toolCallId: unknown, toolName: unknown) => string | undefined,
): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    const value = asRecord(part);
    if (value?.type !== "toolCall") return part;
    const startedAt = startedAtFor(value.id, value.toolName || value.name);
    return startedAt && !value.startedAt ? { ...value, startedAt } : part;
  });
}

export function isRuntimeActivityEvent(event: unknown): boolean {
  switch (asRecord(event)?.type) {
    case "agent_start":
    case "compaction_start":
    case "message_update":
    case "message_end":
    case "turn_end":
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
    case "auto_retry_start":
    case "auto_retry_end":
      return true;
    default:
      return false;
  }
}

export function runtimeActivityTimestamp(event: unknown, fallback = new Date().toISOString()): string {
  const value = asRecord(event);
  for (const candidate of [value?.lastActivityAt, value?.timestamp, value?.startedAt]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return fallback;
}

export class SessionActivityTracker {
  private readonly runtimeStartedAts = new Map<string, string>();
  private readonly runtimeLastActivityAts = new Map<string, string>();
  private readonly toolStartedAts = new Map<string, Map<string, string>>();

  toolStartedAtFor(sessionFile: string | undefined, toolCallId: unknown, toolName: unknown): string | undefined {
    const key = toolRuntimeKey(toolCallId, toolName);
    return sessionFile && key ? this.toolStartedAts.get(sessionFile)?.get(key) : undefined;
  }

  decorateMessageContent(content: unknown, sessionFile?: string): unknown {
    if (!sessionFile) return content;
    return contentWithToolStartedAts(content, (toolCallId, toolName) => this.toolStartedAtFor(sessionFile, toolCallId, toolName));
  }

  runtimeStartedAtForPath(path: string, isRunning: boolean, liveSession?: RuntimeSessionTarget): string | undefined {
    if (!isRunning) return undefined;
    return typeof liveSession?.runtimeStartedAt === "string" && liveSession.runtimeStartedAt.trim()
      ? liveSession.runtimeStartedAt
      : this.runtimeStartedAts.get(path);
  }

  runtimeLastActivityAtForPath(path: string, isRunning: boolean, liveSession?: RuntimeSessionTarget): string | undefined {
    if (!isRunning) return undefined;
    return typeof liveSession?.runtimeLastActivityAt === "string" && liveSession.runtimeLastActivityAt.trim()
      ? liveSession.runtimeLastActivityAt
      : this.runtimeLastActivityAts.get(path) || this.runtimeStartedAtForPath(path, isRunning, liveSession);
  }

  ensureRuntimeStartedAt(target: RuntimeSessionTarget, sessionKey: string, startedAt = new Date().toISOString()): string {
    const existing = sessionKey ? this.runtimeStartedAts.get(sessionKey) : undefined;
    const value = typeof target.runtimeStartedAt === "string" ? target.runtimeStartedAt : existing || startedAt;
    if (sessionKey) {
      this.runtimeStartedAts.set(sessionKey, value);
      if (!this.runtimeLastActivityAts.has(sessionKey)) this.runtimeLastActivityAts.set(sessionKey, value);
    }
    target.runtimeStartedAt = value;
    if (typeof target.runtimeLastActivityAt !== "string") target.runtimeLastActivityAt = value;
    return value;
  }

  markRuntimeActivity(target: RuntimeSessionTarget, sessionKey: string, activityAt = new Date().toISOString()): string {
    if (sessionKey) this.runtimeLastActivityAts.set(sessionKey, activityAt);
    target.runtimeLastActivityAt = activityAt;
    return activityAt;
  }

  clearRuntimeStartedAt(target: RuntimeSessionTarget, sessionKey: string) {
    if (sessionKey) {
      this.runtimeStartedAts.delete(sessionKey);
      this.runtimeLastActivityAts.delete(sessionKey);
    }
    delete target.runtimeStartedAt;
    delete target.runtimeLastActivityAt;
  }

  clearSessionPaths(key: string, sessionFile?: string) {
    for (const path of new Set([key, sessionFile].filter((path): path is string => Boolean(path)))) {
      this.runtimeStartedAts.delete(path);
      this.runtimeLastActivityAts.delete(path);
      this.toolStartedAts.delete(path);
    }
  }

  hasRuntimeStartedAt(sessionFile: string): boolean {
    return this.runtimeStartedAts.has(sessionFile);
  }

  /** Adds host-derived timestamps without reading session state. */
  decorateSessionEvent(target: RuntimeSessionTarget, sessionKey: string, event: unknown): unknown {
    const source = asRecord(event);
    if (!source) return event;
    const sessionFile = target.sessionFile || sessionKey;
    let decorated: SessionEvent = source;

    if (source.type === "agent_start" || source.type === "compaction_start") {
      const startedAt = this.ensureRuntimeStartedAt(target, sessionKey, typeof source.startedAt === "string" ? source.startedAt : undefined);
      decorated = { ...source, startedAt };
    } else if ((source.type === "agent_end" || source.type === "compaction_end") && !source.willRetry) {
      this.clearRuntimeStartedAt(target, sessionFile);
    }

    if (source.type === "tool_execution_start") {
      const toolKey = toolRuntimeKey(source.toolCallId, source.toolName);
      const startedAt = typeof source.startedAt === "string" ? source.startedAt : new Date().toISOString();
      if (toolKey) {
        let sessionToolStarts = this.toolStartedAts.get(sessionFile);
        if (!sessionToolStarts) {
          sessionToolStarts = new Map();
          this.toolStartedAts.set(sessionFile, sessionToolStarts);
        }
        sessionToolStarts.set(toolKey, startedAt);
      }
      decorated = { ...source, startedAt };
    } else if (source.type === "tool_execution_update" || source.type === "tool_execution_end") {
      const toolKey = toolRuntimeKey(source.toolCallId, source.toolName);
      const startedAt = toolKey ? this.toolStartedAts.get(sessionFile)?.get(toolKey) : undefined;
      if (startedAt) decorated = { ...source, startedAt };
      if (source.type === "tool_execution_end" && toolKey) this.toolStartedAts.get(sessionFile)?.delete(toolKey);
    }

    if (isRuntimeActivityEvent(source)) {
      const lastActivityAt = this.markRuntimeActivity(target, sessionFile, runtimeActivityTimestamp(decorated));
      decorated = { ...decorated, lastActivityAt };
    }
    return decorated;
  }

  /** Recovers runtime state from replayed realtime events for sessions not loaded locally. */
  noteEventForUnreadRecovery(sessionFile: string, event: unknown) {
    const source = asRecord(event);
    if (!sessionFile || !source) return;
    switch (source.type) {
      case "agent_start":
      case "compaction_start": {
        const startedAt = typeof source.startedAt === "string" && source.startedAt.trim() ? source.startedAt.trim() : new Date().toISOString();
        this.runtimeStartedAts.set(sessionFile, startedAt);
        this.runtimeLastActivityAts.set(sessionFile, runtimeActivityTimestamp(source, startedAt));
        return;
      }
      case "agent_end":
      case "compaction_end":
        if (!source.willRetry) {
          this.runtimeStartedAts.delete(sessionFile);
          this.runtimeLastActivityAts.delete(sessionFile);
        }
        return;
      default:
        if (isRuntimeActivityEvent(source)) this.runtimeLastActivityAts.set(sessionFile, runtimeActivityTimestamp(source));
    }
  }
}
