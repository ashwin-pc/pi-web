import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { canonicalIP, isLoopbackAddress } from "./ip.js";

export const SUPERVISOR_PEER_HEADER = "x-pi-web-peer";
export const SUPERVISOR_SECRET_HEADER = "x-pi-web-supervisor-secret";
export const UNKNOWN_SUPERVISOR_PEER = "unknown";

type SupervisorPeerContext = {
  supervised: boolean;
  secret?: string;
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

export const canonicalPeerAddress = canonicalIP;
export const isLoopbackPeer = isLoopbackAddress;

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
  const secret = context.secret;
  if (!context.supervised || !secret || !isLoopbackAddress(req.socket?.remoteAddress)) return undefined;
  const rawPeer = req.headers[SUPERVISOR_PEER_HEADER];
  const provided = req.headers[SUPERVISOR_SECRET_HEADER];
  if (typeof rawPeer !== "string" || typeof provided !== "string") return undefined;
  const value = rawPeer.trim();
  const peer = value === UNKNOWN_SUPERVISOR_PEER
    ? UNKNOWN_SUPERVISOR_PEER
    : canonicalIP(value);
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
  const socketPeer = canonicalIP(req.socket?.remoteAddress);
  if (context.supervised) {
    if (!socketPeer) return UNKNOWN_SUPERVISOR_PEER;
    const hasStamp = req.headers[SUPERVISOR_PEER_HEADER] !== undefined ||
      req.headers[SUPERVISOR_SECRET_HEADER] !== undefined;
    if (!hasStamp) return socketPeer;
    return authenticatedSupervisorPeer(req) || UNKNOWN_SUPERVISOR_PEER;
  }
  return socketPeer;
}
