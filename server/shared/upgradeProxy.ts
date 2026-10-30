import type { IncomingMessage } from "node:http";
import net, { type Socket } from "node:net";

const MAX_RESPONSE_HEADER_BYTES = 64 * 1024;
const MAX_REJECTION_BODY_BYTES = 64 * 1024;
const RESPONSE_FLUSH_TIMEOUT_MS = 1_000;

export interface UpgradeProxyOptions {
  host: string;
  port: number;
  expectedPath: string | ((req: IncomingMessage, url: URL) => boolean);
  handshakeTimeoutMs: number;
  maxPending: number;
  maxPendingPerPeer: number;
  accept: (req: IncomingMessage) => boolean;
  prepare: (req: IncomingMessage) => void;
  rejectionBody: string;
}

type UpgradeAdmission = {
  release: () => void;
  rejectedSocketError: () => void;
};

function endHttp(socket: Socket, status: number, reason: string, body = reason): void {
  const flushTimer = setTimeout(() => socket.destroy(), RESPONSE_FLUSH_TIMEOUT_MS);
  flushTimer.unref();
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nContent-Type: text/plain\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    () => {
      clearTimeout(flushTimer);
      socket.destroy();
    },
  );
}

function responseContentLength(header: string): number | undefined {
  const match = /\r\ncontent-length:\s*(\d+)\s*\r\n/i.exec(header);
  if (!match) return undefined;
  const length = Number(match[1]);
  return Number.isSafeInteger(length) ? length : undefined;
}

function createUpgradeAdmission(options: UpgradeProxyOptions) {
  let pending = 0;
  const pendingByPeer = new Map<string, number>();

  return (req: IncomingMessage, socket: Socket): UpgradeAdmission | undefined => {
    // Keep pre-upgrade bytes in the kernel receive buffer while admission runs.
    socket.pause();
    const rejectedSocketError = () => socket.destroy();
    socket.once("error", rejectedSocketError);

    let url: URL;
    try {
      url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    } catch {
      endHttp(socket, 400, "Bad Request");
      return undefined;
    }
    try {
      const expected = typeof options.expectedPath === "string"
        ? url.pathname === options.expectedPath
        : options.expectedPath(req, url);
      if (!expected) {
        socket.destroy();
        return undefined;
      }
      if (!options.accept(req)) {
        endHttp(socket, 403, "Forbidden", options.rejectionBody);
        return undefined;
      }
    } catch {
      endHttp(socket, 400, "Bad Request");
      return undefined;
    }

    const peer = req.socket.remoteAddress || "unknown";
    const peerPending = pendingByPeer.get(peer) || 0;
    if (pending >= options.maxPending || peerPending >= options.maxPendingPerPeer) {
      endHttp(socket, 503, "Service Unavailable");
      return undefined;
    }
    try {
      options.prepare(req);
    } catch {
      endHttp(socket, 400, "Bad Request");
      return undefined;
    }

    pending += 1;
    pendingByPeer.set(peer, peerPending + 1);
    let released = false;
    return {
      rejectedSocketError,
      release: () => {
        if (released) return;
        released = true;
        pending -= 1;
        const remaining = (pendingByPeer.get(peer) || 1) - 1;
        if (remaining > 0) pendingByPeer.set(peer, remaining);
        else pendingByPeer.delete(peer);
      },
    };
  };
}

function relayUpgrade(
  options: UpgradeProxyOptions,
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
  admission: UpgradeAdmission,
): void {
  socket.off("error", admission.rejectedSocketError);
  const upstream = net.connect(options.port, options.host);
  let closed = false;
  let handshakePending = true;
  let responseBuffer = Buffer.alloc(0);
  let rejectionBytesRemaining: number | undefined;

  const releasePending = () => {
    if (!handshakePending) return;
    handshakePending = false;
    clearTimeout(handshakeTimer);
    admission.release();
  };
  const closeBoth = () => {
    if (closed) return;
    closed = true;
    releasePending();
    socket.destroy();
    upstream.destroy();
  };
  const finishRejectedResponse = () => {
    if (closed) return;
    closed = true;
    releasePending();
    upstream.destroy();
    const flushTimer = setTimeout(() => socket.destroy(), RESPONSE_FLUSH_TIMEOUT_MS);
    flushTimer.unref();
    socket.end(() => {
      clearTimeout(flushTimer);
      socket.destroy();
    });
  };
  const handshakeTimer = setTimeout(closeBoth, options.handshakeTimeoutMs);
  handshakeTimer.unref();

  socket.once("error", closeBoth);
  socket.on("drain", () => upstream.resume());
  upstream.once("error", closeBoth);
  socket.once("close", closeBoth);
  upstream.once("close", closeBoth);

  upstream.on("connect", () => {
    upstream.write(`${req.method || "GET"} ${req.url || "/"} HTTP/${req.httpVersion}\r\n`);
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) {
        for (const item of value) upstream.write(`${name}: ${item}\r\n`);
      } else if (value !== undefined) {
        upstream.write(`${name}: ${value}\r\n`);
      }
    }
    upstream.write("\r\n");
    if (head.length) upstream.write(head);
  });

  const onRejectedBodyData = (chunk: Buffer) => {
    if (rejectionBytesRemaining === undefined) return;
    const forwardedLength = Math.min(chunk.length, rejectionBytesRemaining);
    if (forwardedLength && !socket.write(chunk.subarray(0, forwardedLength)))
      upstream.pause();
    rejectionBytesRemaining -= forwardedLength;
    if (rejectionBytesRemaining === 0) {
      upstream.off("data", onRejectedBodyData);
      finishRejectedResponse();
    }
  };

  const onHandshakeData = (chunk: Buffer) => {
    responseBuffer = Buffer.concat([responseBuffer, chunk]);
    const separatorOffset = responseBuffer.indexOf("\r\n\r\n");
    if (separatorOffset < 0) {
      if (responseBuffer.length > MAX_RESPONSE_HEADER_BYTES) closeBoth();
      return;
    }

    const headerEnd = separatorOffset + 4;
    if (headerEnd > MAX_RESPONSE_HEADER_BYTES) {
      closeBoth();
      return;
    }

    const responseHeader = responseBuffer.subarray(0, headerEnd).toString("latin1");
    const upgraded = /^HTTP\/1\.[01] 101(?:\s|$)/.test(responseHeader);
    upstream.off("data", onHandshakeData);
    if (upgraded) {
      releasePending();
      if (!socket.write(responseBuffer)) upstream.pause();
      responseBuffer = Buffer.alloc(0);
      socket.pipe(upstream);
      upstream.pipe(socket);
      return;
    }

    const contentLength = responseContentLength(responseHeader);
    if (contentLength === undefined || contentLength > MAX_REJECTION_BODY_BYTES) {
      socket.write(responseBuffer.subarray(0, headerEnd + MAX_REJECTION_BODY_BYTES));
      finishRejectedResponse();
      return;
    }

    const bodyBytes = responseBuffer.length - headerEnd;
    const forwardedLength = headerEnd + Math.min(bodyBytes, contentLength);
    if (!socket.write(responseBuffer.subarray(0, forwardedLength))) upstream.pause();
    rejectionBytesRemaining = contentLength - Math.min(bodyBytes, contentLength);
    responseBuffer = Buffer.alloc(0);
    if (rejectionBytesRemaining === 0) {
      finishRejectedResponse();
      return;
    }
    upstream.on("data", onRejectedBodyData);
  };

  upstream.on("data", onHandshakeData);
  upstream.once("end", finishRejectedResponse);
}

/** Admits a bounded handshake, then relays established sockets without a lifetime cap. */
export function createUpgradeProxy(options: UpgradeProxyOptions) {
  const admit = createUpgradeAdmission(options);
  return (req: IncomingMessage, socket: Socket, head: Buffer): void => {
    const admission = admit(req, socket);
    if (admission) relayUpgrade(options, req, socket, head, admission);
  };
}
