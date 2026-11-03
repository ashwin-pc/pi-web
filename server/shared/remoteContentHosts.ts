export const remoteContentHostLimit = 64;

function isValidRemoteHostname(hostname: string) {
  if (hostname.startsWith("[") && hostname.endsWith("]")) return true;
  return hostname.split(".").every((label) =>
    label.length > 0
    && label.length <= 63
    && /^[a-z0-9-]+$/.test(label)
    && !label.startsWith("-")
    && !label.endsWith("-"));
}

export function normalizeRemoteContentHost(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const text = value.trim().toLowerCase().replace(/\.$/, "");
  if (!text || text.length > 253 || /[/?#@\\\s]/.test(text)) return;
  try {
    const url = new URL(`https://${text}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!hostname || hostname.length > 253 || !isValidRemoteHostname(hostname)) return;
    return url.port ? `${hostname}:${url.port}` : hostname;
  } catch {
    return;
  }
}

export function normalizeRemoteContentHosts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((entry) => {
    const host = normalizeRemoteContentHost(entry);
    return host ? [host] : [];
  }))].slice(0, remoteContentHostLimit).sort();
}
