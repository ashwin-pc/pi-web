import type { IncomingMessage, ServerResponse } from "node:http";
import type { GateResult } from "../auth/kernel.js";
import type { WorkspaceExtensionTrust } from "./workspaceTrust.js";

type Authorized = Extract<GateResult, { ok: true }>;

type SessionAccess = {
  require(sessionId?: string): Promise<object>;
  cwdForSession(session: object): string;
  workspaceTrustState(session: object): { appliedTrusted?: boolean; busy: boolean };
  reloadExtensions(sessionId: string): Promise<unknown>;
};

type RouteDependencies = {
  trust: WorkspaceExtensionTrust;
  sessions: SessionAccess;
  readBody(req: IncomingMessage): Promise<unknown>;
  broadcast(value: unknown): void;
};

function send(res: ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function sessionIdFrom(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const sessionId = (value as Record<string, unknown>).sessionId;
  return typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : undefined;
}

function workspaceFrom(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const workspace = (value as Record<string, unknown>).workspace;
  return typeof workspace === "string" && workspace ? workspace : undefined;
}

function statusFor(deps: RouteDependencies, session: object) {
  const desired = deps.trust.status(deps.sessions.cwdForSession(session));
  const sessionState = deps.sessions.workspaceTrustState(session);
  return {
    ...desired,
    appliedTrusted: sessionState.appliedTrusted ?? null,
    pendingReload: sessionState.appliedTrusted !== undefined
      && sessionState.appliedTrusted !== desired.desiredTrusted,
    busy: sessionState.busy,
  };
}

export async function handleWorkspaceExtensionTrustRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  auth: Authorized,
  deps: RouteDependencies,
): Promise<boolean> {
  if (url.pathname !== "/api/extensions/workspace-trust") return false;

  if (req.method === "GET") {
    const session = await deps.sessions.require(url.searchParams.get("sessionId") || undefined);
    send(res, 200, { ok: true, ...statusFor(deps, session) });
    return true;
  }

  if (auth.via !== "session") {
    send(res, 403, { ok: false, error: "A browser owner session is required" });
    return true;
  }

  const body = await deps.readBody(req);
  if (req.method === "POST") {
    const sessionId = sessionIdFrom(body);
    if (!sessionId) {
      send(res, 400, { ok: false, error: "sessionId is required" });
      return true;
    }
    const displayedWorkspace = workspaceFrom(body);
    if (!displayedWorkspace) {
      send(res, 400, { ok: false, error: "workspace is required" });
      return true;
    }
    const session = await deps.sessions.require(sessionId) as {
      isStreaming?: boolean;
      isCompacting?: boolean;
    };
    const cwd = deps.sessions.cwdForSession(session);
    const current = deps.trust.status(cwd);
    if (current.workspace !== displayedWorkspace) {
      send(res, 409, { ok: false, error: "Workspace changed. Review its resources before trusting it." });
      return true;
    }
    if (session.isStreaming || session.isCompacting) {
      send(res, 409, {
        ok: false,
        error: `Wait for the current ${session.isStreaming ? "response" : "compaction"} to finish before loading workspace resources.`,
      });
      return true;
    }
    await deps.trust.trust(current.workspace);
    deps.broadcast({ type: "workspace_trust_changed", workspace: current.workspace });
    const reloadStatus = await deps.sessions.reloadExtensions(sessionId);
    send(res, 200, { ok: true, ...statusFor(deps, session), reloadStatus });
    return true;
  }

  if (req.method === "DELETE") {
    const workspace = body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>).workspace
      : undefined;
    if (typeof workspace !== "string" || !workspace) {
      send(res, 400, { ok: false, error: "workspace is required" });
      return true;
    }
    const sessionId = sessionIdFrom(body);
    const session = sessionId ? await deps.sessions.require(sessionId) : undefined;
    await deps.trust.revoke(workspace);
    deps.broadcast({ type: "workspace_trust_changed", workspace });
    const currentStatus = session
      && deps.trust.status(deps.sessions.cwdForSession(session)).workspace === workspace
      ? statusFor(deps, session)
      : undefined;
    send(res, 200, {
      ok: true,
      ...(currentStatus ?? {
        workspace,
        trusted: false,
        desiredTrusted: false,
        appliedTrusted: null,
        pendingReload: false,
        busy: false,
        resources: [],
      }),
      trustedWorkspaces: deps.trust.trustedWorkspaces(),
    });
    return true;
  }

  send(res, 405, { ok: false, error: "Method not allowed" });
  return true;
}
