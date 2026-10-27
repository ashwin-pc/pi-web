import { statSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { isAbsolute, relative, resolve } from "node:path";
import type { ViteDevServer } from "vite";
import type { AuthKernel } from "./kernel.js";
import { originFailureHint, trustedOrigin } from "./origin.js";

type UpgradeListener = (req: IncomingMessage, socket: Socket, head: Buffer) => void;

export function isDevPublicAsset(publicDir: string, pathname: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (decoded.startsWith("/@") || decoded.includes("\0")) return false;
  const candidate = resolve(publicDir, decoded.replace(/^\/+/, ""));
  const pathFromPublic = relative(publicDir, candidate);
  if (!pathFromPublic || pathFromPublic.startsWith("..") || isAbsolute(pathFromPublic)) return false;
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export async function serveAuthenticatedViteRequest(
  vite: ViteDevServer,
  authKernel: AuthKernel,
  publicDir: string,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  if (!isDevPublicAsset(publicDir, pathname)) {
    await authKernel.refreshConfig();
    const auth = await authKernel.gate(req);
    if (!auth.ok) {
      if (req.method === "GET" && (req.headers.accept || "").includes("text/html")) {
        res.writeHead(302, { location: "/api/auth/login" });
        res.end();
      } else {
        res.writeHead(401, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
      }
      return;
    }
    if (
      req.method === "GET" &&
      (req.headers.accept || "").includes("text/html") &&
      (auth.via === "legacy" || auth.via === "external")
    ) {
      await authKernel.establishSession(res, auth.identity, auth.via, req);
    }
  }
  vite.middlewares(req, res, () => {
    if (!res.writableEnded) {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "Not found" }));
    }
  });
}

export class AuthenticatedViteUpgrades {
  private listeners: UpgradeListener[] = [];

  constructor(
    private readonly authKernel: AuthKernel,
    private readonly configuredOrigin: string,
  ) {}

  capture(server: Server, applicationListener: UpgradeListener): void {
    this.listeners = (server.listeners("upgrade") as UpgradeListener[])
      .filter((listener) => listener !== applicationListener);
    for (const listener of this.listeners) server.removeListener("upgrade", listener);
  }

  handle(req: IncomingMessage, socket: Socket, head: Buffer): void {
    if (!this.listeners.length) {
      socket.destroy();
      return;
    }
    if (!trustedOrigin(req, this.configuredOrigin)) {
      socket.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(originFailureHint)}\r\n\r\n${originFailureHint}`);
      return;
    }
    socket.pause();
    void this.authKernel.gate(req).then((auth) => {
      if (!auth.ok) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      socket.resume();
      for (const listener of this.listeners) listener(req, socket, head);
    }).catch(() => socket.destroy());
  }
}
