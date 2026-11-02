export function scopeArtifactUrl(relativeUrl: string, sessionId: string) {
  const scopedSessionId = sessionId.trim();
  if (!scopedSessionId || !relativeUrl.startsWith("/api/artifacts/")) return relativeUrl;

  const hashIndex = relativeUrl.indexOf("#");
  const beforeHash = hashIndex >= 0 ? relativeUrl.slice(0, hashIndex) : relativeUrl;
  const queryIndex = beforeHash.indexOf("?");
  if (queryIndex >= 0 && new URLSearchParams(beforeHash.slice(queryIndex + 1)).has("sessionId")) return relativeUrl;

  const suffix = relativeUrl.slice("/api/artifacts".length);
  return `/api/session-artifacts/${encodeURIComponent(scopedSessionId)}${suffix}`;
}

export function artifactSessionId(relativeUrl: string) {
  const scoped = relativeUrl.match(/^\/api\/session-artifacts\/([^/?#]+)\//);
  if (scoped) {
    try {
      return decodeURIComponent(scoped[1]);
    } catch {
      return "";
    }
  }
  if (!relativeUrl.startsWith("/api/artifacts/")) return "";
  const queryIndex = relativeUrl.indexOf("?");
  if (queryIndex < 0) return "";
  const hashIndex = relativeUrl.indexOf("#", queryIndex);
  const query = relativeUrl.slice(queryIndex + 1, hashIndex < 0 ? undefined : hashIndex);
  return new URLSearchParams(query).get("sessionId") || "";
}
