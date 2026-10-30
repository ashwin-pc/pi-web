import type { IncomingMessage } from "node:http";
import type { AuthVia } from "./kernel.js";
import { originFailureHint, trustedOrigin } from "./origin.js";

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : value) || "";
}

function isBrowserMetadataPresent(req: IncomingMessage): boolean {
  return req.headers["sec-fetch-site"] !== undefined;
}

export function requestIntentFailure(
  req: IncomingMessage,
  url: URL,
  via: AuthVia,
  configuredOrigin: string,
): string | undefined {
  const method = req.method || "GET";
  const mutatingSessionRequest = via === "session" && !["GET", "HEAD", "OPTIONS"].includes(method);
  const fetchingGitStatus = method === "GET" && url.pathname === "/api/git/status" && url.searchParams.get("fetch") === "1";
  if (!mutatingSessionRequest && !fetchingGitStatus) return;
  if (fetchingGitStatus && via === "token" && !req.headers.origin && !isBrowserMetadataPresent(req)) return;
  if (header(req, "sec-fetch-site").toLowerCase() === "cross-site" || !trustedOrigin(req, configuredOrigin)) {
    return originFailureHint;
  }
  if (!req.headers["x-pi-web-client-id"]) return "CSRF validation failed";
}
