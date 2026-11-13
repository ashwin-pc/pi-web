import { describe, expect, it, vi } from "vitest";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { ArtifactDerivations } from "../server/extensions/artifactDerived.js";
import { handleArtifactDerivedRoute, mintArtifactDerivedSelection } from "../server/extensions/artifactDerivedRoute.js";

function request(method = "POST") {
  const req = new IncomingMessage(new Socket()); req.method = method;
  return { req, res: new ServerResponse(req) };
}
const url = new URL("http://localhost/api/web-contributions/artifact-derived");
describe("derived artifact HTTP boundary", () => {
  it("does not consume unrelated requests", async () => {
    const { req, res } = request("GET");
    const readBody = vi.fn();
    expect(await handleArtifactDerivedRoute(req, res, url, { derivations: new ArtifactDerivations(), readBody, resolveSessionId: () => undefined, invoke: vi.fn() })).toBe(false);
    expect(readBody).not.toHaveBeenCalled();
  });
  it("preserves validation errors", async () => {
    const { req, res } = request();
    await expect(handleArtifactDerivedRoute(req, res, url, { derivations: new ArtifactDerivations(), readBody: async () => ({}), resolveSessionId: () => undefined, invoke: vi.fn() })).rejects.toMatchObject({ status: 400, message: "Invalid derivation request" });
  });
  it("propagates typed busy errors and removes request listeners", async () => {
    const { req, res } = request();
    const derivations = new ArtifactDerivations();
    const { HttpError } = await import("../server/shared/httpError.js");
    vi.spyOn(derivations, "derive").mockRejectedValue(new HttpError("Artifact generation is busy", 429));
    await expect(handleArtifactDerivedRoute(req, res, url, { derivations, readBody: async () => ({ selection: "token", key: "stl" }), resolveSessionId: () => "one", invoke: vi.fn() })).rejects.toMatchObject({ status: 429, message: "Artifact generation is busy" });
    expect(req.listenerCount("aborted")).toBe(0); expect(res.listenerCount("close")).toBe(0);
  });
  it("mints opaque authority and keeps registration off the wire", () => {
    const derivations = new ArtifactDerivations();
    const select = vi.spyOn(derivations, "select");
    const result: Record<string, unknown> = { artifactDerived: true, registration: "host-only" };
    mintArtifactDerivedSelection(derivations, "one", { key: "stl", event: { context: { name: "model.stl", kind: "file", path: "/api/artifacts/model.stl" } } }, result);
    expect(select.mock.calls[0][0].url).toBe("/api/session-artifacts/one/model.stl");
    expect(result.registration).toBeUndefined(); expect(result.selection).toBeTypeOf("string");
    expect(JSON.stringify(result)).not.toContain("host-only");
  });
});
