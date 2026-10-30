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

/** Relays only the bounded HTTP upgrade handshake; established sockets stay long-lived. */
export function createUpgradeProxy(options: UpgradeProxyOptions) {
  let pending = 0;
  const pendingByPeer = new Map<string, number>();

  return (req: IncomingMessage, socket: Socket, head: Buffer): void => {
    // The HTTP server has handed ownership of this socket to us. Pause it before
    // authentication/upstream negotiation so pre-upgrade bytes stay bounded by
    // the kernel receive buffer, while preserving Node's already-parsed `head`.
    socket.pause();
    const onRejectedSocketError = () => socket.destroy();
    socket.once("error", onRejectedSocketError);

    let url: URL;
    try {
      url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    } catch {
      endHttp(socket, 400, "Bad Request");
      return;
    }
    let expectedPath: boolean;
    try {
      expectedPath = typeof options.expectedPath === "string"
        ? url.pathname === options.expectedPath
        : options.expectedPath(req, url);
    } catch {
      endHttp(socket, 400, "Bad Request");
      return;
    }
    if (!expectedPath) {
      socket.destroy();
      return;
    }
    let accepted: boolean;
    try {
      accepted = options.accept(req);
    } catch {
      endHttp(socket, 400, "Bad Request");
      return;
    }
    if (!accepted) {
      endHttp(socket, 403, "Forbidden", options.rejectionBody);
      return;
    }

    const peer = req.socket.remoteAddress || "unknown";
    const peerPending = pendingByPeer.get(peer) || 0;
    if (pending >= options.maxPending || peerPending >= options.maxPendingPerPeer) {
      endHttp(socket, 503, "Service Unavailable");
      return;
    }

    try {
      options.prepare(req);
    } catch {
      endHttp(socket, 400, "Bad Request");
      return;
    }

    pending += 1;
    pendingByPeer.set(peer, peerPending + 1);
    const upstream = net.connect(options.port, options.host);
    let closed = false;
    let handshakePending = true;
    let responseBuffer = Buffer.alloc(0);
    let rejectionBytesRemaining: number | undefined;

    const releasePending = () => {
      if (!handshakePending) return;
      handshakePending = false;
      clearTimeout(handshakeTimer);
      pending -= 1;
      const remaining = (pendingByPeer.get(peer) || 1) - 1;
      if (remaining > 0) pendingByPeer.set(peer, remaining);
      else pendingByPeer.delete(peer);
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

    socket.off("error", onRejectedSocketError);
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

    const onRejectedBodyData = (chunk: Buffer) => {
      if (rejectionBytesRemaining === undefined) return;
      const forwardedLength = Math.min(chunk.length, rejectionBytesRemaining);
      if (forwardedLength && !socket.write(chunk.subarray(0, forwardedLength))) upstream.pause();
      rejectionBytesRemaining -= forwardedLength;
      if (rejectionBytesRemaining === 0) {
        upstream.off("data", onRejectedBodyData);
        finishRejectedResponse();
      }
    };

    upstream.on("data", onHandshakeData);
    upstream.once("end", finishRejectedResponse);
  };
}
