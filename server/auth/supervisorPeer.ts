import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { isIP } from "node:net";

export const SUPERVISOR_PEER_HEADER = "x-pi-web-peer";
export const SUPERVISOR_SECRET_HEADER = "x-pi-web-supervisor-secret";
export const SUPERVISOR_TUNNEL_HEADER = "x-pi-web-tunnel";

const tunnelRequests = new WeakSet<IncomingMessage>();
const reservedHeaders = new Set([
  SUPERVISOR_PEER_HEADER,
  SUPERVISOR_SECRET_HEADER,
  SUPERVISOR_TUNNEL_HEADER,
]);

export function canonicalPeerAddress(value: string | undefined): string | undefined {
  if (!value || !isIP(value) || value.includes("%")) return undefined;
  if (isIP(value) === 4) return value;
  const normalized = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(normalized);
  if (!mapped) return normalized;
  const a = parseInt(mapped[1], 16);
  const b = parseInt(mapped[2], 16);
  return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
}

export function isLoopbackPeer(address: string | undefined): boolean {
  const canonical = canonicalPeerAddress(address);
  return canonical === "::1" || !!canonical?.startsWith("127.");
}

export function isReservedSupervisorHeader(value: string): boolean {
  return reservedHeaders.has(value.toLowerCase());
}

export function stripSupervisorPeerHeaders(headers: IncomingHttpHeaders): void {
  for (const header of reservedHeaders) delete headers[header];
}

export function stampSupervisorPeer(
  req: Pick<IncomingMessage, "headers">,
  peer: string,
  secret: string,
): void {
  stripSupervisorPeerHeaders(req.headers);
  req.headers[SUPERVISOR_PEER_HEADER] = peer;
  req.headers[SUPERVISOR_SECRET_HEADER] = secret;
}

export function stampSupervisorTunnel(
  req: Pick<IncomingMessage, "headers">,
  secret: string,
): void {
  stripSupervisorPeerHeaders(req.headers);
  req.headers[SUPERVISOR_SECRET_HEADER] = secret;
  req.headers[SUPERVISOR_TUNNEL_HEADER] = "1";
}

export function markTunnelRequest(req: IncomingMessage): void {
  tunnelRequests.add(req);
}

export function isLocalTunnelRequest(req: IncomingMessage): boolean {
  return tunnelRequests.has(req);
}

function authenticatedSupervisorRequest(
  req: Pick<IncomingMessage, "headers" | "socket">,
): boolean {
  const secret = process.env.PI_WEB_SUPERVISOR_SECRET;
  const provided = req.headers[SUPERVISOR_SECRET_HEADER];
  if (
    process.env.PI_WEB_SUPERVISED !== "1" ||
    !secret ||
    typeof provided !== "string" ||
    !isLoopbackPeer(req.socket?.remoteAddress)
  ) return false;
  const expectedBytes = Buffer.from(secret);
  const providedBytes = Buffer.from(provided);
  return providedBytes.length === expectedBytes.length &&
    timingSafeEqual(providedBytes, expectedBytes);
}

export function authenticatedTunnelRequest(
  req: Pick<IncomingMessage, "headers" | "socket">,
): boolean {
  return isLocalTunnelRequest(req as IncomingMessage) ||
    (authenticatedSupervisorRequest(req) &&
      req.headers[SUPERVISOR_TUNNEL_HEADER] === "1");
}

export function effectivePeerAddress(
  req: Pick<IncomingMessage, "headers" | "socket">,
): string | undefined {
  if (authenticatedSupervisorRequest(req)) {
    const peer = req.headers[SUPERVISOR_PEER_HEADER];
    if (typeof peer === "string") return canonicalPeerAddress(peer.trim());
  }
  return canonicalPeerAddress(req.socket?.remoteAddress);
}
