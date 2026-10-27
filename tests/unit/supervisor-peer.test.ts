import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  canonicalPeerAddress,
  effectivePeerAddress,
  initializeSupervisorPeerContext,
  isLoopbackPeer,
  resolveSupervisorPeer,
  stampSupervisorPeer,
  UNKNOWN_SUPERVISOR_PEER,
} from "../../server/auth/supervisorPeer.js";

function request(remoteAddress?: string, method = "POST", url = "/api/auth/password/bootstrap") {
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

  it("resolves valid outer peers and stamps unknown for missing, malformed, or chained data", () => {
    expect(resolveSupervisorPeer("127.0.0.1", "192.0.2.44", true)).toBe("192.0.2.44");
    expect(resolveSupervisorPeer("127.0.0.1", "192.0.2.44, 198.51.100.2", true)).toBe(UNKNOWN_SUPERVISOR_PEER);
    expect(resolveSupervisorPeer("127.0.0.1", undefined, true)).toBe(UNKNOWN_SUPERVISOR_PEER);
    expect(resolveSupervisorPeer(undefined, undefined, false)).toBe(UNKNOWN_SUPERVISOR_PEER);
  });

  it("uses only the captured per-run secret on the loopback child hop and fails invalid stamps closed", async () => {
    const secret = "synthetic-supervisor-secret";
    const env: NodeJS.ProcessEnv = {
      PI_WEB_SUPERVISED: "1",
      PI_WEB_SUPERVISOR_SECRET: secret,
    };
    initializeSupervisorPeerContext(env);
    try {
      expect(env.PI_WEB_SUPERVISOR_SECRET).toBeUndefined();
      await promisify(execFile)(
        process.execPath,
        ["-e", "process.exit(process.env.PI_WEB_SUPERVISOR_SECRET === undefined ? 0 : 1)"],
        { env },
      );

      const req = request("127.0.0.1");
      req.headers["x-pi-web-peer"] = "127.0.0.1";
      req.headers["x-pi-web-supervisor-secret"] = "caller-controlled";
      stampSupervisorPeer(req, "192.0.2.44", secret);
      expect(effectivePeerAddress(req)).toBe("192.0.2.44");

      req.headers["x-pi-web-peer"] = "127.0.0.1";
      delete req.headers["x-pi-web-supervisor-secret"];
      expect(effectivePeerAddress(req)).toBe(UNKNOWN_SUPERVISOR_PEER);

      req.headers["x-pi-web-supervisor-secret"] = "wrong-secret";
      expect(effectivePeerAddress(req)).toBe(UNKNOWN_SUPERVISOR_PEER);

      const direct = request("192.0.2.9");
      stampSupervisorPeer(direct, "127.0.0.1", secret);
      expect(effectivePeerAddress(direct)).toBe(UNKNOWN_SUPERVISOR_PEER);

      expect(effectivePeerAddress(request("127.0.0.1"))).toBe("127.0.0.1");
      expect(effectivePeerAddress(request())).toBe(UNKNOWN_SUPERVISOR_PEER);

      const unknown = request("127.0.0.1");
      stampSupervisorPeer(unknown, UNKNOWN_SUPERVISOR_PEER, secret);
      expect(effectivePeerAddress(unknown)).toBe(UNKNOWN_SUPERVISOR_PEER);
      expect(isLoopbackPeer(effectivePeerAddress(unknown))).toBe(false);

      expect(isLoopbackPeer(effectivePeerAddress(request("127.0.0.1")))).toBe(true);
      expect(isLoopbackPeer(effectivePeerAddress(unknown))).toBe(false);
      const forged = request("127.0.0.1");
      forged.headers["x-pi-web-peer"] = "127.0.0.1";
      forged.headers["x-pi-web-supervisor-secret"] = "wrong-secret";
      expect(isLoopbackPeer(effectivePeerAddress(forged))).toBe(false);
    } finally {
      initializeSupervisorPeerContext({});
    }
  });
});
