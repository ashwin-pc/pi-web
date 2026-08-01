import { describe, expect, it } from "vitest";
import {
  activeSessionStats,
  patchSessionRuntime,
  reduceSessionSnapshot,
  replaceSessionRuntime,
  selectSession,
  sessionRuntime,
  setSessionStats,
} from "../src/app/sessionState.js";
import type { AppState } from "../src/app/types.js";

function stateWithActive(sessionId = "session-a") {
  return { currentSessionId: sessionId, sessionsById: {} } as AppState;
}

function snapshot(sessionId: string, isCompacting: boolean, percent: number) {
  return {
    sessionId,
    sessionTitle: sessionId,
    cwd: `/tmp/${sessionId}`,
    model: { provider: "mock", id: "model", name: "Mock Model" },
    thinkingLevel: "off",
    stats: { contextUsage: { tokens: percent, contextWindow: 100, percent } },
    queue: { steering: [], followUp: [] },
    isStreaming: false,
    isRetrying: false,
    isCompacting,
    runtime: {
      loaded: true,
      isRunning: isCompacting,
      isStreaming: false,
      isRetrying: false,
      isCompacting,
      pendingMessageCount: 0,
    },
  };
}

describe("session state store", () => {
  it("keeps complete stats and runtime projections keyed by session", () => {
    const state = stateWithActive();
    reduceSessionSnapshot(state, snapshot("session-a", true, 82));
    reduceSessionSnapshot(state, snapshot("session-b", false, 24));

    expect(state.sessionsById["session-a"].snapshotLoaded).toBe(true);
    expect(state.sessionsById["session-a"].runtime?.isCompacting).toBe(true);
    expect(state.sessionsById["session-b"].runtime?.isCompacting).toBe(false);

    selectSession(state, "session-b");
    expect(sessionRuntime(state).isCompacting).toBe(false);
    expect(activeSessionStats(state)?.contextUsage?.percent).toBe(24);

    selectSession(state, "session-a");
    expect(sessionRuntime(state).isCompacting).toBe(true);
    expect(activeSessionStats(state)?.contextUsage?.percent).toBe(82);
  });

  it("clears optional metadata omitted by a later complete snapshot", () => {
    const state = stateWithActive();
    reduceSessionSnapshot(state, { ...snapshot("session-a", false, 20), sessionName: "Named session" });
    const { model: _model, ...withoutModel } = snapshot("session-a", false, 20);

    reduceSessionSnapshot(state, { ...withoutModel, sessionTitle: "Fallback title" });

    expect(state.sessionsById["session-a"].name).toBeUndefined();
    expect(state.sessionsById["session-a"].title).toBe("Fallback title");
    expect(state.sessionsById["session-a"].model).toBeUndefined();
  });

  it("treats legacy snapshots without queue data as complete", () => {
    const state = stateWithActive();
    const { queue: _queue, ...legacySnapshot } = snapshot("session-a", false, 20);

    reduceSessionSnapshot(state, {
      ...legacySnapshot,
      webFooters: [{ key: "footer", footer: { kind: "text", lines: ["ready"] } }],
    });

    expect(state.sessionsById["session-a"].snapshotLoaded).toBe(true);
    expect(state.sessionsById["session-a"].queue).toEqual({ steering: [], followUp: [] });
    expect(state.sessionsById["session-a"].webFooters).toHaveLength(1);
  });

  it("updates a background runtime without changing the active projection", () => {
    const state = stateWithActive();
    reduceSessionSnapshot(state, snapshot("session-a", false, 20));
    reduceSessionSnapshot(state, snapshot("session-b", false, 30));

    const transition = patchSessionRuntime(state, "session-b", {
      isStreaming: true,
      startedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(transition.isActive).toBe(false);
    expect(sessionRuntime(state, "session-b").isRunning).toBe(true);
    expect(sessionRuntime(state).isRunning).toBe(false);
  });

  it("updates stats without disturbing the session runtime", () => {
    const state = stateWithActive();
    reduceSessionSnapshot(state, snapshot("session-a", true, 82));

    setSessionStats(state, "session-a", { contextUsage: { tokens: 10, contextWindow: 100, percent: 10 } });

    expect(activeSessionStats(state)?.contextUsage?.percent).toBe(10);
    expect(sessionRuntime(state).isCompacting).toBe(true);
  });

  it("replaces completed runtime state instead of retaining stale flags or timestamps", () => {
    const state = stateWithActive();
    reduceSessionSnapshot(state, snapshot("session-a", true, 82));
    patchSessionRuntime(state, "session-a", { startedAt: "2026-01-01T00:00:00.000Z" });

    replaceSessionRuntime(state, "session-a", {
      loaded: true,
      isRunning: false,
      isStreaming: false,
      isRetrying: false,
      isCompacting: false,
      pendingMessageCount: 0,
    });

    expect(sessionRuntime(state)).toMatchObject({
      isRunning: false,
      isStreaming: false,
      isRetrying: false,
      isCompacting: false,
    });
    expect(sessionRuntime(state).startedAt).toBeUndefined();
  });
});
