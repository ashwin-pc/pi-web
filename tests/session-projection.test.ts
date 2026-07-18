import { describe, expect, it } from "vitest";
import {
  hasUserMessages,
  isAssistantAbortedMessage,
  isAssistantFailureMessage,
  isIncompleteToolResultMessage,
  messageEntryRefs,
  projectConversationTree,
  projectSessionState,
  projectSessionStats,
  projectSessionTitle,
  simplifyMessage,
  simplifyModel,
  textFromContent,
} from "../server/session/projection.js";

function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("session projections", () => {
  it("projects text and model DTOs through JSON", () => {
    expect(textFromContent([{ type: "text", text: "hello" }, { type: "image" }, { type: "toolCall", toolName: "bash" }])).toBe("hello\n[image]");
    expect(hasUserMessages([{ role: "assistant" }, { role: "user" }])).toBe(true);
    expect(jsonRoundTrip(simplifyModel({ provider: "openai", id: "gpt", reasoning: 1, contextWindow: 128_000 }))).toEqual({
      provider: "openai",
      id: "gpt",
      name: "gpt",
      reasoning: true,
      contextWindow: 128_000,
    });
  });

  it("keeps the compaction summary and only its retained message entry refs", () => {
    const refs = messageEntryRefs([
      { id: "discarded", type: "message" },
      { id: "kept", type: "message" },
      { id: "compact", type: "compaction", firstKeptEntryId: "kept" },
      { id: "summary", type: "branch_summary", summary: "summary" },
      { id: "later", type: "custom_message" },
    ]);
    expect(jsonRoundTrip(refs)).toEqual([{ entryId: "compact" }, { entryId: "kept" }, { entryId: "summary" }, { entryId: "later" }]);
  });

  it("simplifies decorated messages without depending on host runtime state", () => {
    const toolCallArgs = new Map([["call-1", { command: "pwd" }]]);
    const assistant = simplifyMessage({
      role: "assistant",
      content: [{ type: "text", text: "Running" }, { type: "toolCall", id: "call-1", toolName: "bash", arguments: { command: "pwd" }, startedAt: "2026-01-01T00:00:00.000Z" }],
      timestamp: "2026-01-01T00:00:01.000Z",
    }, toolCallArgs, "entry-1");
    const toolResult = simplifyMessage({ role: "toolResult", toolCallId: "call-1", toolName: "bash", content: "workspace" }, toolCallArgs);

    expect(jsonRoundTrip(assistant)).toMatchObject({
      entryId: "entry-1",
      role: "assistant",
      text: "Running",
      toolCalls: [{ id: "call-1", toolName: "bash", args: { command: "pwd" }, startedAt: "2026-01-01T00:00:00.000Z" }],
    });
    expect(jsonRoundTrip(toolResult)).toMatchObject({ role: "toolResult", toolArgs: { command: "pwd" }, text: "workspace" });
  });

  it("projects conversation previews and preserves their JSON DTO shape", () => {
    const tree = projectConversationTree({
      sessionId: "session-1",
      leafId: "tool",
      activePath: [{ id: "user" }, { id: "tool" }],
      roots: [{ entry: { id: "user", type: "message", timestamp: "t1", message: { role: "user", content: "A question" } }, children: [
        { entry: { id: "tool", parentId: "user", type: "message", timestamp: "t2", message: { role: "assistant", content: [{ type: "toolCall", toolName: "bash", arguments: { command: "pwd" } }] } }, children: [] },
      ] }],
    });

    expect(jsonRoundTrip(tree)).toMatchObject({
      ok: true,
      sessionId: "session-1",
      activePathIds: ["user", "tool"],
      entryCount: 2,
      nodes: [
        { id: "user", role: "user", preview: "A question", childCount: 1, isOnActivePath: true },
        { id: "tool", role: "toolCall", preview: "Tool call: bash pwd", isCurrentLeaf: true },
      ],
    });
  });

  it("classifies messages and projects stats and state as JSON", () => {
    expect(isAssistantFailureMessage({ role: "assistant", errorMessage: "HTTP 429" })).toBe(true);
    expect(isAssistantAbortedMessage({ role: "assistant", stopReason: "aborted" })).toBe(true);
    expect(isIncompleteToolResultMessage({ role: "toolResult" })).toBe(true);

    const stats = projectSessionStats([
      { role: "user" },
      { role: "assistant", usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { input: 0.1, output: 0.2 } } },
      { role: "toolResult" },
    ], { tokens: 18, contextWindow: 100, percent: 18 });
    expect(projectSessionTitle(undefined, [{ role: "user", content: "A useful title" }])).toBe("A useful title");

    expect(jsonRoundTrip(projectSessionState({
      cwd: "/repo",
      sessionFile: "/repo/.pi/session.jsonl",
      sessionId: "session-1",
      sessionName: undefined,
      sessionTitle: "A useful title",
      isStreaming: false,
      isRetrying: false,
      isCompacting: false,
      runtimeStartedAt: undefined,
      runtimeLastActivityAt: undefined,
      runtime: { loaded: true, isRunning: false },
      model: { provider: "openai", id: "gpt" },
      thinkingLevel: "medium",
      stats,
      webFooters: [],
      webHeaderActions: [],
      webGitTabs: [],
    }))).toMatchObject({
      cwd: "/repo",
      model: { provider: "openai", id: "gpt", name: "gpt", reasoning: false },
      stats: { userMessages: 1, assistantMessages: 1, toolResults: 1, tokens: { total: 18 }, cost: 0.30000000000000004 },
    });
  });
});
