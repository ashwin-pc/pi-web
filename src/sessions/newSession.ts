import type { AppState, SessionViewState } from "../app/types.js";

/** One creation/switch at a time: coalesce a folder, queue a different folder. */
export function queueNewSession(getCurrentCwd: () => string, start: (cwd?: string) => Promise<void>) {
  let pending: Promise<void> | undefined;
  let pendingCwd: string | undefined;
  function run(cwd?: string): Promise<void> {
    const targetCwd = cwd || getCurrentCwd();
    if (pending) {
      if (pendingCwd === targetCwd) return pending;
      return pending.then(() => run(targetCwd), () => run(targetCwd));
    }
    pendingCwd = targetCwd;
    pending = start(cwd).finally(() => { pending = undefined; pendingCwd = undefined; });
    return pending;
  }
  return run;
}

/** Eligible blank-tab candidates; cold candidates still need an authoritative snapshot. */
export function emptySessionCandidates(
  state: Pick<AppState, "currentSessionId" | "sessionsById" | "lanes" | "sessionOrigins">,
  cwd: string,
  hasDraft: (sessionId: string) => boolean,
): SessionViewState[] {
  const candidates = Array.from(new Set([
    state.currentSessionId,
    ...state.lanes.filter((entry) => entry.lane === "pinned").map((entry) => entry.sessionId),
  ]), (id) => state.sessionsById[id]);
  return candidates.filter((session): session is SessionViewState => {
    if (!session || session.cwd !== cwd || session.name || session.firstMessage?.trim()) return false;
    if (state.sessionOrigins.some((origin) => origin.sessionId === session.id)) return false;
    const lane = state.lanes.find((entry) => entry.sessionId === session.id)?.lane;
    if (lane && lane !== "pinned") return false;
    const runtime = session.runtime;
    if (runtime?.isRunning || runtime?.isStreaming || runtime?.isRetrying || runtime?.isCompacting || runtime?.pendingMessageCount) return false;
    if (session.queue?.steering.length || session.queue?.followUp.length) return false;
    // conversationMessages is refreshed with every stats event. totalMessages
    // includes SDK branch metadata, so a legacy total only proves emptiness at
    // zero when no authoritative conversational count is available.
    const conversational = session.stats?.conversationMessages;
    // A fresh list count can arrive before the next stats event. Treat either
    // positive authoritative count as content rather than risking reuse.
    if ((conversational !== undefined && conversational !== 0)
      || (session.messageCount !== undefined && session.messageCount !== 0)) return false;
    if (conversational === undefined && session.messageCount === undefined
      && (session.stats?.totalMessages ?? 0) > 0) return false;
    return !hasDraft(session.id);
  });
}

/** Never infer emptiness merely from a missing first-message preview. */
export function reusableEmptySession(...args: Parameters<typeof emptySessionCandidates>): SessionViewState | undefined {
  return emptySessionCandidates(...args).find((session) => {
    const conversational = session.stats?.conversationMessages;
    if ((conversational !== undefined && conversational !== 0)
      || (session.messageCount !== undefined && session.messageCount !== 0)) return false;
    return conversational === 0 || session.messageCount === 0
      || (conversational === undefined && session.messageCount === undefined && session.stats?.totalMessages === 0);
  });
}
