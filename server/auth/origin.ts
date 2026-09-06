import type { IncomingMessage } from "node:http";

/** Host is the actual HTTP authority. Forwarded headers are deliberately not
 * trusted: proxies must preserve Host or configure the public origin. */
export function trustedOrigin(
  req: IncomingMessage,
  configuredOrigin: string,
): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.origin !== origin
    )
      return false;
    return (
      parsed.origin === new URL(configuredOrigin).origin ||
      parsed.host.toLowerCase() === req.headers.host?.toLowerCase()
    );
  } catch {
    return false;
  }
}
