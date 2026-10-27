import { describe, expect, it } from "vitest";
import {
  createAuthenticatedSupervisorOrigin,
  stampSupervisorOrigin,
  stripSupervisorOriginHeaders,
} from "../../server/auth/supervisorOrigin.js";

function request(remoteAddress: string) {
  return { headers: {}, socket: { remoteAddress } } as any;
}

describe("authenticated supervisor origin context", () => {
  it("retains captured proof after the environment secret is deleted", () => {
    const env: NodeJS.ProcessEnv = {
      PI_WEB_SUPERVISED: "1",
      PI_WEB_SUPERVISOR_SECRET: "synthetic-supervisor-secret",
    };
    const authenticatedSupervisorOrigin = createAuthenticatedSupervisorOrigin(env);
    delete env.PI_WEB_SUPERVISOR_SECRET;

    const valid = request("127.0.0.1");
    stampSupervisorOrigin(valid, "synthetic-supervisor-secret");
    expect(authenticatedSupervisorOrigin(valid)).toBe(true);

    valid.headers["x-pi-web-supervisor-secret"] = "wrong-secret";
    expect(authenticatedSupervisorOrigin(valid)).toBe(false);

    const remote = request("192.0.2.10");
    stampSupervisorOrigin(remote, "synthetic-supervisor-secret");
    expect(authenticatedSupervisorOrigin(remote)).toBe(false);

    stripSupervisorOriginHeaders(valid.headers);
    expect(authenticatedSupervisorOrigin(valid)).toBe(false);
  });
});
