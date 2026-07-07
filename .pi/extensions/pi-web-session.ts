/**
 * pi-web bundled session orchestration tool.
 *
 * Gives an agent a safe, normalized way to inspect and nudge other pi-web
 * sessions without exposing the pi-web bearer token in the conversation.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ACTIONS = ["list", "state", "messages", "prompt", "wait", "abort", "open", "new"] as const;
const PROMPT_MODES = ["followUp", "steer"] as const;

type Action = typeof ACTIONS[number];
type PromptMode = typeof PROMPT_MODES[number];

type PiWebSessionToolParams = {
  action: Action;
  sessionId?: string;
  cwd?: string;
  message?: string;
  tail?: number;
  limit?: number;
  maxTextChars?: number;
  timeoutMs?: number;
  intervalMs?: number;
  mode?: PromptMode;
};

type ApiOptions = {
  signal?: AbortSignal;
};

type NormalizedState = {
  ok: true;
  sessionId?: string;
  cwd?: string;
  sessionFile?: string;
  sessionTitle?: string;
  isRunning: boolean;
  isStreaming: boolean;
  isCompacting: boolean;
  runtime?: unknown;
  runtimeRef?: unknown;
  model?: unknown;
  thinkingLevel?: unknown;
  stats?: unknown;
};

function piWebBaseUrl() {
  const configured = process.env.PI_WEB_INTERNAL_BASE_URL || process.env.PI_WEB_BASE_URL;
  if (configured) return configured.replace(/\/+$/, "");
  return `http://127.0.0.1:${process.env.PORT || "8787"}`;
}

function piWebHeaders(hasBody: boolean) {
  const headers: Record<string, string> = { accept: "application/json" };
  if (hasBody) headers["content-type"] = "application/json";
  if (process.env.PI_WEB_TOKEN) headers.authorization = `Bearer ${process.env.PI_WEB_TOKEN}`;
  return headers;
}

async function piWebApi<T>(method: string, path: string, body?: unknown, options: ApiOptions = {}): Promise<T> {
  const response = await fetch(`${piWebBaseUrl()}${path}`, {
    method,
    headers: piWebHeaders(body !== undefined),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: options.signal,
  });

  const text = await response.text();
  let value: any = {};
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    value = { ok: false, error: text || response.statusText };
  }

  if (!response.ok || value?.ok === false) {
    throw new Error(`${method} ${path} failed (${response.status}): ${value?.error || response.statusText}`);
  }

  return value as T;
}

function numberInRange(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function requiredSessionId(params: PiWebSessionToolParams) {
  const sessionId = cleanString(params.sessionId);
  if (!sessionId) throw new Error(`sessionId is required for action "${params.action}"`);
  return sessionId;
}

function truncate(text: string, maxChars: number) {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, Math.max(0, maxChars))}\n…[truncated ${omitted} chars]`;
}

function safeJson(value: unknown, maxChars: number) {
  try {
    return truncate(JSON.stringify(value, null, 2), maxChars);
  } catch {
    return String(value);
  }
}

function messageText(message: any) {
  if (typeof message?.text === "string") return message.text;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: any) => {
    if (!part || typeof part !== "object") return "";
    if (part.type === "text" && typeof part.text === "string") return part.text;
    if (part.type === "toolResult" && typeof part.content === "string") return part.content;
    if (part.type === "toolCall") return `[tool:${part.name || part.toolName || "call"}]`;
    if (part.type === "image") return "[image]";
    return "";
  }).filter(Boolean).join("\n");
}

function normalizeToolCalls(toolCalls: unknown, maxTextChars: number) {
  if (!Array.isArray(toolCalls)) return undefined;
  return toolCalls.map((toolCall: any) => ({
    id: typeof toolCall?.id === "string" ? toolCall.id : undefined,
    toolName: typeof toolCall?.toolName === "string" ? toolCall.toolName : typeof toolCall?.name === "string" ? toolCall.name : undefined,
    args: toolCall?.args === undefined && toolCall?.arguments === undefined
      ? undefined
      : safeJson(toolCall.args ?? toolCall.arguments, Math.min(maxTextChars, 2000)),
  }));
}

function normalizeMessage(message: any, maxTextChars: number) {
  return {
    entryId: typeof message?.entryId === "string" ? message.entryId : undefined,
    role: typeof message?.role === "string" ? message.role : "unknown",
    isError: Boolean(message?.isError),
    timestamp: typeof message?.timestamp === "number" ? message.timestamp : undefined,
    text: truncate(messageText(message), maxTextChars),
    toolName: typeof message?.toolName === "string" ? message.toolName : undefined,
    toolArgs: message?.toolArgs === undefined ? undefined : safeJson(message.toolArgs, Math.min(maxTextChars, 2000)),
    toolCalls: normalizeToolCalls(message?.toolCalls, maxTextChars),
  };
}

export function normalizePiWebMessages(result: any, options: { tail?: number; maxTextChars?: number } = {}) {
  const allMessages = Array.isArray(result?.messages) ? result.messages : [];
  const tail = numberInRange(options.tail, 20, 1, 100);
  const maxTextChars = numberInRange(options.maxTextChars, 4000, 200, 20_000);
  const messages = allMessages.slice(-tail).map((message: any) => normalizeMessage(message, maxTextChars));
  return {
    ok: true,
    count: allMessages.length,
    returned: messages.length,
    messages,
  };
}

function isRunning(value: any) {
  return Boolean(
    value?.isStreaming
    || value?.isCompacting
    || value?.runtime?.isRunning
    || value?.runtime?.isStreaming
    || value?.runtime?.isCompacting,
  );
}

export function normalizePiWebSessionState(value: any): NormalizedState {
  return {
    ok: true,
    sessionId: typeof value?.sessionId === "string" ? value.sessionId : undefined,
    cwd: typeof value?.cwd === "string" ? value.cwd : undefined,
    sessionFile: typeof value?.sessionFile === "string" ? value.sessionFile : undefined,
    sessionTitle: typeof value?.sessionTitle === "string" ? value.sessionTitle : undefined,
    isRunning: isRunning(value),
    isStreaming: Boolean(value?.isStreaming || value?.runtime?.isStreaming),
    isCompacting: Boolean(value?.isCompacting || value?.runtime?.isCompacting),
    runtime: value?.runtime ? {
      loaded: Boolean(value.runtime.loaded),
      isRunning: Boolean(value.runtime.isRunning),
      isStreaming: Boolean(value.runtime.isStreaming),
      isCompacting: Boolean(value.runtime.isCompacting),
      pendingMessageCount: typeof value.runtime.pendingMessageCount === "number" ? value.runtime.pendingMessageCount : undefined,
      startedAt: typeof value.runtime.startedAt === "string" ? value.runtime.startedAt : undefined,
      lastActivityAt: typeof value.runtime.lastActivityAt === "string" ? value.runtime.lastActivityAt : undefined,
    } : undefined,
    runtimeRef: value?.runtimeRef,
    model: value?.model || value?.runtime?.model,
    thinkingLevel: value?.thinkingLevel,
    stats: value?.stats,
  };
}

function normalizeSessionList(value: any, limit: number, maxTextChars: number) {
  const sessions = Array.isArray(value?.sessions) ? value.sessions : [];
  return {
    ok: true,
    count: sessions.length,
    returned: Math.min(sessions.length, limit),
    sessions: sessions.slice(0, limit).map((session: any) => ({
      id: session?.id,
      name: session?.name,
      firstMessage: typeof session?.firstMessage === "string" ? truncate(session.firstMessage, maxTextChars) : undefined,
      created: session?.created,
      modified: session?.modified,
      messageCount: session?.messageCount,
      cwd: session?.cwd,
      isCurrent: Boolean(session?.isCurrent),
      unread: Boolean(session?.unread),
      runtime: session?.runtime,
    })),
  };
}

function encodeSessionQuery(sessionId?: string) {
  const clean = cleanString(sessionId);
  return clean ? `?sessionId=${encodeURIComponent(clean)}` : "";
}

function sleep(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(new Error("Cancelled"));
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const timer = setTimeout(() => finish(resolve), ms);
    const onAbort = () => finish(() => reject(new Error("Cancelled")));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function toolResult(result: unknown) {
  return {
    content: [{ type: "text" as const, text: safeJson(result, 30_000) }],
    details: result,
  };
}

export function createPiWebSessionTool() {
  return {
    name: "pi_web_session",
    label: "pi-web Session",
    description: "Manage and monitor pi-web sessions through the local pi-web API. Use this to inspect, wait on, nudge, open, create, or abort another pi-web session by id.",
    promptSnippet: "Orchestrate other pi-web sessions: inspect state/messages, wait until idle, nudge with a prompt, open/create, or abort by session id.",
    promptGuidelines: [
      "Use pi_web_session when the user asks you to monitor, orchestrate, critique, or nudge another pi-web session by id.",
      "Before using pi_web_session with action=prompt, inspect the target with action=state and action=messages so the nudge is specific and non-disruptive.",
      "For pi_web_session action=prompt, prefer mode=followUp unless the user explicitly wants to interrupt the running response.",
      "Use normal bash/read/grep tools for verification, git diffs, Docker smoke tests, and file inspection; pi_web_session is only for session orchestration.",
    ],
    parameters: Type.Object({
      action: StringEnum(ACTIONS),
      sessionId: Type.Optional(Type.String({ description: "Target pi-web session id. Required for prompt, wait, abort, and open. Optional for state/messages to use pi-web's current session." })),
      cwd: Type.Optional(Type.String({ description: "Workspace directory for list filtering, opening, or creating sessions." })),
      message: Type.Optional(Type.String({ description: "Message to send for action=prompt." })),
      tail: Type.Optional(Type.Number({ description: "Number of most recent messages to return for action=messages (1-100).", minimum: 1, maximum: 100 })),
      limit: Type.Optional(Type.Number({ description: "Maximum sessions to return for action=list (1-200).", minimum: 1, maximum: 200 })),
      maxTextChars: Type.Optional(Type.Number({ description: "Maximum text characters per returned message/session field.", minimum: 200, maximum: 20000 })),
      timeoutMs: Type.Optional(Type.Number({ description: "Timeout for action=wait in milliseconds.", minimum: 1000, maximum: 3600000 })),
      intervalMs: Type.Optional(Type.Number({ description: "Polling interval for action=wait in milliseconds.", minimum: 250, maximum: 60000 })),
      mode: Type.Optional(StringEnum(PROMPT_MODES)),
    }),
    async execute(_toolCallId: string, rawParams: PiWebSessionToolParams, signal?: AbortSignal) {
      const params = rawParams || { action: "state" as const };
      const maxTextChars = numberInRange(params.maxTextChars, 4000, 200, 20_000);

      switch (params.action) {
        case "list": {
          const query = new URLSearchParams();
          const cwd = cleanString(params.cwd);
          if (cwd) query.append("cwd", cwd);
          const result = await piWebApi("GET", `/api/sessions${query.size ? `?${query}` : ""}`, undefined, { signal });
          return toolResult(normalizeSessionList(result, numberInRange(params.limit, 50, 1, 200), maxTextChars));
        }

        case "state": {
          const result = await piWebApi("GET", `/api/state${encodeSessionQuery(params.sessionId)}`, undefined, { signal });
          return toolResult(normalizePiWebSessionState(result));
        }

        case "messages": {
          const result = await piWebApi("GET", `/api/messages${encodeSessionQuery(params.sessionId)}`, undefined, { signal });
          return toolResult({ sessionId: cleanString(params.sessionId) || undefined, ...normalizePiWebMessages(result, { tail: params.tail, maxTextChars }) });
        }

        case "prompt": {
          const sessionId = requiredSessionId(params);
          const message = cleanString(params.message);
          if (!message) throw new Error("message is required for action \"prompt\"");
          const mode = params.mode === "steer" ? "steer" : "followUp";
          const result = await piWebApi<Record<string, unknown>>("POST", "/api/prompt", { sessionId, message, mode }, { signal });
          return toolResult({ ok: true, action: "prompt", mode, ...result });
        }

        case "wait": {
          const sessionId = requiredSessionId(params);
          const timeoutMs = numberInRange(params.timeoutMs, 10 * 60_000, 1000, 60 * 60_000);
          const intervalMs = numberInRange(params.intervalMs, 2000, 250, 60_000);
          const startedAt = Date.now();
          let latest: NormalizedState | undefined;
          while (true) {
            const result = await piWebApi("GET", `/api/state?sessionId=${encodeURIComponent(sessionId)}`, undefined, { signal });
            latest = normalizePiWebSessionState(result);
            if (!latest.isRunning) return toolResult({ ok: true, action: "wait", elapsedMs: Date.now() - startedAt, state: latest });
            if (Date.now() - startedAt >= timeoutMs) {
              throw new Error(`Timed out after ${timeoutMs}ms waiting for session ${sessionId}`);
            }
            await sleep(intervalMs, signal);
          }
        }

        case "abort": {
          const sessionId = requiredSessionId(params);
          const result = await piWebApi<Record<string, unknown>>("POST", "/api/abort", { sessionId }, { signal });
          return toolResult({ ok: true, action: "abort", ...result });
        }

        case "open": {
          const sessionId = requiredSessionId(params);
          const cwd = cleanString(params.cwd);
          const result = await piWebApi("POST", "/api/sessions/open", { sessionId, ...(cwd ? { cwd } : {}) }, { signal });
          return toolResult({ action: "open", state: normalizePiWebSessionState(result) });
        }

        case "new": {
          const cwd = cleanString(params.cwd);
          const result = await piWebApi("POST", "/api/sessions/new", cwd ? { cwd } : {}, { signal });
          return toolResult({ action: "new", state: normalizePiWebSessionState(result) });
        }
      }
    },
  };
}

export default function piWebSessionExtension(pi: ExtensionAPI) {
  if (process.env.PI_WEB_SESSION_TOOL === "0") return;
  pi.registerTool(createPiWebSessionTool());
}
