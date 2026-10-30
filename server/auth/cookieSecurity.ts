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

/**
 * Cookies are Secure unless the declared public URL and listener are both
 * demonstrably loopback HTTP. Forwarding headers are intentionally irrelevant.
 */
export function secureSessionCookies(
  configuredOrigin: string | undefined,
  listenerHost: string,
): boolean {
  if (!configuredOrigin) return true;
  let publicUrl: URL;
  try {
    publicUrl = new URL(configuredOrigin);
  } catch {
    return true;
  }
  return !(
    publicUrl.protocol === "http:" &&
    isLoopbackHost(publicUrl.hostname) &&
    isLoopbackHost(listenerHost)
  );
}
