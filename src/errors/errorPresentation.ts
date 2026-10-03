export type ErrorPresentation = {
  message: string;
  type?: string;
  code?: string;
  suggestion?: string;
  technicalDetails: string;
  original: unknown;
};

/** Additive structured shape tools/providers may return; every field is optional. */
export type StructuredErrorPresentation = {
  type?: string;
  code?: string | number;
  message?: string;
  suggestion?: string;
  technical?: unknown;
};

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function stringField(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack || value.message || value.name;
  try {
    const json = JSON.stringify(value, null, 2);
    return json === undefined ? String(value) : json;
  } catch { return String(value); }
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    const item = record(part);
    return item?.type === "text" && typeof item.text === "string" ? item.text : "";
  }).filter(Boolean).join("\n");
}

function sourceRecords(original: unknown) {
  const outer = record(original);
  const details = record(outer?.details);
  const nested = record(details?.error) || record(outer?.error);
  return { outer, details, nested };
}

/** Normalize legacy and structured failures without changing their stored value. */
export function normalizeErrorPresentation(original: unknown): ErrorPresentation {
  const { outer, details, nested } = sourceRecords(original);
  const structured = nested || details || outer;
  const directError = details?.error ?? outer?.error;
  const raw = record(outer?.raw);

  let message = stringField(structured?.message) || stringField(structured?.detail) || stringField(structured?.reason);
  let type = stringField(structured?.type) || stringField(structured?.name);
  const codeValue = structured?.code;
  const code = typeof codeValue === "number" ? String(codeValue) : stringField(codeValue);
  const suggestion = stringField(structured?.suggestion);

  const outerContent = contentText(outer?.content);
  const rawContent = contentText(raw?.content);
  let fallback: unknown = directError ?? (outer?.ok === false ? outer.message : undefined)
    ?? outer?.errorMessage ?? raw?.errorMessage
    ?? (outerContent || rawContent || original);
  if (!message && fallback instanceof Error) {
    message = fallback.message || fallback.name;
    if (fallback.name !== "Error") type = type || fallback.name;
  }
  if (!message) {
    const text = stringify(fallback).trim();
    const prefixed = text.match(/^([A-Za-z_$][\w.$]*(?:Error|Exception)):\s+([\s\S]+)$/);
    if (prefixed) {
      type = type || prefixed[1];
      message = prefixed[2].trim();
    } else message = text;
  }

  const technical = structured?.technical;
  return {
    message: message || "Unknown error",
    ...(type ? { type } : {}),
    ...(code ? { code } : {}),
    ...(suggestion ? { suggestion } : {}),
    technicalDetails: technical === undefined ? stringify(original) : `${stringify(technical)}\n\nOriginal result:\n${stringify(original)}`,
    original,
  };
}
