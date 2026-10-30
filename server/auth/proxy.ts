import type { IncomingMessage } from "node:http";
import { canonicalIP } from "./ip.js";

export function trustedProxyPeer(req: IncomingMessage): boolean {
  const peer = canonicalIP(req.socket.remoteAddress);
  return !!peer && (process.env.PI_WEB_AUTH_PROXY_PEERS || "").split(",")
    .some(value => canonicalIP(value.trim()) === peer);
}
export function forwardedHost(req: IncomingMessage, protocol?: "http:" | "https:"): string | undefined {
  const value = req.headers["x-forwarded-host"];
  if (!trustedProxyPeer(req)) return undefined;
  return normalizedAuthority(value, protocol);
}

export function normalizedAuthority(value: string | string[] | undefined, protocol?: "http:" | "https:"): string | undefined {
  if (typeof value !== "string" || !value || /[\s,/@?#\\]/.test(value)) return undefined;
  try {
    const parsed = new URL(`${protocol || "http:"}//${value}`);
    // Reject paths, malformed ports and noncanonical authority tricks.
    if (parsed.pathname !== "/" || !parsed.hostname || value.endsWith(":")) return undefined;
    // Origin comparisons normalize default ports using that origin's scheme.
    // Header forwarding has no scheme: preserve its explicit port unchanged.
    return protocol ? parsed.host.toLowerCase() : value.toLowerCase();
  } catch { return undefined; }
}
