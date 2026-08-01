/**
 * Structured session references contributed by extensions.
 *
 * Any extension-provided `details` payload (custom messages, tool results) may
 * reference other sessions so pi-web can render links to them. The contract is
 * deliberately explicit and generic: a reference LIST (`sessionRefs`, `sessions`
 * or `workers`) means "surface links to these sessions". A bare `sessionId`
 * field is treated as incidental metadata, not a link request, so tools that
 * merely echo the session they acted on do not sprout chips.
 *
 * Core stays generic here: no extension or tool name is special-cased.
 */

export type SessionRef = { sessionId: string; name?: string; status?: string };

/** Bounds: extension details are untrusted input and may be persisted. */
export const maxSessionRefs = 8;
export const maxSessionRefLabel = 60;
const sessionIdPattern = /^[A-Za-z0-9._:-]{1,100}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001F\u007F]/g, "").trim();
  return cleaned ? cleaned.slice(0, maxSessionRefLabel) : undefined;
}

/**
 * Extract bounded, de-duplicated session references from an extension-provided
 * `details` payload. Returns an empty array when nothing valid is referenced.
 */
export function sessionRefsFromDetails(details: unknown): SessionRef[] {
  if (!isRecord(details)) return [];

  const lists = [details.sessionRefs, details.sessions, details.workers].filter(Array.isArray) as unknown[][];
  if (lists.length === 0) return [];

  const refs: SessionRef[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const entry of list) {
      if (refs.length >= maxSessionRefs) return refs;
      if (!isRecord(entry)) continue;
      const sessionId = typeof entry.sessionId === "string" ? entry.sessionId.trim() : "";
      if (!sessionIdPattern.test(sessionId) || seen.has(sessionId)) continue;
      seen.add(sessionId);
      refs.push({
        sessionId,
        name: cleanLabel(entry.name),
        status: typeof entry.status === "string" ? entry.status.slice(0, 24) : undefined,
      });
    }
  }
  return refs;
}

/** Shared presentation for a session-reference chip. */
export function sessionRefChipText(ref: SessionRef): string {
  const icon = ref.status === "error" ? "⚠" : ref.status === "aborted" ? "⏹" : "↗";
  return `${icon} ${ref.name || ref.sessionId.slice(-8)}`;
}

export function sessionRefChipClass(ref: SessionRef): string {
  return `customCardSessionChip${ref.status === "error" ? " status-error" : ref.status === "aborted" ? " status-aborted" : ""}`;
}

export function sessionRefHref(ref: SessionRef): string {
  return `/?sessionId=${encodeURIComponent(ref.sessionId)}`;
}
