import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { canonicalIP, isLoopbackAddress } from "./ip.js";

export const SUPERVISOR_PEER_HEADER = "x-pi-web-peer";
export const SUPERVISOR_SECRET_HEADER = "x-pi-web-supervisor-secret";
export const SUPERVISOR_TUNNEL_HEADER = "x-pi-web-tunnel";
export const UNKNOWN_SUPERVISOR_PEER = "unknown";

type SupervisorPeerContext = {
  supervised: boolean;
  secret?: string;
  tunnelSocketEnabled: boolean;
};

let context: SupervisorPeerContext = {
  supervised: process.env.PI_WEB_SUPERVISED === "1",
  secret: process.env.PI_WEB_SUPERVISOR_SECRET || undefined,
  tunnelSocketEnabled: !!process.env.PI_WEB_TUNNEL_SOCKET,
};

const tunnelRequests = new WeakSet<IncomingMessage>();
const reservedHeaders = new Set([
  SUPERVISOR_PEER_HEADER,
  SUPERVISOR_SECRET_HEADER,
  SUPERVISOR_TUNNEL_HEADER,
]);

/** Capture startup-only trust once, then keep it out of agent tool environments. */
export function initializeSupervisorPeerContext(env: NodeJS.ProcessEnv): void {
  context = {
    supervised: env.PI_WEB_SUPERVISED === "1",
    secret: env.PI_WEB_SUPERVISOR_SECRET || undefined,
    tunnelSocketEnabled: !!env.PI_WEB_TUNNEL_SOCKET,
  };
  delete env.PI_WEB_SUPERVISOR_SECRET;
  delete env.PI_WEB_TUNNEL_SOCKET;
}

export function tunnelSocketIdentityEnabled(): boolean {
  return context.tunnelSocketEnabled;
}

export function isReservedSupervisorHeader(value: string): boolean {
  return reservedHeaders.has(value.toLowerCase());
}

export function resolveSupervisorPeer(
  remoteAddress: string | undefined,
  forwarded: string | string[] | undefined,
  trustedForwarder: boolean,
): string {
  if (!trustedForwarder)
    return canonicalIP(remoteAddress) || UNKNOWN_SUPERVISOR_PEER;
  return typeof forwarded === "string"
    ? canonicalIP(forwarded.trim()) || UNKNOWN_SUPERVISOR_PEER
    : UNKNOWN_SUPERVISOR_PEER;
}

export const canonicalPeerAddress = canonicalIP;
export const isLoopbackPeer = isLoopbackAddress;

export function stripSupervisorPeerHeaders(
  headers: IncomingHttpHeaders,
): void {
  for (const header of reservedHeaders) delete headers[header];
}

export function stampSupervisorProvenance(
  req: Pick<IncomingMessage, "headers">,
  peer: string,
  tunnel: boolean,
  secret: string,
): void {
  stripSupervisorPeerHeaders(req.headers);
  req.headers[SUPERVISOR_PEER_HEADER] = peer;
  req.headers[SUPERVISOR_SECRET_HEADER] = secret;
  if (tunnel) req.headers[SUPERVISOR_TUNNEL_HEADER] = "1";
}

export function stampSupervisorPeer(
  req: Pick<IncomingMessage, "headers">,
  peer: string,
  secret: string,
): void {
  stampSupervisorProvenance(req, peer, false, secret);
}

export function stampSupervisorTunnel(
  req: Pick<IncomingMessage, "headers">,
  secret: string,
): void {
  stampSupervisorProvenance(req, UNKNOWN_SUPERVISOR_PEER, true, secret);
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
  const secret = context.secret;
  const provided = req.headers[SUPERVISOR_SECRET_HEADER];
  if (
    !context.supervised ||
    !secret ||
    !isLoopbackAddress(req.socket?.remoteAddress) ||
    typeof provided !== "string"
  )
    return false;
  const expectedBytes = Buffer.from(secret);
  const providedBytes = Buffer.from(provided);
  return (
    providedBytes.length === expectedBytes.length &&
    timingSafeEqual(providedBytes, expectedBytes)
  );
}

function authenticatedSupervisorPeer(
  req: Pick<IncomingMessage, "headers" | "socket">,
): string | undefined {
  if (!authenticatedSupervisorRequest(req)) return undefined;
  const rawPeer = req.headers[SUPERVISOR_PEER_HEADER];
  if (typeof rawPeer !== "string") return undefined;
  const value = rawPeer.trim();
  return value === UNKNOWN_SUPERVISOR_PEER
    ? UNKNOWN_SUPERVISOR_PEER
    : canonicalIP(value);
}

export function authenticatedTunnelRequest(
  req: Pick<IncomingMessage, "headers" | "socket">,
): boolean {
  return (
    isLocalTunnelRequest(req as IncomingMessage) ||
    (authenticatedSupervisorRequest(req) &&
      req.headers[SUPERVISOR_TUNNEL_HEADER] === "1")
  );
}

export function effectivePeerAddress(
  req: Pick<IncomingMessage, "headers" | "socket">,
): string | undefined {
  const socketPeer = canonicalIP(req.socket?.remoteAddress);
  if (context.supervised) {
    if (!socketPeer) return UNKNOWN_SUPERVISOR_PEER;
    const hasStamp =
      req.headers[SUPERVISOR_PEER_HEADER] !== undefined ||
      req.headers[SUPERVISOR_SECRET_HEADER] !== undefined;
    if (!hasStamp) return socketPeer;
    return authenticatedSupervisorPeer(req) || UNKNOWN_SUPERVISOR_PEER;
  }
  return socketPeer;
}
