import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  authenticatedTunnelRequest,
  effectivePeerAddress,
  initializeSupervisorPeerContext,
  resolveSupervisorPeer,
  stampSupervisorProvenance,
  stripSupervisorProvenanceHeaders,
  UNKNOWN_SUPERVISOR_PEER,
} from "../../server/auth/supervisorPeer.js";
import { canonicalIP, isLoopbackAddress } from "../../server/auth/ip.js";
import { forwardedHost } from "../../server/auth/proxy.js";

function request(
  remoteAddress?: string,
  headers: Record<string, string> = {},
) {
  return { headers, socket: { remoteAddress } } as any;
}

describe("authenticated supervisor request provenance", () => {
  it("consumes child startup trust before subprocesses spawn while retaining both gates", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "tests/fixtures/supervisor-peer-child.ts"],
      {
        cwd: new URL("../..", import.meta.url),
        encoding: "utf8",
        env: {
          ...process.env,
          PI_WEB_SUPERVISED: "1",
          PI_WEB_SUPERVISOR_SECRET: "synthetic-secret",
          PI_WEB_TUNNEL_SOCKET: "/private/pi-web.sock",
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      inherited: "absent",
      accepted: true,
      peer: "192.0.2.44",
      secretCleared: true,
      socketCleared: true,
    });
  });

  it("accepts forwarding only when the listener has authenticated the tunnel", () => {
    const tunnel = request(undefined, {
      "x-forwarded-for": "192.0.2.44",
      "x-forwarded-host": "owner.example",
    });
    expect(forwardedHost(tunnel)).toBeUndefined();
    expect(forwardedHost(tunnel, undefined, true)).toBe("owner.example");
    expect(resolveSupervisorPeer(
      tunnel.socket.remoteAddress,
      tunnel.headers["x-forwarded-for"],
      true,
    )).toBe("192.0.2.44");
  });

  it("canonicalizes peers and resolves only a single trusted forwarded address", () => {
    expect(canonicalIP("::ffff:127.0.0.9")).toBe("127.0.0.9");
    expect(canonicalIP("2001:0db8::1")).toBe("2001:db8::1");
    expect(canonicalIP("fe80::1%lo0")).toBeUndefined();
    expect(isLoopbackAddress("127.44.2.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("192.0.2.1")).toBe(false);
    expect(resolveSupervisorPeer("127.0.0.1", "192.0.2.44", true)).toBe(
      "192.0.2.44",
    );
    expect(
      resolveSupervisorPeer(
        "127.0.0.1",
        "192.0.2.44, 198.51.100.2",
        true,
      ),
    ).toBe(UNKNOWN_SUPERVISOR_PEER);
    expect(resolveSupervisorPeer(undefined, undefined, false)).toBe(
      UNKNOWN_SUPERVISOR_PEER,
    );
  });

  it("authenticates caller and tunnel provenance separately and fails bad stamps closed", () => {
    const secret = "synthetic-supervisor-secret";
    const env: NodeJS.ProcessEnv = {
      PI_WEB_SUPERVISED: "1",
      PI_WEB_SUPERVISOR_SECRET: secret,
      PI_WEB_TUNNEL_SOCKET: "/private/pi-web.sock",
    };
    initializeSupervisorPeerContext(env);
    try {
      expect(env.PI_WEB_SUPERVISOR_SECRET).toBeUndefined();
      expect(env.PI_WEB_TUNNEL_SOCKET).toBeUndefined();

      const tunnel = request("127.0.0.1", {
        "x-pi-web-peer": "forged",
        "x-pi-web-supervisor-secret": "forged",
        "x-pi-web-tunnel": "1",
        authorization: "Bearer retained",
      });
      stripSupervisorProvenanceHeaders(tunnel.headers);
      expect(tunnel.headers).toEqual({ authorization: "Bearer retained" });
      stampSupervisorProvenance(tunnel, "192.0.2.44", true, secret);
      expect(effectivePeerAddress(tunnel)).toBe("192.0.2.44");
      expect(tunnel.headers["x-pi-web-tunnel"]).toBe("1");

      const missingSecret = request("127.0.0.1");
      stampSupervisorProvenance(missingSecret, "192.0.2.44", true, secret);
      delete missingSecret.headers["x-pi-web-supervisor-secret"];
      expect(effectivePeerAddress(missingSecret)).toBe(UNKNOWN_SUPERVISOR_PEER);
      expect(authenticatedTunnelRequest(missingSecret)).toBe(false);

      tunnel.headers["x-pi-web-supervisor-secret"] = "wrong-secret";
      expect(effectivePeerAddress(tunnel)).toBe(UNKNOWN_SUPERVISOR_PEER);
      expect(isLoopbackAddress(effectivePeerAddress(tunnel))).toBe(false);
      expect(authenticatedTunnelRequest(tunnel)).toBe(false);

      const unknown = request("127.0.0.1");
      stampSupervisorProvenance(unknown, UNKNOWN_SUPERVISOR_PEER, true, secret);
      expect(effectivePeerAddress(unknown)).toBe(UNKNOWN_SUPERVISOR_PEER);
      expect(isLoopbackAddress(effectivePeerAddress(unknown))).toBe(false);

      const direct = request("192.0.2.9");
      stampSupervisorProvenance(direct, "127.0.0.1", true, secret);
      expect(effectivePeerAddress(direct)).toBe(UNKNOWN_SUPERVISOR_PEER);

      expect(effectivePeerAddress(request("127.0.0.1"))).toBe("127.0.0.1");
      expect(effectivePeerAddress(request())).toBe(UNKNOWN_SUPERVISOR_PEER);
    } finally {
      initializeSupervisorPeerContext({});
    }
  });
});
