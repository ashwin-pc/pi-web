import { isSessionReferenceId } from "../shared/sessionReference.js";
import { textFromContent, toolCallName } from "./projection.js";
import type { MessageDto, ToolCallPartDto } from "./dto.js";
import { sessionsReadTail, truncateSessionText, type SessionReadText } from "./referenceTools.js";
const MAX_SESSION_READ_ENTRY_TEXT = 6_000;
const MAX_SESSION_READ_TEXT = 12_000;

function shortValue(value: unknown, limit = 60): string {
  if (typeof value === "string") return truncateSessionText(value, limit).text;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (!value || typeof value !== "object") return "";
  const keys: string[] = [];
  for (const key in value as Record<string, unknown>) {
    if (Object.prototype.hasOwnProperty.call(value, key)) keys.push(truncateSessionText(key, 30).text);
    if (keys.length === 3) break;
  }
  return `{${keys.join(", ")}${keys.length === 3 ? ", …" : ""}}`;
}

function shortToolArgs(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const parts: string[] = [];
  for (const key in value as Record<string, unknown>) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const part = `${truncateSessionText(key, 30).text}: ${shortValue((value as Record<string, unknown>)[key])}`;
    if (parts.length && `${parts.join(", ")}, ${part}`.length > 140) break;
    parts.push(part);
    if (parts.length === 4) break;
  }
  return truncateSessionText(parts.join(", "), 160).text;
}

function textForTail(value: string, limit: number, compact: boolean) {
  return compact ? truncateSessionText(value, limit) : { text: value, truncated: false };
}

export function canonicalTextReference(message: MessageDto, compact: boolean): SessionReadText | undefined {
  const parts = message.parts;
  const content: unknown[] = [{ type: "text", text: parts ? parts.filter((part) => part.type === "text").map((part) => part.text).join("\n") : message.text || "" }];
  if (message.role === "assistant") {
    const calls = parts ? parts.filter((part) => part.type === "toolCall") : message.toolCalls || [];
    for (const call of calls) {
      content.push({ type: "toolCall", name: call.toolName, arguments: call.args });
      const result = (call as Partial<ToolCallPartDto>).result;
      if (result) content.push({ type: "text", text: `  ${result.isError ? "✗" : "✓"} ${call.toolName}: ${result.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n")}` });
    }
  }
  return textReference({ type: "message", id: message.entryId || message.id, message: { ...message, content } }, compact);
}

function textReference(entry: unknown, compact: boolean): SessionReadText | undefined {
  const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : undefined;
  if (!record || record.type !== "message" || !isSessionReferenceId(record.id) || !record.message || typeof record.message !== "object") return undefined;
  const message = record.message as Record<string, unknown>;
  const role = typeof message.role === "string" ? message.role : "unknown";
  const text = textForTail(textFromContent(message.content), role === "assistant" ? 700 : role === "toolResult" ? 200 : 400, compact);
  if (role === "assistant") {
    const lines = text.text ? [`[assistant] ${text.text}`] : [];
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (!part || typeof part !== "object") continue;
      const call = part as Record<string, unknown>;
      if (call.type === "toolCall") lines.push(`  → ${toolCallName(call)}(${shortToolArgs(call.arguments)})`);
    }
    return { entryId: record.id, text: lines.join("\n") || "[assistant]", truncated: text.truncated };
  }
  if (role === "toolResult") {
    const name = typeof message.toolName === "string" ? message.toolName : "tool";
    return { entryId: record.id, text: `  ${message.isError ? "✗" : "✓"} ${name}${text.text ? `: ${text.text}` : ""}`, truncated: text.truncated };
  }
  if (role === "bashExecution") {
    const command = typeof message.command === "string" ? textForTail(message.command, 160, compact) : { text: shortValue(message.command, 160), truncated: false };
    const output = typeof message.output === "string" ? textForTail(message.output, 200, compact) : { text: shortValue(message.output, 200), truncated: false };
    return { entryId: record.id, text: [`  $ ${command.text}`, ...(output.text ? [`    ${output.text}`] : [])].join("\n"), truncated: command.truncated || output.truncated };
  }
  return { entryId: record.id, text: `[${role}]${text.text ? ` ${text.text}` : ""}`, truncated: text.truncated };
}

export function boundReferenceText(entries: SessionReadText[], tail: number) {
  const tailEntries = entries.slice(-sessionsReadTail(tail));
  let remaining = MAX_SESSION_READ_TEXT;
  let truncated = entries.length > tailEntries.length;
  const selected: SessionReadText[] = [];
  for (const entry of tailEntries.reverse()) {
    if (remaining <= 0) { truncated = true; break; }
    const bounded = truncateSessionText(entry.text, Math.min(MAX_SESSION_READ_ENTRY_TEXT, remaining));
    selected.push({ ...entry, text: bounded.text });
    remaining -= bounded.text.length;
    truncated ||= Boolean(entry.truncated) || bounded.truncated;
  }
  return { entries: selected.reverse(), truncated };
}

