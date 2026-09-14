import { diagnostic, object, type NativeObject, type NativeRequest } from "./transport.js";

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

/** Validate the displayed scope; do not evaluate paths or build a second permission policy. */
function permissionProfile(value: unknown): NativeObject | undefined {
  const profile = object(value);
  if (!profile || !onlyKeys(profile, ["network", "fileSystem"])) return;
  if (profile.network != null) {
    const network = object(profile.network);
    if (!network || !onlyKeys(network, ["enabled"]) || (network.enabled !== null && typeof network.enabled !== "boolean")) return;
  }
  if (profile.fileSystem != null) {
    const filesystem = object(profile.fileSystem);
    if (!filesystem || !onlyKeys(filesystem, ["read", "write", "entries", "globScanMaxDepth"])) return;
    if (filesystem.read !== undefined && !paths(filesystem.read)) return;
    if (filesystem.write !== undefined && !paths(filesystem.write)) return;
    if (filesystem.entries !== undefined && (!Array.isArray(filesystem.entries) || filesystem.entries.length > 100 || !filesystem.entries.every(filesystemEntry))) return;
    if (filesystem.globScanMaxDepth !== undefined && (!Number.isSafeInteger(filesystem.globScanMaxDepth) || Number(filesystem.globScanMaxDepth) < 0)) return;
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

export function codexApproval(request: NativeRequest, pendingItem?: NativeObject): CodexApproval | undefined {
  const params = object(request.params);
  if (!params) return;
  const responses = new Map<string, NativeObject>();
  const reason = typeof params.reason === "string" ? diagnostic(params.reason) : "";
  if (request.method === "item/commandExecution/requestApproval") {
    const kind = params.kind ?? "command";
    if (kind !== "command" && kind !== "writeStdin") return;
    const permissions = params.additionalPermissions == null ? undefined : permissionProfile(params.additionalPermissions);
    if (params.additionalPermissions != null && !permissions) return;
    const network = object(params.networkApprovalContext);
    if (params.networkApprovalContext != null && !network) return;
    if (network && (typeof network.host !== "string" || typeof network.protocol !== "string")) return;
    if (typeof params.command !== "string" && !network) return;
    if (params.availableDecisions != null && !Array.isArray(params.availableDecisions)) return;
    const description = [
      typeof params.command === "string" ? diagnostic(params.command) : "",
      typeof params.environmentId === "string" ? `Environment: ${diagnostic(params.environmentId)}` : "",
      typeof params.cwd === "string" ? `Working directory: ${params.cwd.slice(0, 2_048)}` : "",
      network ? `Network destination: ${diagnostic(network.host)} (${diagnostic(network.protocol)}${typeof network.port === "number" ? `:${network.port}` : ""})` : "",
      permissions ? `Requested permissions: ${JSON.stringify(permissions)}` : "", reason,
    ].filter(Boolean).join("\n");
    const choices = basicChoices(params.availableDecisions, kind === "command");
    if (!choices.length) return;
    for (const choice of choices) responses.set(choice.id, { decision: choice.id });
    return { title: kind === "writeStdin" ? "Allow terminal input?" : network ? "Allow network access?" : "Allow command?", description, choices, responses, dismiss: { decision: "cancel" } };
  }
  if (request.method === "item/fileChange/requestApproval") {
    // The request itself omits changes. Never approve without its correlated native item.
    const changes = pendingItem?.type === "fileChange" && Array.isArray(pendingItem.changes) ? pendingItem.changes : undefined;
    if (!changes?.length || changes.length > 100) return;
    const files: string[] = [];
    for (const entry of changes) {
      const change = object(entry);
      const kind = object(change?.kind);
      if (!change || typeof change.path !== "string" || typeof change.diff !== "string" || !kind || !["add", "delete", "update"].includes(String(kind.type))) return;
      files.push(`${String(kind.type)}: ${change.path}`);
    }
    if (files.join("\n").length > 8_192) return;
    // grantRoot is unstable in the installed schema. Do not offer a broader session grant.
    const choices = basicChoices(undefined, false);
    for (const choice of choices) responses.set(choice.id, { decision: choice.id });
    return { title: "Allow file changes?", description: [reason, ...files, typeof params.grantRoot === "string" ? `Requested write root: ${params.grantRoot.slice(0, 2_048)}` : ""].filter(Boolean).join("\n"), choices, responses, dismiss: { decision: "cancel" } };
  }
  if (request.method === "item/permissions/requestApproval") {
    const permissions = permissionProfile(params.permissions);
    if (!permissions) return;
    const choices: CodexApprovalChoice[] = [
      { id: "allowTurn", label: "Allow for this turn", scope: "turn" },
      { id: "allowSession", label: "Allow for this session", scope: "session" },
      { id: "decline", label: "Do not grant" },
    ];
    responses.set("allowTurn", { permissions, scope: "turn" });
    responses.set("allowSession", { permissions, scope: "session" });
    responses.set("decline", { permissions: {}, scope: "turn" });
    return { title: "Grant requested permissions?", description: [
      reason,
      typeof params.environmentId === "string" ? `Environment: ${diagnostic(params.environmentId)}` : "",
      typeof params.cwd === "string" ? `Working directory: ${params.cwd.slice(0, 2_048)}` : "",
      JSON.stringify(permissions),
    ].filter(Boolean).join("\n"), choices, responses, dismiss: { permissions: {}, scope: "turn" } };
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
