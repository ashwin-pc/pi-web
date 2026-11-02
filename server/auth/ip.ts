import { isIP } from "node:net";

/** Exact IPs only: normalize IPv6 spelling and IPv4-mapped sockets. */
export function canonicalIP(value: string | undefined): string | undefined {
  if (!value || !isIP(value) || value.includes("%")) return undefined;
  if (isIP(value) === 4) return value;
  const normalized = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(normalized);
  if (!mapped) return normalized;
  const a = parseInt(mapped[1], 16);
  const b = parseInt(mapped[2], 16);
  return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  const canonical = canonicalIP(address);
  return canonical === "::1" || !!canonical?.startsWith("127.");
}
