import { describe, expect, it } from "vitest";
import { errorStatus } from "../server/shared/httpStatus.js";
import { RemoteSessionError, isSessionResponse, serializeError } from "../server/session/protocol.js";
import { SessionServiceError } from "../server/session/service.js";

describe("session error status transport", () => {
  it.each([404, 409])("keeps local and validated remote status %i", (status) => {
    expect(errorStatus(new SessionServiceError("local", status))).toBe(status);
    expect(errorStatus(new RemoteSessionError({ name: "SessionServiceError", message: "remote", status }))).toBe(status);
  });

  it("rejects arbitrary serialized statuses and does not serialize them", () => {
    expect(isSessionResponse({ type: "error", id: "1", error: { name: "Error", message: "no", status: 418 } })).toBe(false);
    const error = Object.assign(new Error("no"), { status: 418 });
    expect(serializeError(error)).not.toHaveProperty("status");
    expect(errorStatus(error)).toBe(500);
  });
});
