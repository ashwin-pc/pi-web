import type { IncomingMessage } from "node:http";
import { HttpError } from "./httpError.js";

export async function readBytes(req: IncomingMessage, maxBytes = 30_000_000, onChunk?: (bytes: number) => void): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      onChunk?.(buffer.length);
      if (bytes > maxBytes) throw new HttpError("Request body is too large", 413);
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof HttpError && error.status === 413) {
      // Keep the request/socket usable long enough to deliver the response.
      // Any bytes the handler no longer needs must still be consumed so a
      // chunked upload cannot stall this connection.
      req.on("error", () => {});
      req.resume();
    }
    throw error;
  }
  return Buffer.concat(chunks);
}
