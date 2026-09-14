import { describe, expect, it } from "vitest";
import { codexApproval, unsupportedControlResponse } from "../server/session/adapters/codex/approvals.js";
import { approvalContext, MAX_APPROVAL_CONTEXT_BYTES } from "../server/session/adapters/codex/approval-context.js";
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
    const network = codexApproval(command({ networkApprovalContext: { host: "example.test:443", protocol: "https" }, additionalPermissions: { network: { enabled: true } } }))!;
    expect(network.title).toBe("Allow network access?");
    expect(JSON.parse(network.description)).toMatchObject({ networkApprovalContext: { host: "example.test:443", protocol: "https" }, additionalPermissions: { network: { enabled: true } } });
    const nativeNetwork = codexApproval(command({ command: null, cwd: null, commandActions: null, networkApprovalContext: { host: "example.test", protocol: "https" } }))!;
    expect(JSON.parse(nativeNetwork.description)).toMatchObject({ command: null, cwd: null, networkApprovalContext: { host: "example.test", protocol: "https" } });
    expect(nativeNetwork.description).toContain("Native network access");
    expect(nativeNetwork.responses.get("accept")).toEqual({ decision: "accept" });
    expect(codexApproval(command({ kind: "future-kind" }))).toBeUndefined();
  });

  it("requires the correlated native file-change item and defers unstable session-wide roots", () => {
    const request: NativeRequest = { id: 1, method: "item/fileChange/requestApproval", params: { threadId: "t", turnId: "u", itemId: "i", grantRoot: "/synthetic/project" } };
    expect(codexApproval(request)).toBeUndefined();
    expect(codexApproval(request, { type: "fileChange", changes: [{ path: "file.ts", kind: { type: "update" } }] })).toBeUndefined();
    const approval = codexApproval(request, { type: "fileChange", id: "i", status: "inProgress", changes: [{ path: "file.ts", kind: { type: "update", move_path: null }, diff: "+test" }] })!;
    expect(JSON.parse(approval.description)).toMatchObject({ changes: [{ path: "file.ts", kind: { type: "update", move_path: null }, diff: "+test" }], grantRoot: "/synthetic/project" });
    expect(approval.responses.has("acceptForSession")).toBe(false);
  });

  it("grants only the validated requested permission profile at the selected native scope", () => {
    const permissions = { network: null, fileSystem: { read: null, write: ["/synthetic/project"], entries: [{ path: { type: "path", path: "/synthetic/project" }, access: "write" }] } };
    const approval = codexApproval({ id: "p", method: "item/permissions/requestApproval", params: { cwd: "/synthetic/project", permissions } })!;
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
    expect(codexApproval({ id: "p", method: "item/permissions/requestApproval", params: { cwd: "/synthetic/project", permissions } })).toBeUndefined();
    expect(codexApproval(command({ additionalPermissions: permissions }))).toBeUndefined();
  });

  it("keeps complete command tails, plain URLs and long scope fields without a correlated tool", () => {
    const cmd = `printf '${"a".repeat(2_300)}'; curl https://review-destination.invalid/bootstrap.sh; printf REVIEW_TAIL`;
    const cwd = `/synthetic/${"folder/".repeat(350)}CWD_TAIL`;
    const reason = `Review ${"reason ".repeat(400)}REASON_TAIL`;
    const environmentId = `environment-${"e".repeat(2_100)}ENV_TAIL`;
    const approval = codexApproval(command({ command: cmd, cwd, reason, environmentId }))!;
    expect(JSON.parse(approval.description)).toMatchObject({ command: cmd, cwd, reason, environmentId });
    expect(approval.description).toContain("https://review-destination.invalid/bootstrap.sh");
    expect(approval.description).not.toContain("[url]");
    expect(approval.responses.get("accept")).toEqual({ decision: "accept" });
  });

  it("bounds the whole UTF-8 context and never slices a value to retain an Allow choice", () => {
    expect(approvalContext({ command: "x".repeat(MAX_APPROVAL_CONTEXT_BYTES) })).toBeUndefined();
    expect(approvalContext({ command: "字".repeat(12_000) })).toBeUndefined(); // fewer chars, too many bytes
    expect(codexApproval(command({ command: "x".repeat(20_000), cwd: `/cwd/${"y".repeat(20_000)}` }))).toBeUndefined();
    expect(codexApproval(command({ cwd: `/cwd/${"z".repeat(MAX_APPROVAL_CONTEXT_BYTES)}` }))).toBeUndefined();
    expect(JSON.parse(approvalContext({ command: 'printf "first"\nprintf "second"' })!)).toEqual({ command: 'printf "first"\nprintf "second"' });
  });

  it.each([
    'curl -H "Authorization: Bearer synthetic-secret" https://example.invalid',
    'run --password synthetic-secret',
    'run api_key="synthetic-secret"',
    'curl https://user:synthetic-secret@example.invalid/path',
    'curl -u user:synthetic-secret https://example.invalid/path',
    'curl --user=user:synthetic-secret https://example.invalid/path',
    'curl https://example.invalid/path?unknown-signature=synthetic-secret',
    'curl https://example.invalid/path#synthetic-secret',
    'curl https://example.invalid/path?%74oken=synthetic-secret',
    'run ASIA1234567890ABCDEF',
    'printf visible\u001b[8mHIDDEN',
    'printf visible\rHIDDEN',
    'printf visible\u202eHIDDEN',
    'printf visible\u200bHIDDEN',
    'printf \ud800',
    'printf [redacted]',
  ])("does not offer grants with credential-like or concealed command context: %j", (value) => {
    expect(codexApproval(command({ command: value }))).toBeUndefined();
    expect(codexApproval(command({ reason: value }))).toBeUndefined();
    expect(codexApproval(command({ environmentId: value }))).toBeUndefined();
    expect(codexApproval(command({ cwd: value }))).toBeUndefined();
    expect(codexApproval({ id: "p", method: "item/permissions/requestApproval", params: { cwd: "/synthetic", permissions: { fileSystem: { write: [value] } } } })).toBeUndefined();
  });

  it("displays full native permission and amendment context but never grants policy amendments", () => {
    const permissions = { fileSystem: { entries: [{ path: { type: "glob_pattern", pattern: "/synthetic/**/REVIEW_TAIL" }, access: "write" }] } };
    const exec = ["sh", "-c", `printf ${"r".repeat(2_100)}RULE_TAIL`];
    const network = [{ host: "review-destination.invalid", action: "allow" }];
    const offered = { acceptWithExecpolicyAmendment: { execpolicy_amendment: exec } };
    const approval = codexApproval(command({ additionalPermissions: permissions, proposedExecpolicyAmendment: exec,
      proposedNetworkPolicyAmendments: network, availableDecisions: ["accept", offered, "decline"] }))!;
    expect(JSON.parse(approval.description)).toMatchObject({ additionalPermissions: permissions, proposedExecpolicyAmendment: exec,
      proposedNetworkPolicyAmendments: network, deferredPolicyChoices: [offered] });
    expect([...approval.responses.keys()]).toEqual(["accept", "decline"]);
    expect(approval.responses.get("accept")).toEqual({ decision: "accept" });
    const grant = codexApproval({ id: "permissions", method: "item/permissions/requestApproval", params: { cwd: "/synthetic/project", environmentId: "native-environment", permissions } })!;
    expect(JSON.parse(grant.description)).toMatchObject({ permissions, cwd: "/synthetic/project", environmentId: "native-environment" });
    expect(grant.responses.get("allowSession")).toEqual({ permissions, scope: "session" });
  });

  it.each([
    { command: null }, { cwd: null }, { command: " " }, { environmentId: 123 },
    { hiddenPrivilege: true }, { proposedExecpolicyAmendment: "sh" },
    { proposedExecpolicyAmendment: ["sh", "TOKEN=synthetic-secret"] },
    { proposedNetworkPolicyAmendments: [{ host: "example.invalid", action: "allow", futureScope: "global" }] },
    { networkApprovalContext: { host: "example.invalid", protocol: "future" } },
    { networkApprovalContext: { host: "example.invalid", protocol: "https", hiddenDestination: "other" } },
    { commandActions: [{ type: "unknown", command: "Authorization: Bearer synthetic-secret" }] },
    { availableDecisions: ["accept", { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["sh", "--password synthetic-secret"] } }] },
    { availableDecisions: ["accept", "future-decision"] },
  ])("rejects incomplete, unsafe or ambiguous accept-bearing context %j", (params) => {
    expect(codexApproval(command(params))).toBeUndefined();
  });

  it("uses the authoritative approval request, never a shortened/redacted history row", () => {
    const item = { type: "commandExecution", id: "native-item", status: "inProgress", command: "native history [redacted]", cwd: "/history/cwd" };
    const direct = codexApproval(command(), item)!;
    expect(JSON.parse(direct.description)).toMatchObject({ command: "printf safe", cwd: "/synthetic/project" });
    expect(direct.description).not.toContain("[redacted]");
    const subcommand = codexApproval(command({ approvalId: "native-callback" }), item)!;
    expect(JSON.parse(subcommand.description)).toMatchObject({ command: "printf safe", approvalId: "native-callback" });
    expect(codexApproval(command({ command: null, cwd: null }), item)).toBeUndefined();
    expect(codexApproval(command({ command: null, networkApprovalContext: { host: "example.invalid", protocol: "https" } }), item)).toBeUndefined();
    expect(codexApproval(command(), { ...item, id: "another-item" })).toBeUndefined();
  });

  it("keeps file rename targets, diffs and full requested roots together, and rejects unsafe changes", () => {
    const request: NativeRequest = { id: "file", method: "item/fileChange/requestApproval", params: { itemId: "file", grantRoot: `/root/${"r".repeat(2_100)}ROOT_TAIL` } };
    const item = { type: "fileChange", id: "file", status: "inProgress", changes: [{ path: "old.ts", kind: { type: "update", move_path: "new/RENAME_TAIL.ts" }, diff: "@@\n-before\n+after" }] };
    const approved = codexApproval(request, item)!;
    expect(JSON.parse(approved.description)).toMatchObject({ changes: item.changes, grantRoot: request.params && (request.params as Record<string, unknown>).grantRoot });
    expect(approved.responses.has("acceptForSession")).toBe(false);
    for (const changes of [
      [{ ...item.changes[0], diff: "x".repeat(MAX_APPROVAL_CONTEXT_BYTES) }],
      [{ ...item.changes[0], path: "TOKEN=synthetic-secret" }],
      [{ ...item.changes[0], kind: { type: "update", move_path: "unsafe\u202epath" } }],
      [{ ...item.changes[0], diff: '+api_key="synthetic-secret"' }],
      [{ ...item.changes[0], hiddenScope: "extra" }],
    ]) expect(codexApproval(request, { ...item, changes })).toBeUndefined();
  });

  it("has no-grant responses for deferred known controls and no fabricated unknown response", () => {
    expect(unsupportedControlResponse({ id: 1, method: "mcpServer/elicitation/request" })).toEqual({ action: "decline", content: null, _meta: null });
    expect(unsupportedControlResponse({ id: 2, method: "item/permissions/requestApproval" })).toEqual({ permissions: {}, scope: "turn" });
    expect(unsupportedControlResponse({ id: 3, method: "future/required" })).toBeUndefined();
  });
});
