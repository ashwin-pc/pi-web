import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { canonicalIP, isLoopbackAddress } from "./ip.js";

export const SUPERVISOR_PEER_HEADER = "x-pi-web-peer";
export const SUPERVISOR_ORIGIN_HEADER = "x-pi-web-supervisor-origin";
export const SUPERVISOR_SECRET_HEADER = "x-pi-web-supervisor-secret";
export const UNKNOWN_SUPERVISOR_PEER = "unknown";

type SupervisorPeerContext = {
  supervised: boolean;
  secret?: string;
};

type SupervisorProvenance = {
  peer: string;
  originValidated: boolean;
};

let context: SupervisorPeerContext = { supervised: false };

/** Capture the proof secret once, then keep it out of agent tool environments. */
export function initializeSupervisorPeerContext(env: NodeJS.ProcessEnv): void {
  context = {
    supervised: env.PI_WEB_SUPERVISED === "1",
    secret: env.PI_WEB_SUPERVISOR_SECRET || undefined,
  };
  delete env.PI_WEB_SUPERVISOR_SECRET;
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
  delete headers[SUPERVISOR_PEER_HEADER];
  delete headers[SUPERVISOR_ORIGIN_HEADER];
  delete headers[SUPERVISOR_SECRET_HEADER];
}

/** Stamp one authenticated description of the public request onto the child hop. */
export function stampSupervisorProvenance(
  req: Pick<IncomingMessage, "headers">,
  peer: string,
  originValidated: boolean,
  secret: string,
): void {
  stripSupervisorProvenanceHeaders(req.headers);
  req.headers[SUPERVISOR_PEER_HEADER] = peer;
  if (originValidated) req.headers[SUPERVISOR_ORIGIN_HEADER] = "1";
  req.headers[SUPERVISOR_SECRET_HEADER] = secret;
}

function authenticatedSupervisorProvenance(
  req: Pick<IncomingMessage, "headers" | "socket">,
): SupervisorProvenance | undefined {
  const secret = context.secret;
  if (!context.supervised || !secret || !isLoopbackAddress(req.socket?.remoteAddress)) return undefined;
  const rawPeer = req.headers[SUPERVISOR_PEER_HEADER];
  const rawOrigin = req.headers[SUPERVISOR_ORIGIN_HEADER];
  const provided = req.headers[SUPERVISOR_SECRET_HEADER];
  if (typeof rawPeer !== "string" || typeof provided !== "string") return undefined;
  if (rawOrigin !== undefined && rawOrigin !== "1") return undefined;
  const value = rawPeer.trim();
  const peer = value === UNKNOWN_SUPERVISOR_PEER
    ? UNKNOWN_SUPERVISOR_PEER
    : canonicalIP(value);
  const expectedBytes = Buffer.from(secret);
  const providedBytes = Buffer.from(provided);
  if (!peer || providedBytes.length !== expectedBytes.length || !timingSafeEqual(providedBytes, expectedBytes)) {
    return undefined;
  }
  return { peer, originValidated: rawOrigin === "1" };
}

export function authenticatedSupervisorOrigin(
  req: Pick<IncomingMessage, "headers" | "socket">,
): boolean {
  return authenticatedSupervisorProvenance(req)?.originValidated === true;
}

export function effectivePeerAddress(
  req: Pick<IncomingMessage, "headers" | "socket">,
): string | undefined {
  const socketPeer = canonicalIP(req.socket?.remoteAddress);
  if (context.supervised) {
    if (!socketPeer) return UNKNOWN_SUPERVISOR_PEER;
    const hasStamp = req.headers[SUPERVISOR_PEER_HEADER] !== undefined
      || req.headers[SUPERVISOR_ORIGIN_HEADER] !== undefined
      || req.headers[SUPERVISOR_SECRET_HEADER] !== undefined;
    if (!hasStamp) return socketPeer;
    return authenticatedSupervisorProvenance(req)?.peer || UNKNOWN_SUPERVISOR_PEER;
  }
  return socketPeer;
}
