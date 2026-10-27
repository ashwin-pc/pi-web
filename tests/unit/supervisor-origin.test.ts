import { describe, expect, it } from "vitest";
import {
  authenticatedSupervisorOrigin,
  stampSupervisorOrigin,
  stripSupervisorOriginHeaders,
} from "../../server/auth/supervisorOrigin.js";

function request(remoteAddress: string) {
  return { headers: {}, socket: { remoteAddress } } as any;
}

describe("authenticated supervisor origin context", () => {
  it("accepts only this run's secret over the supervised loopback hop", () => {
    const previous = {
      supervised: process.env.PI_WEB_SUPERVISED,
      secret: process.env.PI_WEB_SUPERVISOR_SECRET,
    };
    process.env.PI_WEB_SUPERVISED = "1";
    process.env.PI_WEB_SUPERVISOR_SECRET = "synthetic-supervisor-secret";
    try {
      const valid = request("127.0.0.1");
      stampSupervisorOrigin(valid, process.env.PI_WEB_SUPERVISOR_SECRET);
      expect(authenticatedSupervisorOrigin(valid)).toBe(true);

      valid.headers["x-pi-web-supervisor-secret"] = "wrong-secret";
      expect(authenticatedSupervisorOrigin(valid)).toBe(false);

      const remote = request("192.0.2.10");
      stampSupervisorOrigin(remote, process.env.PI_WEB_SUPERVISOR_SECRET);
      expect(authenticatedSupervisorOrigin(remote)).toBe(false);

      stripSupervisorOriginHeaders(valid.headers);
      expect(authenticatedSupervisorOrigin(valid)).toBe(false);
    } finally {
      if (previous.supervised === undefined) delete process.env.PI_WEB_SUPERVISED;
      else process.env.PI_WEB_SUPERVISED = previous.supervised;
      if (previous.secret === undefined) delete process.env.PI_WEB_SUPERVISOR_SECRET;
      else process.env.PI_WEB_SUPERVISOR_SECRET = previous.secret;
    }
  });
});
