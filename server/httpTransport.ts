import { createReadStream, type ReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError } from "./shared/httpError.js";

export const ordinaryJsonBodyLimit = 1_048_576;
export const promptJsonBodyLimit = 4_194_304;
export const largeJsonBodyLimit = 40_000_000;
export const attachmentBodyLimit = 30_000_000;

export async function readBytes(req: IncomingMessage, maxBytes = attachmentBodyLimit, onChunk?: (bytes: number) => void): Promise<Buffer> {
  const declaredLength = req.headers["content-length"];
  if (typeof declaredLength === "string" && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    throw new HttpError("Request body is too large", 413);
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    onChunk?.(buffer.length);
    if (bytes > maxBytes) throw new HttpError("Request body is too large", 413);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function createJsonBodyReader(resolveLimit?: (req: IncomingMessage, requestedLimit: number) => number) {
  const bodies = new WeakMap<IncomingMessage, Promise<unknown>>();
  return (req: IncomingMessage, maxBytes = ordinaryJsonBodyLimit): Promise<unknown> => {
    let body = bodies.get(req);
    if (!body) {
      body = readBytes(req, resolveLimit?.(req, maxBytes) ?? maxBytes).then((bytes) => {
        const text = bytes.toString("utf-8");
        return text ? JSON.parse(text) : {};
      });
      bodies.set(req, body);
    }
    return body;
  };
}

type StreamFactory = typeof createReadStream;

export function pipeReadStream(
  res: ServerResponse,
  file: string,
  range?: { start: number; end: number },
  createStream: StreamFactory = createReadStream,
) {
  const stream: ReadStream = createStream(file, range);
  const abort = () => stream.destroy();
  const cleanup = () => res.off("close", abort);
  res.once("close", abort);
  stream.once("close", cleanup);
  stream.once("error", (error: NodeJS.ErrnoException) => {
    cleanup();
    if (res.writableEnded || res.destroyed) return;
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    const status = error.code === "ENOENT" || error.code === "EISDIR" ? 404 : 500;
    const body = JSON.stringify({ ok: false, error: status === 404 ? "Not found" : "Could not read file" });
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  });
  stream.pipe(res);
}
