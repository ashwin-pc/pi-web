import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";

export const SUPERVISOR_ORIGIN_HEADER = "x-pi-web-supervisor-origin";
export const SUPERVISOR_SECRET_HEADER = "x-pi-web-supervisor-secret";

function isLoopback(address: string | undefined): boolean {
  return address === "::1"
    || !!address?.startsWith("127.")
    || !!address?.startsWith("::ffff:127.");
}

export function stripSupervisorOriginHeaders(headers: IncomingHttpHeaders): void {
  delete headers[SUPERVISOR_ORIGIN_HEADER];
  delete headers[SUPERVISOR_SECRET_HEADER];
}

export function stampSupervisorOrigin(
  req: Pick<IncomingMessage, "headers">,
  secret: string,
): void {
  stripSupervisorOriginHeaders(req.headers);
  req.headers[SUPERVISOR_ORIGIN_HEADER] = "1";
  req.headers[SUPERVISOR_SECRET_HEADER] = secret;
}

export function createAuthenticatedSupervisorOrigin(
  env: NodeJS.ProcessEnv,
): (req: Pick<IncomingMessage, "headers" | "socket">) => boolean {
  const supervised = env.PI_WEB_SUPERVISED === "1";
  const secret = env.PI_WEB_SUPERVISOR_SECRET;

  /** Accept only an origin decision made by this run's supervisor over its loopback child hop. */
  return (req) => {
    if (!supervised || !secret || !isLoopback(req.socket.remoteAddress)) return false;
    if (req.headers[SUPERVISOR_ORIGIN_HEADER] !== "1") return false;
    const provided = req.headers[SUPERVISOR_SECRET_HEADER];
    if (typeof provided !== "string") return false;
    const expectedBytes = Buffer.from(secret);
    const providedBytes = Buffer.from(provided);
    return providedBytes.length === expectedBytes.length
      && timingSafeEqual(providedBytes, expectedBytes);
  };
}

export const authenticatedSupervisorOrigin = createAuthenticatedSupervisorOrigin(process.env);
