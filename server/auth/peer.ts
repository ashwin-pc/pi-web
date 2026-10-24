import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

// Internal header the supervisor writes with the public socket peer when it
// proxies a request to the loopback child. Any caller-supplied value for this
// header MUST be stripped by sanitizeProxyHeaders before the forward hop.
export const SUPERVISOR_PEER_HEADER = "x-pi-web-peer";

// True when the raw socket peer address is itself a loopback address.
export function isLoopbackSocketAddress(address: string | undefined): boolean {
  if (!address) return false;
  if (isIP(address) === 4) return address.startsWith("127.");
  if (isIP(address) !== 6 || address.includes("%")) return false;
  const normalized = new URL(`http://[${address}]/`).hostname;
  if (normalized === "[::1]") return true;
  const mapped = /^\[::ffff:([0-9a-f]+):[0-9a-f]+\]$/.exec(normalized);
  return !!mapped && (parseInt(mapped[1], 16) >>> 8) === 127;
}

// Canonicalize an IP string the supervisor is about to forward: reject
// non-IP input and interface-scoped IPv6, normalize IPv6 spelling and unwrap
// IPv4-mapped sockets. Returns undefined for anything unusable.
export function canonicalPeerAddress(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (isIP(value) === 4) return value;
  if (isIP(value) !== 6 || value.includes("%")) return undefined;
  const normalized = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(normalized);
  if (!mapped) return normalized;
  const a = parseInt(mapped[1], 16),
    b = parseInt(mapped[2], 16);
  return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
}

// Resolve the effective client peer for authorization decisions.
//
// When the child runs under the supervisor (PI_WEB_SUPERVISED=1) and the
// socket peer is loopback (the supervisor's loopback hop), prefer the
// supervisor-authored x-pi-web-peer header, which carries the real public
// client address. Otherwise return the raw socket address.
//
// Defense in depth: the supervisor strips any caller-supplied x-pi-web-peer
// before forwarding, so the header is only ever supervisor-authored in that
// configuration.
export function effectivePeerAddress(req: Pick<IncomingMessage, "socket" | "headers">): string | undefined {
  const socketPeer = req.socket?.remoteAddress || undefined;
  if (
    process.env.PI_WEB_SUPERVISED === "1" &&
    isLoopbackSocketAddress(socketPeer)
  ) {
    const raw = req.headers[SUPERVISOR_PEER_HEADER];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === "string") {
      const canonical = canonicalPeerAddress(value.trim());
      if (canonical) return canonical;
    }
  }
  return socketPeer;
}
