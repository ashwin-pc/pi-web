/** Synthetic native 0.154.0 MCP tool output, shared by adapter and real-browser tests. */
export const codexFixturePng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg+M/wHwAEAQH/cetH5QAAAABJRU5ErkJggg==";

export function mcpImageEvents(threadId: string, turnId: string, itemId = "mcp-image") {
  const item = { type: "mcpToolCall", id: itemId, server: "fixture", tool: "image", arguments: { name: "synthetic" },
    appContext: null, pluginId: null, readOnlyHint: true, result: null, error: null, durationMs: null };
  return [
    { method: "item/started", params: { threadId, turnId, startedAtMs: 1, item: { ...item, status: "inProgress" } } },
    { method: "item/completed", params: { threadId, turnId, completedAtMs: 2, item: { ...item, status: "completed", durationMs: 1,
      result: { content: [{ type: "text", text: "Native image result" }, { type: "image", mimeType: "image/png", data: codexFixturePng }], structuredContent: null, _meta: null } } } },
  ];
}
