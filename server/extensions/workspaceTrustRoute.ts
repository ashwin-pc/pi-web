import type { IncomingMessage, ServerResponse } from "node:http";
import type { GateResult } from "../auth/kernel.js";
import type { WorkspaceExtensionTrust } from "./workspaceTrust.js";

type Authorized = Extract<GateResult, { ok: true }>;

type SessionAccess = {
  require(sessionId?: string): Promise<object>;
  cwdForSession(session: object): string;
  reloadExtensions(sessionId: string): Promise<unknown>;
};

type RouteDependencies = {
  trust: WorkspaceExtensionTrust;
  sessions: SessionAccess;
  readBody(req: IncomingMessage): Promise<unknown>;
  settings(): Promise<unknown>;
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
    send(res, 200, { ok: true, ...deps.trust.status(deps.sessions.cwdForSession(session)) });
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
    const session = await deps.sessions.require(sessionId) as {
      isStreaming?: boolean;
      isCompacting?: boolean;
    };
    if (session.isStreaming || session.isCompacting) {
      send(res, 409, {
        ok: false,
        error: `Wait for the current ${session.isStreaming ? "response" : "compaction"} to finish before loading workspace extensions.`,
      });
      return true;
    }
    const status = await deps.trust.trust(deps.sessions.cwdForSession(session));
    const reloadStatus = await deps.sessions.reloadExtensions(sessionId);
    const settings = await deps.settings();
    deps.broadcast({ type: "settings_updated", settings });
    send(res, 200, { ok: true, ...status, reloadStatus });
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
    await deps.trust.revoke(workspace);
    const settings = await deps.settings();
    deps.broadcast({ type: "settings_updated", settings });
    send(res, 200, {
      ok: true,
      trustedWorkspaces: deps.trust.trustedWorkspaces(),
    });
    return true;
  }

  send(res, 405, { ok: false, error: "Method not allowed" });
  return true;
}
