import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  AuthenticatedViteUpgrades,
  serveAuthenticatedViteRequest,
} from "../../server/auth/devAccess.js";

function request(headers: Record<string, string> = {}) {
  return {
    method: "GET",
    url: "/",
    headers,
    socket: { remoteAddress: "127.0.0.1" },
  } as any;
}

function response() {
  const headers = new Map<string, string>();
  return {
    writableEnded: false,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    writeHead: vi.fn(),
    end: vi.fn(function (this: { writableEnded: boolean }) {
      this.writableEnded = true;
    }),
  } as any;
}

describe("authenticated Vite access", () => {
  it("establishes a browser session for external-header HTML before Vite responds", async () => {
    const req = request({ accept: "text/html" });
    const res = response();
    const establishSession = vi.fn(async (target) => {
      target.setHeader("set-cookie", "pi_web_session=synthetic; HttpOnly");
    });
    const kernel = {
      refreshConfig: vi.fn(),
      gate: vi.fn(async () => ({
        ok: true,
        identity: { id: "external:owner" },
        via: "external",
      })),
      establishSession,
    } as any;
    const vite = {
      middlewares: vi.fn((_req, target) => target.end()),
    } as any;

    await serveAuthenticatedViteRequest(vite, kernel, "/does-not-exist", req, res, "/");

    expect(establishSession).toHaveBeenCalledWith(
      res,
      { id: "external:owner" },
      "external",
      req,
    );
    expect(res.getHeader("set-cookie")).toContain("HttpOnly");
    expect(vite.middlewares).toHaveBeenCalledOnce();
  });

  it("keeps replacement Vite HMR listeners behind the authenticated upgrade route", async () => {
    const gate = vi.fn(async () => ({
      ok: true,
      identity: { id: "external:owner" },
      via: "session",
    }));
    const publicServer = new EventEmitter();
    const viteHmrServer = new EventEmitter();
    const upgrades = new AuthenticatedViteUpgrades(
      { gate } as any,
      "https://pi.example.invalid",
      viteHmrServer as any,
    );
    const applicationListener = vi.fn();
    const startupViteListener = vi.fn();
    publicServer.on("upgrade", applicationListener);
    viteHmrServer.on("upgrade", startupViteListener);

    const hostileSocket = {
      end: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      destroy: vi.fn(),
    };
    upgrades.handle(
      request({
        host: "pi.example.invalid",
        origin: "https://hostile.example.invalid",
        cookie: "pi_web_session=synthetic",
      }),
      hostileSocket as any,
      Buffer.alloc(0),
    );
    expect(hostileSocket.end).toHaveBeenCalledWith(expect.stringContaining("403 Forbidden"));
    expect(gate).not.toHaveBeenCalled();
    expect(startupViteListener).not.toHaveBeenCalled();

    const ownOriginSocket = {
      end: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      destroy: vi.fn(),
    };
    const ownOriginRequest = request({
      host: "pi.example.invalid",
      origin: "https://pi.example.invalid",
      cookie: "pi_web_session=synthetic",
    });
    upgrades.handle(ownOriginRequest, ownOriginSocket as any, Buffer.alloc(0));
    await vi.waitFor(() => expect(startupViteListener).toHaveBeenCalledWith(
      ownOriginRequest,
      ownOriginSocket,
      expect.any(Buffer),
    ));
    expect(ownOriginSocket.resume).toHaveBeenCalledOnce();

    const replacementViteListener = vi.fn();
    viteHmrServer.on("upgrade", replacementViteListener);
    viteHmrServer.off("upgrade", startupViteListener);
    expect(publicServer.listeners("upgrade")).toEqual([applicationListener]);

    const reconnectSocket = {
      end: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      destroy: vi.fn(),
    };
    const reconnectRequest = request({
      host: "pi.example.invalid",
      origin: "https://pi.example.invalid",
      cookie: "pi_web_session=synthetic",
    });
    upgrades.handle(reconnectRequest, reconnectSocket as any, Buffer.alloc(0));
    await vi.waitFor(() => expect(replacementViteListener).toHaveBeenCalledWith(
      reconnectRequest,
      reconnectSocket,
      expect.any(Buffer),
    ));
    expect(startupViteListener).toHaveBeenCalledOnce();
  });
});
