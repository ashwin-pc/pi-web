import { describe, expect, it } from "vitest";
import {
  authenticatedTunnelRequest,
  canonicalPeerAddress,
  effectivePeerAddress,
  isLocalTunnelRequest,
  markTunnelRequest,
  stampSupervisorPeer,
  stampSupervisorTunnel,
  stripSupervisorPeerHeaders,
} from "../../server/auth/supervisorPeer.js";

function request(remoteAddress: string, headers: Record<string, string> = {}) {
  return { headers, socket: { remoteAddress } } as any;
}

describe("supervisor request provenance", () => {
  it("uses the #264 peer and secret names while keeping tunnel provenance distinct", () => {
    const previous = {
      supervised: process.env.PI_WEB_SUPERVISED,
      secret: process.env.PI_WEB_SUPERVISOR_SECRET,
    };
    process.env.PI_WEB_SUPERVISED = "1";
    process.env.PI_WEB_SUPERVISOR_SECRET = "synthetic-secret";
    try {
      const tcp = request("127.0.0.1", {
        "x-pi-web-peer": "attacker",
        "x-pi-web-tunnel": "1",
      });
      stampSupervisorPeer(tcp, "192.0.2.4", "synthetic-secret");
      expect(effectivePeerAddress(tcp)).toBe("192.0.2.4");
      expect(authenticatedTunnelRequest(tcp)).toBe(false);

      const tunnel = request("::1");
      markTunnelRequest(tunnel);
      expect(isLocalTunnelRequest(tunnel)).toBe(true);
      expect(authenticatedTunnelRequest(tunnel)).toBe(true);

      const forwardedTunnel = request("::1");
      stampSupervisorTunnel(forwardedTunnel, "synthetic-secret");
      expect(isLocalTunnelRequest(forwardedTunnel)).toBe(false);
      expect(authenticatedTunnelRequest(forwardedTunnel)).toBe(true);
      forwardedTunnel.headers["x-pi-web-supervisor-secret"] = "wrong";
      expect(authenticatedTunnelRequest(forwardedTunnel)).toBe(false);
    } finally {
      if (previous.supervised === undefined) delete process.env.PI_WEB_SUPERVISED;
      else process.env.PI_WEB_SUPERVISED = previous.supervised;
      if (previous.secret === undefined) delete process.env.PI_WEB_SUPERVISOR_SECRET;
      else process.env.PI_WEB_SUPERVISOR_SECRET = previous.secret;
    }
  });

  it("canonicalizes peers and strips every reserved inbound marker", () => {
    expect(canonicalPeerAddress("::ffff:127.0.0.9")).toBe("127.0.0.9");
    const headers = {
      "x-pi-web-peer": "127.0.0.1",
      "x-pi-web-supervisor-secret": "forged",
      "x-pi-web-tunnel": "1",
      authorization: "Bearer retained",
    };
    stripSupervisorPeerHeaders(headers);
    expect(headers).toEqual({ authorization: "Bearer retained" });
  });
});
