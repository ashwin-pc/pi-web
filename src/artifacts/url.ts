export function scopeArtifactUrl(relativeUrl: string, sessionId: string) {
  const scopedSessionId = sessionId.trim();
  if (!relativeUrl.startsWith("/api/artifacts/")) return relativeUrl;

  const hashIndex = relativeUrl.indexOf("#");
  const hash = hashIndex >= 0 ? relativeUrl.slice(hashIndex) : "";
  const beforeHash = hashIndex >= 0 ? relativeUrl.slice(0, hashIndex) : relativeUrl;
  const queryIndex = beforeHash.indexOf("?");
  const pathname = queryIndex >= 0 ? beforeHash.slice(0, queryIndex) : beforeHash;
  const query = new URLSearchParams(queryIndex >= 0 ? beforeHash.slice(queryIndex + 1) : "");
  const explicitSessionId = query.get("sessionId")?.trim();
  const effectiveSessionId = explicitSessionId || scopedSessionId;
  if (!effectiveSessionId) return relativeUrl;
  query.delete("sessionId");
  const remainingQuery = query.toString();
  const suffix = pathname.slice("/api/artifacts".length);
  return `/api/session-artifacts/${encodeURIComponent(effectiveSessionId)}${suffix}${remainingQuery ? `?${remainingQuery}` : ""}${hash}`;
}

export function artifactSessionId(relativeUrl: string) {
  const scoped = relativeUrl.match(/^\/api\/session-artifacts\/([^/?#]+)\//);
  if (!scoped) return "";
  try {
    return decodeURIComponent(scoped[1]);
  } catch {
    return "";
  }
}
