import { isLoopbackAddress } from "./ip.js";

/** Local origins cannot safely move their setup ceremony to a remote browser. */
export function bootstrapRequiresLoopback(origin: string): boolean {
  const hostname = new URL(origin).hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  return hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    isLoopbackAddress(hostname);
}
