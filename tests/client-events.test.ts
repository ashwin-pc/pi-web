import { describe, expect, it } from "vitest";
import { absoluteToolPath, createEventTranslator, toolPaths } from "../src/client/events.js";

const agent = (sessionId: string, event: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: "agent_event", sessionId, event, ...extra });

describe("client event translation", () => {
  it("maps one pi run onto neutral events, in order", () => {
    const translator = createEventTranslator({ cwdOf: () => "/repo" });
    const events = [
      agent("s1", { type: "agent_start", startedAt: "2026-10-11T10:00:00Z" }),
      agent("s1", { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } }),
      agent("s1", { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello" } }),
      agent("s1", { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "hmm" } }),
      agent("s1", { type: "tool_execution_start", toolCallId: "t1", toolName: "edit", args: { path: "src/a.ts" } }),
      agent("s1", { type: "tool_execution_update", toolCallId: "t1", toolName: "edit", args: { path: "src/a.ts" }, partialResult: {} }),
      agent("s1", { type: "tool_execution_end", toolCallId: "t1", toolName: "edit", isError: false, result: {} }),
      agent("s1", { type: "agent_end", willRetry: false, aborted: false }),
      agent("s1", { type: "agent_settled" }),
    ].flatMap((envelope) => translator.translate(envelope));
    expect(events).toEqual([
      { type: "turn/start", sessionId: "s1", at: "2026-10-11T10:00:00Z" },
      { type: "assistant/delta", sessionId: "s1", channel: "text", delta: "Hello", contentIndex: 0 },
      { type: "assistant/delta", sessionId: "s1", channel: "thinking", delta: "hmm", contentIndex: 1 },
      { type: "tool/call", sessionId: "s1", toolCallId: "t1", name: "edit", args: { path: "src/a.ts" }, paths: ["/repo/src/a.ts"] },
      { type: "tool/result", sessionId: "s1", toolCallId: "t1", name: "edit", isError: false, paths: ["/repo/src/a.ts"] },
      { type: "turn/end", sessionId: "s1", aborted: false },
    ]);
  });

  it("carries an aborted run and the last assistant error to turn/end", () => {
    const translator = createEventTranslator();
    translator.translate(agent("s1", { type: "agent_start" }));
    translator.translate(agent("s1", { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "usage limit" } }));
    expect(translator.translate(agent("s1", { type: "agent_end", willRetry: true, aborted: false }))).toEqual([]);
    translator.translate(agent("s1", { type: "agent_end", willRetry: false, aborted: true }));
    expect(translator.translate(agent("s1", { type: "agent_settled" }))).toEqual([{ type: "turn/end", sessionId: "s1", aborted: true, error: "usage limit" }]);
    // A successful assistant message clears an earlier error in the same run.
    translator.translate(agent("s1", { type: "agent_start" }));
    translator.translate(agent("s1", { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "transient" } }));
    translator.translate(agent("s1", { type: "message_end", message: { role: "assistant", stopReason: "stop" } }));
    expect(translator.translate(agent("s1", { type: "agent_settled" }))).toEqual([{ type: "turn/end", sessionId: "s1", aborted: false }]);
  });

  it("turns a delivered prompt into user/message, whatever its content shape", () => {
    const translator = createEventTranslator();
    expect(translator.translate(agent("s1", { type: "message_end", message: { role: "user", content: "hi there" } }))).toEqual([{ type: "user/message", sessionId: "s1", text: "hi there" }]);
    expect(translator.translate(agent("s1", { type: "message_end", message: { role: "user", content: [{ type: "text", text: "a" }, { type: "image" }] } }))).toEqual([{ type: "user/message", sessionId: "s1", text: "a\n" }]);
    expect(translator.translate(agent("s1", { type: "message_end", message: { role: "user", content: [] } }))).toEqual([]);
  });

  it("ignores replayed envelopes, other envelope types and events without a session", () => {
    const translator = createEventTranslator();
    expect(translator.translate(agent("s1", { type: "agent_start" }, { replay: true }))).toEqual([]);
    expect(translator.translate({ type: "state_changed", sessionId: "s1" })).toEqual([]);
    expect(translator.translate(agent("", { type: "agent_start" }))).toEqual([]);
    expect(translator.translate(agent("s1", { type: "queue_update", steering: [], followUp: [] }))).toEqual([]);
    expect(translator.translate(agent("s1", { type: "message_update", assistantMessageEvent: { type: "text_end", content: "x" } }))).toEqual([]);
  });

  it("keeps tool paths per session, so equal tool call ids in two sessions do not collide", () => {
    const translator = createEventTranslator({ cwdOf: (id) => `/w/${id}` });
    translator.translate(agent("a", { type: "tool_execution_start", toolCallId: "t", toolName: "read", args: { path: "x.ts" } }));
    translator.translate(agent("b", { type: "tool_execution_start", toolCallId: "t", toolName: "read", args: { path: "y.ts" } }));
    expect(translator.translate(agent("a", { type: "tool_execution_end", toolCallId: "t", toolName: "read", isError: true }))[0]).toMatchObject({ paths: ["/w/a/x.ts"], isError: true });
    expect(translator.translate(agent("b", { type: "tool_execution_end", toolCallId: "t", toolName: "read", isError: false }))[0]).toMatchObject({ paths: ["/w/b/y.ts"] });
  });
});

describe("tool paths", () => {
  it("derives paths from file tool arguments, resolved against the cwd", () => {
    expect(toolPaths("read", { path: "./src/main.ts" }, "/repo")).toEqual(["/repo/src/main.ts"]);
    expect(toolPaths("write", { path: "/abs/file.md" }, "/repo")).toEqual(["/abs/file.md"]);
    expect(toolPaths("edit", { path: "a.ts", edits: [{ path: "a.ts" }, { path: "b.ts" }] }, "/repo")).toEqual(["/repo/a.ts", "/repo/b.ts"]);
    expect(toolPaths("ls", { path: "." }, "/repo")).toEqual(["/repo"]);
  });

  it("derives a folder from search commands, and nothing from plain commands", () => {
    expect(toolPaths("bash", { command: "rg -n 'flick' src/views | head" }, "/repo")).toEqual(["/repo/src/views"]);
    expect(toolPaths("bash", { command: "cat package.json" }, "/repo")).toEqual(["/repo/package.json"]);
    expect(toolPaths("bash", { command: "npm test" }, "/repo")).toEqual([]);
    expect(toolPaths("bash", { command: 42 }, "/repo")).toEqual([]);
    expect(toolPaths("read", null)).toEqual([]);
  });

  it("joins paths without doubling or trailing slashes", () => {
    expect(absoluteToolPath("/repo/", "src/")).toBe("/repo/src");
    expect(absoluteToolPath("", "src/a.ts")).toBe("src/a.ts");
    expect(absoluteToolPath("/repo", "  ")).toBe("");
  });
});
