const DEFAULT_URL = "http://127.0.0.1:27182/mcp";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TEXT_RESPONSE_BYTES = 2 * 1024 * 1024;

export type FusionDirection = "front" | "back" | "left" | "right" | "top" | "bottom" | "iso-top-right" | "iso-top-left" | "iso-bottom-right" | "iso-bottom-left";

export function fusionMcpUrl(value = process.env.PI_WEB_FUSION_MCP_URL) {
  const url = new URL(value || DEFAULT_URL);
  if (url.username || url.password || url.search || url.hash || url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]" && url.hostname !== "::1")) {
    throw new Error("PI_WEB_FUSION_MCP_URL must be an HTTP loopback URL.");
  }
  return url.toString();
}

function abortSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

async function responseBytes(response: Response, maxBytes: number) {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error("Fusion MCP response exceeds the size limit."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

function decodePayloads(text: string, sse: boolean): any[] {
  const payloads = sse
    ? text.split(/\r?\n\r?\n/).map(event => event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n")).filter(data => data.trim() && data.trim() !== "[DONE]")
    : [text];
  try { return payloads.map(payload => JSON.parse(payload)); }
  catch { throw new Error("Fusion MCP returned malformed JSON or SSE data."); }
}

async function readLimited(response: Response, maxBytes = MAX_TEXT_RESPONSE_BYTES, expectedId: number) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new Error("Fusion MCP response exceeds the size limit.");
  const bytes = await responseBytes(response, maxBytes);
  if (bytes.byteLength > maxBytes) throw new Error("Fusion MCP response exceeds the size limit.");
  const text = new TextDecoder().decode(bytes);
  if (!response.ok) throw new Error(`Fusion MCP HTTP ${response.status}: ${text.slice(0, 500)}`);
  if (!text.trim()) throw new Error("Fusion MCP returned an empty response.");
  const sse = !!response.headers.get("content-type")?.includes("text/event-stream");
  const payloads = decodePayloads(text, sse);
  const payload = payloads.find(item => item && typeof item === "object" && (Object.hasOwn(item, "result") || Object.hasOwn(item, "error")) && item.id === expectedId);
  if (!payload) throw new Error(`Fusion MCP returned no JSON-RPC response matching request id ${expectedId}.`);
  return payload;
}

async function drainInitialized(response: Response, maxBytes: number) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new Error("Fusion MCP initialized response exceeds the size limit.");
  const bytes = await responseBytes(response, maxBytes);
  if (bytes.byteLength > maxBytes) throw new Error("Fusion MCP initialized response exceeds the size limit.");
  const text = new TextDecoder().decode(bytes).trim();
  if (!response.ok) throw new Error(`Fusion MCP initialized notification failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
  if (text) {
    for (const parsed of decodePayloads(text, !!response.headers.get("content-type")?.includes("text/event-stream"))) {
      if (parsed?.error) throw new Error(`Fusion MCP initialized notification failed: ${JSON.stringify(parsed.error).slice(0, 500)}`);
    }
  }
}

function structuredToolFailure(result: any) {
  for (const item of Array.isArray(result?.content) ? result.content : []) {
    if (item?.type !== "text" || typeof item.text !== "string") continue;
    try {
      const parsed = JSON.parse(item.text);
      if (parsed && typeof parsed === "object" && (parsed.success === false || parsed.error)) {
        return String(parsed.error || parsed.message || "Fusion MCP tool reported failure").slice(0, 1000);
      }
    } catch { /* ordinary tool output or printed non-JSON text */ }
  }
  return undefined;
}

export async function requestFusionMcp(method: "tools/call" | "tools/list" | "resources/list" | "resources/read", params: unknown, options: { signal?: AbortSignal; timeoutMs?: number; maxResponseBytes?: number } = {}) {
  const url = fusionMcpUrl();
  const signal = abortSignal(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  let response = await fetch(url, { method: "POST", redirect: "error", headers, signal, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "pi-web-3d-modeling", version: "1" } } }) });
  const initialized = await readLimited(response, options.maxResponseBytes, 1);
  if (initialized.error) throw new Error("Fusion MCP initialization failed.");
  const sessionId = response.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("Fusion MCP did not return a session id.");
  headers["mcp-session-id"] = sessionId;
  try {
    response = await fetch(url, { method: "POST", redirect: "error", headers, signal, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    await drainInitialized(response, Math.min(options.maxResponseBytes ?? MAX_TEXT_RESPONSE_BYTES, 512 * 1024));
    response = await fetch(url, { method: "POST", redirect: "error", headers, signal, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }) });
    const result = await readLimited(response, options.maxResponseBytes, 2);
    if (result.error) throw new Error(`Fusion MCP error: ${JSON.stringify(result.error).slice(0, 1000)}`);
    const structuredFailure = structuredToolFailure(result.result);
    if (result.result?.isError || result.result?.error || structuredFailure) throw new Error(`Fusion MCP tool error: ${String(result.result.error || structuredFailure || JSON.stringify(result.result.content)).slice(0, 1000)}`);
    return { initialized: initialized.result, result: result.result };
  } finally {
    // Session disposal is best effort, separately bounded even after the request
    // signal aborts. DELETE is not proof that remote Python stopped executing.
    // Older bridges may reject session deletion; never mask the call outcome.
    try {
      const closed = await fetch(url, { method: "DELETE", redirect: "error", headers, signal: AbortSignal.timeout(2_000) });
      await closed.body?.cancel();
    } catch { /* unsupported disposal, unavailable bridge, or disposal timeout */ }
  }
}

export function callFusionMcp(tool: string, args: unknown, options: { signal?: AbortSignal; timeoutMs?: number; maxResponseBytes?: number } = {}) {
  return requestFusionMcp("tools/call", { name: tool, arguments: args }, options);
}
