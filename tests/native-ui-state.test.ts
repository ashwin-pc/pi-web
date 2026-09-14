import { describe, expect, it } from "vitest";
import { activeSessionState, reduceSessionSnapshot, replaceSessionRuntime, selectSession, sessionRuntime } from "../src/app/sessionState.js";
import type { AppState } from "../src/app/types.js";
import { imagesFromMessage, messageText } from "../src/messages/content.js";
import { collectToolImages, textFromToolResult } from "../src/tools/toolCards.js";
import type { MessageDto } from "../server/session/dto.js";

function app(): AppState { return { currentSessionId: "web-codex", sessionsById: {} } as AppState; }
function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "web-codex", harnessId: "codex", phase: "running", activity: "working",
    nativeSession: { harnessId: "codex", sessionId: "native-thread", persistence: "persistent", status: "resumable" },
    activeExecution: { id: "host-execution", owner: "host", nativeExecutionId: "native-turn" },
    isStreaming: false, isRetrying: false, isCompacting: false, stats: {}, pendingInteractions: [],
    ...overrides,
  };
}

describe("native UI state uses authoritative activity, not Pi terminal heuristics", () => {
  it.each(["waiting-approval", "waiting-input"])("keeps %s running without claiming text is streaming", (activity) => {
    const state = app(); reduceSessionSnapshot(state, snapshot({ activity }));
    expect(sessionRuntime(state)).toMatchObject({ isRunning: true, isStreaming: false });
    expect(activeSessionState(state)?.activeExecution).toEqual({ id: "host-execution", owner: "host", nativeExecutionId: "native-turn" });
  });

  it("does not make an interrupt receipt or stale host runtime an idle boundary", () => {
    const state = app(); reduceSessionSnapshot(state, snapshot({ phase: "settling" }));
    replaceSessionRuntime(state, "web-codex", { isRunning: false, isStreaming: false });
    expect(sessionRuntime(state).isRunning).toBe(true);
    reduceSessionSnapshot(state, snapshot({ phase: "idle", activity: "idle", activeExecution: undefined }));
    expect(sessionRuntime(state).isRunning).toBe(false);
    replaceSessionRuntime(state, "web-codex", { isRunning: true, isStreaming: true });
    expect(sessionRuntime(state).isRunning).toBe(false);
  });

  it("keeps web/native/execution identity separate and clears absent complete-snapshot fields", () => {
    const state = app(); reduceSessionSnapshot(state, snapshot());
    const { activeExecution: _execution, ...idle } = snapshot({ phase: "idle", activity: "idle" });
    reduceSessionSnapshot(state, idle);
    expect(activeSessionState(state)?.id).toBe("web-codex");
    expect(activeSessionState(state)?.nativeSession?.sessionId).toBe("native-thread");
    expect(activeSessionState(state)?.sessionFile).toBeUndefined();
    expect(activeSessionState(state)?.activeExecution).toBeUndefined();
    expect(activeSessionState(state)?.stats?.cost).toBeUndefined();
  });

  it("preserves independent Pi running flags when switching sessions", () => {
    const state = app(); reduceSessionSnapshot(state, snapshot({ phase: "idle" }));
    reduceSessionSnapshot(state, { sessionId: "web-pi", harnessId: "pi", isStreaming: true });
    selectSession(state, "web-pi"); expect(sessionRuntime(state).isRunning).toBe(true);
    selectSession(state, "web-codex"); expect(sessionRuntime(state).isRunning).toBe(false);
  });
});

describe("canonical transcript content retains fidelity", () => {
  it("prefers ordered parts over legacy flattened/raw text and never exposes thinking as prose", () => {
    const message: MessageDto = { role: "assistant", isError: false, text: "obsolete flattened text", raw: { content: "obsolete Pi raw" }, parts: [
      { id: "a", type: "text", text: "Before tool" },
      { id: "b", type: "thinking", text: "Exposed reasoning" },
      { id: "c", type: "toolCall", toolCallId: "call", toolName: "command", args: { command: "printf example" }, status: "completed" },
      { id: "d", type: "text", text: "After tool" },
    ] };
    expect(messageText(message)).toBe("Before tool\nAfter tool");
  });

  it("retains canonical image location/media and tool result parts/details", () => {
    const image = { id: "image", type: "image" as const, mediaType: "image/png", url: "/api/artifacts/example.png", alt: "Example" };
    expect(imagesFromMessage({ role: "assistant", isError: false, parts: [image] })).toEqual([{ mimeType: "image/png", contentUrl: image.url, name: "Example", data: undefined }]);
    const result = { parts: [{ id: "text", type: "text", text: "Exact output" }, image], details: { diff: "-before\n+after", sessionRefs: [{ sessionId: "linked-session" }] } };
    expect(textFromToolResult(result)).toBe("Exact output\n[image]");
    expect(collectToolImages(result)).toEqual([{ src: image.url, alt: "Example", needsAuth: true }]);
    expect(result.details.diff).toBe("-before\n+after");
  });

  it("continues to parse legacy Pi text and thinking-free tool results", () => {
    expect(messageText({ role: "assistant", raw: { content: [{ type: "text", text: "Pi answer" }, { type: "thinking", thinking: "Private to its thinking card" }] } })).toBe("Pi answer");
    expect(textFromToolResult({ raw: { content: [{ type: "text", text: "Pi output" }], details: { diff: " +1 original" } } })).toBe("Pi output");
  });
});
