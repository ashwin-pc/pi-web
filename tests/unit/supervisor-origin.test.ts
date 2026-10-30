import { afterEach, describe, expect, it } from "vitest";
import {
  authenticatedSupervisorOrigin,
  initializeSupervisorPeerContext,
  stampSupervisorProvenance,
  stripSupervisorProvenanceHeaders,
} from "../../server/auth/supervisorPeer.js";

function request(remoteAddress: string) {
  return { headers: {}, socket: { remoteAddress } } as any;
}

afterEach(() => initializeSupervisorPeerContext({}));

describe("authenticated supervisor origin context", () => {
  it("uses the initialized proof after deleting the environment secret", () => {
    const env: NodeJS.ProcessEnv = {
      PI_WEB_SUPERVISED: "1",
      PI_WEB_SUPERVISOR_SECRET: "synthetic-supervisor-secret",
    };
    initializeSupervisorPeerContext(env);
    expect(env.PI_WEB_SUPERVISOR_SECRET).toBeUndefined();

    const valid = request("127.0.0.1");
    stampSupervisorProvenance(valid, "192.0.2.44", true, "synthetic-supervisor-secret");
    expect(authenticatedSupervisorOrigin(valid)).toBe(true);

    valid.headers["x-pi-web-supervisor-secret"] = "wrong-secret";
    expect(authenticatedSupervisorOrigin(valid)).toBe(false);

    const remote = request("192.0.2.10");
    stampSupervisorProvenance(remote, "192.0.2.44", true, "synthetic-supervisor-secret");
    expect(authenticatedSupervisorOrigin(remote)).toBe(false);

    stripSupervisorProvenanceHeaders(valid.headers);
    expect(authenticatedSupervisorOrigin(valid)).toBe(false);
  });

  it("does not accept provenance before the child initializes its context", () => {
    initializeSupervisorPeerContext({});
    const requestBeforeInitialization = request("127.0.0.1");
    stampSupervisorProvenance(
      requestBeforeInitialization,
      "192.0.2.44",
      true,
      "synthetic-supervisor-secret",
    );
    expect(authenticatedSupervisorOrigin(requestBeforeInitialization)).toBe(false);
  });
});
