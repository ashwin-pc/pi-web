import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { type Tool, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { WorkError } from "./workStore.js";
import { browserUrl } from "./browser.js";
import { boundedId } from "../../shared/work.js";

type Connection = { id: string; workId: string; name: string; url: string; headersEnv: Record<string, string> };
type Result = { arguments: Record<string, unknown>; result: CallToolResult };
export function appUri(tool: Tool) {
  const ui = tool._meta?.ui as { resourceUri?: unknown } | undefined;
  const uri = ui?.resourceUri || tool._meta?.["ui/resourceUri"];
  return typeof uri === "string" && uri.startsWith("ui://") ? uri : undefined;
}
export class WorkspaceMcp {
  private clients = new Map<string, Promise<Client>>();
  private lastResults = new Map<string, Result>();
  private cached?: Connection[];
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string, private readonly emit: (value: Record<string, unknown>) => void) {}
  async connections(workId: string) {
    if (!this.cached) {
      try { const raw: unknown = JSON.parse(await readFile(this.file, "utf8")); if (!Array.isArray(raw) || raw.some(c => !boundedId(c?.id) || !boundedId(c?.workId) || typeof c.name !== "string" || typeof c.url !== "string" || !c.headersEnv || typeof c.headersEnv !== "object" || Array.isArray(c.headersEnv) || Object.entries(c.headersEnv).some(([h,v]) => !/^[A-Za-z0-9-]+$/.test(h) || typeof v !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)))) throw new Error("Invalid MCP connection catalogue"); for (const c of raw) browserUrl(c.url); this.cached = raw as Connection[]; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; this.cached = []; }
    }
    return this.cached.filter(c => c.workId === workId).map(c => ({ ...c, headersEnv: { ...c.headersEnv } }));
  }
  async connect(workId: string, input: Record<string, unknown>) {
    const url = browserUrl(input.url), name = typeof input.name === "string" ? input.name.trim().slice(0, 160) : new URL(url).hostname;
    if (!name) throw new WorkError("Give this connection a name");
    const headersEnv = input.headersEnv && typeof input.headersEnv === "object" ? input.headersEnv as Record<string, string> : {};
    for (const [header, variable] of Object.entries(headersEnv)) if (!/^[A-Za-z0-9-]+$/.test(header) || typeof variable !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) throw new WorkError("Connection headers must refer to environment variable names");
    await this.connections(workId);
    const connection: Connection = { id: randomUUID(), workId, name, url, headersEnv };
    const client = await this.createClient(connection);
    this.clients.set(connection.id, Promise.resolve(client));
    const operation = this.queue.then(async () => {
      const next = [...this.cached!, connection]; await mkdir(dirname(this.file), { recursive: true });
      const temp = this.file + "." + randomUUID() + ".tmp"; await writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 }); await rename(temp, this.file); this.cached = next;
    });
    this.queue = operation.catch(() => undefined); await operation; return connection;
  }
  private async require(workId: string, id: string) { const connection = (await this.connections(workId)).find(c => c.id === id); if (!connection) throw new WorkError("This MCP connection is unavailable in this work", 404); return connection; }
  async validate(workId: string, id: string, toolName: string) { await this.require(workId, id); if (!(await this.tools(workId, id)).some(tool => tool.name === toolName && appUri(tool))) throw new WorkError("This connected app is unavailable", 404); }
  private async createClient(connection: Connection) {
    const headers: Record<string, string> = {};
    for (const [header, variable] of Object.entries(connection.headersEnv)) { const value = process.env[variable]; if (!value) throw new WorkError(`Set ${variable} before using this connection`, 503); headers[header] = value; }
    const client = new Client({ name: "pi-web", version: "0.6.1" }, { capabilities: { extensions: { "io.modelcontextprotocol/ui": {} } } });
    try { await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers } }), { timeout: 15_000 }); return client; }
    catch (error) { await client.close().catch(() => undefined); throw error; }
  }
  private async client(workId: string, id: string) {
    const connection = await this.require(workId, id);
    if (!this.clients.has(id)) this.clients.set(id, this.createClient(connection).catch(error => { this.clients.delete(id); throw error; }));
    return this.clients.get(id)!;
  }
  async tools(workId: string, id: string): Promise<Tool[]> {
    const client = await this.client(workId, id), tools: Tool[] = []; let cursor: string | undefined;
    do { const page = await client.listTools({ ...(cursor ? { cursor } : {}) }, { timeout: 15_000 }); tools.push(...page.tools); cursor = page.nextCursor; } while (cursor && tools.length < 200);
    return tools.slice(0, 200);
  }
  async apps(workId: string) {
    return Promise.all((await this.connections(workId)).map(async connection => {
      try { return { ...connection, apps: (await this.tools(workId, connection.id)).filter(appUri) }; }
      catch (error) { return { ...connection, apps: [] as Tool[], error: error instanceof Error ? error.message : String(error) }; }
    }));
  }
  async call(workId: string, id: string, name: string, args: unknown, fromApp = false, fromModel = false) {
    const tools = await this.tools(workId, id), tool = tools.find(t => t.name === name);
    const visibility = (tool?._meta?.ui as { visibility?: string[] } | undefined)?.visibility;
    if (!tool || (fromApp && visibility && !visibility.includes("app")) || (fromModel && visibility && !visibility.includes("model"))) throw new WorkError("This tool is unavailable to this caller", 403);
    if (!args || typeof args !== "object" || Array.isArray(args) || JSON.stringify(args).length > 64_000) throw new WorkError("Tool arguments must be a JSON object of at most 64KB");
    const result = await (await this.client(workId, id)).callTool({ name, arguments: args as Record<string, unknown> }) as CallToolResult;
    this.lastResults.set(id + "/" + name, { arguments: args as Record<string, unknown>, result });
    this.emit({ type: "work_mcp_result", workId, connectionId: id, toolName: name, arguments: args, result }); return result;
  }
  async app(workId: string, id: string, name: string) {
    const tool = (await this.tools(workId, id)).find(t => t.name === name), uri = tool && appUri(tool);
    if (!tool || !uri) throw new WorkError("This tool does not advertise an MCP app", 404);
    const resource = await (await this.client(workId, id)).readResource({ uri });
    const content = resource.contents.find(c => typeof c.mimeType === "string" && /^text\/html(?:;|$)/.test(c.mimeType));
    if (!content) throw new WorkError("The app returned no HTML resource", 502);
    const html = "text" in content ? content.text : Buffer.from(content.blob, "base64").toString("utf8");
    if (html.length > 2_000_000) throw new WorkError("This app is larger than the 2MB host limit", 413);
    const metadata = content._meta?.ui as { csp?: { resourceDomains?: string[]; connectDomains?: string[] } } | undefined;
    return { html, uri, tool, metadata, ...this.lastResults.get(id + "/" + name) };
  }
  async dispose() { for (const client of this.clients.values()) await client.then(c => c.close()).catch(() => undefined); this.clients.clear(); }
}
