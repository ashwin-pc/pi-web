import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { canonicalIP, isLoopbackAddress } from "./ip.js";

export const SUPERVISOR_PEER_HEADER = "x-pi-web-peer";
export const SUPERVISOR_ORIGIN_HEADER = "x-pi-web-supervisor-origin";
export const SUPERVISOR_SECRET_HEADER = "x-pi-web-supervisor-secret";
export const SUPERVISOR_TUNNEL_HEADER = "x-pi-web-tunnel";
export const UNKNOWN_SUPERVISOR_PEER = "unknown";

type SupervisorPeerContext = {
  supervised: boolean;
  secret?: string;
  tunnelSocketEnabled: boolean;
};

type SupervisorProvenance = {
  peer: string;
  tunnel: boolean;
  originValidated: boolean;
};

let context: SupervisorPeerContext = {
  supervised: false,
  tunnelSocketEnabled: false,
};

const reservedHeaders = new Set([
  SUPERVISOR_PEER_HEADER,
  SUPERVISOR_ORIGIN_HEADER,
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
  if (!trustedForwarder) return canonicalIP(remoteAddress) || UNKNOWN_SUPERVISOR_PEER;
  return typeof forwarded === "string"
    ? canonicalIP(forwarded.trim()) || UNKNOWN_SUPERVISOR_PEER
    : UNKNOWN_SUPERVISOR_PEER;
}

export function stripSupervisorProvenanceHeaders(headers: IncomingHttpHeaders): void {
  for (const header of reservedHeaders) delete headers[header];
}

/** Stamp one authenticated description of the public request onto the child hop. */
export function stampSupervisorProvenance(
  req: Pick<IncomingMessage, "headers">,
  peer: string,
  tunnel: boolean,
  originValidated: boolean,
  secret: string,
): void {
  stripSupervisorProvenanceHeaders(req.headers);
  req.headers[SUPERVISOR_PEER_HEADER] = peer;
  if (tunnel) req.headers[SUPERVISOR_TUNNEL_HEADER] = "1";
  if (originValidated) req.headers[SUPERVISOR_ORIGIN_HEADER] = "1";
  req.headers[SUPERVISOR_SECRET_HEADER] = secret;
}

function authenticatedSupervisorProvenance(
  req: Pick<IncomingMessage, "headers" | "socket">,
): SupervisorProvenance | undefined {
  const secret = context.secret;
  const provided = req.headers[SUPERVISOR_SECRET_HEADER];
  const rawPeer = req.headers[SUPERVISOR_PEER_HEADER];
  const rawTunnel = req.headers[SUPERVISOR_TUNNEL_HEADER];
  const rawOrigin = req.headers[SUPERVISOR_ORIGIN_HEADER];
  if (
    !context.supervised
    || !secret
    || !isLoopbackAddress(req.socket?.remoteAddress)
    || typeof provided !== "string"
    || typeof rawPeer !== "string"
    || (rawTunnel !== undefined && rawTunnel !== "1")
    || (rawOrigin !== undefined && rawOrigin !== "1")
  ) return undefined;
  const expectedBytes = Buffer.from(secret);
  const providedBytes = Buffer.from(provided);
  if (providedBytes.length !== expectedBytes.length || !timingSafeEqual(providedBytes, expectedBytes)) return undefined;
  const value = rawPeer.trim();
  const peer = value === UNKNOWN_SUPERVISOR_PEER
    ? UNKNOWN_SUPERVISOR_PEER
    : canonicalIP(value);
  return peer ? {
    peer,
    tunnel: rawTunnel === "1",
    originValidated: rawOrigin === "1",
  } : undefined;
}

export function authenticatedSupervisorOrigin(
  req: Pick<IncomingMessage, "headers" | "socket">,
): boolean {
  return authenticatedSupervisorProvenance(req)?.originValidated === true;
}

export function authenticatedTunnelRequest(
  req: Pick<IncomingMessage, "headers" | "socket">,
): boolean {
  return authenticatedSupervisorProvenance(req)?.tunnel === true;
}

export function effectivePeerAddress(
  req: Pick<IncomingMessage, "headers" | "socket">,
): string | undefined {
  const socketPeer = canonicalIP(req.socket?.remoteAddress);
  if (context.supervised) {
    if (!socketPeer) return UNKNOWN_SUPERVISOR_PEER;
    const hasStamp = [...reservedHeaders].some(header => req.headers[header] !== undefined);
    if (!hasStamp) return socketPeer;
    return authenticatedSupervisorProvenance(req)?.peer || UNKNOWN_SUPERVISOR_PEER;
  }
  return socketPeer;
}
