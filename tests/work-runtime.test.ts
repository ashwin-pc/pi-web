import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server as HttpServer } from "node:http";
import { WorkStore } from "../server/workspace/workStore.js";
import { WorkViews } from "../server/workspace/views.js";
import { WorkspaceRegistry } from "../server/workspace/registry.js";
import { WorkspaceBrowser, browserUrl } from "../server/workspace/browser.js";
import { WorkspaceMcp } from "../server/workspace/mcp.js";
import { createWorkspaceTools } from "../server/workspace/tools.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";

async function listen(server: HttpServer) { await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); return `http://127.0.0.1:${(server.address() as { port: number }).port}`; }
async function close(server: HttpServer) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }

it("captures an immutable run origin, redacts draft contents from view events, and stops late requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-work-runtime-"));
  try {
    const registry = new WorkspaceRegistry(), a = registry.register(join(dir, "a")), b = registry.register(join(dir, "b"));
    const store = new WorkStore(join(dir, "work.json"), registry), events: unknown[] = [], views = new WorkViews(store, value => events.push(value));
    const work = await store.create({ title: "Both", workspaceIds: [a.id, b.id], sessionIds: ["session"] }), other = await store.create({ title: "Other", workspaceIds: [a.id], sessionIds: ["session"] });
    const context = { workId: work.id, windowId: "window-a", revision: 3, readWorkspaceIds: [a.id], drafts: [{ resource: { kind: "file" as const, workspaceId: a.id, path: "note.md" }, version: "draft-one", text: "unsaved private draft" }] };
    await views.capture("session", context);
    await expect(views.capture("session", { ...context, workId: other.id }, true)).rejects.toMatchObject({ status: 409 });
    await views.capture("session", { ...context, revision: 10 }, true);
    expect((await views.origin("session")).revision).toBe(3);
    const requested = await views.issue("session", await views.origin("session"), { action: "open", item: { kind: "file", workspaceId: a.id, path: "note.md" } });
    expect(requested.context.drafts).toBeUndefined(); expect(JSON.stringify(events)).not.toContain("unsaved private draft");
    await expect(views.issue("session", context, { action: "open", item: { kind: "file", workspaceId: b.id, path: "note.md" } })).rejects.toMatchObject({ status: 403 });
    const proposed = await views.edit("session", context, { workspaceId: a.id, path: "note.md", mode: "append", text: "Agent proposal" });
    expect(proposed.draft).toMatchObject({ version: "draft-one", text: "Agent proposal" }); expect(proposed.context.drafts).toBeUndefined();
    views.cancel("session");
    await expect(views.issue("session", context, { action: "close", item: requested.item })).rejects.toMatchObject({ status: 409 });
    await expect(views.origin("session")).rejects.toMatchObject({ status: 409 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("native Pi tools propose draft edits and issue real view requests using the captured work", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-work-tools-")), browser = new WorkspaceBrowser(), mcp = new WorkspaceMcp(join(dir, "mcp.json"), () => undefined);
  try {
    const registry = new WorkspaceRegistry(), root = registry.register(dir), work = new WorkStore(join(dir, "work.json"), registry), views = new WorkViews(work, () => undefined);
    const record = await work.create({ title: "Notes", workspaceIds: [root.id], sessionIds: ["session"] });
    await views.capture("session", { workId: record.id, windowId: "window", revision: 2, readWorkspaceIds: [root.id], drafts: [{ resource: { kind: "file", workspaceId: root.id, path: "note.md" }, version: "version", text: "Current unsaved note" }] });
    const tools = createWorkspaceTools({ views, work, registry, browser, mcp });
    const call = (name: string, args: unknown) => tools.find(t => t.name === name)!.execute("call", args as never, new AbortController().signal, undefined, { sessionManager: { getSessionId: () => "session" } } as never);
    expect((await call("workspace_draft", { action: "read" })).content).toEqual([{ type: "text", text: expect.stringContaining("Current unsaved note") }]);
    await call("workspace_draft", { action: "append", workspaceId: root.id, path: "note.md", text: "New thought" });
    expect(views.listDrafts()[0].draft.version).toBe("version");
    await call("workspace_view", { action: "open", item: { kind: "file", workspaceId: root.id, path: "note.md" }, alongside: true });
    expect(views.list()[0]).toMatchObject({ sessionId: "session", alongside: true, context: { workId: record.id } });
  } finally { await browser.dispose(); await mcp.dispose(); await rm(dir, { recursive: true, force: true }); }
});

it("the workspace browser runs an actual page and enforces browser ownership", async () => {
  const server = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end('<title>Browser integration</title><button id="count">0</button><input id="note"><script>count.onclick=()=>count.textContent=Number(count.textContent)+1</script>'); });
  const url = await listen(server), browser = new WorkspaceBrowser();
  try {
    const page = await browser.open("work-a", url); expect(page.title).toBe("Browser integration"); expect(page.image.length).toBeGreaterThan(100);
    const changed = await browser.action("work-a", page.id, { action: "click", selector: "#count" }); expect(changed.text).toContain("1");
    await browser.action("work-a", page.id, { action: "type", selector: "#note", text: "Real input" });
    expect(() => browser.validate("work-b", page.id)).toThrow("unavailable");
    expect(() => browserUrl("file:///etc/passwd")).toThrow(); expect(() => browserUrl("https://user:password@example.com")).toThrow();
    await browser.close("work-a", page.id); expect(() => browser.validate("work-a", page.id)).toThrow();
  } finally { await browser.dispose(); await close(server); }
}, 20_000);

it("MCP connects through HTTP, loads advertised UI, shares real results and restricts callers", async () => {
  let calls = 0;
  const server = createServer((req, res) => { void (async () => {
    if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
    let raw = ""; for await (const chunk of req) raw += chunk;
    const mcp = new Server({ name: "integration-fixture", version: "1" }, { capabilities: { tools: {}, resources: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
      { name: "count", title: "Count", inputSchema: { type: "object", properties: {} }, _meta: { ui: { resourceUri: "ui://fixture/count", visibility: ["model", "app"] } } },
      { name: "app-only", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["app"] } } },
    ] }));
    mcp.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: String(++calls) }], structuredContent: { calls } }));
    mcp.setRequestHandler(ReadResourceRequestSchema, async () => ({ contents: [{ uri: "ui://fixture/count", mimeType: "text/html;profile=mcp-app", text: "<button>Actual advertised app</button>", _meta: { ui: { csp: { connectDomains: [] } } } }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); await mcp.connect(transport);
    res.on("close", () => { void transport.close(); void mcp.close(); }); await transport.handleRequest(req, res, JSON.parse(raw));
  })().catch(e => { res.writeHead(500); res.end(String(e)); }); });
  const url = await listen(server), dir = await mkdtemp(join(tmpdir(), "pi-mcp-test-")), events: Record<string, unknown>[] = [], host = new WorkspaceMcp(join(dir, "mcp.json"), e => events.push(e));
  try {
    const connection = await host.connect("work-a", { name: "Fixture", url });
    expect((await host.apps("work-a"))[0].apps[0].name).toBe("count");
    const result = await host.call("work-a", connection.id, "count", {}, false, true); expect(result.structuredContent).toEqual({ calls: 1 });
    const app = await host.app("work-a", connection.id, "count"); expect(app.html).toContain("Actual advertised app"); expect(app.result).toEqual(result); expect(events[0].type).toBe("work_mcp_result");
    await host.call("work-a", connection.id, "count", {}, true); expect(calls).toBe(2);
    await expect(host.call("work-a", connection.id, "app-only", {}, false, true)).rejects.toMatchObject({ status: 403 });
    await expect(host.call("work-b", connection.id, "count", {})).rejects.toMatchObject({ status: 404 });
    const restarted = new WorkspaceMcp(join(dir, "mcp.json"), () => undefined); expect((await restarted.connections("work-a"))[0].id).toBe(connection.id); await restarted.dispose();
  } finally { await host.dispose(); await close(server); await rm(dir, { recursive: true, force: true }); }
}, 20_000);
