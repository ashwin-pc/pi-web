import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { JsonValue, MessageDto, MessagePartDto, TranscriptEventDto, TranscriptMessageDto } from "../../dto.js";

type Correlation = { executionId?: string; clientMessageId?: string; sourceClientId?: string };
type WithoutSession<T> = T extends unknown ? Omit<T, "sessionId"> : never;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const json = (value: unknown): JsonValue => value === undefined ? null : JSON.parse(JSON.stringify(value)) as JsonValue;

/** Native content projection only; no session lifecycle, storage or dispatch policy. */
export class ClaudeTranscript {
  private readonly items = new Map<string, TranscriptMessageDto>();
  private readonly tools = new Map<string, { messageId: string; partId: string }>();
  private readonly seen = new Set<string>();
  private readonly wrappers = new Map<string, { messageId: string; partIds: string[] }>();
  private readonly streaming = new Map<string, { id: string; index: number; indices: Map<number, number> }>();
  private silent = false;

  constructor(private readonly sessionId: string, private readonly publish: (event: TranscriptEventDto) => void,
    private readonly unknown: (type: string) => void) {}

  messages(): MessageDto[] { return structuredClone([...this.items.values()]); }

  counts() {
    const messages = [...this.items.values()];
    return {
      userMessages: messages.filter((message) => message.role === "user").length,
      assistantMessages: messages.filter((message) => message.role === "assistant").length,
      toolResults: messages.reduce((count, message) => count + message.parts.filter((part) => part.type === "toolCall" && part.result).length + (message.role === "toolResult" ? 1 : 0), 0),
      totalMessages: messages.length,
    };
  }

  load(history: SessionMessage[]): void {
    this.silent = true;
    try {
      for (const entry of history) {
        if (entry.type === "assistant") this.assistant({ ...entry, message: entry.message }, {});
        else if (entry.type === "user") this.user({ ...entry, message: entry.message }, {});
        else this.notice(entry.uuid, text(object(entry.message).content) || text(object(entry.message).message), {});
      }
    } finally { this.silent = false; }
  }

  private event(event: WithoutSession<TranscriptEventDto>, correlation: Correlation): void {
    if (!this.silent) this.publish(structuredClone({ ...event, ...correlation, sessionId: this.sessionId }) as TranscriptEventDto);
  }

  private assistantItem(nativeId: string, correlation: Correlation, parent?: unknown): TranscriptMessageDto {
    const id = `claude:assistant:${nativeId}`;
    let item = this.items.get(id);
    if (!item) {
      item = { id, role: "assistant", isError: false, parts: [], text: "", status: "streaming", nativeItemId: nativeId,
        ...(correlation.executionId ? { executionId: correlation.executionId } : {}),
        ...(typeof parent === "string" ? { details: { parentToolUseId: parent } } : {}) };
      this.items.set(id, item);
      this.event({ type: "message_start", message: item }, correlation);
    }
    return item;
  }

  private part(block: Record<string, unknown>, id: string): MessagePartDto | undefined {
    if (block.type === "text") return { id, type: "text", text: text(block.text) };
    if (block.type === "thinking") return { id, type: "thinking", text: text(block.thinking) };
    if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
      return { id, type: "toolCall", toolCallId: block.id, nativeItemId: block.id, toolName: block.name, args: json(block.input ?? {}), status: "running" };
    }
    const source = object(block.source);
    if (block.type === "image" && source.type === "base64" && typeof source.data === "string" && typeof source.media_type === "string") {
      return { id, type: "image", mediaType: source.media_type, data: source.data };
    }
    // Redacted thinking is not text; never synthesize reasoning from its payload.
    this.unknown(text(block.type) || "invalid_content_block");
    return undefined;
  }

  private upsert(item: TranscriptMessageDto, part: MessagePartDto, index: number, correlation: Correlation): void {
    item.parts[index] = part;
    item.text = item.parts.filter((candidate) => candidate?.type === "text").map((candidate) => candidate.type === "text" ? candidate.text : "").join("");
    if (part.type === "toolCall") this.tools.set(part.toolCallId, { messageId: item.id, partId: part.id });
    this.event({ type: "message_part", messageId: item.id, index, part }, correlation);
  }

  stream(envelope: Record<string, unknown>, correlation: Correlation): void {
    const event = object(envelope.event);
    const key = text(envelope.parent_tool_use_id);
    if (event.type === "message_start") {
      const message = object(event.message);
      if (!text(message.id)) return this.unknown("stream_without_message_id");
      this.streaming.set(key, { id: text(message.id), index: -1, indices: new Map() });
      this.assistantItem(text(message.id), correlation, envelope.parent_tool_use_id);
      return;
    }
    const current = this.streaming.get(key);
    if (!current) return this.unknown("orphan_stream_event");
    const item = this.assistantItem(current.id, correlation, envelope.parent_tool_use_id);
    const index = typeof event.index === "number" && Number.isSafeInteger(event.index) && event.index >= 0 && event.index < 10000 ? event.index : -1;
    if (event.type === "content_block_start" && index >= 0) {
      const partIndex = current.indices.get(index) ?? item.parts.length;
      const part = this.part(object(event.content_block), `${item.id}:part:${index}`);
      current.index = part ? partIndex : -1;
      if (part) { current.indices.set(index, partIndex); this.upsert(item, part, partIndex, correlation); }
    } else if (event.type === "content_block_delta" && index >= 0) {
      const partIndex = current.indices.get(index);
      const part = partIndex === undefined ? undefined : item.parts[partIndex];
      const delta = object(event.delta);
      if ((part?.type === "text" && delta.type === "text_delta") || (part?.type === "thinking" && delta.type === "thinking_delta")) {
        const addition = part.type === "text" ? text(delta.text) : text(delta.thinking);
        part.text += addition;
        item.text = item.parts.filter((candidate) => candidate?.type === "text").map((candidate) => candidate.type === "text" ? candidate.text : "").join("");
        this.event({ type: "message_delta", messageId: item.id, partId: part.id, delta: addition }, correlation);
      } else if (delta.type !== "input_json_delta" && delta.type !== "signature_delta") this.unknown(text(delta.type) || "invalid_delta");
      // Tool JSON deltas may be invalid prefixes; the complete native tool block
      // supplies authoritative args. Do not invent parsed input or duplicate it.
    } else if (event.type === "content_block_stop") {
      current.index = -1;
    } else if (event.type === "message_stop") {
      item.status = "completed";
      this.event({ type: "message_replace", message: item, final: true }, correlation);
      this.streaming.delete(key);
    } else if (event.type !== "message_delta" && event.type !== "ping") this.unknown(text(event.type) || "invalid_stream_event");
  }

  assistant(envelope: Record<string, unknown>, correlation: Correlation): void {
    const uuid = text(envelope.uuid);
    if (uuid && this.seen.has(uuid)) return;
    if (uuid) this.seen.add(uuid);
    const body = object(envelope.message);
    const nativeId = text(body.id) || uuid;
    if (!nativeId || !Array.isArray(body.content)) return this.unknown("invalid_assistant_message");
    if (Array.isArray(envelope.supersedes)) {
      for (const replaced of envelope.supersedes) {
        const old = typeof replaced === "string" ? this.wrappers.get(replaced) : undefined;
        const item = old && this.items.get(old.messageId);
        if (item && old) {
          item.parts = item.parts.filter((part) => !old.partIds.includes(part.id));
          item.text = item.parts.filter((part) => part.type === "text").map((part) => part.type === "text" ? part.text : "").join("");
          this.event({ type: "message_replace", message: item, final: item.status !== "streaming" }, correlation);
        }
      }
    }
    const item = this.assistantItem(nativeId, correlation, envelope.parent_tool_use_id);
    const current = this.streaming.get(text(envelope.parent_tool_use_id));
    const partIds: string[] = [];
    for (const [offset, value] of body.content.entries()) {
      const block = object(value);
      let index = block.type === "tool_use" ? item.parts.findIndex((part) => part?.type === "toolCall" && part.toolCallId === block.id) : -1;
      if (index < 0 && current?.id === nativeId && current.index >= 0) index = current.index + offset;
      if (index < 0) index = item.parts.length;
      const part = this.part(block, item.parts[index]?.id ?? `${item.id}:part:${index}`);
      if (!part) continue;
      if (part.type !== "toolCall") part.nativeItemId = uuid || undefined;
      const previous = item.parts[index];
      if (part.type === "toolCall" && previous?.type === "toolCall" && previous.result) { part.result = previous.result; part.status = previous.status; }
      this.upsert(item, part, index, correlation);
      partIds.push(part.id);
    }
    if (uuid) this.wrappers.set(uuid, { messageId: item.id, partIds });
    if (typeof envelope.timestamp === "string") item.timestamp = envelope.timestamp;
    if (body.stop_reason) item.stopReason = text(body.stop_reason);
    if (envelope.error && item.role === "assistant") { item.isError = true; item.errorMessage = text(envelope.error); }
    item.status = envelope.aborted === true ? "interrupted" : envelope.error ? "error" : current?.id === nativeId ? "streaming" : "completed";
    this.event({ type: "message_replace", message: item, final: item.status !== "streaming" }, correlation);
  }

  user(envelope: Record<string, unknown>, correlation: Correlation): void {
    const uuid = text(envelope.uuid);
    if (uuid && this.seen.has(uuid)) {
      const item = this.items.get(`claude:user:${uuid}`);
      if (item && !item.timestamp && typeof envelope.timestamp === "string") {
        item.timestamp = envelope.timestamp;
        this.event({ type: "message_replace", message: item, final: true }, correlation);
      }
      return;
    }
    if (uuid) this.seen.add(uuid);
    const body = object(envelope.message);
    const content = typeof body.content === "string" ? [{ type: "text", text: body.content }] : Array.isArray(body.content) ? body.content : [];
    const ordinary: unknown[] = [];
    for (const value of content) {
      const block = object(value);
      if (block.type !== "tool_result") { ordinary.push(value); continue; }
      const toolId = text(block.tool_use_id);
      const location = this.tools.get(toolId);
      const item = location && this.items.get(location.messageId);
      const index = item?.parts.findIndex((part) => part?.id === location?.partId) ?? -1;
      const part = index >= 0 ? item?.parts[index] : undefined;
      const raw = typeof block.content === "string" ? [{ type: "text", text: block.content }] : Array.isArray(block.content) ? block.content : [];
      const results = raw.map((entry, n) => this.part(object(entry), `claude:result:${toolId}:${n}`)).filter((entry): entry is Extract<MessagePartDto, { type: "text" | "image" }> => entry?.type === "text" || entry?.type === "image");
      if (item && part?.type === "toolCall") {
        part.result = { parts: results, isError: block.is_error === true, ...(envelope.tool_use_result === undefined ? {} : { details: json(envelope.tool_use_result) }) };
        part.status = block.is_error === true ? "error" : "completed";
        this.upsert(item, part, index, correlation);
      } else {
        const id = `claude:tool-result:${uuid || toolId}`;
        const message: TranscriptMessageDto = { id, role: "toolResult", toolCallId: toolId, isError: block.is_error === true, parts: results, status: "completed", ...(envelope.tool_use_result === undefined ? {} : { details: json(envelope.tool_use_result) }), ...(correlation.executionId ? { executionId: correlation.executionId } : {}) };
        this.items.set(id, message);
        this.event({ type: "message_start", message }, correlation);
      }
    }
    if (!ordinary.length || !uuid) return;
    const id = `claude:user:${uuid}`;
    const parts = ordinary.map((entry, index) => this.part(object(entry), `${id}:part:${index}`)).filter((part): part is MessagePartDto => Boolean(part));
    const message: TranscriptMessageDto = { id, role: "user", parts, nativeItemId: uuid, status: "completed",
      text: parts.filter((part) => part.type === "text").map((part) => part.type === "text" ? part.text : "").join(""),
      ...(correlation.executionId ? { executionId: correlation.executionId } : {}), ...(typeof envelope.timestamp === "string" ? { timestamp: envelope.timestamp } : {}) };
    this.items.set(id, message);
    this.event({ type: "message_start", message }, correlation);
  }

  notice(nativeId: string, content: string, correlation: Correlation): void {
    if (!content || this.seen.has(nativeId)) return;
    this.seen.add(nativeId);
    const id = `claude:system:${nativeId}`;
    const message: TranscriptMessageDto = { id, role: "system", parts: [{ id: `${id}:text`, type: "text", text: content }], text: content, status: "completed" };
    this.items.set(id, message);
    this.event({ type: "message_start", message }, correlation);
  }

  finish(executionId: string, status: "completed" | "error" | "interrupted"): void {
    for (const message of this.items.values()) {
      if (message.executionId !== executionId || message.role !== "assistant") continue;
      message.status = status;
      if (status === "error") message.isError = true;
      if (status === "interrupted") for (const part of message.parts) if (part?.type === "toolCall" && part.status === "running") part.status = "cancelled";
      this.event({ type: "message_replace", message, final: true }, { executionId });
    }
  }
}
