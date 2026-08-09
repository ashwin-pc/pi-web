import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { mapPiEvent, type HarnessEventDto } from "../server/session/piEventMap.js";

const message = { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 1, stopReason: "stop" } as AssistantMessage;
const partial = { ...message, content: [{ type: "text", text: "x".repeat(1_000) }] } as AssistantMessage;
const events = [
  { type: "agent_start" },
  { type: "agent_end", messages: [message], willRetry: false },
  { type: "agent_settled" },
  { type: "turn_start" },
  { type: "turn_end", message, toolResults: [{ role: "toolResult", timestamp: 2 }] },
  { type: "message_start", message },
  { type: "message_update", message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi", partial } },
  { type: "message_end", message },
  { type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "a" } },
  { type: "tool_execution_update", toolCallId: "call-1", toolName: "read", args: { path: "a" }, partialResult: { content: [{ type: "text", text: "partial" }] } },
  { type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: { content: [{ type: "text", text: "done" }] }, isError: false },
  { type: "queue_update", steering: ["one"], followUp: ["two"] },
  { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 100, errorMessage: "busy" },
  { type: "auto_retry_end", success: true, attempt: 1 },
  { type: "summarization_retry_scheduled", attempt: 1, maxAttempts: 2, delayMs: 100, errorMessage: "busy" },
  { type: "summarization_retry_attempt_start", source: "branchSummary" },
  { type: "summarization_retry_attempt_start", source: "compaction", reason: "manual" },
  { type: "summarization_retry_finished" },
  { type: "compaction_start", reason: "manual" },
  { type: "compaction_end", reason: "manual", result: { summary: "short" }, aborted: false, willRetry: false },
  { type: "session_info_changed", name: "Named" },
  { type: "thinking_level_changed", level: "high" },
  { type: "bash_execution_update", id: "bash-1", delta: "output" },
  { type: "entry_appended", entry: { id: "entry-1", parentId: "parent-1", type: "message", message } },
] satisfies AgentSessionEvent[];

describe("pi event wire mapping", () => {
  it("maps the recorded pi event surface without cumulative streaming messages", () => {
    const mapped = events.map(mapPiEvent);
    expect(mapped).toMatchSnapshot();
    const update = mapped.find((item) => item.kind === "event" && item.event.type === "message_update");
    expect(update).not.toHaveProperty("event.message");
    expect(update).not.toHaveProperty("event.assistantMessageEvent.partial");
  });

  it("keeps the open harness escape hatch JSON-round-trip tolerant", () => {
    const event: HarnessEventDto = { type: "harness_event", harness: "future", payload: { type: "new_event", value: 1 } };
    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
  });
});
