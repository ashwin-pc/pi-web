import type { IncomingMessage } from "node:http";
import type { AuthVia } from "./kernel.js";
import { trustedOrigin } from "./origin.js";

const ambientBrowserAuth = new Set<AuthVia>(["session", "external", "open"]);

export type MutationAdmissionFailure = "origin" | "intent";

export function isAmbientBrowserAuth(via: AuthVia): boolean {
  return ambientBrowserAuth.has(via);
}

export function isIdempotentMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

export function browserMutationFailure(
  req: IncomingMessage,
  via: AuthVia,
  configuredOrigin: string,
  mockMode = false,
): MutationAdmissionFailure | undefined {
  const hasBrowserSignal =
    req.headers.origin !== undefined ||
    req.headers["sec-fetch-site"] !== undefined;
  if (!isAmbientBrowserAuth(via) && !(via === "token" && hasBrowserSignal)) return undefined;

  const mockIntent = mockMode && Boolean(req.headers["x-pi-web-test-client-intent"]);
  const explicitMockOrigin =
    mockIntent &&
    req.headers.origin === undefined &&
    req.headers["sec-fetch-site"] === undefined;
  if (!trustedOrigin(req, configuredOrigin) && !explicitMockOrigin) return "origin";
  if (!req.headers["x-pi-web-client-id"] && !explicitMockOrigin) return "intent";
  return undefined;
}
