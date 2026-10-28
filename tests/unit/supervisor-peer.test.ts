import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  isLocalTunnelRequest,
  markTunnelRequest,
  stampSupervisorTunnel,
  stripSupervisorPeerHeaders,
} from "../../server/auth/supervisorPeer.js";

function request(remoteAddress: string, headers: Record<string, string> = {}) {
  return { headers, socket: { remoteAddress } } as any;
}

describe("supervisor request provenance", () => {
  it("consumes child startup trust before subprocesses spawn while retaining the marked gate", () => {
    const result = spawnSync(process.execPath, [
      "--import", "tsx",
      "tests/fixtures/supervisor-peer-child.ts",
    ], {
      cwd: new URL("../..", import.meta.url),
      encoding: "utf8",
      env: {
        ...process.env,
        PI_WEB_SUPERVISED: "1",
        PI_WEB_SUPERVISOR_SECRET: "synthetic-secret",
        PI_WEB_TUNNEL_SOCKET: "/private/pi-web.sock",
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      inherited: "absent",
      accepted: true,
      secretCleared: true,
      socketCleared: true,
    });
  });

  it("keeps local tunnel provenance process-local", () => {
    const tunnel = request("::1");
    markTunnelRequest(tunnel);
    expect(isLocalTunnelRequest(tunnel)).toBe(true);
  });

  it("stamps tunnel requests and strips every reserved inbound marker", () => {
    const headers = {
      "x-pi-web-peer": "127.0.0.1",
      "x-pi-web-supervisor-secret": "forged",
      "x-pi-web-tunnel": "1",
      authorization: "Bearer retained",
    };
    stripSupervisorPeerHeaders(headers);
    expect(headers).toEqual({ authorization: "Bearer retained" });
    stampSupervisorTunnel({ headers }, "synthetic-secret");
    expect(headers).toEqual({
      authorization: "Bearer retained",
      "x-pi-web-supervisor-secret": "synthetic-secret",
      "x-pi-web-tunnel": "1",
    });
  });
});
