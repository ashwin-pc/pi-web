/**
 * Stable, instance-local session citations. This module is deliberately free of
 * Node and DOM dependencies so tools, API responses and the browser use the
 * same identities and URL format. Entry IDs are persisted Pi entry IDs, never
 * transcript indexes or timestamps.
 */
export type SessionReference = { sessionId: string; entryId?: string };

const referenceIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const parserBase = "http://pi-web.invalid";

export function isSessionReferenceId(value: unknown): value is string {
  return typeof value === "string" && referenceIdPattern.test(value);
}

/** Produce a portable link with no origin, credentials or incidental URL state. */
export function sessionReferenceHref(ref: SessionReference): string {
  if (!isSessionReferenceId(ref.sessionId) || (ref.entryId !== undefined && !isSessionReferenceId(ref.entryId))) {
    throw new TypeError("Invalid session reference");
  }
  return `/?sessionId=${encodeURIComponent(ref.sessionId)}${ref.entryId === undefined ? "" : `&entryId=${encodeURIComponent(ref.entryId)}`}`;
}

/**
 * Recognize a canonical app route or a copied absolute URL. Browser callers
 * supply their origin to leave foreign links alone. Server callers may omit it:
 * resolution is always against local session storage, NEVER an HTTP fetch.
 * Unknown query parameters (including authentication tokens) are not retained.
 */
export function parseSessionReference(value: string, allowedOrigin?: string): SessionReference | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  const input = value.trim();
  if (!input || /[\\\u0000-\u001F\u007F]/.test(input)) return null;
  if (!(input.startsWith("/") && !input.startsWith("//")) && !/^https?:\/\//i.test(input)) return null;

  try {
    const base = new URL(allowedOrigin ?? parserBase).origin;
    const url = new URL(input, base);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.pathname !== "/" || url.hash) return null;
    if (allowedOrigin !== undefined && url.origin !== base) return null;
    if (url.searchParams.getAll("sessionId").length !== 1 || url.searchParams.getAll("entryId").length > 1) return null;
    const sessionId = url.searchParams.get("sessionId");
    const entryId = url.searchParams.get("entryId");
    if (!isSessionReferenceId(sessionId) || (entryId !== null && !isSessionReferenceId(entryId))) return null;
    return { sessionId, ...(entryId === null ? {} : { entryId }) };
  } catch {
    return null;
  }
}
