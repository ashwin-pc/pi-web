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
  it.each(["legacy", "external"] as const)(
    "establishes a browser session for credential-backed %s HTML before Vite responds",
    async (via) => {
      const req = request({ accept: "text/html" });
      const res = response();
      const establishSession = vi.fn(async (target) => {
        target.setHeader("set-cookie", "pi_web_session=synthetic; HttpOnly");
      });
      const kernel = {
        refreshConfig: vi.fn(),
        gate: vi.fn(async () => ({
          ok: true,
          identity: { id: `${via}:owner` },
          via,
        })),
        establishSession,
      } as any;
      const vite = {
        middlewares: vi.fn((_req, target) => target.end()),
      } as any;

      await serveAuthenticatedViteRequest(vite, kernel, "/does-not-exist", req, res, "/");

      expect(establishSession).toHaveBeenCalledWith(
        res,
        { id: `${via}:owner` },
        via,
        req,
      );
      expect(res.getHeader("set-cookie")).toContain("HttpOnly");
      expect(vite.middlewares).toHaveBeenCalledOnce();
    },
  );

  it("checks the configured origin inside the child Vite HMR upgrade route", async () => {
    const gate = vi.fn(async () => ({
      ok: true,
      identity: { id: "external:owner" },
      via: "session",
    }));
    const upgrades = new AuthenticatedViteUpgrades({ gate } as any, "https://pi.example.invalid");
    const server = new EventEmitter();
    const applicationListener = vi.fn();
    const viteListener = vi.fn();
    server.on("upgrade", applicationListener);
    server.on("upgrade", viteListener);
    upgrades.capture(server as any, applicationListener);

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
    expect(viteListener).not.toHaveBeenCalled();

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
    await vi.waitFor(() => expect(viteListener).toHaveBeenCalledWith(
      ownOriginRequest,
      ownOriginSocket,
      expect.any(Buffer),
    ));
    expect(ownOriginSocket.resume).toHaveBeenCalledOnce();
  });
});
