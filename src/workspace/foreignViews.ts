import type { AppPanelManager } from "../layout/rightPanel.js";
import type { WorkItem } from "../../shared/work.js";
import { iconElement } from "../app/icons.js";

type BrowserPage = { id: string; workId: string; url: string; title: string; image: string; width: number; height: number; text: string };
export function createForeignViews(options: { panels: AppPanelManager; headers: () => HeadersInit; workId: () => string; onBrowser: (item: WorkItem) => Promise<void>; onTitle: (workId: string, item: WorkItem, title: string) => void; onError: (error: unknown) => void }) {
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(path, { headers: options.headers(), ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
    const data = await response.json(); if (!response.ok || data.ok === false) throw new Error(data.error || "App request failed"); return data;
  };
  function panel(id: string, title: string, surface: string) {
    const root = document.createElement("section"); root.id = id; root.className = "workForeignPanel"; root.hidden = true;
    const header = document.createElement("header"), heading = document.createElement("strong"), close = document.createElement("button"); heading.textContent = title; close.type = "button"; close.className = "iconButton"; close.setAttribute("aria-label", "Close " + title); close.append(iconElement("x"));
    const body = document.createElement("div"); body.className = "workForeignBody"; header.append(heading, close); root.append(header, body); document.body.append(root);
    const handle = options.panels.register({ id, surface, panel: root, closeButton: close, width: "760px" }); return { root, heading, body, handle };
  }
  const browser = panel("workBrowser", "Browser", "browser"), mcp = panel("workMcpApp", "Connected app", "mcp");
  const address = document.createElement("form"), back = document.createElement("button"), input = document.createElement("input"), go = document.createElement("button");
  address.className = "workBrowserAddress"; back.type = "button"; back.append(iconElement("arrow-left")); back.setAttribute("aria-label", "Browser back"); input.type = "url"; input.required = true; input.setAttribute("aria-label", "Browser address"); go.append(iconElement("arrow-up-right")); go.setAttribute("aria-label", "Navigate browser"); address.append(back, input, go);
  const image = document.createElement("img"); image.className = "workBrowserImage"; image.alt = "Current browser page"; image.tabIndex = 0;
  const type = document.createElement("form"), text = document.createElement("input"), insert = document.createElement("button"); type.className = "workBrowserInput"; text.placeholder = "Type into the focused page field"; text.setAttribute("aria-label", "Text for the browser"); insert.textContent = "Type"; type.append(text, insert);
  const error = document.createElement("p"); error.className = "workBrowserError"; error.setAttribute("role", "status"); browser.body.append(address, error, image, type);
  let current: { workId: string; id: string } | undefined, page: BrowserPage | undefined, browserGeneration = 0, requestSequence = 0, paintedSequence = 0;
  async function browserAction(body: unknown) {
    if (!current) return;
    const owner = current, generation = browserGeneration, sequence = ++requestSequence;
    try { const data = await request(`/api/work/${owner.workId}/browser/${owner.id}`, body); if (generation !== browserGeneration || sequence < paintedSequence) return; paintedSequence = sequence; page = data.page; input.value = page!.url; image.src = "data:image/jpeg;base64," + page!.image; browser.heading.textContent = page!.title || "Browser"; options.onTitle(owner.workId, { kind: "browser", id: owner.id }, browser.heading.textContent); error.textContent = ""; }
    catch (e) { if (generation === browserGeneration) error.textContent = e instanceof Error ? e.message : String(e); }
  }
  address.onsubmit = event => { event.preventDefault(); void browserAction({ action: "navigate", url: input.value }); };
  back.onclick = () => void browserAction({ action: "back" });
  type.onsubmit = event => { event.preventDefault(); void browserAction({ action: "type", text: text.value }); text.value = ""; };
  image.onclick = event => { if (!page) return; const box = image.getBoundingClientRect(); void browserAction({ action: "click", x: (event.clientX - box.left) * page.width / box.width, y: (event.clientY - box.top) * page.height / box.height }); };
  const timer = window.setInterval(() => { if (current && browser.root.getClientRects().length && !document.hidden && document.activeElement !== input && document.activeElement !== text) void browserAction(undefined); }, 3000);
  let bridge: import("@modelcontextprotocol/ext-apps/app-bridge").AppBridge | undefined, mcpGeneration = 0;
  let initialized = false, latestResult: import("@modelcontextprotocol/client").CallToolResult | undefined;
  let activeApp: { workId: string; connectionId: string; toolName: string } | undefined;
  async function openApp(item: Extract<WorkItem, { kind: "mcp-app" }>, workId: string) {
    const generation = ++mcpGeneration; await bridge?.close(); bridge = undefined; initialized = false; latestResult = undefined; activeApp = { workId, connectionId: item.connectionId, toolName: item.toolName };
    mcp.body.textContent = "Loading connected app…"; mcp.handle.open();
    const data = await request(`/api/work/${workId}/mcp/${item.connectionId}/app?tool=${encodeURIComponent(item.toolName)}`); if (generation !== mcpGeneration) return;
    const app = data.app;
    const domains = (values: unknown) => Array.isArray(values) ? values.flatMap(value => { try { const url = new URL(String(value)); return ["http:", "https:"].includes(url.protocol) ? [url.origin] : []; } catch { return []; } }).join(" ") : "";
    const resources = domains(app.metadata?.csp?.resourceDomains), connections = domains(app.metadata?.csp?.connectDomains);
    const csp = `default-src 'none'; script-src 'unsafe-inline' ${resources}; style-src 'unsafe-inline' ${resources}; img-src data: blob: ${resources}; font-src ${resources || "'none'"}; connect-src ${connections || "'none'"}; form-action 'none'; base-uri 'none';`;
    const frame = document.createElement("iframe"); frame.title = app.tool.title || item.toolName; frame.setAttribute("sandbox", "allow-scripts"); frame.referrerPolicy = "no-referrer";
    mcp.heading.textContent = frame.title; mcp.body.replaceChildren(frame);
    options.onTitle(workId, item, frame.title);
    const { AppBridge, PostMessageTransport } = await import("@modelcontextprotocol/ext-apps/app-bridge"); if (generation !== mcpGeneration) return;
    const host = new AppBridge(null, { name: "Pi Web", version: "0.6.1" }, { serverTools: {}, serverResources: {}, openLinks: {} }); bridge = host; latestResult = app.result;
    const active = () => generation === mcpGeneration && options.workId() === workId && mcp.root.getClientRects().length > 0;
    host.oncalltool = async params => { if (!active()) throw new Error("This app is no longer foreground"); return (await request(`/api/work/${workId}/mcp/${item.connectionId}/call`, { ...params, fromApp: true })).result; };
    host.onreadresource = async params => { if (params.uri !== app.uri || !active()) throw new Error("This resource is outside the current app"); return { contents: [{ uri: app.uri, mimeType: "text/html;profile=mcp-app", text: app.html }] }; };
    host.onopenlink = async params => { if (!active()) throw new Error("This app is no longer foreground"); const data = await request(`/api/work/${workId}/browser`, { url: params.url }); if (active()) await options.onBrowser({ kind: "browser", id: data.page.id }); return { isError: false }; };
    host.oninitialized = () => { if (generation !== mcpGeneration) return; initialized = true; void (async () => { await host.sendToolInput({ arguments: app.arguments || {} }); if (latestResult) await host.sendToolResult(latestResult); })().catch(options.onError); };
    await host.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
    frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="${csp.replaceAll('"', '&quot;')}">${app.html}`;
  }
  window.addEventListener("pi-web-work-event", ((event: CustomEvent) => {
    const data = event.detail;
    if (data.type === "work_mcp_result" && activeApp && activeApp.workId === data.workId && activeApp.connectionId === data.connectionId && activeApp.toolName === data.toolName && bridge) { latestResult = data.result; if (initialized) void bridge.sendToolResult(data.result).catch(options.onError); }
  }) as EventListener);
  return {
    async open(item: WorkItem, workId: string) {
      if (item.kind === "browser") { if (current?.workId !== workId || current?.id !== item.id) { page = undefined; image.removeAttribute("src"); input.value = ""; browser.heading.textContent = "Browser"; error.textContent = "Loading…"; } current = { workId, id: item.id }; browserGeneration++; browser.handle.open(); await browserAction(undefined); }
      else if (item.kind === "mcp-app") await openApp(item, workId);
    },
    async createBrowser(url: string, workId: string): Promise<WorkItem> { const data = await request(`/api/work/${workId}/browser`, { url }); return { kind: "browser", id: data.page.id }; },
    panelId: (item: WorkItem) => item.kind === "browser" ? "workBrowser" : item.kind === "mcp-app" ? "workMcpApp" : undefined,
    dispose() { clearInterval(timer); void bridge?.close(); browserGeneration++; mcpGeneration++; },
  };
}
