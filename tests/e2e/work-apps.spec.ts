import { test, expect } from "@playwright/test";
import { createServer, type Server as HttpServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";

async function listen(server: HttpServer) { await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); return `http://127.0.0.1:${(server.address() as { port: number }).port}`; }
async function close(server: HttpServer) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
test.beforeEach(async ({ page }) => { await page.addInitScript(() => localStorage.removeItem("pi-web.shell")); });

test("the browser tab displays the actual isolated page and sends clicks to it", async ({ page, request }) => {
  const server = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end('<title>Live browser page</title><button style="width:100px;height:80px" onclick="this.textContent=\'Clicked\'">Click me</button>'); });
  const url = await listen(server);
  try {
    const { current } = await (await request.get("/api/workspaces")).json();
    const work = (await (await request.post("/api/work", { data: { title: "Browser " + randomUUID(), workspaceIds: [current.id], sessionIds: [] } })).json()).work;
    await page.goto(`/?work=${work.id}`); await expect(page.locator("#filesPanel")).toBeVisible();
    await page.locator("#workOpen").click(); await page.locator("dialog").getByRole("button", { name: "Browser", exact: true }).click();
    await page.getByRole("textbox", { name: "Open browser", exact: true }).fill(url); await page.getByRole("button", { name: "Open browser", exact: true }).click();
    await expect(page.locator("#workBrowser > header strong")).toHaveText("Live browser page");
    const image = page.locator(".workBrowserImage"); await expect(image).toHaveAttribute("src", /^data:image\/jpeg;base64,/);
    const id = await page.evaluate(workId => JSON.parse(sessionStorage.getItem("pi-web.work.scene/" + workId)!).items.find((i: { kind: string }) => i.kind === "browser").id, work.id);
    const box = await image.boundingBox(); await image.click({ position: { x: box!.width * 45 / 1280, y: box!.width * 40 / 1280 } });
    await expect.poll(async () => (await (await request.get(`/api/work/${work.id}/browser/${id}`)).json()).page.text).toContain("Clicked");
    await page.locator('.workTab.active').getByRole("button", { name: "Close Live browser page", exact: true }).click(); await expect(page.locator("#workBrowser")).toBeHidden();
  } finally { await close(server); }
});

test("an MCP app initializes through its sandbox and receives actual tool results", async ({ page, request }) => {
  let count = 0;
  const html = `<p id="status">Starting</p><p id="result"></p><p id="boundary"></p><button id="call">Call tool</button>
<script>
try { parent.document.body.dataset.escaped='yes'; boundary.textContent='escaped'; } catch { boundary.textContent='isolated'; }
addEventListener('message',e=>{const m=e.data;if(m.id===1&&m.result){document.getElementById('status').textContent='Connected';parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}},'*');}if(m.method==='ui/notifications/tool-result')result.textContent=String(m.params.structuredContent.count);if(m.id===2&&m.result)result.textContent=String(m.result.structuredContent.count);});
call.onclick=()=>parent.postMessage({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'count',arguments:{}}},'*');
parent.postMessage({jsonrpc:'2.0',id:1,method:'ui/initialize',params:{appInfo:{name:'integration-fixture',version:'1'},appCapabilities:{},protocolVersion:'2026-01-26'}},'*');
</script>`;
  const server = createServer((req, res) => { void (async () => {
    if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
    let raw = ""; for await (const chunk of req) raw += chunk;
    const mcp = new Server({ name: "integration-fixture", version: "1" }, { capabilities: { tools: {}, resources: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "count", title: "Counter", inputSchema: { type: "object", properties: {} }, _meta: { ui: { resourceUri: "ui://fixture/count" } } }] }));
    mcp.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: String(++count) }], structuredContent: { count } }));
    mcp.setRequestHandler(ReadResourceRequestSchema, async () => ({ contents: [{ uri: "ui://fixture/count", mimeType: "text/html;profile=mcp-app", text: html }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); await mcp.connect(transport); res.on("close", () => { void transport.close(); void mcp.close(); }); await transport.handleRequest(req, res, JSON.parse(raw));
  })().catch(e => { res.writeHead(500); res.end(String(e)); }); });
  const url = await listen(server);
  try {
    const { current } = await (await request.get("/api/workspaces")).json();
    const work = (await (await request.post("/api/work", { data: { title: "MCP " + randomUUID(), workspaceIds: [current.id], sessionIds: [] } })).json()).work;
    const connected = await request.post(`/api/work/${work.id}/mcp`, { data: { name: "Fixture", url } }); expect(connected.ok()).toBeTruthy(); const connection = (await connected.json()).connection;
    await page.goto(`/?work=${work.id}`); await expect(page.locator("#filesPanel")).toBeVisible();
    await page.locator("#workOpen").click(); await page.locator("dialog").getByRole("button", { name: "Apps", exact: true }).click();
    await page.getByRole("button", { name: "Counter · Fixture", exact: true }).click(); await page.getByRole("button", { name: "Run and open app", exact: true }).click();
    const frame = page.frameLocator("#workMcpApp iframe"); await expect(frame.locator("#status")).toHaveText("Connected"); await expect(frame.locator("#result")).toHaveText("1");
    await expect(frame.locator("#boundary")).toHaveText("isolated"); await expect(page.locator("#workMcpApp iframe")).toHaveAttribute("sandbox", "allow-scripts"); expect(await page.locator("body").getAttribute("data-escaped")).toBeNull();
    await frame.getByRole("button", { name: "Call tool" }).click(); await expect(frame.locator("#result")).toHaveText("2");
    await request.post(`/api/work/${work.id}/mcp/${connection.id}/call`, { data: { name: "count", arguments: {} } }); await expect(frame.locator("#result")).toHaveText("3");
  } finally { await close(server); }
});
