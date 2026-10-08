import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { PiWebSession } from "../server/types.js";
import { jsonRoundTrip } from "../server/session/dto.js";
import {
  conversationTreeForSession,
  entryMessage,
  getSessionSlashCommands,
  messageEntryRefs,
  projectCommittedMessage,
  projectMessages,
  projectSessionState,
  sessionStats,
  simplifyMessage,
  simplifyModel,
  textFromContent,
} from "../server/session/projection.js";

function fixtureSession(): PiWebSession {
  const branch = [
    { id: "user-1", parentId: null, type: "message", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "Hello" } },
    { id: "assistant-1", parentId: "user-1", type: "message", timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "Hi" }], usage: { input: 2, output: 3, cost: { total: 0.01 } } } },
  ];
  const tree = [{ entry: branch[0], children: [{ entry: branch[1], children: [] }] }];
  return {
    sessionId: "session-1",
    sessionFile: "/tmp/session-1.jsonl",
    sessionName: "Projection fixture",
    isStreaming: false,
    isCompacting: false,
    model: { provider: "test", id: "model", name: "Test Model", reasoning: true, contextWindow: 1000, maxTokens: 100 },
    thinkingLevel: "medium",
    messages: branch.map((entry) => entry.message),
    agent: { state: { messages: branch.map((entry) => entry.message) } },
    sessionManager: {
      newSession() {},
      buildSessionContext: () => ({ messages: branch.map((entry) => entry.message) }),
      getSessionName: () => "Projection fixture",
      getBranch: () => branch,
      getLeafId: () => "assistant-1",
      getTree: () => tree,
    },
    modelRuntime: { getAvailableSnapshot: () => [], getModel: () => undefined },
    extensionRunner: { getRegisteredCommands: () => [{ invocationName: "ext", description: "Extension command", sourceInfo: { path: "/tmp/ext.ts", source: "extension", scope: "user", origin: "top-level" } }] },
    promptTemplates: [{ name: "prompt", description: "Prompt command", sourceInfo: { path: "/tmp/prompt.md", source: "prompt", scope: "user", origin: "top-level" } }],
    resourceLoader: { getSkills: () => ({ skills: [{ name: "demo", description: "Demo skill", sourceInfo: { path: "/tmp/SKILL.md", source: "skill", scope: "user", origin: "top-level" } }] }) },
    getAvailableThinkingLevels: () => ["low", "medium", "high"],
    getSessionName: () => "Projection fixture",
    getContextUsage: () => ({ tokens: 5, contextWindow: 1000, percent: 0.5 }),
    async setModel() {},
    setThinkingLevel() {},
    async prompt() {},
    async abort() {},
  };
}

describe("pure session projections", () => {
  it("projects content and models without session globals", () => {
    expect(textFromContent([{ type: "text", text: "hello" }, { type: "image" }])).toBe("hello\n[image]");
    expect(simplifyModel(fixtureSession().model)).toEqual({ provider: "test", id: "model", name: "Test Model", reasoning: true, contextWindow: 1000, maxTokens: 100 });
  });

  it("keeps compaction-aware active-branch entry ids", () => {
    const session = fixtureSession();
    session.sessionManager.getBranch = () => [
      { id: "old", type: "message", message: { role: "user", content: "old" } },
      { id: "kept", type: "message", message: { role: "user", content: "kept" } },
      { id: "compact", type: "compaction", firstKeptEntryId: "kept", summary: "summary" },
      { id: "new", type: "message", message: { role: "assistant", content: "new" } },
    ];
    expect(messageEntryRefs(session)).toEqual([{ entryId: "compact" }, { entryId: "kept" }, { entryId: "new" }]);
  });

  it("keeps user action targets aligned after context edits omit messages", () => {
    const manager = SessionManager.inMemory();
    const firstUser = manager.appendMessage({ role: "user", content: "First turn", timestamp: 1 });
    const removedTool = manager.appendMessage({
      role: "toolResult", toolCallId: "read-1", toolName: "read",
      content: [{ type: "text", text: "Large output" }], isError: false, timestamp: 2,
    });
    const secondUser = manager.appendMessage({ role: "user", content: "Second turn", timestamp: 3 });
    const edit = manager.appendContextEdit(removedTool, null);
    const lastUser = manager.appendMessage({ role: "user", content: "Third turn", timestamp: 4 });
    const session = fixtureSession();
    session.sessionManager = manager;
    session.messages = manager.buildSessionContext().messages;

    expect(manager.getEntry(removedTool)).toMatchObject({ type: "message", message: { role: "toolResult" } });
    expect(session.messages.map((message: any) => message.role)).toEqual(["user", "user", "user"]);
    expect(projectMessages(session).map(({ entryId, parentEntryId }) => ({ entryId, parentEntryId }))).toEqual([
      { entryId: firstUser, parentEntryId: undefined },
      { entryId: secondUser, parentEntryId: removedTool },
      { entryId: lastUser, parentEntryId: edit },
    ]);
    expect(projectCommittedMessage(session, session.messages.at(-1))).toMatchObject({
      role: "user", entryId: lastUser, parentEntryId: edit, text: "Third turn",
    });
  });

  it("uses compaction provenance for both checkpoint messages and retained user messages", () => {
    const manager = SessionManager.inMemory();
    manager.appendMessage({ role: "system", content: "Initial prompt", timestamp: 1 });
    const oldUser = manager.appendMessage({ role: "user", content: "Summarized turn", timestamp: 2 });
    const keptUser = manager.appendMessage({ role: "user", content: "Kept turn", timestamp: 3 });
    const keptSystem = manager.appendMessage({ role: "system", content: "Prompt update", timestamp: 4 });
    const nextUser = manager.appendMessage({ role: "user", content: "Next turn", timestamp: 5 });
    const compaction = manager.appendCompaction("Earlier conversation", keptUser, 1000);
    const lastUser = manager.appendMessage({ role: "user", content: "After compaction", timestamp: 6 });
    const session = fixtureSession();
    session.sessionManager = manager;
    session.messages = manager.buildSessionContext().messages;

    expect(manager.getEntry(compaction)).toMatchObject({ type: "compaction", systemMessage: { role: "system" } });
    expect(projectMessages(session).map(({ role, entryId, parentEntryId }) => ({ role, entryId, parentEntryId }))).toEqual([
      { role: "system", entryId: compaction, parentEntryId: nextUser },
      { role: "compactionSummary", entryId: compaction, parentEntryId: nextUser },
      { role: "user", entryId: keptUser, parentEntryId: oldUser },
      { role: "user", entryId: nextUser, parentEntryId: keptSystem },
      { role: "user", entryId: lastUser, parentEntryId: compaction },
    ]);
    expect(projectCommittedMessage(session, session.messages.at(-1))).toMatchObject({
      role: "user", entryId: lastUser, parentEntryId: compaction,
    });
  });

  it("does not invent labels for older retained compactions", () => {
    const manager = SessionManager.inMemory();
    manager.appendMessage({ role: "system", content: "Prompt", timestamp: 1 });
    const keptUser = manager.appendMessage({ role: "user", content: "Kept turn", timestamp: 2 });
    manager.appendCompaction("First summary", keptUser, 1000);
    const nextUser = manager.appendMessage({ role: "user", content: "Next turn", timestamp: 3 });
    const latestCompaction = manager.appendCompaction("Latest summary", keptUser, 2000);
    const session = fixtureSession();
    session.sessionManager = manager;
    session.messages = manager.buildSessionContext().messages;

    expect(messageEntryRefs(session)).toEqual([
      { entryId: latestCompaction, parentEntryId: nextUser },
      { entryId: latestCompaction, parentEntryId: nextUser },
      { entryId: keptUser, parentEntryId: manager.getEntry(keptUser)?.parentId },
      { entryId: nextUser, parentEntryId: manager.getEntry(nextUser)?.parentId },
    ]);
  });

  it("preserves visible custom metadata and omits hidden custom content", () => {
    for (const content of ["hello", [{ type: "text", text: "hello" }]]) {
      const message = entryMessage({
        type: "custom_message",
        customType: "probe",
        content,
        details: { source: "extension" },
        display: true,
        timestamp: "now",
      });
      expect(simplifyMessage(message)).toEqual({
        role: "custom",
        customType: "probe",
        text: "hello",
        details: { source: "extension" },
        display: true,
        timestamp: "now",
        raw: message,
      });
      expect(simplifyMessage({ ...message, display: false })).toBeUndefined();
    }
  });

  it("recovers persisted metadata for the committed message reference", () => {
    const session = fixtureSession();
    expect(projectCommittedMessage(session, session.messages[1])).toMatchObject({
      role: "assistant",
      entryId: "assistant-1",
      text: "Hi",
    });
  });

  it("projects unknown roles without dropping their content", () => {
    expect(simplifyMessage({ role: "futureKind", content: "important text", timestamp: "now" })).toEqual({
      role: "unknown",
      originalRole: "futureKind",
      text: "important text",
      timestamp: "now",
      raw: { role: "futureKind", content: "important text", timestamp: "now" },
    });
  });

  it("accepts host decoration as explicit message projection input", () => {
    const projected = simplifyMessage({ role: "assistant", content: [{ type: "toolCall", id: "tool-1", toolName: "read", arguments: { path: "README.md" } }], timestamp: "now" }, {
      entryId: "entry-1",
      decorateContent: (content) => (content as Array<Record<string, unknown>>).map((part) => ({ ...part, startedAt: "then" })),
    });
    expect(projected).toMatchObject({ entryId: "entry-1", role: "assistant", toolCalls: [{ id: "tool-1", toolName: "read", startedAt: "then" }] });
  });

  it("reports transcript messages separately from branch metadata", () => {
    const session = fixtureSession();
    session.sessionManager.getBranch = () => [
      { type: "model_change" },
      ...session.messages.map((message) => ({ type: "message", message })),
      { type: "thinking_level_change" },
    ];
    expect(sessionStats(session)).toMatchObject({ totalMessages: 4, conversationMessages: 2 });
    expect(projectSessionState(session, "/tmp").stats).toMatchObject({ conversationMessages: 2 });
  });

  it("returns wire-stable state, stats, tree, and command DTOs", () => {
    const session = fixtureSession();
    const results = [
      projectSessionState(session, "/tmp"),
      sessionStats(session),
      conversationTreeForSession(session),
      getSessionSlashCommands(session),
    ];
    for (const result of results) expect(jsonRoundTrip(result)).toStrictEqual(result);
  });
});
