import type { ContentBlock, SessionUpdate, StopReason, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { ImagePartDto, JsonValue, MessageDto, TextPartDto, ToolCallPartDto, TranscriptEventDto, TranscriptMessageDto } from "../../dto.js";
import { kiroContext as approvalContext } from "./approval-context.js";
import { object } from "./transport.js";

type Correlation = { executionId?: string; clientMessageId?: string; sourceClientId?: string };
/** ACP v1 sparse updates: absent and null optional fields leave previous values
 * intact. Raw input/output are unknown JSON and explicit null remains meaningful. */
export function mergeTool(previous: ToolCallUpdate | undefined, update: ToolCallUpdate): ToolCallUpdate {
  const next = { ...previous, toolCallId: update.toolCallId };
  for (const key of ["kind", "status", "title", "name", "content", "locations"] as const) {
    if (update[key] != null) Object.assign(next, { [key]: update[key] });
  }
  for (const key of ["rawInput", "rawOutput"] as const) if (Object.hasOwn(update, key)) next[key] = update[key];
  return next;
}
const safeJson = (value: unknown): JsonValue => {
  const context = approvalContext(value);
  return context === undefined ? { omitted: "Native context is unsafe, incomplete or too large to display" } : JSON.parse(context) as JsonValue;
};
function contentPart(content: ContentBlock, id: string): TextPartDto | ImagePartDto | undefined {
  if (content.type === "text" && typeof content.text === "string") return { type: "text", id, text: content.text };
  if (content.type === "image" && typeof content.data === "string" && typeof content.mimeType === "string"
    && /^image\/(png|jpeg|gif|webp)$/.test(content.mimeType) && content.data.length <= 4_000_000 && /^[A-Za-z0-9+/=\s]+$/.test(content.data)) {
    return { type: "image", id, mediaType: content.mimeType, data: content.data };
  }
}

/** Projection has no process, persistence, permission or settlement authority. */
export class KiroTranscript {
  private readonly items = new Map<string, TranscriptMessageDto>();
  private readonly tools = new Map<string, { native: ToolCallUpdate; executionId?: string; message: TranscriptMessageDto }>();
  private current?: TranscriptMessageDto;
  private serial = 0;
  constructor(private readonly sessionId: string, private readonly emit: (event: TranscriptEventDto) => void, private readonly observe: (kind: string) => void) {}
  messages(): MessageDto[] { return structuredClone([...this.items.values()]); }
  counts() {
    const values = [...this.items.values()];
    return { userMessages: values.filter((m) => m.role === "user").length, assistantMessages: values.filter((m) => m.role === "assistant").length,
      toolResults: values.flatMap((m) => m.parts).filter((p) => p.type === "toolCall" && p.result).length, totalMessages: values.length };
  }
  begin(input: string, correlation: Correlation) {
    this.current = undefined;
    this.chunk("user", { type: "text", text: input }, false, correlation);
    this.current = undefined;
  }
  staleTool(id: string, executionId: string): boolean {
    const tool = this.tools.get(id);
    return !!tool && tool.executionId !== executionId;
  }
  toolContext(id: string, executionId: string): ToolCallUpdate | undefined {
    const tool = this.tools.get(id);
    return tool?.executionId === executionId ? tool.native : undefined;
  }
  update(update: SessionUpdate, correlation: Correlation, replay: boolean): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": case "agent_thought_chunk": case "user_message_chunk":
        if (update.sessionUpdate === "user_message_chunk" && !replay) { this.observe("live-user-chunk"); return; }
        this.chunk(update.sessionUpdate === "user_message_chunk" ? "user" : "assistant", update.content,
          update.sessionUpdate === "agent_thought_chunk", correlation, update.messageId ?? undefined); return;
      case "tool_call": case "tool_call_update": this.tool(update, correlation); return;
      case "plan": {
        if (!Array.isArray(update.entries) || !update.entries.every((e) => typeof e.content === "string" && typeof e.status === "string")) { this.observe("invalid-plan"); return; }
        const id = "kiro:plan";
        const text = `Plan\n${update.entries.map((e) => `${e.status}: ${e.content}`).join("\n")}`;
        const message: TranscriptMessageDto = { id, role: "system", status: "completed", text, parts: [{ id: `${id}:text`, type: "text", text }] };
        this.items.set(id, message); this.emit({ type: "message_replace", sessionId: this.sessionId, message, final: true }); return;
      }
      default: this.observe(update.sessionUpdate);
    }
  }
  private chunk(role: "user" | "assistant", content: ContentBlock, thinking: boolean, correlation: Correlation, nativeId?: string): void {
    if (!object(content)) { this.observe("invalid-content"); return; }
    let message = this.current;
    if (!message || message.role !== role || message.executionId !== correlation.executionId || message.nativeItemId !== nativeId) {
      const id = nativeId ? `kiro:${role}:${nativeId}` : `kiro:message:${++this.serial}`;
      message = this.items.get(id);
      if (!message) {
        const created: TranscriptMessageDto = { id, role, isError: false, status: role === "user" ? "completed" : "streaming", parts: [], text: "", ...(nativeId ? { nativeItemId: nativeId } : {}),
          ...(correlation.executionId ? { executionId: correlation.executionId } : {}) };
        this.items.set(id, created);
        this.emit({ type: "message_start", sessionId: this.sessionId, ...correlation, message: created });
        message = created;
      }
      this.current = message;
    }
    if (!message) return;
    const type = thinking ? "thinking" : "text";
    let part = message.parts.at(-1);
    if (content.type === "text" && typeof content.text === "string") {
      if (!part || part.type !== type) {
        const created: TextPartDto | { type: "thinking"; id: string; text: string } = { id: `${message.id}:part:${message.parts.length}`, type, text: "" };
        message.parts.push(created);
        this.emit({ type: "message_part", sessionId: this.sessionId, messageId: message.id, index: message.parts.length - 1, part: created });
        part = created;
      }
      if (!part || part.type !== "text" && part.type !== "thinking") return;
      part.text += content.text;
      if (!thinking) message.text = (message.text ?? "") + content.text;
      this.emit({ type: "message_delta", sessionId: this.sessionId, ...correlation, messageId: message.id, partId: part.id, delta: content.text });
    } else {
      const image = contentPart(content, `${message.id}:part:${message.parts.length}`);
      if (!image || thinking) { this.observe(`content:${content.type}`); return; }
      message.parts.push(image);
      this.emit({ type: "message_part", sessionId: this.sessionId, messageId: message.id, index: message.parts.length - 1, part: image });
    }
  }
  private tool(update: ToolCallUpdate, correlation: Correlation): void {
    if (typeof update.toolCallId !== "string" || !update.toolCallId) { this.observe("invalid-tool"); return; }
    this.current = undefined;
    const old = this.tools.get(update.toolCallId);
    if (old && old.executionId !== correlation.executionId) { this.observe("stale-tool"); return; }
    const native = mergeTool(old?.native, update);
    const id = old?.message.id ?? `kiro:tool:${update.toolCallId}`;
    const status = native.status === "completed" ? "completed" : native.status === "failed" ? "error" : "running";
    const part: ToolCallPartDto = { id: `${id}:tool`, type: "toolCall", nativeItemId: native.toolCallId, toolCallId: native.toolCallId,
      toolName: typeof native.title === "string" && approvalContext(native.title) ? native.title : "Native tool", args: safeJson(native.rawInput), status };
    // Kiro 2.24.0 emits native read results as rawOutput.items[].Text, with
    // no ACP content array. Project only this captured shape, never stringify
    // arbitrary rawOutput or replace an explicitly supplied content array.
    const rawItems = object(native.rawOutput)?.items;
    if (native.content == null && Array.isArray(rawItems) && approvalContext(native.rawOutput)
      && rawItems.every((item) => object(item) && Object.keys(item).length === 1 && typeof item.Text === "string")) {
      part.result = { parts: rawItems.map((item, index) => ({ type: "text", id: `${id}:result:${index}`, text: item.Text as string })), isError: status === "error" };
    }
    if (Array.isArray(native.content)) {
      const parts: Array<TextPartDto | ImagePartDto> = [];
      const diffs: string[] = [];
      for (const [index, value] of native.content.entries()) {
        if (!object(value)) continue;
        if (value.type === "content" && object(value.content)) {
          const p = contentPart(value.content, `${id}:result:${index}`);
          if (p) parts.push(p); else this.observe("tool-content");
        } else if (value.type === "diff" && approvalContext(value) && typeof value.path === "string" && typeof value.newText === "string" && (value.oldText == null || typeof value.oldText === "string")) {
          diffs.push(`--- ${value.path}\n+++ ${value.path}\n${(value.oldText ?? "").split("\n").map((s) => `-${s}`).join("\n")}\n${value.newText.split("\n").map((s) => `+${s}`).join("\n")}`);
        } else this.observe("tool-content");
      }
      part.result = { parts, isError: status === "error", ...(diffs.length ? { details: { diff: diffs.join("\n") } } : {}) };
    }
    const message: TranscriptMessageDto = { id, role: "assistant", isError: false, nativeItemId: native.toolCallId, parts: [part], text: "",
      status: status === "running" ? "streaming" : "completed", ...(correlation.executionId ? { executionId: correlation.executionId } : {}) };
    this.tools.set(update.toolCallId, { native, executionId: correlation.executionId, message }); this.items.set(id, message);
    if (!old) this.emit({ type: "message_start", sessionId: this.sessionId, ...correlation, message });
    else this.emit({ type: "message_part", sessionId: this.sessionId, messageId: id, index: 0, part });
  }
  finish(executionId?: string, reason?: StopReason, error?: string): void {
    if (executionId && (reason || error) && ![...this.items.values()].some((m) => m.role === "assistant" && m.executionId === executionId)) {
      const id = `kiro:terminal:${++this.serial}`;
      const terminal: TranscriptMessageDto = { id, role: "assistant", isError: false, executionId, parts: [], text: "", status: "streaming" };
      this.items.set(id, terminal);
      this.emit({ type: "message_start", sessionId: this.sessionId, executionId, message: terminal });
    }
    for (const message of this.items.values()) {
      if (message.role !== "assistant" || message.executionId !== executionId) continue;
      message.status = error ? "error" : reason === "cancelled" ? "interrupted" : "completed";
      if (reason) message.stopReason = reason;
      if (error) { message.isError = true; message.errorMessage = error; }
      for (const part of message.parts) if (part.type === "toolCall" && part.status === "running") part.status = reason === "cancelled" ? "cancelled" : "error";
      this.emit({ type: "message_replace", sessionId: this.sessionId, message, final: true });
    }
    this.current = undefined;
  }
}
