import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { jsonRoundTrip, type JsonValue } from "./dto.js";

type WithoutCumulativePartial<T> = T extends unknown ? Omit<T, "partial"> : never;
export type AssistantDeltaDto = WithoutCumulativePartial<AssistantMessageEvent>;
export type RetrySourceDto = "agent" | "branchSummary" | "compaction";

export type AgentEventDto =
  | { type: "agent_start"; startedAt?: string; lastActivityAt?: string }
  | { type: "agent_end"; willRetry: boolean; aborted: boolean }
  | { type: "agent_settled" }
  | { type: "turn_start" }
  | { type: "turn_end"; message: MessageRefDto; toolResults: MessageRefDto[] }
  | { type: "message_start"; message: MessageRefDto }
  | { type: "message_update"; assistantMessageEvent: AssistantDeltaDto }
  | { type: "message_end"; message: JsonValue; timestamp?: string; lastActivityAt?: string }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: JsonValue }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: JsonValue; partialResult: JsonValue }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: JsonValue; isError: boolean }
  | { type: "queue_update"; steering: string[]; followUp: string[] }
  | { type: "auto_retry_start"; source: RetrySourceDto; attempt: number; maxAttempts?: number; delayMs?: number; errorMessage?: string; reason?: "manual" | "threshold" | "overflow" }
  | { type: "auto_retry_end"; source: RetrySourceDto; success: boolean; attempt: number; finalError?: string }
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | { type: "compaction_end"; reason: "manual" | "threshold" | "overflow"; result?: JsonValue; aborted: boolean; willRetry: boolean; errorMessage?: string }
  | { type: "session_info_changed"; name?: string }
  | { type: "thinking_level_changed"; level: string }
  | { type: "bash_execution_update"; id?: string; delta: string };

export type HarnessEventDto = AgentEventDto | { type: "harness_event"; harness: string; payload: JsonValue };
export type MessageRefDto = { role: string; timestamp?: string };
export type PiEventMapResult = { kind: "event"; event: AgentEventDto } | { kind: "entry"; entryId: string; parentId?: string; entryKind: string };

function value(input: unknown): JsonValue {
  return jsonRoundTrip(input) as JsonValue;
}

function messageRef(input: unknown): MessageRefDto {
  const message = input && typeof input === "object" ? input as Record<string, unknown> : {};
  return {
    role: String(message.role || "unknown"),
    ...(typeof message.timestamp === "number" || typeof message.timestamp === "string" ? { timestamp: String(message.timestamp) } : {}),
  };
}

function stripCumulativePartial(event: AssistantMessageEvent): AssistantDeltaDto {
  if (!("partial" in event)) return event;
  const { partial: _partial, ...delta } = event;
  return delta as AssistantDeltaDto;
}

function agentRunAborted(messages: readonly unknown[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; stopReason?: unknown } | undefined;
    if (message?.role === "assistant") return message.stopReason === "aborted";
  }
  return false;
}

function assertNever(event: never): never {
  throw new Error(`Unmapped pi event: ${String((event as { type?: unknown }).type)}`);
}

/** The single exhaustive boundary between pi's event API and pi-web's wire contract. */
export function mapPiEvent(event: AgentSessionEvent): PiEventMapResult {
  switch (event.type) {
    case "agent_start": {
      const timed = event as typeof event & { startedAt?: string; lastActivityAt?: string };
      return { kind: "event", event: {
        type: "agent_start",
        ...(timed.startedAt ? { startedAt: timed.startedAt } : {}),
        ...(timed.lastActivityAt ? { lastActivityAt: timed.lastActivityAt } : {}),
      } };
    }
    case "agent_end": return { kind: "event", event: { type: "agent_end", willRetry: event.willRetry, aborted: agentRunAborted(event.messages || []) } };
    case "agent_settled": return { kind: "event", event: { type: "agent_settled" } };
    case "turn_start": return { kind: "event", event: { type: "turn_start" } };
    case "turn_end": return { kind: "event", event: { type: "turn_end", message: messageRef(event.message), toolResults: event.toolResults.map(messageRef) } };
    case "message_start": return { kind: "event", event: { type: "message_start", message: messageRef(event.message) } };
    case "message_update": return { kind: "event", event: { type: "message_update", assistantMessageEvent: stripCumulativePartial(event.assistantMessageEvent) } };
    case "message_end": {
      const timed = event as typeof event & { timestamp?: string; lastActivityAt?: string };
      return { kind: "event", event: {
        type: "message_end",
        message: value(event.message),
        ...(timed.timestamp ? { timestamp: timed.timestamp } : {}),
        ...(timed.lastActivityAt ? { lastActivityAt: timed.lastActivityAt } : {}),
      } };
    }
    case "tool_execution_start": return { kind: "event", event: { type: "tool_execution_start", toolCallId: event.toolCallId, toolName: event.toolName, args: value(event.args) } };
    case "tool_execution_update": return { kind: "event", event: { type: "tool_execution_update", toolCallId: event.toolCallId, toolName: event.toolName, args: value(event.args), partialResult: value(event.partialResult) } };
    case "tool_execution_end": return { kind: "event", event: { type: "tool_execution_end", toolCallId: event.toolCallId, toolName: event.toolName, result: value(event.result), isError: event.isError } };
    case "queue_update": return { kind: "event", event: { type: "queue_update", steering: [...event.steering], followUp: [...event.followUp] } };
    case "auto_retry_start": return { kind: "event", event: { ...event, source: "agent" } };
    case "auto_retry_end": return { kind: "event", event: { ...event, source: "agent" } };
    case "summarization_retry_scheduled": return { kind: "event", event: { type: "auto_retry_start", source: "compaction", attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs, errorMessage: event.errorMessage } };
    case "summarization_retry_attempt_start": return { kind: "event", event: { type: "auto_retry_start", source: event.source, attempt: 1, ...(event.source === "compaction" ? { reason: event.reason } : {}) } };
    case "summarization_retry_finished": return { kind: "event", event: { type: "auto_retry_end", source: "compaction", success: true, attempt: 1 } };
    case "compaction_start": return { kind: "event", event: { ...event } };
    case "compaction_end": return { kind: "event", event: {
      type: "compaction_end",
      reason: event.reason,
      aborted: event.aborted,
      willRetry: event.willRetry,
      ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
      ...(event.result === undefined ? {} : { result: value(event.result) }),
    } };
    case "session_info_changed": return { kind: "event", event: { ...event } };
    case "thinking_level_changed": return { kind: "event", event: { ...event } };
    case "bash_execution_update": return { kind: "event", event: { ...event } };
    case "entry_appended": {
      const entry = event.entry as unknown as Record<string, unknown>;
      return {
        kind: "entry",
        entryId: String(entry.id || ""),
        ...(typeof entry.parentId === "string" ? { parentId: entry.parentId } : {}),
        entryKind: String(entry.type || "entry"),
      };
    }
    default: return assertNever(event);
  }
}
