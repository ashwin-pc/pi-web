import { describe, expect, it } from "vitest";
import { codexApproval, unsupportedControlResponse } from "../server/session/adapters/codex/approvals.js";
import type { NativeRequest } from "../server/session/adapters/codex/transport.js";

const command = (params: Record<string, unknown> = {}): NativeRequest => ({ id: "approval", method: "item/commandExecution/requestApproval", params: {
  threadId: "native-thread", turnId: "native-turn", itemId: "native-item", kind: "command", command: "printf safe", cwd: "/synthetic/project", ...params,
} });

describe("Codex method-specific native approval mapping", () => {
  it("preserves the distinct native once/session/decline/cancel choices", () => {
    const approval = codexApproval(command({ availableDecisions: ["accept", "acceptForSession", "decline", "cancel"] }))!;
    expect(approval.choices).toEqual([
      { id: "accept", label: "Allow once", scope: "once" },
      { id: "acceptForSession", label: "Allow for this session", scope: "session" },
      { id: "decline", label: "Decline action" }, { id: "cancel", label: "Stop turn" },
    ]);
    for (const decision of ["accept", "acceptForSession", "decline", "cancel"]) expect(approval.responses.get(decision)).toEqual({ decision });
    expect(approval.dismiss).toEqual({ decision: "cancel" });
  });

  it("does not invent a session scope when the native server did not offer one", () => {
    expect(codexApproval(command())!.responses.has("acceptForSession")).toBe(false);
    expect(codexApproval(command({ availableDecisions: ["decline", "cancel"] }))!.choices.map((choice) => choice.id)).toEqual(["decline", "cancel"]);
    expect(codexApproval(command({ availableDecisions: "accept" }))).toBeUndefined();
    expect(codexApproval(command({ availableDecisions: [] }))).toBeUndefined();
  });

  it("does not turn offered policy amendments into an unreviewed persistent grant", () => {
    const approval = codexApproval(command({ availableDecisions: [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: ["sh"] } }, "cancel"] }))!;
    expect(approval.choices.map((choice) => choice.id)).toEqual(["cancel"]);
    expect(approval.responses.has("acceptWithExecpolicyAmendment")).toBe(false);
  });

  it("separately describes terminal input, network destination and native permission context", () => {
    const stdin = codexApproval(command({ kind: "writeStdin", availableDecisions: ["accept", "acceptForSession", "cancel"] }))!;
    expect(stdin.title).toBe("Allow terminal input?");
    expect(stdin.responses.has("acceptForSession")).toBe(false);
    const network = codexApproval(command({ networkApprovalContext: { host: "example.test", protocol: "https", port: 443 }, additionalPermissions: { network: { enabled: true } } }))!;
    expect(network.title).toBe("Allow network access?");
    expect(network.description).toContain("example.test (https:443)");
    expect(network.description).toContain('"enabled":true');
    expect(codexApproval(command({ kind: "future-kind" }))).toBeUndefined();
  });

  it("requires the correlated native file-change item and defers unstable session-wide roots", () => {
    const request: NativeRequest = { id: 1, method: "item/fileChange/requestApproval", params: { threadId: "t", turnId: "u", itemId: "i", grantRoot: "/synthetic/project" } };
    expect(codexApproval(request)).toBeUndefined();
    const approval = codexApproval(request, { type: "fileChange", changes: [{ path: "file.ts", kind: { type: "update" }, diff: "+test" }] })!;
    expect(approval.description).toContain("update: file.ts");
    expect(approval.description).toContain("Requested write root: /synthetic/project");
    expect(approval.responses.has("acceptForSession")).toBe(false);
  });

  it("grants only the validated requested permission profile at the selected native scope", () => {
    const permissions = { network: null, fileSystem: { read: null, write: ["/synthetic/project"], entries: [{ path: { type: "path", path: "/synthetic/project" }, access: "write" }] } };
    const approval = codexApproval({ id: "p", method: "item/permissions/requestApproval", params: { permissions } })!;
    expect(approval.responses.get("allowTurn")).toEqual({ permissions: { fileSystem: permissions.fileSystem }, scope: "turn" });
    expect(approval.responses.get("allowSession")).toEqual({ permissions: { fileSystem: permissions.fileSystem }, scope: "session" });
    expect(approval.responses.get("decline")).toEqual({ permissions: {}, scope: "turn" });
    expect(approval.dismiss).toEqual({ permissions: {}, scope: "turn" });
    expect(approval.responses.has("always")).toBe(false);
  });

  it.each([
    { network: { enabled: "yes" } },
    { network: { enabled: true, futurePrivilege: true } },
    { fileSystem: { write: [42] } },
    { fileSystem: { entries: [{ path: { type: "special", value: { kind: "unknown", path: "opaque" } }, access: "write" }] } },
    { futurePermission: true },
  ])("fails closed on an unrecognized or malformed permission scope %j", (permissions) => {
    expect(codexApproval({ id: "p", method: "item/permissions/requestApproval", params: { permissions } })).toBeUndefined();
    expect(codexApproval(command({ additionalPermissions: permissions }))).toBeUndefined();
  });

  it("has no-grant responses for deferred known controls and no fabricated unknown response", () => {
    expect(unsupportedControlResponse({ id: 1, method: "mcpServer/elicitation/request" })).toEqual({ action: "decline", content: null, _meta: null });
    expect(unsupportedControlResponse({ id: 2, method: "item/permissions/requestApproval" })).toEqual({ permissions: {}, scope: "turn" });
    expect(unsupportedControlResponse({ id: 3, method: "future/required" })).toBeUndefined();
  });
});
