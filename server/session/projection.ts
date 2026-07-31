import type { PiWebSession } from "../types.js";
import { jsonRoundTrip, type BaseSessionStateDto, type ConversationTreeDto, type MessageDto, type ModelDto, type SessionStatsDto, type SlashCommandDto } from "./dto.js";

export type ContentDecorator = (content: unknown) => unknown;

const warnedUnknownMessageRoles = new Set<string>();

export function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const p = part as Record<string, unknown>;
    if (p.type === "text" && typeof p.text === "string") return p.text;
    if (p.type === "image") return "[image]";
    // toolCall parts are rendered as tool cards in the UI — omit from text
    return "";
  }).filter(Boolean).join("\n");
}

export function simplifyModel(model: any): ModelDto | undefined {
  if (!model) return undefined;
  return {
    provider: model.provider,
    id: model.id,
    name: model.name || model.id,
    reasoning: Boolean(model.reasoning),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}


export function appendMessageEntryRef(refs: Array<{ entryId?: string }>, entry: any) {
  if (!entry || typeof entry !== "object") return;
  if (entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary" && entry.summary) {
    const entryId = typeof entry.id === "string" && entry.id.trim() ? entry.id : undefined;
    refs.push({ entryId });
  }
}

export function messageEntryRefs(targetSession: PiWebSession): Array<{ entryId?: string }> {
  const getBranch = targetSession.sessionManager?.getBranch;
  if (typeof getBranch !== "function") return [];

  let branch: any[];
  try {
    branch = getBranch.call(targetSession.sessionManager);
  } catch {
    return [];
  }
  if (!Array.isArray(branch)) return [];

  const refs: Array<{ entryId?: string }> = [];
  let compaction: any | undefined;
  for (const entry of branch) {
    if (entry?.type === "compaction") compaction = entry;
  }

  if (!compaction) {
    for (const entry of branch) appendMessageEntryRef(refs, entry);
    return refs;
  }

  const compactionId = typeof compaction.id === "string" && compaction.id.trim() ? compaction.id : undefined;
  refs.push({ entryId: compactionId });
  const compactionIndex = branch.findIndex((entry) => entry?.type === "compaction" && entry?.id === compaction.id);
  let foundFirstKept = false;
  for (let index = 0; index < compactionIndex; index += 1) {
    const entry = branch[index];
    if (entry?.id === compaction.firstKeptEntryId) foundFirstKept = true;
    if (foundFirstKept) appendMessageEntryRef(refs, entry);
  }
  for (let index = compactionIndex + 1; index < branch.length; index += 1) appendMessageEntryRef(refs, branch[index]);
  return refs;
}

export function simplifyMessage(
  message: unknown,
  options: { toolCallArgs?: Map<string, Record<string, unknown>>; decorateContent?: ContentDecorator; entryId?: string } = {},
): MessageDto | undefined {
  if (!message || typeof message !== "object") return undefined;
  const m = message as Record<string, unknown>;
  const content = options.decorateContent ? options.decorateContent(m.content) : m.content;
  const entry = options.entryId ? { entryId: options.entryId } : {};
  const toolCallArgs = options.toolCallArgs;
  if (m.role === "bashExecution") {
    return jsonRoundTrip({
      ...entry,
      role: "bashExecution",
      command: m.command,
      output: m.output,
      exitCode: m.exitCode,
      cancelled: Boolean(m.cancelled),
      truncated: Boolean(m.truncated),
      fullOutputPath: m.fullOutputPath,
      excludeFromContext: Boolean(m.excludeFromContext),
      timestamp: m.timestamp,
      raw: m,
    }) as MessageDto;
  }
  if (m.role === "toolResult") {
    const args = toolCallArgs?.get(m.toolCallId as string);
    return jsonRoundTrip({
      ...entry,
      role: "toolResult",
      toolCallId: m.toolCallId,
      toolName: m.toolName,
      toolArgs: args,
      isError: Boolean(m.isError),
      text: textFromContent(m.content),
      timestamp: m.timestamp,
      raw: m,
    }) as MessageDto;
  }
  if (m.role === "custom") {
    if (m.display === false) return undefined;
    return jsonRoundTrip({
      ...entry,
      role: "custom",
      customType: typeof m.customType === "string" ? m.customType : "",
      text: textFromContent(content),
      details: m.details,
      display: true,
      timestamp: m.timestamp,
      raw: content === m.content ? m : { ...m, content },
    }) as MessageDto;
  }
  if (!["user", "assistant", "system", "compactionSummary", "branchSummary"].includes(String(m.role))) {
    const originalRole = typeof m.role === "string" && m.role ? m.role : "unknown";
    if (!warnedUnknownMessageRoles.has(originalRole)) {
      warnedUnknownMessageRoles.add(originalRole);
      console.warn(`Projecting unknown transcript message role: ${originalRole}`);
    }
    return jsonRoundTrip({
      ...entry,
      role: "unknown",
      originalRole,
      text: textFromContent(content),
      timestamp: m.timestamp,
      raw: content === m.content ? m : { ...m, content },
    }) as MessageDto;
  }
  const text = textFromContent(content);
  const errorText = m.role === "assistant" && m.errorMessage ? assistantErrorPreview(m) : "";
  const stopReasonText = m.role === "assistant" && !errorText ? assistantStopReasonPreview(m) : "";
  const displayText = errorText || (text && stopReasonText ? `${text}\n\n${stopReasonText}` : stopReasonText || text);
  const toolCalls = m.role === "assistant" && Array.isArray(content)
    ? content.filter((part: any) => part?.type === "toolCall").map((part: any) => ({
      id: part.id,
      toolName: part.toolName || part.name || "tool",
      args: part.arguments || part.args || {},
      startedAt: part.startedAt,
    }))
    : undefined;
  return jsonRoundTrip({
    ...entry,
    role: m.role,
    text: displayText,
    toolCalls,
    isError: Boolean(m.errorMessage || m.stopReason === "error" || stopReasonText),
    timestamp: m.timestamp,
    raw: content === m.content ? m : { ...m, content },
  }) as MessageDto;
}

function messageProjectionContext(targetSession: PiWebSession) {
  const toolCallArgs = new Map<string, Record<string, unknown>>();
  for (const message of targetSession.messages as any[]) {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part?.type === "toolCall" && part.id) toolCallArgs.set(part.id, part.arguments || {});
    }
  }
  return { toolCallArgs, refs: messageEntryRefs(targetSession) };
}

export function projectMessages(targetSession: PiWebSession): MessageDto[] {
  const { toolCallArgs, refs } = messageProjectionContext(targetSession);
  return targetSession.messages.flatMap((message, index) => {
    const projected = simplifyMessage(message, { toolCallArgs, entryId: refs[index]?.entryId });
    return projected ? [projected] : [];
  });
}

export function projectCommittedMessage(targetSession: PiWebSession, committed: unknown): MessageDto | undefined {
  const serialized = JSON.stringify(committed);
  let index = targetSession.messages.lastIndexOf(committed as never);
  if (index < 0 && serialized !== undefined) {
    for (let candidate = targetSession.messages.length - 1; candidate >= 0; candidate -= 1) {
      if (JSON.stringify(targetSession.messages[candidate]) === serialized) {
        index = candidate;
        break;
      }
    }
  }
  if (index < 0) return undefined;
  const { toolCallArgs, refs } = messageProjectionContext(targetSession);
  return simplifyMessage(targetSession.messages[index], { toolCallArgs, entryId: refs[index]?.entryId });
}

export function truncatePreview(value: string, max = 220) {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function entryMessage(entry: any) {
  if (entry?.type === "message") return entry.message;
  if (entry?.type === "custom_message") return {
    role: "custom",
    customType: entry.customType,
    content: entry.content,
    details: entry.details,
    display: entry.display,
    timestamp: entry.timestamp,
  };
  return undefined;
}

export function messageToolCalls(message: any) {
  return Array.isArray(message?.content)
    ? message.content.filter((part: any) => part?.type === "toolCall")
    : [];
}

export function toolCallName(part: any) {
  return String(part?.toolName || part?.name || "tool");
}

export function toolCallArgs(part: any) {
  const args = part?.arguments || part?.args;
  return args && typeof args === "object" ? args as Record<string, unknown> : {};
}

export function shortArg(value: unknown, max = 90) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function toolCallPreview(part: any) {
  const name = toolCallName(part);
  const args = toolCallArgs(part);
  if (name === "bash" && typeof args.command === "string") return `Tool call: bash ${shortArg(args.command, 120)}`;
  if (typeof args.path === "string") return `Tool call: ${name} ${shortArg(args.path, 120)}`;
  if (typeof args.query === "string") return `Tool call: ${name} ${shortArg(args.query, 120)}`;
  if (typeof args.pattern === "string") return `Tool call: ${name} ${shortArg(args.pattern, 120)}`;
  const first = Object.entries(args).find(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean");
  return first ? `Tool call: ${name} ${first[0]}=${shortArg(first[1], 90)}` : `Tool call: ${name}`;
}

export function toolCallsPreview(message: any) {
  const calls = messageToolCalls(message);
  if (calls.length === 0) return "";
  const [first] = calls;
  const suffix = calls.length > 1 ? ` + ${calls.length - 1} more` : "";
  return `${toolCallPreview(first)}${suffix}`;
}

export function messageTextPreview(message: any) {
  return textFromContent(message?.content || "");
}

const assistantHttpErrorLabels: Record<string, string> = {
  "429": "Throttling error",
  "500": "Server error",
  "502": "Bad gateway",
  "503": "Service unavailable",
  "504": "Gateway timeout",
  "529": "Overloaded",
};

export function isAssistantHttpErrorStatus(code: string) {
  return code in assistantHttpErrorLabels || /^[45]\d\d$/.test(code);
}

export function assistantStatusLabel(label: string | undefined, code: string) {
  const clean = (label || "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!clean || /^(?:http|status|error|request failed|model request failed)$/i.test(clean)) return assistantHttpErrorLabels[code] || `HTTP ${code}`;
  return clean;
}

export function assistantStatusErrorPreview(text: string) {
  const labelled = text.match(/^([A-Za-z][A-Za-z0-9 _/-]*?):\s*(\d{3})(?=$|[\s:,-])/);
  if (labelled && isAssistantHttpErrorStatus(labelled[2])) return `${assistantStatusLabel(labelled[1], labelled[2])} (${labelled[2]})`;
  const leading = text.match(/^(?:HTTP\s*)?(\d{3})(?=$|[\s:,-])/i);
  if (leading && isAssistantHttpErrorStatus(leading[1])) return `${assistantStatusLabel(undefined, leading[1])} (${leading[1]})`;
  const generic = text.match(/^(Error|Request failed|Model request failed)\s*:?\s*(\d{3})(?=$|[\s:,-])/i);
  if (generic && isAssistantHttpErrorStatus(generic[2])) return `${assistantStatusLabel(generic[1], generic[2])} (${generic[2]})`;
  return "";
}

export function assistantParsedErrorDetail(parsed: any) {
  if (typeof parsed === "string") return parsed.trim();
  if (!parsed || typeof parsed !== "object") return "";
  if (parsed.error && typeof parsed.error === "object") return parsed.error.message || parsed.error.type || "";
  return parsed.message || parsed.detail || parsed.error_description || "";
}

export function assistantJsonErrorPreview(text: string) {
  const trimmed = text.trim();
  if (!((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]")))) return "";
  try {
    const detail = assistantParsedErrorDetail(JSON.parse(trimmed));
    return detail ? `Error: ${detail}` : "";
  } catch {
    return "";
  }
}

export function assistantErrorPreview(message: any) {
  const raw = String(message?.errorMessage || "").trim();
  if (!raw) return "";
  const jsonText = raw.replace(/^Codex error:\s*/i, "").trim();
  return assistantJsonErrorPreview(jsonText)
    || assistantStatusErrorPreview(jsonText)
    || assistantStatusErrorPreview(raw)
    || (raw.length > 180 ? `${raw.slice(0, 179)}…` : raw);
}

export function assistantStopReasonPreview(message: any) {
  const reason = String(message?.stopReason || "").trim();
  if (!reason || reason === "stop" || reason === "toolUse") return "";
  if (reason === "length") return "Response stopped because the model hit its output length limit.";
  if (reason === "aborted") return "Response was aborted.";
  return `Response stopped unexpectedly: ${reason}`;
}

export function entryRole(entry: any) {
  const message = entryMessage(entry);
  if (message?.role === "assistant" && !messageTextPreview(message).trim()) {
    if (messageToolCalls(message).length > 0) return "toolCall";
    if (message.errorMessage || assistantStopReasonPreview(message)) return "error";
  }
  if (message?.role) return String(message.role);
  switch (entry?.type) {
    case "branch_summary": return "branchSummary";
    case "compaction": return "compaction";
    case "model_change": return "model";
    case "thinking_level_change": return "thinking";
    case "session_info": return "session";
    case "label": return "label";
    case "custom": return "custom";
    default: return String(entry?.type || "entry");
  }
}

export function entryPreview(entry: any) {
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
  switch (entry?.type) {
    case "branch_summary": return entry.summary || "Branch summary";
    case "compaction": return entry.summary || "Compaction summary";
    case "model_change": return `Model changed to ${entry.provider || "provider"}/${entry.modelId || "model"}`;
    case "thinking_level_change": return `Thinking level changed to ${entry.thinkingLevel || "unknown"}`;
    case "session_info": return entry.name ? `Session named ${entry.name}` : "Session name cleared";
    case "label": return entry.label ? `Label ${entry.targetId || "entry"} as ${entry.label}` : `Clear label on ${entry.targetId || "entry"}`;
    case "custom": return `Custom entry${entry.customType ? `: ${entry.customType}` : ""}`;
    default: return String(entry?.type || "Entry");
  }
}

export function countTreeNodes(nodes: any[]): number {
  let count = 0;
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop();
    count += 1;
    const children = Array.isArray(node?.children) ? node.children : [];
    for (const child of children) stack.push(child);
  }
  return count;
}

export function countBranchPoints(nodes: any[]): number {
  let count = 0;
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop();
    const children = Array.isArray(node?.children) ? node.children : [];
    if (children.length > 1) count += 1;
    for (const child of children) stack.push(child);
  }
  return count;
}

export function simpleTreeNode(node: any, activePathIds: Set<string>, leafId: string | null, childCount: number): any {
  const entry = node?.entry || node;
  const id = String(entry?.id || "");
  return {
    id,
    parentId: typeof entry?.parentId === "string" ? entry.parentId : null,
    type: String(entry?.type || "entry"),
    role: entryRole(entry),
    preview: truncatePreview(entryPreview(entry)),
    timestamp: String(entry?.timestamp || ""),
    ...(typeof node?.label === "string" ? { label: node.label } : {}),
    ...(typeof node?.labelTimestamp === "string" ? { labelTimestamp: node.labelTimestamp } : {}),
    childCount,
    isOnActivePath: activePathIds.has(id),
    isCurrentLeaf: Boolean(leafId && id === leafId),
    children: [],
  };
}

export function simplifyTreeNodesFlat(roots: any[], activePathIds: Set<string>, leafId: string | null): any[] {
  const nodes: any[] = [];
  const stack = [...roots].reverse();
  while (stack.length > 0) {
    const node = stack.pop();
    const children = Array.isArray(node?.children) ? node.children : [];
    nodes.push(simpleTreeNode(node, activePathIds, leafId, children.length));
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
  }
  return nodes;
}

export function conversationTreeForSession(targetSession: PiWebSession): ConversationTreeDto {
  const manager = targetSession.sessionManager;
  if (typeof manager.getTree !== "function") throw new Error("Session tree is not available");
  const leafId = typeof manager.getLeafId === "function" ? manager.getLeafId() : null;
  const activePath = typeof manager.getBranch === "function" ? manager.getBranch() : [];
  const activePathIds = new Set(activePath.map((entry: any) => String(entry?.id || "")).filter(Boolean));
  const roots = manager.getTree();
  const nodes = simplifyTreeNodesFlat(roots, activePathIds, leafId);
  return {
    ok: true,
    sessionId: targetSession.sessionId,
    leafId,
    activePathIds: Array.from(activePathIds),
    entryCount: nodes.length,
    branchPointCount: nodes.filter((node: any) => node.childCount > 1).length,
    nodes,
  };
}


export function messageRole(message: any) {
  return String(message?.role || message?.raw?.role || "");
}

export function messageStopReason(message: any) {
  return String(message?.stopReason || message?.raw?.stopReason || "");
}

export function messageErrorText(message: any) {
  return typeof message?.errorMessage === "string"
    ? message.errorMessage
    : typeof message?.raw?.errorMessage === "string"
      ? message.raw.errorMessage
      : "";
}

export function isAssistantFailureMessage(message: any) {
  return messageRole(message) === "assistant" && (messageStopReason(message) === "error" || Boolean(messageErrorText(message).trim()));
}

export function isAssistantAbortedMessage(message: any) {
  return messageRole(message) === "assistant" && messageStopReason(message) === "aborted";
}

export function isIncompleteToolResultMessage(message: any) {
  return messageRole(message) === "toolResult";
}


export function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function sessionDisplayName(targetSession: PiWebSession) {
  return targetSession.getSessionName?.()?.trim()
    || targetSession.sessionName?.trim()
    || targetSession.sessionManager.getSessionName?.()?.trim()
    || undefined;
}

export function liveSessionTitle(targetSession: PiWebSession) {
  const name = sessionDisplayName(targetSession);
  if (name) return name;

  for (const message of targetSession.messages as any[]) {
    const text = textFromContent(message?.content).trim();
    if (message?.role === "user" && text) return truncatePreview(text, 80);
  }
  return "New session";
}

export function sessionStats(targetSession: PiWebSession): SessionStatsDto {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let toolResults = 0;

  const branch = targetSession.sessionManager.getBranch?.();
  const entries = Array.isArray(branch) && branch.length > 0
    ? branch.map((entry: any) => entry?.message ?? entry)
    : targetSession.messages;

  for (const message of entries as any[]) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "user") userMessages++;
    if (message.role === "toolResult") toolResults++;
    if (message.role !== "assistant") continue;
    assistantMessages++;
    const usage = message.usage || {};
    input += finiteNumber(usage.input);
    output += finiteNumber(usage.output);
    cacheRead += finiteNumber(usage.cacheRead);
    cacheWrite += finiteNumber(usage.cacheWrite);
    const usageCost = usage.cost || {};
    const totalCost = finiteNumber(usageCost.total);
    cost += totalCost || finiteNumber(usageCost.input) + finiteNumber(usageCost.output) + finiteNumber(usageCost.cacheRead) + finiteNumber(usageCost.cacheWrite);
  }

  const contextUsage = targetSession.getContextUsage?.() || undefined;
  return {
    userMessages,
    assistantMessages,
    toolResults,
    totalMessages: entries.length,
    tokens: {
      input,
      output,
      cacheRead,
      cacheWrite,
      total: input + output + cacheRead + cacheWrite,
    },
    cost,
    contextUsage,
  };
}


export function sessionIsRetrying(targetSession: PiWebSession | undefined): boolean {
  return Boolean(targetSession?.isRetrying);
}

export function projectSessionState(targetSession: PiWebSession, cwd: string): BaseSessionStateDto {
  return {
    cwd,
    sessionFile: targetSession.sessionFile,
    sessionId: targetSession.sessionId,
    sessionName: sessionDisplayName(targetSession),
    sessionTitle: liveSessionTitle(targetSession),
    isStreaming: targetSession.isStreaming,
    isRetrying: sessionIsRetrying(targetSession),
    isCompacting: Boolean(targetSession.isCompacting),
    queue: {
      steering: [...(targetSession.getSteeringMessages?.() || [])],
      followUp: [...(targetSession.getFollowUpMessages?.() || [])],
    },
    model: simplifyModel(targetSession.model),
    thinkingLevel: targetSession.thinkingLevel,
    thinkingLevels: targetSession.getAvailableThinkingLevels(),
    stats: sessionStats(targetSession),
  };
}

export function getSessionSlashCommands(value: PiWebSession): SlashCommandDto[] {
  const commands: SlashCommandDto[] = [];

  for (const command of value.extensionRunner?.getRegisteredCommands?.() as any[] || []) {
    commands.push({
      name: command.invocationName || command.name,
      description: command.description,
      source: "extension",
      sourceInfo: command.sourceInfo,
    });
  }

  for (const template of value.promptTemplates as any[] || value.resourceLoader?.getPrompts?.().prompts as any[] || []) {
    commands.push({
      name: template.name,
      description: template.description,
      source: "prompt",
      sourceInfo: template.sourceInfo,
    });
  }

  for (const skill of value.resourceLoader?.getSkills?.().skills as any[] || []) {
    commands.push({
      name: `skill:${skill.name}`,
      description: skill.description,
      source: "skill",
      sourceInfo: skill.sourceInfo,
    });
  }

  return commands.filter((command) => typeof command.name === "string" && command.name.length > 0);
}
