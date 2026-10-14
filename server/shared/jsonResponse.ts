import type { IncomingMessage, ServerResponse } from "node:http";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

const gzipAsync = promisify(gzip);

export function acceptsGzip(header: string | undefined): boolean {
  const encodings = new Map<string, number>();
  for (const item of (header || "").split(",")) {
    const [encoding, ...parameters] = item.trim().toLowerCase().split(";");
    if (!encoding) continue;
    let quality = 1;
    for (const parameter of parameters) {
      const match = /^\s*q\s*=\s*(.*?)\s*$/.exec(parameter);
      if (match) quality = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(match[1]) ? Number(match[1]) : 0;
    }
    encodings.set(encoding, quality);
  }
  return (encodings.get("gzip") ?? encodings.get("*") ?? 0) > 0;
}

/** Async zlib uses the worker pool rather than blocking the event loop. */
export async function sendNegotiatedJson(req: IncomingMessage, res: ServerResponse, status: number, value: unknown): Promise<void> {
  const plain = Buffer.from(JSON.stringify(value));
  let body = plain;
  let compressed = false;
  if (plain.length >= 1024 && acceptsGzip(req.headers["accept-encoding"])) {
    const candidate = await gzipAsync(plain);
    if (candidate.length < plain.length) {
      body = candidate;
      compressed = true;
    }
  }
  if (res.destroyed) return;
  const previousVary = res.getHeader("vary");
  const vary = String(previousVary || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!vary.some((value) => value.toLowerCase() === "accept-encoding" || value === "*")) vary.push("Accept-Encoding");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    vary: vary.join(", "),
    ...(compressed ? { "content-encoding": "gzip" } : {}),
  });
  res.end(body);
}
