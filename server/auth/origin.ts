import type { IncomingMessage } from "node:http";
import type { TLSSocket } from "node:tls";
import { forwardedHost, normalizedAuthority } from "./proxy.js";

export const originFailureHint = "Origin does not match Host. If a reverse proxy rewrites Host, preserve the public Host, set PI_WEB_AUTH_ORIGIN to the public origin, or configure PI_WEB_AUTH_PROXY_PEERS with exact trusted proxy IPs that overwrite X-Forwarded-Host.";
let warned = false;

/**
 * Operator-provided public-host allowlist (comma-separated authorities,
 * normalized with default-port semantics for the Origin's scheme). When set,
 * both the Host/X-Forwarded-Host fallback and the pre-routing anti-rebinding
 * guard require membership. When unset, the legacy Origin==Host fallback is
 * preserved for back-compat; set this (or PI_WEB_AUTH_ORIGIN) to pin trust in
 * deployments exposed beyond loopback.
 */
function parseAllowedHosts(protocol?: "http:" | "https:"): Set<string> | undefined {
  const raw = process.env.PI_WEB_AUTH_ALLOWED_HOSTS;
  if (!raw) return undefined;
  const out = new Set<string>();
  for (const entry of raw.split(",")) {
    const normalized = normalizedAuthority(entry.trim(), protocol);
    if (normalized) out.add(normalized);
  }
  return out.size ? out : undefined;
}

/** Scheme the request actually arrived on. */
function requestProtocol(req: IncomingMessage): "http:" | "https:" {
  return (req.socket as TLSSocket | undefined)?.encrypted ? "https:" : "http:";
}

/** True when the request's Host authority is permitted by the allowlist (if set). */
export function hostAllowed(req: IncomingMessage): boolean {
  const protocol = requestProtocol(req);
  const allowed = parseAllowedHosts(protocol);
  if (!allowed) return true;
  const host = normalizedAuthority(req.headers.host, protocol);
  if (host && allowed.has(host)) return true;
  const xfh = forwardedHost(req, protocol);
  return !!xfh && allowed.has(xfh);
}

/** Shared by public auth, cookie mutations, WebSockets and supervisor. */
export function trustedOrigin(req: IncomingMessage, configuredOrigin: string): boolean {
  const origin = req.headers.origin;
  if (!origin) {
    // A missing Origin header is only trusted when the browser's Fetch-Metadata
    // signal confirms the request is same-origin. Foreign pages cannot set
    // `sec-fetch-site`, so this closes the Origin-less bypass without breaking
    // same-origin navigations (which modern browsers mark `same-origin`,
    // `none`, or when upgraded from a user activation `same-site`).
    const fetchSite = req.headers["sec-fetch-site"];
    return fetchSite === "same-origin" || fetchSite === "none";
  }
  let valid = false;
  try {
    const parsed = new URL(origin);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== origin) {
      return false;
    }
    const configured = new URL(configuredOrigin);
    const allowedHosts = parseAllowedHosts(parsed.protocol);
    // (1) Exact configured origin match: the primary, pinned trust anchor.
    if (parsed.origin === configured.origin) {
      valid = true;
    } else if (allowedHosts && parsed.protocol === configured.protocol &&
               allowedHosts.has(parsed.host.toLowerCase())) {
      // (2) Operator-configured public-host allowlist, scheme-strict against
      //     the configured origin.
      valid = true;
    } else if (!(configured.protocol === "https:" && parsed.protocol === "http:")) {
      // (3) Host/X-Forwarded-Host fallback (OWASP same-origin derivation).
      //     Also refuses a scheme downgrade: an HTTP Origin is never accepted
      //     for an HTTPS-pinned deployment. When PI_WEB_AUTH_ALLOWED_HOSTS is
      //     set, Host/XFH membership is required, closing DNS-rebinding.
      const originHost = parsed.host.toLowerCase();
      const hostAuthority = normalizedAuthority(req.headers.host, parsed.protocol);
      const xfh = forwardedHost(req, parsed.protocol);
      const hostMatch = !!hostAuthority && originHost === hostAuthority;
      const xfhMatch = !!xfh && originHost === xfh;
      if (allowedHosts) {
        if ((hostMatch && hostAuthority && allowedHosts.has(hostAuthority)) ||
            (xfhMatch && xfh && allowedHosts.has(xfh))) {
          valid = true;
        }
      } else if (hostMatch || xfhMatch) {
        valid = true;
      }
    }
  } catch { /* Reject malformed origins. */ }
  if (!valid && req.headers["x-forwarded-host"] && req.headers["x-forwarded-host"] !== req.headers.host && !warned) {
    warned = true;
    // Fixed message: no attacker-controlled header values or unbounded labels.
    console.warn(originFailureHint);
  }
  return valid;
}
