import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { timingSafeEqual } from "node:crypto";

/** Header the bundled supervisor stamps with the public socket's peer IP. */
export const SUPERVISOR_PEER_HEADER = "x-pi-supervisor-peer";
/** Header carrying the per-start secret that proves the stamp came from the supervisor. */
export const SUPERVISOR_SECRET_HEADER = "x-pi-supervisor-secret";

/** Exact IP peers only: normalize IPv6 spelling and IPv4-mapped sockets. */
export function canonicalIP(value: string): string | undefined {
  if (!isIP(value) || value.includes("%")) return undefined;
  if (isIP(value) === 4) return value;
  const normalized = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(normalized);
  if (!mapped) return normalized;
  const a = parseInt(mapped[1], 16), b = parseInt(mapped[2], 16);
  return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
}

/** True when `value` is in 127.0.0.0/8, ::1, or an IPv4-mapped loopback. */
export function isLoopbackIP(value: string | undefined): boolean {
  const canonical = canonicalIP(value || "");
  if (!canonical) return false;
  if (isIP(canonical) === 4) return canonical.startsWith("127.");
  return canonical === "::1";
}

function constantTimeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Verify the bundled supervisor's authenticated client marker.
 * The supervisor is the only process that knows PI_WEB_SUPERVISOR_SECRET, and it
 * only accepts connections from its public listener before stamping these headers.
 * Returns the canonicalized true client IP, or undefined when the marker is
 * absent, forged, or malformed.
 */
export function supervisorForwardedPeer(req: IncomingMessage): string | undefined {
  const expected = process.env.PI_WEB_SUPERVISOR_SECRET || "";
  if (!expected) return undefined;
  // The supervisor always connects over loopback; refuse the marker from any
  // other peer so a network attacker cannot spoof it directly against the child.
  const socketPeer = canonicalIP(req.socket?.remoteAddress || "");
  if (!socketPeer || !isLoopbackIP(socketPeer)) return undefined;
  const provided = req.headers[SUPERVISOR_SECRET_HEADER];
  const peerHeader = req.headers[SUPERVISOR_PEER_HEADER];
  if (typeof provided !== "string" || typeof peerHeader !== "string") return undefined;
  if (!constantTimeEqualString(provided, expected)) return undefined;
  return canonicalIP(peerHeader.trim());
}

export function trustedProxyPeer(req: IncomingMessage): boolean {
  const peer = canonicalIP(req.socket.remoteAddress || "");
  return !!peer && (process.env.PI_WEB_AUTH_PROXY_PEERS || "").split(",")
    .some(value => canonicalIP(value.trim()) === peer);
}

/**
 * The caller IP the server should attribute this request to. Prefers the
 * supervisor's authenticated marker (per-start shared secret + stamped peer),
 * then an explicitly trusted proxy's single-IP X-Forwarded-For, else the
 * raw TCP peer. Behind the bundled supervisor every network client gets a
 * distinct identity instead of collapsing to 127.0.0.1.
 */
export function effectivePeer(req: IncomingMessage): string {
  const forwarded = supervisorForwardedPeer(req);
  if (forwarded) return forwarded;
  const header = req.headers["x-forwarded-for"];
  // Opt-in exact proxy peers; require one sanitized IP, never take an arbitrary chain.
  if (trustedProxyPeer(req) && typeof header === "string" && isIP(header.trim())) {
    return header.trim();
  }
  return req.socket?.remoteAddress || "unknown";
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
