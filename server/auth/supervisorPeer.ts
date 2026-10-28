import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { canonicalIP } from "./proxy.js";

export const SUPERVISOR_SECRET_HEADER = "x-pi-web-supervisor-secret";
export const SUPERVISOR_TUNNEL_HEADER = "x-pi-web-tunnel";

const supervisedChild = process.env.PI_WEB_SUPERVISED === "1";
const supervisorSecret = process.env.PI_WEB_SUPERVISOR_SECRET;
const tunnelSocketEnabled = !!process.env.PI_WEB_TUNNEL_SOCKET;
if (supervisedChild) {
  delete process.env.PI_WEB_SUPERVISOR_SECRET;
  delete process.env.PI_WEB_TUNNEL_SOCKET;
}

const tunnelRequests = new WeakSet<IncomingMessage>();
const reservedHeaders = new Set([
  "x-pi-web-peer",
  SUPERVISOR_SECRET_HEADER,
  SUPERVISOR_TUNNEL_HEADER,
]);

export function tunnelSocketIdentityEnabled(): boolean {
  return tunnelSocketEnabled;
}

export function isReservedSupervisorHeader(value: string): boolean {
  return reservedHeaders.has(value.toLowerCase());
}

export function stripSupervisorPeerHeaders(headers: IncomingHttpHeaders): void {
  for (const header of reservedHeaders) delete headers[header];
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
  const provided = req.headers[SUPERVISOR_SECRET_HEADER];
  const peer = canonicalIP(req.socket?.remoteAddress || "");
  if (
    !supervisedChild ||
    !supervisorSecret ||
    typeof provided !== "string" ||
    (peer !== "::1" && !peer?.startsWith("127."))
  ) return false;
  const expectedBytes = Buffer.from(supervisorSecret);
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
