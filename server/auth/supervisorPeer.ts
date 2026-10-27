import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { isIP } from "node:net";

export const SUPERVISOR_PEER_HEADER = "x-pi-web-peer";
export const SUPERVISOR_SECRET_HEADER = "x-pi-web-supervisor-secret";

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

export function stripSupervisorPeerHeaders(headers: IncomingHttpHeaders): void {
  delete headers[SUPERVISOR_PEER_HEADER];
  delete headers[SUPERVISOR_SECRET_HEADER];
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

function authenticatedSupervisorPeer(
  req: Pick<IncomingMessage, "headers" | "socket">,
): string | undefined {
  const secret = process.env.PI_WEB_SUPERVISOR_SECRET;
  if (process.env.PI_WEB_SUPERVISED !== "1" || !secret || !isLoopbackPeer(req.socket?.remoteAddress)) return undefined;
  const rawPeer = req.headers[SUPERVISOR_PEER_HEADER];
  const provided = req.headers[SUPERVISOR_SECRET_HEADER];
  if (typeof rawPeer !== "string" || typeof provided !== "string") return undefined;
  const peer = canonicalPeerAddress(rawPeer.trim());
  const expectedBytes = Buffer.from(secret);
  const providedBytes = Buffer.from(provided);
  return peer &&
    providedBytes.length === expectedBytes.length &&
    timingSafeEqual(providedBytes, expectedBytes)
    ? peer
    : undefined;
}

export function effectivePeerAddress(
  req: Pick<IncomingMessage, "headers" | "socket">,
): string | undefined {
  return authenticatedSupervisorPeer(req) || canonicalPeerAddress(req.socket?.remoteAddress);
}
