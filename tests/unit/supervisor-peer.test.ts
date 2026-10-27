import { describe, expect, it } from "vitest";
import {
  canonicalPeerAddress,
  effectivePeerAddress,
  isLoopbackPeer,
  stampSupervisorPeer,
} from "../../server/auth/supervisorPeer.js";

function request(remoteAddress: string, method = "POST", url = "/api/auth/password/bootstrap") {
  return { headers: {}, method, url, socket: { remoteAddress } } as any;
}

describe("authenticated supervisor peer context", () => {
  it("canonicalizes loopback spellings without accepting scoped or malformed addresses", () => {
    expect(canonicalPeerAddress("::ffff:127.0.0.9")).toBe("127.0.0.9");
    expect(canonicalPeerAddress("2001:0db8::1")).toBe("2001:db8::1");
    expect(canonicalPeerAddress("fe80::1%lo0")).toBeUndefined();
    expect(isLoopbackPeer("127.44.2.1")).toBe(true);
    expect(isLoopbackPeer("::1")).toBe(true);
    expect(isLoopbackPeer("192.0.2.1")).toBe(false);
  });

  it("uses only the per-run supervisor secret on the loopback child hop", () => {
    const previous = {
      supervised: process.env.PI_WEB_SUPERVISED,
      secret: process.env.PI_WEB_SUPERVISOR_SECRET,
    };
    process.env.PI_WEB_SUPERVISED = "1";
    process.env.PI_WEB_SUPERVISOR_SECRET = "synthetic-supervisor-secret";
    try {
      const req = request("127.0.0.1");
      req.headers["x-pi-web-peer"] = "127.0.0.1";
      req.headers["x-pi-web-supervisor-secret"] = "caller-controlled";
      stampSupervisorPeer(req, "192.0.2.44", process.env.PI_WEB_SUPERVISOR_SECRET);
      expect(effectivePeerAddress(req)).toBe("192.0.2.44");

      req.headers["x-pi-web-peer"] = "127.0.0.1";
      expect(effectivePeerAddress(req)).toBe("127.0.0.1");

      req.headers["x-pi-web-supervisor-secret"] = "wrong-secret";
      expect(effectivePeerAddress(req)).toBe("127.0.0.1");

      const direct = request("192.0.2.9");
      stampSupervisorPeer(direct, "127.0.0.1", process.env.PI_WEB_SUPERVISOR_SECRET);
      expect(effectivePeerAddress(direct)).toBe("192.0.2.9");
    } finally {
      if (previous.supervised === undefined) delete process.env.PI_WEB_SUPERVISED;
      else process.env.PI_WEB_SUPERVISED = previous.supervised;
      if (previous.secret === undefined) delete process.env.PI_WEB_SUPERVISOR_SECRET;
      else process.env.PI_WEB_SUPERVISOR_SECRET = previous.secret;
    }
  });
});
