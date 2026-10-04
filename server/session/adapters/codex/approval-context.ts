import { object, redactCredentials } from "./transport.js";

/** A grant must never rely on truncated, redacted or visually concealed context. */
export const MAX_APPROVAL_CONTEXT_BYTES = 32 * 1_024;

function reviewable(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (typeof value === "string") {
    // Newlines/tabs are made explicit by JSON rendering. Reject terminal controls,
    // lone surrogates and invisible/bidi formatting rather than normalize them.
    if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ud800-\udfff]/u.test(value)) return false;
    if (redactCredentials(value) !== value || /\[(?:redacted|omitted|url)(?:\]|:)/i.test(value)) return false;
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|\beyJ[\w-]+\.[\w-]+\.[\w-]+\b|--(?:password|passwd|token|api-key|secret)(?:\s|=)/i.test(value)) return false;
    if (/(?:^|\s)(?:--user(?:=|\s+)|-u\s*)[^\s]+:[^\s]+/i.test(value)) return false;
    for (const match of value.matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi)) {
      try {
        const url = new URL(match[0]);
        // Plain destinations remain complete. Credentials may occur under arbitrary
        // query/fragment names; defer these URLs instead of masking part and granting.
        if (url.username || url.password || url.search || url.hash) return false;
      } catch { return false; }
    }
    return true;
  }
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 100 && value.every((entry) => reviewable(entry, depth + 1));
  const record = object(value);
  return !!record && Object.keys(record).length <= 100 && Object.entries(record).every(([key, entry]) => reviewable(key, depth + 1) && reviewable(entry, depth + 1));
}

/** Full, reversible JSON text for the existing Request details surface; no slicing. */
export function approvalContext(value: unknown): string | undefined {
  try {
    const text = JSON.stringify(value, null, 2);
    return text !== undefined && Buffer.byteLength(text) <= MAX_APPROVAL_CONTEXT_BYTES && reviewable(value) ? text : undefined;
  } catch { return undefined; }
}
