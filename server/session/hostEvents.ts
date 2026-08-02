import type { PiWebSession } from "../types.js";
import { SessionActivity } from "./activity.js";
import type { BaseSessionStateDto, MessageDto, SessionServiceEvent } from "./dto.js";

export type HostSessionStateDecoration = {
  runtimeStartedAt?: string;
  runtimeLastActivityAt?: string;
  runtime: ReturnType<SessionActivity["runtimeForPath"]>;
  webFooters: unknown[];
  webHeaderActions: unknown[];
  webArtifactActions: unknown[];
  webGitTabs: unknown[];
};
export type DecoratedSessionState = BaseSessionStateDto & HostSessionStateDecoration;
export type WireSessionState = Omit<DecoratedSessionState, "thinkingLevels"> & { thinkingLevels?: string[] };

type HostEventDependencies = {
  sessionForId(sessionId: string): PiWebSession | undefined;
  projectState(session: PiWebSession): BaseSessionStateDto;
  webUiEntries(session: PiWebSession): Pick<HostSessionStateDecoration, "webFooters" | "webHeaderActions" | "webArtifactActions" | "webGitTabs">;
  sessionActivity: SessionActivity;
  broadcast(value: unknown): void;
  markSessionUnreadCompleted(sessionId: string): void;
  notifySessionCompleted?(sessionId: string): void;
};

export function decorateHostSessionState(
  baseState: BaseSessionStateDto,
  targetSession: PiWebSession,
  sessionActivity: SessionActivity,
  webUiEntries: HostEventDependencies["webUiEntries"],
  includeThinkingLevels = false,
): WireSessionState {
  const { thinkingLevels, ...base } = baseState;
  const isRunning = Boolean(base.isStreaming || base.isRetrying || base.isCompacting);
  return {
    ...base,
    runtimeStartedAt: typeof (targetSession as any).runtimeStartedAt === "string"
      ? (targetSession as any).runtimeStartedAt
      : sessionActivity.startedAtForPath(targetSession.sessionFile, isRunning),
    runtimeLastActivityAt: typeof (targetSession as any).runtimeLastActivityAt === "string"
      ? (targetSession as any).runtimeLastActivityAt
      : sessionActivity.lastActivityAtForPath(targetSession.sessionFile, isRunning),
    runtime: sessionActivity.runtimeForPath(targetSession.sessionFile),
    ...webUiEntries(targetSession),
    ...(includeThinkingLevels ? { thinkingLevels } : {}),
  };
}

export function decorateHostMessages(messages: MessageDto[], sessionFile: string, sessionActivity: SessionActivity): MessageDto[] {
  return messages.map((message) => {
    const raw = message.raw;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return message;
    const content = sessionActivity.decorateMessageContent(raw.content, sessionFile);
    if (content === raw.content) return message;
    const decoratedToolCalls = Array.isArray(content)
      ? content.filter((part: any) => part?.type === "toolCall") as Array<{ startedAt?: string }>
      : [];
    return {
      ...message,
      ...(message.role === "assistant" && message.toolCalls ? {
        toolCalls: message.toolCalls.map((call, index) => {
          const startedAt = decoratedToolCalls[index]?.startedAt;
          return startedAt && !call.startedAt ? { ...call, startedAt } : call;
        }),
      } : {}),
      raw: { ...raw, content },
    } as MessageDto;
  });
}

/** Synchronous serving-layer adapter from service events to browser wire events. */
export function createHostSessionEventHandler(deps: HostEventDependencies) {
  const decorate = (state: BaseSessionStateDto, target: PiWebSession, includeThinkingLevels = false) =>
    decorateHostSessionState(state, target, deps.sessionActivity, deps.webUiEntries, includeThinkingLevels);

  return (serviceEvent: SessionServiceEvent): void => {
    switch (serviceEvent.type) {
      case "pi": {
        const target = deps.sessionForId(serviceEvent.sessionId);
        const enriched = target
          ? deps.sessionActivity.enrichEvent(target, serviceEvent.event)
          : { event: serviceEvent.event, sessionId: serviceEvent.sessionId, sessionFile: serviceEvent.sessionFile };
        deps.broadcast({
          type: "pi_event",
          sessionId: enriched.sessionId,
          sessionFile: enriched.sessionFile,
          event: enriched.event,
          ...(serviceEvent.clientMessageId ? { clientMessageId: serviceEvent.clientMessageId } : {}),
          ...(serviceEvent.sourceClientId ? { sourceClientId: serviceEvent.sourceClientId } : {}),
        });
        deps.broadcast({
          type: "session_runtime_changed",
          sessionId: enriched.sessionId,
          sessionFile: enriched.sessionFile,
          runtime: deps.sessionActivity.runtimeForEvent(enriched.sessionFile, serviceEvent.event),
        });
        return;
      }
      case "committed":
        deps.broadcast({
          type: "committed_message",
          sessionId: serviceEvent.sessionId,
          sessionFile: serviceEvent.sessionFile,
          message: decorateHostMessages([serviceEvent.message], serviceEvent.sessionFile, deps.sessionActivity)[0],
        });
        return;
      case "state": {
        const target = deps.sessionForId(serviceEvent.state.sessionId);
        if (target) deps.broadcast({ type: "state_changed", ...decorate(serviceEvent.state, target, Boolean(serviceEvent.includeThinkingLevels)) });
        return;
      }
      case "stats":
        deps.broadcast({ type: "session_stats_changed", sessionId: serviceEvent.sessionId, sessionFile: serviceEvent.sessionFile, stats: serviceEvent.stats });
        return;
      case "models":
        deps.broadcast({ type: "models_updated", sessionId: serviceEvent.sessionId, models: serviceEvent.models });
        return;
      case "error":
        deps.broadcast({ type: "server_error", ...(serviceEvent.sessionId ? { sessionId: serviceEvent.sessionId } : {}), ...(serviceEvent.sessionFile ? { sessionFile: serviceEvent.sessionFile } : {}), error: serviceEvent.error });
        return;
      case "runtime": {
        const target = deps.sessionForId(serviceEvent.sessionId);
        if (!target) return;
        const activitySessionFile = serviceEvent.activitySessionFile || serviceEvent.sessionFile;
        if (serviceEvent.action === "ensure") {
          deps.sessionActivity.ensureStarted(target);
          return;
        }
        if (serviceEvent.action === "clear") {
          deps.sessionActivity.clearStarted(target, activitySessionFile);
          return;
        }
        if (serviceEvent.action === "completed") {
          const isRunning = Boolean(target.isStreaming || target.isCompacting);
          if (deps.sessionActivity.hasStarted(activitySessionFile) && !isRunning) {
            deps.sessionActivity.clearStarted(target, activitySessionFile);
            deps.markSessionUnreadCompleted(serviceEvent.sessionId);
            deps.notifySessionCompleted?.(serviceEvent.sessionId);
          }
        }
        deps.broadcast({ type: "session_runtime_changed", sessionId: serviceEvent.sessionId, sessionFile: serviceEvent.sessionFile, runtime: deps.sessionActivity.runtimeForPath(serviceEvent.sessionFile) });
        return;
      }
      case "shutdown":
        deps.sessionActivity.clearSession(serviceEvent.sessionKey, { sessionFile: serviceEvent.sessionFile });
        deps.broadcast({ type: "session_runtime_changed", sessionId: serviceEvent.sessionId, sessionFile: serviceEvent.sessionFile, runtime: deps.sessionActivity.runtimeForPath(serviceEvent.sessionFile) });
        return;
      case "wire": {
        const value = serviceEvent.value as any;
        if (value?.type === "state_changed" && typeof value.sessionId === "string") {
          const target = deps.sessionForId(value.sessionId);
          if (target) return deps.broadcast({ type: "state_changed", ...decorate(deps.projectState(target), target, true) });
        }
        deps.broadcast(value);
      }
    }
  };
}

/** Unknown IDs may use the legacy current-session fallback; open failures must propagate. */
export async function resolveWebSocketHelloSession(
  requestedSessionId: string,
  currentSession: PiWebSession,
  findSession: (sessionId: string) => Promise<PiWebSession | undefined>,
): Promise<PiWebSession | undefined> {
  return requestedSessionId === currentSession.sessionId ? currentSession : findSession(requestedSessionId);
}
