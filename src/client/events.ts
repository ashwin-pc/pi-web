// The ONE place pi and pi-web realtime events become the client's neutral
// events (turn/start, assistant/delta, tool/call, tool/result, turn/end).
// Views never see pi's wire names; when pi's protocol changes, only this
// module and its tests change.
import type { ClientEvent, RealtimeEnvelope } from "./types.js";

type Record_ = Record<string, unknown>;
const isRecord = (value: unknown): value is Record_ => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown) => (typeof value === "string" ? value : "");

// Shell commands that walk a directory: their last path-like argument is where.
const SEARCH_COMMAND = /^(rg|grep|find|fd|ag|ls|tree|cat|head|tail|wc|sed)\b/;
const PATH_TOKEN = /^[\w.~/@+-]+$/;

/** Join a tool path onto the session's cwd. Absolute paths and empty cwds pass through. */
export function absoluteToolPath(cwd: string, path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("/") || !cwd) return trimmed.replace(/\/+$/, "") || "/";
  const relative = trimmed.replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (!relative || relative === ".") return cwd.replace(/\/+$/, "");
  return `${cwd.replace(/\/+$/, "")}/${relative}`;
}

function pathsFromShellCommand(command: string): string[] {
  // Only the first command of a pipeline or chain; quoted strings are patterns, not paths.
  const first = command.split(/\|\||&&|[|;]/)[0]?.trim() || "";
  if (!SEARCH_COMMAND.test(first)) return [];
  const tokens = first.replace(/"[^"]*"|'[^']*'/g, " ").split(/\s+/).slice(1)
    .filter((token) => token && !token.startsWith("-") && PATH_TOKEN.test(token) && /[/.]/.test(token));
  const last = tokens[tokens.length - 1];
  return last ? [last] : [];
}

/**
 * The file or folder paths a tool touches, derived from its arguments only.
 * Tool arguments are complete when pi emits tool_execution_start, so this
 * works live, before the result arrives.
 */
export function toolPaths(name: string, args: unknown, cwd = ""): string[] {
  if (!isRecord(args)) return [];
  const raw: string[] = [];
  for (const key of ["path", "file_path", "filePath", "file", "directory", "dir", "cwd"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) raw.push(value);
  }
  if (Array.isArray(args.paths)) for (const value of args.paths) if (typeof value === "string" && value.trim()) raw.push(value);
  if (Array.isArray(args.edits)) for (const edit of args.edits) if (isRecord(edit) && typeof edit.path === "string") raw.push(edit.path);
  if (!raw.length && (name === "bash" || name === "shell") && typeof args.command === "string") raw.push(...pathsFromShellCommand(args.command));
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of raw) {
    const resolved = absoluteToolPath(cwd, path);
    if (resolved && !seen.has(resolved)) { seen.add(resolved); result.push(resolved); }
  }
  return result;
}

function assistantError(message: unknown): string | undefined {
  const value = isRecord(message) && isRecord(message.message) ? message.message : message;
  if (!isRecord(value)) return undefined;
  const raw = isRecord(value.raw) ? value.raw : value;
  const role = str(raw.role) || str(value.role);
  if (role && role !== "assistant") return undefined;
  const error = str(raw.errorMessage) || str(value.errorMessage);
  if (error) return error;
  return str(raw.stopReason) === "error" || str(value.stopReason) === "error" ? "Assistant error" : undefined;
}

type RunState = { aborted: boolean; error?: string };

export type EventTranslator = {
  /** Neutral events for one realtime envelope (often none, sometimes one). Replayed envelopes are ignored. */
  translate(envelope: RealtimeEnvelope): ClientEvent[];
  reset(): void;
};

export function createEventTranslator(options: { cwdOf?: (sessionId: string) => string } = {}): EventTranslator {
  const tools = new Map<string, { name: string; paths: string[] }>();
  const runs = new Map<string, RunState>();
  const cwdOf = options.cwdOf || (() => "");

  function translate(envelope: RealtimeEnvelope): ClientEvent[] {
    if (!isRecord(envelope) || envelope.type !== "agent_event" || envelope.replay === true) return [];
    const sessionId = str(envelope.sessionId);
    const event = envelope.event;
    if (!sessionId || !isRecord(event)) return [];
    const at = str(event.lastActivityAt) || str(event.startedAt) || undefined;
    switch (event.type) {
      case "agent_start":
        runs.set(sessionId, { aborted: false });
        return [{ type: "turn/start", sessionId, ...(at ? { at } : {}) }];
      case "message_update": {
        const delta = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : undefined;
        if (!delta) return [];
        const channel = delta.type === "text_delta" ? "text" : delta.type === "thinking_delta" ? "thinking" : undefined;
        if (!channel) return [];
        const contentIndex = typeof delta.contentIndex === "number" ? delta.contentIndex : undefined;
        return [{ type: "assistant/delta", sessionId, channel, delta: str(delta.delta), ...(contentIndex === undefined ? {} : { contentIndex }) }];
      }
      case "message_end": {
        const error = assistantError(event.message);
        const run = runs.get(sessionId) || { aborted: false };
        if (error) runs.set(sessionId, { ...run, error });
        else if (isRecord(event.message) && str(event.message.role) === "assistant") runs.set(sessionId, { ...run, error: undefined });
        return [];
      }
      case "tool_execution_start": {
        const toolCallId = str(event.toolCallId);
        const name = str(event.toolName) || "tool";
        const paths = toolPaths(name, event.args, cwdOf(sessionId));
        tools.set(`${sessionId}\0${toolCallId}`, { name, paths });
        return [{ type: "tool/call", sessionId, toolCallId, name, args: event.args ?? {}, paths, ...(at ? { at } : {}) }];
      }
      case "tool_execution_end": {
        const toolCallId = str(event.toolCallId);
        const key = `${sessionId}\0${toolCallId}`;
        const known = tools.get(key);
        tools.delete(key);
        return [{ type: "tool/result", sessionId, toolCallId, name: str(event.toolName) || known?.name || "tool", isError: Boolean(event.isError), paths: known?.paths || [] }];
      }
      case "agent_end": {
        if (event.willRetry) return [];
        const run = runs.get(sessionId) || { aborted: false };
        runs.set(sessionId, { ...run, aborted: Boolean(event.aborted) });
        return [];
      }
      case "agent_settled": {
        // agent_end closes one low-level loop; agent_settled is the idle boundary.
        const run = runs.get(sessionId) || { aborted: false };
        runs.delete(sessionId);
        for (const key of [...tools.keys()]) if (key.startsWith(`${sessionId}\0`)) tools.delete(key);
        return [{ type: "turn/end", sessionId, aborted: run.aborted, ...(run.error ? { error: run.error } : {}), ...(at ? { at } : {}) }];
      }
      default:
        return [];
    }
  }

  return { translate, reset() { tools.clear(); runs.clear(); } };
}
