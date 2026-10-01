import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { WorkViews } from "./views.js";
import { WorkStore } from "./workStore.js";
import { WorkspaceBrowser } from "./browser.js";
import { WorkspaceMcp, appUri } from "./mcp.js";
import { WorkspaceRegistry } from "./registry.js";

const viewParameters = Type.Object({ action: Type.Union([Type.Literal("list"), Type.Literal("open"), Type.Literal("close"), Type.Literal("pin"), Type.Literal("unpin")]), item: Type.Optional(Type.Any()), alongside: Type.Optional(Type.Boolean()) });
const browserParameters = Type.Object({ action: Type.Union([Type.Literal("open"), Type.Literal("inspect"), Type.Literal("navigate"), Type.Literal("click"), Type.Literal("type"), Type.Literal("back"), Type.Literal("reload"), Type.Literal("close")]), id: Type.Optional(Type.String()), url: Type.Optional(Type.String()), selector: Type.Optional(Type.String()), text: Type.Optional(Type.String()) });
const mcpParameters = Type.Object({ action: Type.Union([Type.Literal("list"), Type.Literal("call")]), connectionId: Type.Optional(Type.String()), toolName: Type.Optional(Type.String()), arguments: Type.Optional(Type.Any()) });
const draftParameters = Type.Object({ action: Type.Union([Type.Literal("read"), Type.Literal("append"), Type.Literal("replace")]), workspaceId: Type.Optional(Type.String()), path: Type.Optional(Type.String()), text: Type.Optional(Type.String()) });
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value });
export function createWorkspaceTools(options: { views: WorkViews; work: WorkStore; registry: WorkspaceRegistry; browser: WorkspaceBrowser; mcp: WorkspaceMcp }): ToolDefinition[] {
  const { views, work, registry, browser, mcp } = options;
  return [defineTool({
    name: "workspace_draft", label: "Edit the user's draft", parameters: draftParameters,
    description: "Read the open file drafts captured with the prompt, or propose appending/replacing one of those drafts. Use this for unsaved text rather than writing over the disk file. Returns a proposed draft change; the shell applies it only if the captured draft is still current and the user is not typing. A changed draft waits for review. Saving to disk remains the user's explicit action.",
    async execute(_id, params: Static<typeof draftParameters>, signal, _update, ctx) {
      const sessionId = ctx.sessionManager.getSessionId(), context = await views.origin(sessionId); if (signal?.aborted) throw new Error("Stopped");
      if (params.action === "read") return result(context.drafts || []);
      return result({ proposed: await views.edit(sessionId, context, { ...params, mode: params.action }) });
    },
  }), defineTool({
    name: "workspace_view", label: "Arrange the workspace", parameters: viewParameters,
    description: "List the current work's projects and conversations, or request opening, closing, pinning or unpinning a file/app/browser tab. Item: {kind:'file',workspaceId,path}, {kind:'diff',workspaceId,repo,path,staged}, {kind:'preview',workspaceId,path}, {kind:'app',sessionId,key}, {kind:'browser',id}, or {kind:'mcp-app',connectionId,toolName}. alongside opens beside the current item on desktop. This requests a view; it does not edit or save files. The user's pins and foreground focus take precedence.",
    async execute(_id, params: Static<typeof viewParameters>, signal, _update, ctx) {
      const sessionId = ctx.sessionManager.getSessionId(), context = await views.origin(sessionId);
      if (signal?.aborted) throw new Error("Stopped");
      if (params.action === "list") { const record = await work.require(context.workId); return result({ work: record, projects: context.readWorkspaceIds.map(id => registry.require(id)), views: views.list().filter(v => v.context.workId === record.id).map(v => v.item) }); }
      const command = await views.issue(sessionId, context, params); return result({ requested: command, note: "The shell may defer this behind Show while the user edits or works elsewhere." });
    },
  }), defineTool({
    name: "workspace_browser", label: "Use the browser", parameters: browserParameters,
    description: "Use a real isolated browser in the current work. Open an http(s) URL, inspect rendered text, click a CSS selector, type into a selector, navigate, reload, go back or close the browser runtime. Opening also requests its tab. Returns current page text and a screenshot; only read what the actual page reports.",
    async execute(_id, params: Static<typeof browserParameters>, signal, _update, ctx) {
      const sessionId = ctx.sessionManager.getSessionId(), context = await views.origin(sessionId); if (signal?.aborted) throw new Error("Stopped");
      if (params.action === "close") { await views.issue(sessionId, context, { action: "close", item: { kind: "browser", id: params.id } }); await browser.close(context.workId, params.id || ""); return result({ closed: params.id }); }
      const page = params.action === "open" ? await browser.open(context.workId, params.url || "") : await browser.action(context.workId, params.id || "", params);
      if (signal?.aborted) throw new Error("Stopped");
      if (params.action === "open") await views.issue(sessionId, context, { action: "open", item: { kind: "browser", id: page.id } });
      return { content: [{ type: "text" as const, text: JSON.stringify({ ...page, image: undefined }) }, { type: "image" as const, data: page.image, mimeType: "image/jpeg" }], details: { id: page.id, url: page.url, workId: context.workId } };
    },
  }), defineTool({
    name: "workspace_mcp", label: "Use connected app tools", parameters: mcpParameters,
    description: "List MCP connections and their real tool schemas in the current work, or call one with a connectionId, toolName and JSON arguments. A tool advertising an MCP app also requests its app tab. Tool results are shared with the app UI. File/workspace references do not grant access to another connection.",
    async execute(_id, params: Static<typeof mcpParameters>, signal, _update, ctx) {
      const sessionId = ctx.sessionManager.getSessionId(), context = await views.origin(sessionId); if (signal?.aborted) throw new Error("Stopped");
      if (params.action === "list") return result(await Promise.all((await mcp.connections(context.workId)).map(async connection => ({ id: connection.id, name: connection.name, tools: (await mcp.tools(context.workId, connection.id)).filter(tool => { const visibility = (tool._meta?.ui as { visibility?: string[] } | undefined)?.visibility; return !visibility || visibility.includes("model"); }) }))));
      const id = params.connectionId || "", name = params.toolName || "", output = await mcp.call(context.workId, id, name, params.arguments || {}, false, true);
      if (signal?.aborted) throw new Error("Stopped");
      if ((await mcp.tools(context.workId, id)).some(tool => tool.name === name && appUri(tool))) await views.issue(sessionId, context, { action: "open", item: { kind: "mcp-app", connectionId: id, toolName: name }, alongside: true });
      return result(output);
    },
  })];
}
