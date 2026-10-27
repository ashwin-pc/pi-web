import type { IncomingMessage } from "node:http";
import { forwardedHost } from "./proxy.js";

export const originFailureHint = "Origin does not match the configured public origin. Set PI_WEB_AUTH_ORIGIN to the exact public origin or configure trusted proxy peers for a local HTTP origin.";
let warned = false;

function isCanonicalLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function effectivePort(url: URL): string {
  return url.port || (url.protocol === "http:" ? "80" : "443");
}

function localLoopbackAlias(origin: URL, configured: URL): boolean {
  return origin.protocol === "http:"
    && configured.protocol === "http:"
    && isCanonicalLoopback(origin.hostname)
    && isCanonicalLoopback(configured.hostname)
    && effectivePort(origin) === effectivePort(configured);
}

function trustedProxyOrigin(req: IncomingMessage, origin: URL, configured: URL): boolean {
  if (configured.protocol !== "http:" || !isCanonicalLoopback(configured.hostname)) return false;
  return forwardedHost(req, origin.protocol as "http:" | "https:") === origin.host.toLowerCase();
}

/** Shared by public auth, cookie mutations, WebSockets and supervisor. */
export function trustedOrigin(req: IncomingMessage, configuredOrigin: string): boolean {
  const origin = req.headers.origin;
  if (!origin) {
    const fetchSite = req.headers["sec-fetch-site"];
    return fetchSite === "same-origin" || fetchSite === "none";
  }
  let valid = false;
  try {
    const parsed = new URL(origin);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== origin) return false;
    const configured = new URL(configuredOrigin);
    valid = parsed.origin === configured.origin
      || localLoopbackAlias(parsed, configured)
      || trustedProxyOrigin(req, parsed, configured);
  } catch { /* Reject malformed origins. */ }
  if (!valid && req.headers["x-forwarded-host"] && req.headers["x-forwarded-host"] !== req.headers.host && !warned) {
    warned = true;
    // Fixed message: no attacker-controlled header values or unbounded labels.
    console.warn(originFailureHint);
  }
  return valid;
}
