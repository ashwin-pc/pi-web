function routeArtifactUrl(urlText: string, sessionId: string, runtimeId: string) {
  try {
    const url = new URL(urlText, "http://pi-web.local");
    if (!url.pathname.startsWith("/api/artifacts/")) return urlText;
    if (!url.searchParams.has("sessionId")) url.searchParams.set("sessionId", sessionId);
    if (!url.searchParams.has("runtimeId")) url.searchParams.set("runtimeId", runtimeId);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return urlText;
  }
}

function routeArtifactUrlsInText(text: string, sessionId: string, runtimeId: string) {
  return text.replace(/(?<![A-Za-z0-9:])\/api\/artifacts\/[^\s)\]"'<>]+/g, (url) => routeArtifactUrl(url, sessionId, runtimeId));
}

/** Add explicit runtime routing to artifact URLs nested anywhere in a simplified message. */
export function routeRuntimeArtifactUrls(value: unknown, sessionId: string, runtimeId: string): unknown {
  if (typeof value === "string") return routeArtifactUrlsInText(value, sessionId, runtimeId);
  if (Array.isArray(value)) return value.map((item) => routeRuntimeArtifactUrls(item, sessionId, runtimeId));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, routeRuntimeArtifactUrls(item, sessionId, runtimeId)]));
}
