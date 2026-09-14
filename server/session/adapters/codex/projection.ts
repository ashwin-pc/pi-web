import type { ImagePartDto, JsonValue, MessagePartDto, TextPartDto, ToolCallPartDto, TranscriptMessageDto } from "../../dto.js";
import { diagnostic, object, type NativeObject } from "./transport.js";

export const itemMessageId = (turnId: string, itemId: string): string => `codex:${turnId}:${itemId}`;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

/** Only native data needed by the renderer crosses this boundary. No native SDK envelope/raw field. */
function json(value: unknown, depth = 0): JsonValue {
  if (depth > 8) return "[omitted: depth]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, 64_000);
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => json(entry, depth + 1));
  const record = object(value);
  if (!record) return null;
  return Object.fromEntries(Object.entries(record).slice(0, 100).map(([key, entry]) => [key,
    /(?:authorization|password|secret|token|api.?key)/i.test(key) ? "[redacted]" : json(entry, depth + 1),
  ]));
}

function toolStatus(item: NativeObject, final: boolean): ToolCallPartDto["status"] {
  if (item.status === "interrupted" || item.status === "cancelled") return "cancelled";
  if (item.status === "failed" || item.status === "declined" || item.success === false || object(item.error) || (typeof item.exitCode === "number" && item.exitCode !== 0)) return "error";
  return item.status === "completed" || final ? "completed" : "running";
}

function inlineImage(value: NativeObject, id: string): ImagePartDto | undefined {
  if (value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string"
      && /^image\/(?:png|jpeg|gif|webp)$/.test(value.mimeType) && value.data.length <= 4_000_000 && /^[A-Za-z0-9+/=\s]+$/.test(value.data)) {
    return { type: "image", id, mediaType: value.mimeType, data: value.data };
  }
  if (value.type === "inputImage" && typeof value.imageUrl === "string") {
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(value.imageUrl);
    if (match && match[2]!.length <= 4_000_000) return { type: "image", id, mediaType: match[1]!, data: match[2]! };
  }
  return undefined;
}

function contentParts(value: unknown, prefix: string): Array<TextPartDto | ImagePartDto> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap((entry, index): Array<TextPartDto | ImagePartDto> => {
    const content = object(entry);
    if (!content) return [];
    const id = `${prefix}:result:${index}`;
    if ((content.type === "text" || content.type === "inputText") && typeof content.text === "string") return [{ type: "text", id, text: content.text }];
    const image = inlineImage(content, id);
    return image ? [image] : [{ type: "text", id, text: "[Native content is not displayed]" }];
  });
}

export function fileDiff(item: NativeObject): string {
  return Array.isArray(item.changes) ? item.changes.map((entry) => object(entry)?.diff).filter((value): value is string => typeof value === "string").join("\n") : "";
}

export function projectItem(item: NativeObject, turnId: string, executionId: string | undefined, timestamp: string | undefined, final: boolean): TranscriptMessageDto | undefined {
  if (typeof item.id !== "string" || typeof item.type !== "string") return;
  const nativeItemId = item.id;
  const id = itemMessageId(turnId, nativeItemId);
  const identity = { nativeItemId, nativeExecutionId: turnId };
  const base = { id, entryId: id, ...identity, ...(executionId ? { executionId } : {}), ...(timestamp ? { timestamp } : {}),
    status: final ? "completed" as const : "streaming" as const };
  const textPart = (text: string, key = "text"): TextPartDto => ({ type: "text", id: `${id}:${key}`, text, ...identity });
  const message = (role: "user" | "assistant" | "system", parts: MessagePartDto[]): TranscriptMessageDto => ({
    ...base, role, parts, text: parts.filter((part): part is TextPartDto => part.type === "text").map((part) => part.text).join("\n"), isError: false,
  });
  if (item.type === "userMessage") {
    const parts = Array.isArray(item.content) ? item.content.flatMap((entry, index): MessagePartDto[] => {
      const input = object(entry);
      if (typeof input?.text === "string") return [textPart(input.text, `input:${index}`)];
      if (input) return [textPart(`[Native ${String(input.type ?? "input")} input]`, `input:${index}`)];
      return [];
    }) : [];
    return message("user", parts);
  }
  if (item.type === "agentMessage") return message("assistant", [textPart(typeof item.text === "string" ? item.text : "")]);
  if (item.type === "reasoning") {
    const parts: MessagePartDto[] = [
      ...strings(item.summary).map((text, index) => ({ type: "thinking" as const, id: `${id}:summary:${index}`, text, ...identity })),
      ...strings(item.content).map((text, index) => ({ type: "thinking" as const, id: `${id}:content:${index}`, text, ...identity })),
    ];
    return message("assistant", parts);
  }
  if (item.type === "plan") return message("system", [textPart(`Plan\n${typeof item.text === "string" ? item.text : ""}`)]);
  if (item.type === "enteredReviewMode" || item.type === "exitedReviewMode") return message("system", [textPart(`${item.type === "enteredReviewMode" ? "Review started" : "Review finished"}\n${typeof item.review === "string" ? item.review : ""}`)]);
  if (item.type === "contextCompaction") return message("system", [textPart("Codex compacted the conversation context.")]);

  let toolName: string;
  let args: JsonValue;
  let result: ToolCallPartDto["result"];
  const status = toolStatus(item, final);
  const isError = status === "error" || status === "cancelled";
  const resultText = (text: string, details?: JsonValue): ToolCallPartDto["result"] => ({ parts: [textPart(text, "result")], isError, ...(details ? { details } : {}) });
  if (item.type === "commandExecution") {
    toolName = "command";
    args = json({ command: item.command, cwd: item.cwd });
    if (typeof item.aggregatedOutput === "string" || final || status !== "running") result = resultText(
      typeof item.aggregatedOutput === "string" && item.aggregatedOutput ? item.aggregatedOutput : item.status === "declined" ? "Command declined" : "",
      json({ ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}), ...(typeof item.durationMs === "number" ? { durationMs: item.durationMs } : {}) }),
    );
  } else if (item.type === "fileChange") {
    toolName = "file changes";
    const changes = Array.isArray(item.changes) ? item.changes.map(object).filter((entry): entry is NativeObject => !!entry) : [];
    args = json({ files: changes.map((change) => ({ path: change.path, kind: object(change.kind)?.type })) });
    result = resultText(changes.map((change) => `${String(object(change.kind)?.type ?? "change")}: ${String(change.path ?? "")}`).join("\n"), { diff: fileDiff(item) });
  } else if (item.type === "mcpToolCall") {
    toolName = `${String(item.server ?? "MCP")}/${String(item.tool ?? "tool")}`;
    args = json(item.arguments);
    const nativeResult = object(item.result);
    const nativeError = object(item.error);
    if (nativeResult || nativeError || final) result = {
      parts: nativeResult ? contentParts(nativeResult.content, id) : [textPart(nativeError ? diagnostic(nativeError.message) : "", "result")],
      isError: isError || !!nativeError,
      ...(nativeResult?.structuredContent != null ? { details: { structuredContent: json(nativeResult.structuredContent) } } : {}),
    };
  } else if (item.type === "dynamicToolCall") {
    toolName = typeof item.tool === "string" ? item.tool : "native tool";
    args = json(item.arguments);
    if (Array.isArray(item.contentItems) || final) result = { parts: contentParts(item.contentItems, id), isError };
  } else if (item.type === "collabAgentToolCall") {
    toolName = "Codex agents";
    args = json({ action: item.tool, receiverThreadIds: item.receiverThreadIds });
    if (final) result = resultText(JSON.stringify(json(item.agentsStates ?? {})));
  } else if (item.type === "webSearch") {
    toolName = "web search"; args = json({ query: item.query, action: item.action });
    if (final) result = resultText("Native web search completed");
  } else if (item.type === "imageView") {
    toolName = "view image"; args = json({ path: item.path });
    if (final) result = resultText("Native image viewed; local file content is not exported.");
  } else return undefined;
  const part: ToolCallPartDto = { type: "toolCall", id: `${id}:tool`, ...identity, toolCallId: id, toolName, args, status, ...(timestamp ? { startedAt: timestamp } : {}), ...(result ? { result } : {}) };
  return { ...base, role: "assistant", parts: [part], text: "", isError,
    ...(isError ? { status: status === "cancelled" ? "interrupted" as const : "error" as const } : {}) };
}
