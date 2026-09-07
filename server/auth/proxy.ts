import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

/** Exact IP peers only: normalize IPv6 spelling and IPv4-mapped sockets. */
function canonicalIP(value: string): string | undefined {
  if (!isIP(value) || value.includes("%")) return undefined;
  if (isIP(value) === 4) return value;
  const normalized = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(normalized);
  if (!mapped) return normalized;
  const a = parseInt(mapped[1], 16), b = parseInt(mapped[2], 16);
  return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
}
export function trustedProxyPeer(req: IncomingMessage): boolean {
  const peer = canonicalIP(req.socket.remoteAddress || "");
  return !!peer && (process.env.PI_WEB_AUTH_PROXY_PEERS || "").split(",")
    .some(value => canonicalIP(value.trim()) === peer);
}
export function forwardedHost(req: IncomingMessage): string | undefined {
  const value = req.headers["x-forwarded-host"];
  if (!trustedProxyPeer(req) || typeof value !== "string" ||
      !value || /[\s,/@?#\\]/.test(value)) return undefined;
  try {
    const parsed = new URL(`http://${value}`);
    // Reject paths, malformed ports and noncanonical authority tricks.
    if (parsed.pathname !== "/" || !parsed.hostname || value.endsWith(":")) return undefined;
    return value.toLowerCase();
  } catch { return undefined; }
}
