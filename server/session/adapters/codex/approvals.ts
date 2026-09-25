import { object, type NativeObject, type NativeRequest } from "./transport.js";
import { approvalContext } from "./approval-context.js";

export interface CodexApprovalChoice {
  id: string;
  label: string;
  scope?: "once" | "turn" | "session";
}

/** Responses stay server-side. A browser selects an ID, never supplies native policy JSON. */
export interface CodexApproval {
  title: string;
  description: string;
  choices: CodexApprovalChoice[];
  responses: Map<string, NativeObject>;
  dismiss: NativeObject;
}

function onlyKeys(value: NativeObject, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function paths(value: unknown): boolean {
  return value === null || (Array.isArray(value) && value.length <= 100 && value.every((path) => typeof path === "string" && path.length <= 2_048));
}

function filesystemEntry(value: unknown): boolean {
  const entry = object(value);
  const path = object(entry?.path);
  if (!entry || !path || !onlyKeys(entry, ["path", "access"]) || !["read", "write", "deny"].includes(String(entry.access))) return false;
  if (path.type === "path") return onlyKeys(path, ["type", "path"]) && typeof path.path === "string";
  if (path.type === "glob_pattern") return onlyKeys(path, ["type", "pattern"]) && typeof path.pattern === "string";
  const special = object(path.value);
  return path.type === "special" && onlyKeys(path, ["type", "value"]) && !!special
    && ["root", "minimal", "project_roots", "tmpdir", "slash_tmp"].includes(String(special.kind))
    && onlyKeys(special, ["kind", "subpath"])
    && (special.subpath == null || typeof special.subpath === "string");
}

/** Validate the displayed scope; do not evaluate paths or build a second permission policy.
 * The pinned schema permits omitted/null optional fields. Skip their value checks,
 * but retain the supplied representation; never turn no-value into a default grant.
 */
function permissionProfile(value: unknown): NativeObject | undefined {
  const profile = object(value);
  if (!profile || !onlyKeys(profile, ["network", "fileSystem"])) return;
  if (profile.network != null) {
    const network = object(profile.network);
    if (!network || !onlyKeys(network, ["enabled"]) || (network.enabled != null && typeof network.enabled !== "boolean")) return;
  }
  if (profile.fileSystem != null) {
    const filesystem = object(profile.fileSystem);
    if (!filesystem || !onlyKeys(filesystem, ["read", "write", "entries", "globScanMaxDepth"])) return;
    if (filesystem.read !== undefined && !paths(filesystem.read)) return;
    if (filesystem.write !== undefined && !paths(filesystem.write)) return;
    if (filesystem.entries != null && (!Array.isArray(filesystem.entries) || filesystem.entries.length > 100 || !filesystem.entries.every(filesystemEntry))) return;
    if (filesystem.globScanMaxDepth != null && (!Number.isSafeInteger(filesystem.globScanMaxDepth) || Number(filesystem.globScanMaxDepth) < 0)) return;
  }
  if (JSON.stringify(profile).length > 8_192) return;
  return Object.fromEntries(Object.entries(profile).filter(([, entry]) => entry !== null));
}

function basicChoices(offered: unknown, allowSession: boolean): CodexApprovalChoice[] {
  const supported: CodexApprovalChoice[] = [
    { id: "accept", label: "Allow once", scope: "once" },
    ...(allowSession ? [{ id: "acceptForSession", label: "Allow for this session", scope: "session" } as const] : []),
    { id: "decline", label: "Decline action" },
    { id: "cancel", label: "Stop turn" },
  ];
  if (!Array.isArray(offered)) return supported.filter((choice) => choice.id !== "acceptForSession");
  return supported.filter((choice) => offered.includes(choice.id));
}

const commonKeys = ["threadId", "turnId", "itemId", "startedAtMs", "reason"];
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const optionalString = (value: unknown): boolean => value == null || nonempty(value);

function execPolicy(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.length <= 100 && value.every(nonempty);
}
function networkPolicy(value: unknown): boolean {
  const amendment = object(value);
  return !!amendment && onlyKeys(amendment, ["host", "action"]) && nonempty(amendment.host) && ["allow", "deny"].includes(String(amendment.action));
}

function commandActions(value: unknown): boolean {
  return value == null || (Array.isArray(value) && value.length <= 100 && value.every((entry) => {
    const action = object(entry);
    if (!action || !nonempty(action.command)) return false;
    if (action.type === "unknown") return onlyKeys(action, ["type", "command"]);
    if (action.type === "read") return onlyKeys(action, ["type", "command", "name", "path"]) && nonempty(action.name) && nonempty(action.path);
    if (action.type === "listFiles") return onlyKeys(action, ["type", "command", "path"]) && optionalString(action.path);
    return action.type === "search" && onlyKeys(action, ["type", "command", "query", "path"]) && optionalString(action.query) && optionalString(action.path);
  }));
}

export function codexApproval(request: NativeRequest, pendingItem?: NativeObject): CodexApproval | undefined {
  const params = object(request.params);
  if (!params || (params.reason != null && typeof params.reason !== "string")) return;
  const responses = new Map<string, NativeObject>();
  if (request.method === "item/commandExecution/requestApproval") {
    if (!onlyKeys(params, [...commonKeys, "kind", "approvalId", "environmentId", "command", "cwd", "commandActions", "additionalPermissions",
      "networkApprovalContext", "proposedExecpolicyAmendment", "proposedNetworkPolicyAmendments", "availableDecisions"])) return;
    const kind = params.kind ?? "command";
    if ((kind !== "command" && kind !== "writeStdin") || !optionalString(params.environmentId) || !optionalString(params.approvalId)) return;
    if (!commandActions(params.commandActions)) return;
    const permissions = params.additionalPermissions == null ? undefined : permissionProfile(params.additionalPermissions);
    if (params.additionalPermissions != null && !permissions) return;
    const network = object(params.networkApprovalContext);
    if (params.networkApprovalContext != null && (!network || !onlyKeys(network, ["host", "protocol"]) || !nonempty(network.host)
      || !["http", "https", "socks5Tcp", "socks5Udp"].includes(String(network.protocol)))) return;
    const execAmendment = params.proposedExecpolicyAmendment;
    if (execAmendment != null && !execPolicy(execAmendment)) return;
    const networkAmendments = params.proposedNetworkPolicyAmendments;
    if (networkAmendments != null && (!Array.isArray(networkAmendments) || networkAmendments.length > 100 || !networkAmendments.every(networkPolicy))) return;
    if (params.availableDecisions != null && (!Array.isArray(params.availableDecisions) || params.availableDecisions.length > 100)) return;
    const deferredPolicyChoices: NativeObject[] = [];
    for (const choice of (params.availableDecisions ?? []) as unknown[]) {
      if (typeof choice === "string") { if (!["accept", "acceptForSession", "decline", "cancel"].includes(choice)) return; continue; }
      const decision = object(choice);
      const exec = object(decision?.acceptWithExecpolicyAmendment);
      const network = object(decision?.applyNetworkPolicyAmendment);
      if (!decision) return;
      const knownExec = exec && onlyKeys(decision, ["acceptWithExecpolicyAmendment"]) && onlyKeys(exec, ["execpolicy_amendment"]) && execPolicy(exec.execpolicy_amendment);
      const knownNetwork = network && onlyKeys(decision, ["applyNetworkPolicyAmendment"]) && onlyKeys(network, ["network_policy_amendment"]) && networkPolicy(network.network_policy_amendment);
      if (!knownExec && !knownNetwork) return;
      deferredPolicyChoices.push(decision);
    }
    if (pendingItem && (pendingItem.type !== "commandExecution" || pendingItem.id !== params.itemId)) return;
    // Native approval requests retain the exact command; history may be shortened
    // or redacted by Codex itself. Never fill missing consent fields from that row.
    const command = params.command;
    const cwd = params.cwd;
    // Codex's explicit Network presentation intentionally omits command/cwd.
    // Review that native host/protocol scope, never a fabricated command fallback.
    const networkOnly = !!network && command == null && cwd == null && params.commandActions == null;
    if (!networkOnly && (!nonempty(command) || !nonempty(cwd))) return;
    const context = { kind, command: command ?? null, cwd: cwd ?? null, environmentId: params.environmentId ?? null, reason: params.reason ?? null,
      ...(networkOnly ? { reviewScope: "Native network access for the shown host/protocol; no command or cwd supplied" } : {}),
      ...(params.commandActions != null ? { commandActions: params.commandActions } : {}),
      ...(network ? { networkApprovalContext: network } : {}), ...(permissions ? { additionalPermissions: permissions } : {}),
      ...(execAmendment != null ? { proposedExecpolicyAmendment: execAmendment } : {}),
      ...(networkAmendments != null ? { proposedNetworkPolicyAmendments: networkAmendments } : {}),
      ...(deferredPolicyChoices.length ? { deferredPolicyChoices } : {}),
      ...(execAmendment != null || networkAmendments != null || deferredPolicyChoices.length ? { policyAmendments: "Not applied by the offered choices" } : {}),
      ...(params.approvalId ? { approvalId: params.approvalId } : {}) };
    const description = approvalContext(context);
    const choices = basicChoices(params.availableDecisions, kind === "command");
    if (!description || !choices.length) return;
    for (const choice of choices) responses.set(choice.id, { decision: choice.id });
    return { title: kind === "writeStdin" ? "Allow terminal input?" : network ? "Allow network access?" : "Allow command?", description, choices, responses, dismiss: { decision: "cancel" } };
  }
  if (request.method === "item/fileChange/requestApproval") {
    if (!onlyKeys(params, [...commonKeys, "grantRoot"]) || !optionalString(params.grantRoot)) return;
    // The request itself omits changes. Never approve without its exact native item.
    const changes = pendingItem?.type === "fileChange" && pendingItem.id === params.itemId && pendingItem.status === "inProgress"
      && Array.isArray(pendingItem.changes) ? pendingItem.changes : undefined;
    if (!changes?.length || changes.length > 100) return;
    for (const entry of changes) {
      const change = object(entry);
      const kind = object(change?.kind);
      if (!change || !onlyKeys(change, ["path", "kind", "diff"]) || !nonempty(change.path) || typeof change.diff !== "string" || !kind) return;
      if (kind.type === "update") { if (!onlyKeys(kind, ["type", "move_path"]) || !optionalString(kind.move_path)) return; }
      else if (!["add", "delete"].includes(String(kind.type)) || !onlyKeys(kind, ["type"])) return;
    }
    const description = approvalContext({ changes, reason: params.reason ?? null, grantRoot: params.grantRoot ?? null,
      scope: "This change only; session-wide write roots are not granted" });
    if (!description) return;
    const choices = basicChoices(undefined, false);
    for (const choice of choices) responses.set(choice.id, { decision: choice.id });
    return { title: "Allow file changes?", description, choices, responses, dismiss: { decision: "cancel" } };
  }
  if (request.method === "item/permissions/requestApproval") {
    if (!onlyKeys(params, [...commonKeys, "environmentId", "cwd", "permissions"]) || !nonempty(params.cwd) || !optionalString(params.environmentId)) return;
    const permissions = permissionProfile(params.permissions);
    if (!permissions) return;
    const description = approvalContext({ permissions, cwd: params.cwd, environmentId: params.environmentId ?? null, reason: params.reason ?? null });
    if (!description) return;
    const choices: CodexApprovalChoice[] = [
      { id: "allowTurn", label: "Allow for this turn", scope: "turn" },
      { id: "allowSession", label: "Allow for this session", scope: "session" },
      { id: "decline", label: "Do not grant" },
    ];
    responses.set("allowTurn", { permissions, scope: "turn" });
    responses.set("allowSession", { permissions, scope: "session" });
    responses.set("decline", { permissions: {}, scope: "turn" });
    return { title: "Grant requested permissions?", description, choices, responses, dismiss: { permissions: {}, scope: "turn" } };
  }
  return undefined;
}

/** Known unimplemented control protocols have documented no-grant replies. */
export function unsupportedControlResponse(request: NativeRequest): NativeObject | undefined {
  if (request.method === "mcpServer/elicitation/request") return { action: "decline", content: null, _meta: null };
  if (request.method === "item/permissions/requestApproval") return { permissions: {}, scope: "turn" };
  if (request.method === "item/commandExecution/requestApproval" || request.method === "item/fileChange/requestApproval") return { decision: "cancel" };
  return undefined;
}
