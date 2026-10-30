import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  canonicalPeerAddress,
  effectivePeerAddress,
  initializeSupervisorPeerContext,
  isLocalTunnelRequest,
  isLoopbackPeer,
  markTunnelRequest,
  resolveSupervisorPeer,
  stampSupervisorProvenance,
  stripSupervisorPeerHeaders,
  UNKNOWN_SUPERVISOR_PEER,
} from "../../server/auth/supervisorPeer.js";

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

  it("keeps local tunnel provenance process-local", () => {
    const tunnel = request("::1");
    markTunnelRequest(tunnel);
    expect(isLocalTunnelRequest(tunnel)).toBe(true);
  });

  it("canonicalizes peers and resolves only a single trusted forwarded address", () => {
    expect(canonicalPeerAddress("::ffff:127.0.0.9")).toBe("127.0.0.9");
    expect(canonicalPeerAddress("2001:0db8::1")).toBe("2001:db8::1");
    expect(canonicalPeerAddress("fe80::1%lo0")).toBeUndefined();
    expect(isLoopbackPeer("127.44.2.1")).toBe(true);
    expect(isLoopbackPeer("::1")).toBe(true);
    expect(isLoopbackPeer("192.0.2.1")).toBe(false);
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
      stripSupervisorPeerHeaders(tunnel.headers);
      expect(tunnel.headers).toEqual({ authorization: "Bearer retained" });
      stampSupervisorProvenance(tunnel, "192.0.2.44", true, secret);
      expect(effectivePeerAddress(tunnel)).toBe("192.0.2.44");
      expect(tunnel.headers["x-pi-web-tunnel"]).toBe("1");

      tunnel.headers["x-pi-web-supervisor-secret"] = "wrong-secret";
      expect(effectivePeerAddress(tunnel)).toBe(UNKNOWN_SUPERVISOR_PEER);

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
