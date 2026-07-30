import { describe, expect, it } from "vitest";
import type { PiWebSession } from "../server/types.js";
import { jsonRoundTrip } from "../server/session/dto.js";
import {
  conversationTreeForSession,
  entryMessage,
  getSessionSlashCommands,
  messageEntryRefs,
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

  it("preserves custom message metadata and string or array content", () => {
    for (const content of ["hello", [{ type: "text", text: "hello" }]]) {
      const message = entryMessage({
        type: "custom_message",
        customType: "probe",
        content,
        details: { source: "extension" },
        display: false,
        timestamp: "now",
      });
      expect(simplifyMessage(message)).toEqual({
        role: "custom",
        customType: "probe",
        text: "hello",
        details: { source: "extension" },
        display: false,
        timestamp: "now",
        raw: message,
      });
    }
  });

  it("accepts host decoration as explicit message projection input", () => {
    const projected = simplifyMessage({ role: "assistant", content: [{ type: "toolCall", id: "tool-1", toolName: "read", arguments: { path: "README.md" } }], timestamp: "now" }, {
      entryId: "entry-1",
      decorateContent: (content) => (content as Array<Record<string, unknown>>).map((part) => ({ ...part, startedAt: "then" })),
    });
    expect(projected).toMatchObject({ entryId: "entry-1", role: "assistant", toolCalls: [{ id: "tool-1", toolName: "read", startedAt: "then" }] });
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
