import type { IncomingMessage } from "node:http";

export type JsonBodyLimits = {
  maxBytes: number;
  idleTimeoutMs: number;
  totalTimeoutMs: number;
};

export async function readJsonBody(
  req: IncomingMessage,
  limits: JsonBodyLimits,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  let idleTimer: NodeJS.Timeout | undefined;
  let totalTimer: NodeJS.Timeout | undefined;
  const abort = () => req.destroy(new Error("Request body timed out"));
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(abort, limits.idleTimeoutMs);
    idleTimer.unref();
  };
  totalTimer = setTimeout(abort, limits.totalTimeoutMs);
  totalTimer.unref();
  resetIdle();
  try {
    for await (const chunk of req) {
      resetIdle();
      size += chunk.length;
      if (size > limits.maxBytes) throw new Error("Body too large");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString() || "{}") as unknown;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (totalTimer) clearTimeout(totalTimer);
  }
}
