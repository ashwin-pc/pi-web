import type { IncomingMessage, ServerResponse } from "node:http";
import { assertDirectory } from "../shared/fsList.js";
import { parseWorkContext } from "../../shared/work.js";
import { WorkStore, WorkError } from "./workStore.js";
import { WorkspaceRegistry } from "./registry.js";
import { WorkViews } from "./views.js";
import { WorkspaceBrowser } from "./browser.js";
import { WorkspaceMcp } from "./mcp.js";

export async function handleWorkRoute(req: IncomingMessage, res: ServerResponse, url: URL, options: {
  store: WorkStore; registry: WorkspaceRegistry; views: WorkViews; browser: WorkspaceBrowser; mcp: WorkspaceMcp;
  defaultRoot: () => string; refreshRoots: () => void; sessionRoot: (id: string) => Promise<string>;
  readBody: (req: IncomingMessage) => Promise<unknown>; send: (res: ServerResponse, status: number, data: unknown) => void;
}) {
  const { store, registry, views, browser, mcp, readBody, send } = options;
  if (url.pathname !== "/api/work" && !url.pathname.startsWith("/api/work/") && !(url.pathname === "/api/workspaces" && req.method === "POST")) return false;
  try {
    options.refreshRoots();
    const body = async () => (await readBody(req)) as Record<string, unknown>;
    const validateSessions = async (input: Record<string, unknown>) => {
      if (!Array.isArray(input.sessionIds) || !Array.isArray(input.workspaceIds)) return;
      for (const id of input.sessionIds) {
        if (typeof id !== "string") throw new WorkError("Invalid conversation reference");
        const workspace = registry.register(await options.sessionRoot(id));
        if (!input.workspaceIds.includes(workspace.id)) throw new WorkError("A conversation's project must be included in this work");
      }
    };
    if (url.pathname === "/api/workspaces" && req.method === "POST") {
      const input = await body(); if (typeof input.root !== "string") throw new WorkError("Choose a project folder");
      const root = await assertDirectory(input.root, options.defaultRoot());
      send(res, 201, { ok: true, workspace: await store.register(registry.register(root)) }); return true;
    }
    if (url.pathname === "/api/work/views") {
      if (req.method === "GET") send(res, 200, { ok: true, commands: views.list() });
      else if (req.method === "POST") { const input = await body(), context = parseWorkContext(input.context); if (!context || typeof input.sessionId !== "string") throw new WorkError("A conversation and work context are required"); send(res, 202, { ok: true, command: await views.issue(input.sessionId, context, input) }); }
      else throw new WorkError("Method not allowed", 405);
      return true;
    }
    if (url.pathname === "/api/work/drafts") { if (req.method !== "GET") throw new WorkError("Method not allowed", 405); send(res, 200, { ok: true, commands: views.listDrafts() }); return true; }
    if (url.pathname === "/api/work") {
      if (req.method === "GET") send(res, 200, { ok: true, ...(await store.read()), workspaces: registry.list() });
      else if (req.method === "POST") { const input = await body(); await validateSessions(input); const work = await store.create(input); send(res, 201, { ok: true, work }); }
      else throw new WorkError("Method not allowed", 405);
      return true;
    }
    const parts = url.pathname.slice("/api/work/".length).split("/").map(decodeURIComponent);
    const workId = parts[0], record = await store.require(workId);
    if (parts.length === 1 && req.method === "PATCH") {
      const input = await body(); await validateSessions({ ...record, ...input });
      send(res, 200, { ok: true, work: await store.patch(workId, input, input.expectedRevision) }); return true;
    }
    if (parts[1] === "browser") {
      const id = parts[2];
      if (!id && req.method === "POST") send(res, 201, { ok: true, page: await browser.open(workId, String((await body()).url || "")) });
      else if (id && req.method === "GET") send(res, 200, { ok: true, page: await browser.action(workId, id, { action: "inspect" }) });
      else if (id && req.method === "POST") send(res, 200, { ok: true, page: await browser.action(workId, id, await body()) });
      else if (id && req.method === "DELETE") { await browser.close(workId, id); send(res, 200, { ok: true }); }
      else throw new WorkError("Method not allowed", 405);
      return true;
    }
    if (parts[1] === "mcp") {
      const id = parts[2], action = parts[3];
      if (!id && req.method === "GET") send(res, 200, { ok: true, connections: await mcp.apps(workId) });
      else if (!id && req.method === "POST") send(res, 201, { ok: true, connection: await mcp.connect(workId, await body()) });
      else if (id && action === "app" && req.method === "GET") send(res, 200, { ok: true, app: await mcp.app(workId, id, url.searchParams.get("tool") || "") });
      else if (id && action === "call" && req.method === "POST") { const input = await body(); send(res, 200, { ok: true, result: await mcp.call(workId, id, String(input.name || ""), input.arguments || {}, input.fromApp === true) }); }
      else throw new WorkError("Method not allowed", 405);
      return true;
    }
    throw new WorkError("Work route not found", 404);
  } catch (error) { send(res, error instanceof WorkError ? error.status : 502, { ok: false, error: error instanceof Error ? error.message : String(error) }); return true; }
}
