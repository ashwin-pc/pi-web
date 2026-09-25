import type { SessionHandle } from "./adapter.js";
import { SessionServiceError } from "./errors.js";
import { SessionActivity } from "./activity.js";
import type { BaseSessionStateDto, MessageDto, SessionServiceEvent } from "./dto.js";

export type HostSessionStateDecoration = {
  runtimeStartedAt?: string;
  runtimeLastActivityAt?: string;
  runtime: ReturnType<SessionActivity["runtimeForPath"]>;
  webContributions: unknown[];
};
export type DecoratedSessionState = BaseSessionStateDto & HostSessionStateDecoration;
export type WireSessionState = Omit<DecoratedSessionState, "thinkingLevels"> & { thinkingLevels?: string[] };

type HostEventDependencies = {
  sessionForId(sessionId: string): SessionHandle | undefined;
  projectState(session: SessionHandle): BaseSessionStateDto;
  webUiEntries(session: SessionHandle): Pick<HostSessionStateDecoration, "webContributions">;
  sessionActivity: SessionActivity;
  broadcast(value: unknown): void;
  markSessionUnreadCompleted(sessionId: string): void;
  notifySessionCompleted?(sessionId: string): void;
};

export function decorateHostSessionState(
  baseState: BaseSessionStateDto,
  targetSession: SessionHandle,
  sessionActivity: SessionActivity,
  webUiEntries: HostEventDependencies["webUiEntries"],
  includeThinkingLevels = false,
): WireSessionState {
  const { thinkingLevels, ...base } = baseState;
  const isRunning = base.phase ? ["starting", "running", "settling"].includes(base.phase) : Boolean(base.isStreaming || base.isRetrying || base.isCompacting);
  const timing = targetSession.state() as BaseSessionStateDto & { runtimeStartedAt?: string; runtimeLastActivityAt?: string };
  return {
    ...base,
    runtimeStartedAt: typeof timing.runtimeStartedAt === "string"
      ? timing.runtimeStartedAt
      : sessionActivity.startedAtForPath(targetSession.sessionId, isRunning),
    runtimeLastActivityAt: typeof timing.runtimeLastActivityAt === "string"
      ? timing.runtimeLastActivityAt
      : sessionActivity.lastActivityAtForPath(targetSession.sessionId, isRunning),
    runtime: sessionActivity.runtimeForPath(targetSession.sessionId),
    ...webUiEntries(targetSession),
    ...(includeThinkingLevels ? { thinkingLevels } : {}),
  };
}

export function decorateHostMessages(messages: MessageDto[], sessionFile: string | undefined, sessionActivity: SessionActivity): MessageDto[] {
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
  const decorate = (state: BaseSessionStateDto, target: SessionHandle, includeThinkingLevels = false) =>
    decorateHostSessionState(state, target, deps.sessionActivity, deps.webUiEntries, includeThinkingLevels);

  return (serviceEvent: SessionServiceEvent): void => {
    switch (serviceEvent.type) {
      case "agent": {
        const target = deps.sessionForId(serviceEvent.sessionId);
        const enriched = target
          ? deps.sessionActivity.enrichEvent(target.state(), serviceEvent.event)
          : { event: serviceEvent.event, sessionId: serviceEvent.sessionId, sessionFile: serviceEvent.sessionFile };
        deps.broadcast({
          type: "agent_event",
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
          runtime: deps.sessionActivity.runtimeForEvent(enriched.sessionId, serviceEvent.event),
        });
        return;
      }
      case "message_start":
      case "message_part":
      case "message_delta":
      case "message_replace":
      case "interaction_resolved":
        deps.broadcast(serviceEvent);
        return;
      case "interaction":
        deps.broadcast({ type: "interaction_request", ...serviceEvent.request });
        return;
      case "settlement_dependencies":
        // Consumed by the host's settlement tracker; this internal bridge event
        // is not itself part of the browser wire protocol.
        return;
      case "entry":
        deps.broadcast({
          type: "committed_message",
          sessionId: serviceEvent.sessionId,
          sessionFile: serviceEvent.sessionFile,
          entryId: serviceEvent.entryId,
          ...(serviceEvent.parentId ? { parentId: serviceEvent.parentId } : {}),
          kind: serviceEvent.entryKind,
        });
        return;
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
        if (target) {
          const state = serviceEvent.state;
          const active = state.phase && ["starting", "running", "settling"].includes(state.phase);
          if (target.harnessId !== "pi") {
            if (active) deps.sessionActivity.ensureStarted(state);
            else if (deps.sessionActivity.hasStarted(state.sessionId)) {
              deps.sessionActivity.clearStarted(state);
              // Native idle also follows interruption. Completion notifications
              // remain Pi-only until a native successful-outcome signal is exposed.
            }
          }
          deps.broadcast({ type: "state_changed", ...decorate(state, target, Boolean(serviceEvent.includeThinkingLevels)) });
          if (target.harnessId !== "pi") deps.broadcast({ type: "session_runtime_changed", sessionId: state.sessionId, runtime: deps.sessionActivity.runtimeForPath(state.sessionId) });
        }
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
        const activitySessionFile = serviceEvent.sessionId;
        const state = target.state();
        if (serviceEvent.action === "ensure") {
          deps.sessionActivity.ensureStarted(state);
          return;
        }
        if (serviceEvent.action === "clear") {
          deps.sessionActivity.clearStarted(state, activitySessionFile);
          return;
        }
        if (serviceEvent.action === "completed") {
          const isRunning = Boolean(state.isStreaming || state.isCompacting);
          if (deps.sessionActivity.hasStarted(activitySessionFile) && !isRunning) {
            deps.sessionActivity.clearStarted(state, activitySessionFile);
            if (!serviceEvent.aborted) {
              deps.markSessionUnreadCompleted(serviceEvent.sessionId);
              deps.notifySessionCompleted?.(serviceEvent.sessionId);
            }
          }
        }
        deps.broadcast({ type: "session_runtime_changed", sessionId: serviceEvent.sessionId, sessionFile: serviceEvent.sessionFile, runtime: deps.sessionActivity.runtimeForPath(serviceEvent.sessionId) });
        return;
      }
      case "shutdown":
        deps.sessionActivity.clearSession(serviceEvent.sessionKey, { sessionFile: serviceEvent.sessionFile });
        deps.broadcast({ type: "session_runtime_changed", sessionId: serviceEvent.sessionId, sessionFile: serviceEvent.sessionFile, runtime: deps.sessionActivity.runtimeForPath(serviceEvent.sessionId) });
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

/** An explicit unknown/failed session must never become a hello for another harness. */
export async function resolveWebSocketHelloSession(
  requestedSessionId: string,
  currentSession: SessionHandle,
  findSession: (sessionId: string) => Promise<SessionHandle | undefined>,
): Promise<SessionHandle> {
  const handle = requestedSessionId === currentSession.sessionId ? currentSession : await findSession(requestedSessionId);
  if (!handle) throw new SessionServiceError("Session not found", 404);
  return handle;
}
