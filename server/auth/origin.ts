import type { IncomingMessage } from "node:http";
import { forwardedHost, normalizedAuthority } from "./proxy.js";

export const originFailureHint = "Origin does not match Host. If a reverse proxy rewrites Host, preserve the public Host, set PI_WEB_AUTH_ORIGIN to the public origin, or configure PI_WEB_AUTH_PROXY_PEERS with exact trusted proxy IPs that overwrite X-Forwarded-Host.";
let warned = false;
/** Shared by public auth, cookie mutations, WebSockets and supervisor. */
export function trustedOrigin(req: IncomingMessage, configuredOrigin: string): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  let valid = false;
  try {
    const parsed = new URL(origin);
    valid = (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.origin === origin &&
      (parsed.origin === new URL(configuredOrigin).origin ||
       parsed.host.toLowerCase() === normalizedAuthority(req.headers.host, parsed.protocol) ||
       parsed.host.toLowerCase() === forwardedHost(req, parsed.protocol));
  } catch { /* Reject malformed origins. */ }
  if (!valid && req.headers["x-forwarded-host"] && req.headers["x-forwarded-host"] !== req.headers.host && !warned) {
    warned = true;
    // Fixed message: no attacker-controlled header values or unbounded labels.
    console.warn(originFailureHint);
  }
  return valid;
}
