import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { jsonRoundTrip } from "../server/session/dto.js";
import { LocalSessionService, type LocalSessionServiceDependencies } from "../server/session/service.js";
import type { PiWebSession } from "../server/types.js";

function fixtureSession(): PiWebSession {
  const entries = [
    { id: "call", parentId: null, type: "message", timestamp: "2026-01-01T00:00:00Z", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", toolName: "read", args: { path: "secret" }, startedAt: "2026-01-01T00:00:00Z" }], timestamp: "2026-01-01T00:00:00Z" } },
    { id: "result", parentId: "call", type: "message", timestamp: "2026-01-01T00:00:01Z", message: { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, timestamp: "2026-01-01T00:00:01Z" } },
  ];
  const model = { provider: "test", id: "model", name: "Model", reasoning: true, contextWindow: 1000, maxTokens: 100 };
  return {
    sessionId: "current", sessionFile: "/tmp/current.jsonl", isStreaming: false, isCompacting: false,
    model, thinkingLevel: "medium", messages: entries.map((entry) => entry.message), agent: { state: { messages: entries.map((entry) => entry.message) } },
    sessionManager: { newSession() {}, getBranch: () => entries, getLeafId: () => "result", getTree: () => [{ entry: entries[0], children: [{ entry: entries[1], children: [] }] }] },
    modelRuntime: { getAvailableSnapshot: () => [model], getModel: () => model },
    extensionRunner: { getRegisteredCommands: () => [] }, promptTemplates: [], resourceLoader: { getSkills: () => ({ skills: [] }) },
    getAvailableThinkingLevels: () => ["off", "medium"], getSessionName: () => "Fixture", getContextUsage: () => ({ tokens: 1, contextWindow: 1000, percent: 0.1 }),
    setModel: vi.fn(async () => undefined), setThinkingLevel: vi.fn(), prompt: async () => undefined, abort: async () => undefined,
  };
}

function fixtureService() {
  const session = fixtureSession();
  const creates: Array<{ cwd?: string; previous?: string }> = [];
  const deps: LocalSessionServiceDependencies = {
    currentSessionId: () => "current", globalCwd: () => "/global", resolve: async (id) => id === "current" ? session : undefined,
    cwd: () => "/current", decorateState: () => ({ sessionId: "current", cwd: "/current", model: { provider: "test", id: "model" } }),
    decorateMessageContent: (content) => content, availableModels: () => [session.model], webCommands: [{ name: "web", source: "web" }],
    list: async () => [], create: async (cwd, previous) => { creates.push({ cwd, previous }); return session; }, open: async () => session,
    delete: async () => ({}), switchCwd: async () => ({}), executeCommand: async () => ({ message: "ok", state: {} }), prompt: async () => undefined,
    retry: async () => undefined, navigate: async () => ({ finish() {} }), invokeHeaderAction: async () => ({}), invokeGitTab: async () => ({}), reportError: () => undefined,
  };
  return { service: new LocalSessionService(deps), session, creates };
}

describe("LocalSessionService contract", () => {
  it("returns JSON-round-trip-stable projection results", async () => {
    const { service } = fixtureService();
    for (const result of await Promise.all([service.state(), service.stats(), service.tree(), service.messages(), service.models(), service.commands()])) {
      expect(jsonRoundTrip(result)).toStrictEqual(result);
    }
  });

  it("maps unavailable conversation trees to the legacy 400 status", async () => {
    const { service, session } = fixtureService();
    session.sessionManager.getTree = undefined;
    await expect(service.tree()).rejects.toMatchObject({ status: 400 });
  });

  it("preserves message args and empty thinking-level behavior", async () => {
    const { service, session } = fixtureService();
    const messages = await service.messages() as Array<Record<string, unknown>>;
    expect(messages[1].toolArgs).toEqual({});
    await service.setModel(undefined, "test", "model", "");
    expect(session.setThinkingLevel).toHaveBeenCalledWith("");
  });

  it("inherits the current session but lets unknown sources fall back globally", async () => {
    const { service, creates } = fixtureService();
    await service.create();
    await service.create("missing");
    expect(creates).toEqual([
      { cwd: "/current", previous: "/tmp/current.jsonl" },
      { cwd: "/global", previous: undefined },
    ]);
  });
});

describe("session route boundary", () => {
  it("does not access PiWebSession members directly in HTTP route bodies", async () => {
    const source = await readFile(new URL("../server.ts", import.meta.url), "utf8");
    const routes = source.slice(source.indexOf("const server = createServer"));
    expect(routes).not.toContain("targetSession.");
  });

  it("writes a navigation response before calling its finalizer", async () => {
    const source = await readFile(new URL("../server.ts", import.meta.url), "utf8");
    const start = source.indexOf('url.pathname === "/api/session/tree/navigate"');
    const route = source.slice(start, source.indexOf('url.pathname === "/api/session/tree/abort-summary"', start));
    expect(route.indexOf("sendJson(res, 200")).toBeGreaterThan(-1);
    expect(route.indexOf("sendJson(res, 200")).toBeLessThan(route.indexOf("finish();"));
    expect(route).not.toContain("setTimeout");
  });
});
