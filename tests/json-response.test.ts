import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { acceptsGzip, sendNegotiatedJson } from "../server/shared/jsonResponse.js";

function get(port: number, encoding?: string): Promise<{ headers: IncomingMessage["headers"]; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, headers: encoding ? { "accept-encoding": encoding } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("negotiated JSON compression", () => {
  it("honors gzip quality and explicit exclusion over wildcard", () => {
    for (const header of ["gzip", "br, gzip;q=0.5", "*", "GZIP; q=1"]) expect(acceptsGzip(header)).toBe(true);
    for (const header of [undefined, "br", "gzip;q=0", "gzip;q=0, *;q=1", "gzip;q=wat", "gzip;q=2"]) expect(acceptsGzip(header)).toBe(false);
  });

  it("sends gzip only when negotiated, preserves Vary and matches body length", async () => {
    const value = { ok: true, messages: [{ content: "sample text ".repeat(5000) }] };
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      res.setHeader("Vary", "Origin");
      void sendNegotiatedJson(req, res, 200, value);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No listening address");
    try {
      const plain = await get(address.port);
      const zipped = await get(address.port, "gzip");
      const excluded = await get(address.port, "gzip;q=0, *;q=1");
      expect(plain.headers["content-encoding"]).toBeUndefined();
      expect(excluded.headers["content-encoding"]).toBeUndefined();
      expect(zipped.headers["content-encoding"]).toBe("gzip");
      expect(zipped.headers.vary).toBe("Origin, Accept-Encoding");
      expect(zipped.headers["cache-control"]).toBe("no-store");
      expect(Number(zipped.headers["content-length"])).toBe(zipped.body.length);
      expect(JSON.parse(gunzipSync(zipped.body).toString())).toEqual(value);
      expect(excluded.body).toEqual(plain.body);
      expect(zipped.body.length).toBeLessThan(plain.body.length / 10);
      console.log(`JSON payload compression: identity=${plain.body.length} bytes; gzip=${zipped.body.length} bytes`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
