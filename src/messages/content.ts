import type { AttachedImage } from "../app/types.js";

export function shouldCollapseMessage(text: string) {
  // Collapse is a prose-wall heuristic. Fenced code blocks (including
  // html-preview sources, which can be large) render in their own
  // scrollable/preview containers, so their contents shouldn't count —
  // otherwise any message carrying an inline preview collapses and the
  // preview gets clipped by the 18rem body clamp.
  let length = 0;
  let lines = 0;
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1] ?? null;
    if (fence) {
      // CommonMark: a closing fence uses the same character and is at
      // least as long as the opener.
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    length += line.length + 1;
    lines += 1;
  }
  return length > 1800 || lines > 28;
}

export function imagesFromRawContent(content: unknown): AttachedImage[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((part): part is Record<string, unknown> => !!part && typeof part === "object" && (part as any).type === "image")
    .map((part) => ({ data: part.data as string | undefined, mimeType: part.mimeType as string | undefined }));
}

export function stripImagePathNote(text: string) {
  const match = text.match(/(\n\nAttached image files?:\n(?:- .+\n?)+)/s);
  return match ? text.replace(match[1], "").trimEnd() : text;
}

export function imageFileName(path: string | undefined, fallback = "image") {
  return path ? path.split("/").pop() || fallback : fallback;
}

export function textFromRawContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const value = part as Record<string, unknown>;
    if (value.type === "text") return typeof value.text === "string" ? value.text : "";
    if (value.type === "image") return "[image]";
    // toolCall and thinking parts are rendered as cards — skip them in text bubbles
    return "";
  }).filter(Boolean).join("\n");
}

export function thinkingFromRawContent(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const value = part as Record<string, unknown>;
    if (value.type !== "thinking") return "";
    if (typeof value.thinking === "string") return value.thinking;
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
    return "";
  }).map((text) => text.trim()).filter(Boolean);
}

export type ThinkingTextSegment = { type: "heading" | "text"; text: string };

const emptyHtmlCommentLine = /^\s*<!--\s*-->\s*$/;

export function cleanThinkingText(text: string) {
  return text
    .split("\n")
    .filter((line) => !emptyHtmlCommentLine.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .replace(/(?:\n[ \t]*)+$/, "");
}

function standaloneThinkingHeading(line: string) {
  const match = line.match(/^(\s*)\*\*(\S(?:.*\S)?)\*\*\s*$/);
  return match ? `${match[1]}${match[2]}` : undefined;
}

export function thinkingTextSegments(text: string): ThinkingTextSegment[] {
  const lines = cleanThinkingText(text).split("\n");
  const segments: ThinkingTextSegment[] = [];
  lines.forEach((line, index) => {
    const heading = standaloneThinkingHeading(line);
    segments.push({ type: heading === undefined ? "text" : "heading", text: heading ?? line });
    if (index < lines.length - 1) segments.push({ type: "text", text: "\n" });
  });
  return segments;
}

export function formatThinkingText(text: string) {
  return thinkingTextSegments(text).map((segment) => segment.text).join("");
}

const httpStatusErrorLabels: Record<string, string> = {
  "429": "Throttling error",
  "500": "Server error",
  "502": "Bad gateway",
  "503": "Service unavailable",
  "504": "Gateway timeout",
  "529": "Overloaded",
};

function rawErrorText(rawError: unknown) {
  return String(rawError || "").trim();
}

function withoutCodexPrefix(raw: string) {
  return raw.replace(/^Codex error:\s*/i, "").trim();
}

function isJsonLike(text: string) {
  const trimmed = text.trim();
  return (trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"));
}

function parsedErrorDetail(parsed: unknown): string {
  if (typeof parsed === "string") return parsed.trim();
  if (!parsed || typeof parsed !== "object") return "";
  const value = parsed as Record<string, any>;
  const error = value.error;
  if (error && typeof error === "object") {
    const errorValue = error as Record<string, unknown>;
    if (typeof errorValue.message === "string" && errorValue.message.trim()) return errorValue.message.trim();
    if (typeof errorValue.type === "string" && errorValue.type.trim()) return errorValue.type.trim();
  }
  for (const key of ["message", "detail", "error_description"] as const) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
  }
  return "";
}

function parseWholeJsonError(text: string) {
  if (!isJsonLike(text)) return "";
  try {
    return parsedErrorDetail(JSON.parse(text));
  } catch {
    return "";
  }
}

function isHttpErrorStatus(code: string) {
  return code in httpStatusErrorLabels || /^[45]\d\d$/.test(code);
}

function statusLabel(label: string | undefined, code: string) {
  const clean = (label || "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!clean || /^(?:http|status|error|request failed|model request failed)$/i.test(clean)) return httpStatusErrorLabels[code] || `HTTP ${code}`;
  return clean;
}

function statusErrorMatch(text: string): { label?: string; code: string } | undefined {
  const labelled = text.match(/^([A-Za-z][A-Za-z0-9 _/-]*?):\s*(\d{3})(?=$|[\s:,-])/);
  if (labelled && isHttpErrorStatus(labelled[2])) return { label: labelled[1], code: labelled[2] };

  const leading = text.match(/^(?:HTTP\s*)?(\d{3})(?=$|[\s:,-])/i);
  if (leading && isHttpErrorStatus(leading[1])) return { code: leading[1] };

  const generic = text.match(/^(Error|Request failed|Model request failed)\s*:?\s*(\d{3})(?=$|[\s:,-])/i);
  if (generic && isHttpErrorStatus(generic[2])) return { label: generic[1], code: generic[2] };

  return undefined;
}

function statusErrorSummary(text: string) {
  const match = statusErrorMatch(text);
  return match ? `${statusLabel(match.label, match.code)} (${match.code})` : "";
}

export function assistantErrorStatusCode(rawError: unknown) {
  const raw = rawErrorText(rawError);
  if (!raw) return "";
  const jsonText = withoutCodexPrefix(raw);
  return statusErrorMatch(jsonText)?.code || statusErrorMatch(raw)?.code || "";
}

export function isRetryableAssistantError(rawError: unknown) {
  return new Set(["429", "500", "502", "503", "504", "529"]).has(assistantErrorStatusCode(rawError));
}

export function normalizeAssistantError(rawError: unknown) {
  const raw = rawErrorText(rawError);
  if (!raw) return "";
  const jsonText = withoutCodexPrefix(raw);
  const parsedDetail = parseWholeJsonError(jsonText);
  if (parsedDetail) return `Error: ${parsedDetail}`;
  const statusSummary = statusErrorSummary(jsonText) || statusErrorSummary(raw);
  if (statusSummary) return statusSummary;
  return raw.length > 180 ? `${raw.slice(0, 179)}…` : raw;
}

export function assistantErrorBody(rawError: unknown, fallback = "") {
  const raw = rawErrorText(rawError);
  if (!raw) return fallback;
  const jsonText = withoutCodexPrefix(raw);
  if (parseWholeJsonError(jsonText)) return raw;
  const statusSummary = statusErrorSummary(jsonText) || statusErrorSummary(raw);
  if (statusSummary) return statusSummary;
  return raw.length > 2000 ? `${raw.slice(0, 1999)}…` : raw;
}

function errorTextFromRaw(message: any) {
  return normalizeAssistantError(message?.raw?.errorMessage || message?.errorMessage || "");
}

function stopReasonTextFromRaw(message: any) {
  const reason = String(message?.raw?.stopReason || message?.stopReason || "").trim();
  if (!reason || reason === "stop" || reason === "toolUse") return "";
  if (reason === "length") return "Response stopped because the model hit its output length limit.";
  if (reason === "aborted") return "Response was aborted.";
  return `Response stopped unexpectedly: ${reason}`;
}

export function messageText(message: any): string {
  if (message?.role === "compactionSummary" || message?.raw?.role === "compactionSummary") {
    const raw = message.raw || message;
    const tokenText = typeof raw.tokensBefore === "number" ? raw.tokensBefore.toLocaleString() : "unknown";
    const header = `Context compacted from ${tokenText} tokens.`;
    return raw.summary ? `${header}\n\n${raw.summary}` : header;
  }

  // Prefer server-precomputed text, but fall back to raw content parsing.
  // Also reparse from raw if the precomputed text looks like a pure tool-call placeholder.
  const precomputed: string = message?.text || "";
  if (precomputed && !/^(\[tool call: [^\]]+\]\n?)+$/.test(precomputed.trim())) {
    return precomputed;
  }
  const text = textFromRawContent(message?.raw?.content || message?.content);
  const error = errorTextFromRaw(message);
  const stopReason = stopReasonTextFromRaw(message);
  if (error) return error;
  if (text && stopReason) return `${text}\n\n${stopReason}`;
  return text || stopReason || "";
}
