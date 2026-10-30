import { isIP } from "node:net";

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost") return true;
  if (isIP(host) === 4) return host.startsWith("127.");
  if (isIP(host) !== 6 || host.includes("%")) return false;
  const normalized = new URL(`http://[${host}]/`).hostname;
  if (normalized === "[::1]") return true;
  const mapped = /^\[::ffff:([0-9a-f]+):[0-9a-f]+\]$/.exec(normalized);
  return !!mapped && (parseInt(mapped[1], 16) >>> 8) === 127;
}

function requestHostname(host: string | undefined): string | undefined {
  if (!host) return undefined;
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return undefined;
  }
}

/**
 * An explicit HTTP origin opts into plaintext cookies. Without an origin,
 * only an unproxied loopback Host on a loopback listener gets that exception.
 * Forwarding headers are intentionally irrelevant.
 */
export function secureSessionCookies(
  configuredOrigin: string | undefined,
  listenerHost: string,
  configuredProxyPeers: string | undefined,
  requestHost?: string,
): boolean {
  if (!configuredOrigin) {
    if (configuredProxyPeers?.trim()) return true;
    const hostname = requestHostname(requestHost);
    return !hostname || !isLoopbackHost(hostname) || !isLoopbackHost(listenerHost);
  }
  let publicUrl: URL;
  try {
    publicUrl = new URL(configuredOrigin);
  } catch {
    return true;
  }
  if (publicUrl.protocol === "http:") return false;
  return true;
}
