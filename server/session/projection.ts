import type {
  ConversationTreeDTO,
  ConversationTreeNodeDTO,
  MessageEntryRefDTO,
  SessionStateDTO,
  SessionStateProjectionInput,
  SessionStatsDTO,
  SimplifiedMessageDTO,
  SimplifiedModelDTO,
} from "./dto.js";

export type ToolCallArgumentMap = ReadonlyMap<string, Record<string, unknown>>;

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" ? value as UnknownRecord : undefined;
}

export function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    const value = asRecord(part);
    if (!value) return "";
    if (value.type === "text" && typeof value.text === "string") return value.text;
    if (value.type === "image") return "[image]";
    // toolCall parts are rendered as tool cards in the UI — omit from text
    return "";
  }).filter(Boolean).join("\n");
}

export function simplifyModel(model: unknown): SimplifiedModelDTO | undefined {
  if (!model) return undefined;
  const value = model as UnknownRecord;
  return {
    provider: value.provider,
    id: value.id,
    name: value.name || value.id,
    reasoning: Boolean(value.reasoning),
    contextWindow: value.contextWindow,
    maxTokens: value.maxTokens,
  };
}

export function hasUserMessages(messages: readonly unknown[]): boolean {
  return messages.some((message) => asRecord(message)?.role === "user");
}

function appendMessageEntryRef(refs: MessageEntryRefDTO[], entry: unknown) {
  const value = asRecord(entry);
  if (!value) return;
  if (value.type === "message" || value.type === "custom_message" || value.type === "branch_summary" && value.summary) {
    const entryId = typeof value.id === "string" && value.id.trim() ? value.id : undefined;
    refs.push({ entryId });
  }
}

/** Projects a session-manager branch without accessing the manager itself. */
export function messageEntryRefs(branch: readonly unknown[]): MessageEntryRefDTO[] {
  const refs: MessageEntryRefDTO[] = [];
  let compaction: UnknownRecord | undefined;
  for (const entry of branch) {
    const value = asRecord(entry);
    if (value?.type === "compaction") compaction = value;
  }

  if (!compaction) {
    for (const entry of branch) appendMessageEntryRef(refs, entry);
    return refs;
  }

  const compactionId = typeof compaction.id === "string" && compaction.id.trim() ? compaction.id : undefined;
  refs.push({ entryId: compactionId });
  const compactionIndex = branch.findIndex((entry) => asRecord(entry)?.type === "compaction" && asRecord(entry)?.id === compaction.id);
  let foundFirstKept = false;
  for (let index = 0; index < compactionIndex; index += 1) {
    const entry = asRecord(branch[index]);
    if (entry?.id === compaction.firstKeptEntryId) foundFirstKept = true;
    if (foundFirstKept) appendMessageEntryRef(refs, entry);
  }
  for (let index = compactionIndex + 1; index < branch.length; index += 1) appendMessageEntryRef(refs, branch[index]);
  return refs;
}

function assistantHttpErrorStatus(code: string) {
  return code in assistantHttpErrorLabels || /^[45]\d\d$/.test(code);
}

const assistantHttpErrorLabels: Record<string, string> = {
  "429": "Throttling error",
  "500": "Server error",
  "502": "Bad gateway",
  "503": "Service unavailable",
  "504": "Gateway timeout",
  "529": "Overloaded",
};

function assistantStatusLabel(label: string | undefined, code: string) {
  const clean = (label || "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!clean || /^(?:http|status|error|request failed|model request failed)$/i.test(clean)) return assistantHttpErrorLabels[code] || `HTTP ${code}`;
  return clean;
}

function assistantStatusErrorPreview(text: string) {
  const labelled = text.match(/^([A-Za-z][A-Za-z0-9 _/-]*?):\s*(\d{3})(?=$|[\s:,-])/);
  if (labelled && assistantHttpErrorStatus(labelled[2])) return `${assistantStatusLabel(labelled[1], labelled[2])} (${labelled[2]})`;
  const leading = text.match(/^(?:HTTP\s*)?(\d{3})(?=$|[\s:,-])/i);
  if (leading && assistantHttpErrorStatus(leading[1])) return `${assistantStatusLabel(undefined, leading[1])} (${leading[1]})`;
  const generic = text.match(/^(Error|Request failed|Model request failed)\s*:?\s*(\d{3})(?=$|[\s:,-])/i);
  if (generic && assistantHttpErrorStatus(generic[2])) return `${assistantStatusLabel(generic[1], generic[2])} (${generic[2]})`;
  return "";
}

function assistantParsedErrorDetail(parsed: unknown) {
  if (typeof parsed === "string") return parsed.trim();
  const value = asRecord(parsed);
  if (!value) return "";
  if (value.error && typeof value.error === "object") {
    const error = value.error as UnknownRecord;
    return error.message || error.type || "";
  }
  return value.message || value.detail || value.error_description || "";
}

function assistantJsonErrorPreview(text: string) {
  const trimmed = text.trim();
  if (!((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]")))) return "";
  try {
    const detail = assistantParsedErrorDetail(JSON.parse(trimmed));
    return detail ? `Error: ${detail}` : "";
  } catch {
    return "";
  }
}

export function assistantErrorPreview(message: unknown) {
  const raw = String(asRecord(message)?.errorMessage || "").trim();
  if (!raw) return "";
  const jsonText = raw.replace(/^Codex error:\s*/i, "").trim();
  return assistantJsonErrorPreview(jsonText)
    || assistantStatusErrorPreview(jsonText)
    || assistantStatusErrorPreview(raw)
    || (raw.length > 180 ? `${raw.slice(0, 179)}…` : raw);
}

export function assistantStopReasonPreview(message: unknown) {
  const reason = String(asRecord(message)?.stopReason || "").trim();
  if (!reason || reason === "stop" || reason === "toolUse") return "";
  if (reason === "length") return "Response stopped because the model hit its output length limit.";
  if (reason === "aborted") return "Response was aborted.";
  return `Response stopped unexpectedly: ${reason}`;
}

/** The input may already contain host-derived fields such as tool startedAt. */
export function simplifyMessage(message: unknown, toolCallArgs?: ToolCallArgumentMap, entryId?: string): SimplifiedMessageDTO | unknown {
  const value = asRecord(message);
  if (!value) return message;
  const entry = entryId ? { entryId } : {};
  if (value.role === "bashExecution") {
    return {
      ...entry,
      role: "bashExecution",
      command: value.command,
      output: value.output,
      exitCode: value.exitCode,
      cancelled: Boolean(value.cancelled),
      truncated: Boolean(value.truncated),
      fullOutputPath: value.fullOutputPath,
      excludeFromContext: Boolean(value.excludeFromContext),
      timestamp: value.timestamp,
      raw: value,
    };
  }
  if (value.role === "toolResult") {
    const toolCallId = value.toolCallId;
    const args = toolCallArgs?.get(toolCallId as string);
    return {
      ...entry,
      role: "toolResult",
      toolCallId,
      toolName: value.toolName,
      toolArgs: args,
      isError: Boolean(value.isError),
      text: textFromContent(value.content),
      timestamp: value.timestamp,
      raw: value,
    };
  }
  const text = textFromContent(value.content);
  const errorText = value.role === "assistant" && value.errorMessage ? assistantErrorPreview(value) : "";
  const stopReasonText = value.role === "assistant" && !errorText ? assistantStopReasonPreview(value) : "";
  const displayText = errorText || (text && stopReasonText ? `${text}\n\n${stopReasonText}` : stopReasonText || text);
  const toolCalls = value.role === "assistant" && Array.isArray(value.content)
    ? value.content.filter((part) => asRecord(part)?.type === "toolCall").map((part) => {
      const toolCall = asRecord(part)!;
      return {
        id: toolCall.id,
        toolName: toolCall.toolName || toolCall.name || "tool",
        args: toolCall.arguments || toolCall.args || {},
        startedAt: toolCall.startedAt,
      };
    })
    : undefined;
  return {
    ...entry,
    role: value.role,
    text: displayText,
    toolCalls,
    isError: Boolean(value.errorMessage || value.stopReason === "error" || stopReasonText),
    timestamp: value.timestamp,
    raw: value,
  };
}

function truncatePreview(value: string, max = 220) {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function entryMessage(entry: unknown): UnknownRecord | undefined {
  const value = asRecord(entry);
  if (value?.type === "message") return asRecord(value.message);
  if (value?.type === "custom_message") return { role: "custom", content: value.content, timestamp: value.timestamp };
  return undefined;
}

function messageToolCalls(message: unknown): UnknownRecord[] {
  const content = asRecord(message)?.content;
  return Array.isArray(content) ? content.filter((part): part is UnknownRecord => asRecord(part)?.type === "toolCall") : [];
}

function toolCallName(part: UnknownRecord) {
  return String(part.toolName || part.name || "tool");
}

function toolCallArgs(part: UnknownRecord): Record<string, unknown> {
  const args = part.arguments || part.args;
  return args && typeof args === "object" ? args as Record<string, unknown> : {};
}

function shortArg(value: unknown, max = 90) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function toolCallPreview(part: UnknownRecord) {
  const name = toolCallName(part);
  const args = toolCallArgs(part);
  if (name === "bash" && typeof args.command === "string") return `Tool call: bash ${shortArg(args.command, 120)}`;
  if (typeof args.path === "string") return `Tool call: ${name} ${shortArg(args.path, 120)}`;
  if (typeof args.query === "string") return `Tool call: ${name} ${shortArg(args.query, 120)}`;
  if (typeof args.pattern === "string") return `Tool call: ${name} ${shortArg(args.pattern, 120)}`;
  const first = Object.entries(args).find(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean");
  return first ? `Tool call: ${name} ${first[0]}=${shortArg(first[1], 90)}` : `Tool call: ${name}`;
}

function toolCallsPreview(message: unknown) {
  const calls = messageToolCalls(message);
  if (calls.length === 0) return "";
  const [first] = calls;
  const suffix = calls.length > 1 ? ` + ${calls.length - 1} more` : "";
  return `${toolCallPreview(first)}${suffix}`;
}

function messageTextPreview(message: unknown) {
  return textFromContent(asRecord(message)?.content || "");
}

function entryRole(entry: unknown) {
  const message = entryMessage(entry);
  if (message?.role === "assistant" && !messageTextPreview(message).trim()) {
    if (messageToolCalls(message).length > 0) return "toolCall";
    if (message.errorMessage || assistantStopReasonPreview(message)) return "error";
  }
  if (message?.role) return String(message.role);
  switch (asRecord(entry)?.type) {
    case "branch_summary": return "branchSummary";
    case "compaction": return "compaction";
    case "model_change": return "model";
    case "thinking_level_change": return "thinking";
    case "session_info": return "session";
    case "label": return "label";
    case "custom": return "custom";
    default: return String(asRecord(entry)?.type || "entry");
  }
}

function entryPreview(entry: unknown): string {
  const value = asRecord(entry);
  const message = entryMessage(entry);
  if (message) {
    if (message.role === "toolResult") {
      const text = textFromContent(message.content);
      return `Tool result: ${message.toolName || "tool"}${text ? ` — ${text}` : ""}`;
    }
    const text = messageTextPreview(message);
    if (text.trim()) return text;
    const calls = toolCallsPreview(message);
    if (calls) return calls;
    const error = assistantErrorPreview(message);
    if (error) return error;
    const stopReason = assistantStopReasonPreview(message);
    if (stopReason) return stopReason;
    return message.role === "assistant" ? "Empty assistant message" : `${message.role || "Message"} message`;
  }
  switch (value?.type) {
    case "branch_summary": return value.summary as string || "Branch summary";
    case "compaction": return value.summary as string || "Compaction summary";
    case "model_change": return `Model changed to ${value.provider || "provider"}/${value.modelId || "model"}`;
    case "thinking_level_change": return `Thinking level changed to ${value.thinkingLevel || "unknown"}`;
    case "session_info": return value.name ? `Session named ${value.name}` : "Session name cleared";
    case "label": return value.label ? `Label ${value.targetId || "entry"} as ${value.label}` : `Clear label on ${value.targetId || "entry"}`;
    case "custom": return `Custom entry${value.customType ? `: ${value.customType}` : ""}`;
    default: return String(value?.type || "Entry");
  }
}

function simpleTreeNode(node: unknown, activePathIds: ReadonlySet<string>, leafId: string | null, childCount: number): ConversationTreeNodeDTO {
  const nodeValue = asRecord(node);
  const entry = asRecord(nodeValue?.entry) || nodeValue;
  const id = String(entry?.id || "");
  return {
    id,
    parentId: typeof entry?.parentId === "string" ? entry.parentId : null,
    type: String(entry?.type || "entry"),
    role: entryRole(entry),
    preview: truncatePreview(entryPreview(entry)),
    timestamp: String(entry?.timestamp || ""),
    label: typeof nodeValue?.label === "string" ? nodeValue.label : undefined,
    labelTimestamp: typeof nodeValue?.labelTimestamp === "string" ? nodeValue.labelTimestamp : undefined,
    childCount,
    isOnActivePath: activePathIds.has(id),
    isCurrentLeaf: Boolean(leafId && id === leafId),
    children: [],
  };
}

function simplifyTreeNodesFlat(roots: readonly unknown[], activePathIds: ReadonlySet<string>, leafId: string | null): ConversationTreeNodeDTO[] {
  const nodes: ConversationTreeNodeDTO[] = [];
  const stack = [...roots].reverse();
  while (stack.length > 0) {
    const node = stack.pop();
    const children = Array.isArray(asRecord(node)?.children) ? asRecord(node)!.children as unknown[] : [];
    nodes.push(simpleTreeNode(node, activePathIds, leafId, children.length));
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
  }
  return nodes;
}

export function projectConversationTree(input: { sessionId: string; roots: readonly unknown[]; leafId: string | null; activePath: readonly unknown[] }): ConversationTreeDTO {
  const activePathIds = new Set(input.activePath.map((entry) => String(asRecord(entry)?.id || "")).filter(Boolean));
  const nodes = simplifyTreeNodesFlat(input.roots, activePathIds, input.leafId);
  return {
    ok: true,
    sessionId: input.sessionId,
    leafId: input.leafId,
    activePathIds: Array.from(activePathIds),
    entryCount: nodes.length,
    branchPointCount: nodes.filter((node) => node.childCount > 1).length,
    nodes,
  };
}

export function messageRole(message: unknown) {
  const value = asRecord(message);
  return String(value?.role || asRecord(value?.raw)?.role || "");
}

export function messageStopReason(message: unknown) {
  const value = asRecord(message);
  return String(value?.stopReason || asRecord(value?.raw)?.stopReason || "");
}

export function messageErrorText(message: unknown) {
  const value = asRecord(message);
  return typeof value?.errorMessage === "string"
    ? value.errorMessage
    : typeof asRecord(value?.raw)?.errorMessage === "string"
      ? asRecord(value?.raw)!.errorMessage as string
      : "";
}

export function isAssistantFailureMessage(message: unknown) {
  return messageRole(message) === "assistant" && (messageStopReason(message) === "error" || Boolean(messageErrorText(message).trim()));
}

export function isAssistantAbortedMessage(message: unknown) {
  return messageRole(message) === "assistant" && messageStopReason(message) === "aborted";
}

export function isIncompleteToolResultMessage(message: unknown) {
  return messageRole(message) === "toolResult";
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function projectSessionStats(entries: readonly unknown[], contextUsage: unknown): SessionStatsDTO {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let toolResults = 0;

  for (const message of entries) {
    const value = asRecord(message);
    if (!value) continue;
    if (value.role === "user") userMessages++;
    if (value.role === "toolResult") toolResults++;
    if (value.role !== "assistant") continue;
    assistantMessages++;
    const usage = asRecord(value.usage) || {};
    input += finiteNumber(usage.input);
    output += finiteNumber(usage.output);
    cacheRead += finiteNumber(usage.cacheRead);
    cacheWrite += finiteNumber(usage.cacheWrite);
    const usageCost = asRecord(usage.cost) || {};
    const totalCost = finiteNumber(usageCost.total);
    cost += totalCost || finiteNumber(usageCost.input) + finiteNumber(usageCost.output) + finiteNumber(usageCost.cacheRead) + finiteNumber(usageCost.cacheWrite);
  }

  return {
    userMessages,
    assistantMessages,
    toolResults,
    totalMessages: entries.length,
    tokens: { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite },
    cost,
    contextUsage,
  };
}

export function projectSessionTitle(sessionName: string | undefined, messages: readonly unknown[]): string {
  if (sessionName) return sessionName;
  for (const message of messages) {
    const value = asRecord(message);
    const text = textFromContent(value?.content).trim();
    if (value?.role === "user" && text) return truncatePreview(text, 80);
  }
  return "New session";
}

export function projectSessionState(input: SessionStateProjectionInput): SessionStateDTO {
  return {
    ...input,
    model: simplifyModel(input.model),
  };
}
