import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wrapRegisteredTool } from "@earendil-works/pi-coding-agent";
import sessionOrchestrator, {
  workerReport,
  formatWorkerReport,
  normalizeBedrockId,
  parseToken,
  resolveModel,
} from "../examples/pi-web-extensions/session-orchestrator.js";

// ---------------------------------------------------------------------------
// Pure resolution helpers (Amendment 6 ordering)
// ---------------------------------------------------------------------------

describe("model token parsing", () => {
  it("splits on the first colon so ids may contain colons", () => {
    expect(parseToken("amazon-bedrock:amazon.nova-2-lite-v1:0")).toEqual({
      provider: "amazon-bedrock",
      id: "amazon.nova-2-lite-v1:0",
    });
  });

  it("returns null when there is no provider separator", () => {
    expect(parseToken("nova-2-lite")).toBeNull();
  });

  it("normalizes a bedrock id to its base", () => {
    expect(normalizeBedrockId("us.anthropic.claude-x-v1:0")).toBe("us.anthropic.claude-x-v1");
  });
});

describe("resolveModel", () => {
  const registry = [
    { provider: "anthropic", id: "fast-1" },
    { provider: "amazon-bedrock", id: "us.anthropic.claude-x-v1:0" },
  ];

  it("prefers an exact provider/id match without substituting", () => {
    const result = resolveModel("anthropic:fast-1", registry, "us.");
    expect(result?.match).toEqual({ provider: "anthropic", id: "fast-1" });
    expect(result?.substituted).toBe(false);
  });

  it("falls back to the parent region prefix only after an exact miss, and reports it", () => {
    const result = resolveModel("amazon-bedrock:anthropic.claude-x-v1:0", registry, "us.");
    expect(result?.match).toEqual({ provider: "amazon-bedrock", id: "us.anthropic.claude-x-v1:0" });
    expect(result?.substituted).toBe(true);
  });

  it("does not substitute when the parent has no region prefix", () => {
    expect(resolveModel("amazon-bedrock:anthropic.claude-x-v1:0", registry, "")).toBeNull();
  });

  it("never replaces an explicit configured region prefix", () => {
    expect(resolveModel("amazon-bedrock:eu.anthropic.claude-x-v1:0", registry, "us.")).toBeNull();
  });

  it("never picks an arbitrary candidate from another provider", () => {
    expect(resolveModel("openai:missing-1", registry, "us.")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// sessions_spawn: create-unprompted -> resolve -> dispatch or delete
// ---------------------------------------------------------------------------

type Call = { method: string; path: string; body?: any };

const FAST = { name: "Fast", model: "anthropic:fast-1", description: "Cheap scouting." };
const SMART = { name: "Smart", model: "anthropic:smart-1", description: "Hard implementation work." };

const registry = [
  { provider: "anthropic", id: "fast-1", name: "Fast One" },
  { provider: "anthropic", id: "smart-1", name: "Smart One" },
];

let calls: Call[];
let tools: Map<string, any>;
let handlers: Map<string, (event: any, ctx: any) => any>;
let realFetch: typeof globalThis.fetch;
let stateDir: string;
let branch: any[];
let entrySequence: number;
let workerMessages: Map<string, any[]>;
let historyMessages: Map<string, any[]>;
function transcriptRoute(url: unknown) { return String(url).startsWith("/api/messages") || String(url).startsWith("/api/session/history"); }
let saved: Map<string, any>;
let completionPending = false;

function makeExtension(options: { wakeupFails?: boolean } = {}) {
  tools = new Map();
  handlers = new Map();
  const pi: any = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (event: string, handler: any) => handlers.set(event, handler),
    sendMessage: options.wakeupFails
      ? vi.fn(async () => { throw new Error("wakeup unavailable"); })
      : vi.fn(),
    sendUserMessage: options.wakeupFails
      ? vi.fn(() => { throw new Error("user-message unavailable"); })
      : vi.fn(),
    appendEntry: vi.fn((customType: string, data: any) => { branch.push({ type: "custom", id: `entry-${entrySequence++}`, customType, data }); }),
  };
  sessionOrchestrator(pi);
  return pi;
}

function makeCtx(options: {
  categories?: any[];
  defaultCategory?: string;
  worker?: boolean;
  parentModelId?: string;
} = {}) {
  if (options.worker) branch = options.worker
    ? [{ type: "message", message: { role: "user", content: [{ type: "text", text: "[pi-web orchestrated worker] You are a worker session spawned by session parent-1 to do one task." }] } }]
    : [];
  return {
    sessionManager: {
      getBranch: () => branch,
      getSessionId: () => "parent-1",
      getCwd: () => "/repo",
    },
    ui: {
      web: {
        createApiClient: vi.fn(() => ({
          request: (method: string, path: string, options?: { body?: unknown }) => globalThis.fetch(path, {
            method, ...(options?.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          }),
          dispose: vi.fn(),
        })),
        registerSettings: vi.fn(async () => ({ registered: true, migrated: false, usedBackup: false })),
        getSettings: vi.fn(async () => ({
          schemaVersion: 1,
          values: {
            categories: options.categories ?? [],
            defaultCategory: options.defaultCategory ?? "",
          },
        })),
        reportSettlementDependencies: vi.fn(),
      },
    },
    __parentModelId: options.parentModelId ?? "fast-1",
  };
}

/** Route pi-web API calls; `models` is the worker session's registry. */
function stubFetch(options: {
  models?: any[];
  parentModelId?: string;
  newChatFails?: boolean;
  promptFails?: boolean;
  promptFailureStatus?: number;
  wakeupPromptFails?: boolean;
  deleteFails?: boolean;
} = {}) {
  let created = 0;
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const method = String(init.method || "GET");
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });

    let payload: any = { ok: true };
    if (path === "/api/new-chat") {
      created += 1;
      payload = options.newChatFails ? { ok: false, error: "boom" } : { ok: true, sessionId: `worker-${created}` };
    } else if (path === "/api/prompt/validate") {
      // Core owns command matching; this mock only supplies validation decisions.
      payload = ["/my-ext-command foo", "/template args", "/template\targs", "/skill:foo"].includes(body.message)
        ? { ok: false, status: 400, error: "Tracked slash dispatch unsupported" }
        : { ok: true, valid: true };
    } else if (path.startsWith("/api/models")) {
      payload = { ok: true, models: options.models ?? registry };
    } else if (path.startsWith("/api/state")) {
      payload = { ok: true, model: { provider: "anthropic", id: options.parentModelId ?? "fast-1" } };
    } else if (transcriptRoute(path)) {
      const query = new URL(path, "http://local").searchParams;
      const id = query.get("sessionId")!;
      const messages = (path.startsWith("/api/session/history") ? historyMessages.get(id) : undefined) || workerMessages.get(id) || [];
      const boundary = messages.findIndex((m) => m.role === "user" && String(m.text).includes(`[pi-web-dispatch:${query.get("dispatchId")}]`));
      payload = { ok: true, messages: path.startsWith("/api/session/history") ? boundary < 0 ? [] : messages.slice(boundary) : messages };
    } else if (path === "/api/session/completion") {
      if (!completionPending) saved.set(body.deliveryId, body);
      payload = { ok: true, deliveryId: body.deliveryId, state: completionPending ? "pending" : "saved", entryId: completionPending ? undefined : `saved-${body.deliveryId}` };
    } else if (path === "/api/abort") {
      payload = { ok: true, idle: true };
    } else if (path === "/api/prompt" && (options.promptFails || (options.wakeupPromptFails && body?.sessionId === "parent-1"))) {
      payload = { ok: false, error: "prompt failed", status: options.promptFailureStatus ?? 400 };
    } else if (path === "/api/prompt") {
      workerMessages.set(body.sessionId, [{ role: "user", text: `${body.message}\\n\\n[pi-web-dispatch:${body.dispatchId}]`, entryId: `prompt-${body.dispatchId}` }]);
      payload = { ok: true, admission: "accepted", dispatchId: body.dispatchId };
    } else if (path === "/api/sessions/delete" && options.deleteFails) {
      payload = { ok: false, error: "delete failed" };
    }
    return { ok: payload.ok !== false, status: payload.ok === false ? payload.status ?? 500 : 200, json: async () => payload } as any;
  }) as any;
}

function pathsFor(method: string) {
  return calls.filter((call) => call.method === method).map((call) => call.path);
}

async function activate(ctx: any) {
  await handlers.get("session_start")?.({}, ctx);
  // Ignore activation traffic (settings registration, ledger re-arm) so each
  // test asserts only on its own spawn flow.
  calls.length = 0;
}

function serializedSpawnDefinition() {
  const { name, description, parameters } = tools.get("sessions_spawn");
  return JSON.stringify({ name, description, parameters });
}

async function spawn(ctx: any, params: Record<string, unknown>) {
  // sessions_spawn is (re)built from config on session_start, so activate first.
  if (!tools.has("sessions_spawn")) await activate(ctx);
  const tool = tools.get("sessions_spawn");
  const wrapped = wrapRegisteredTool({ definition: tool } as any, { createContext: () => ctx } as any);
  // Model the agent's conversion of a thrown tool failure to a tool result.
  try {
    return await wrapped.execute("call-1", params as any, undefined);
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: String((error as Error).message) }] };
  }
}

function resultText(result: any) {
  return String(result?.content?.[0]?.text || "");
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "orchestrator-test-"));
  vi.stubEnv("PI_WEB_ORCHESTRATOR_STATE_DIR", stateDir);
  branch = [];
  entrySequence = 0;
  workerMessages = new Map();
  historyMessages = new Map();
  saved = new Map();
  completionPending = false;
  calls = [];
  realFetch = globalThis.fetch;
  stubFetch();
  makeExtension();
});

afterEach(() => {
  // Clears the background poll timer started by a successful spawn.
  handlers.get("session_shutdown")?.({}, makeCtx());
  globalThis.fetch = realFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

describe("issue 190 quick fixes", () => {
  it("throws spawn refusals through the SDK wrapper rather than returning isError", async () => {
    const ctx = makeCtx({ worker: true });
    await activate(ctx);
    const tool = wrapRegisteredTool({ definition: tools.get("sessions_spawn") } as any, { createContext: () => ctx } as any);
    await expect(tool.execute("refusal", { name: "nested", task: "work" }, undefined)).rejects.toThrow(/depth cap/);
    expect(calls).toHaveLength(0);
  });

  it("asks for four short labelled outcome lines before report details", async () => {
    await spawn(makeCtx(), { name: "labels", task: "work" });
    const prompt = calls.find((call) => call.path === "/api/prompt")?.body.message;
    expect(prompt).toMatch(/Lead your final report.*Outcome:.*Changed:.*Verified:.*Blocked:/);
  });

  it("does not mistake old assistant prose followed by tool activity for a finished report", () => {
    const old = { role: "assistant", text: "Done yesterday" };
    expect(workerReport([old, { role: "toolResult", text: "build started" }])).toMatchObject({ outcome: "interrupted", text: "build started" });
    expect(workerReport([old, { role: "assistant", text: "Checking", toolCalls: [{ toolName: "bash" }] }]).outcome).toBe("interrupted");
    expect(workerReport([{ role: "assistant", text: "Stopped", isError: true, raw: { stopReason: "aborted" } }]).outcome).toBe("interrupted");
    expect(workerReport([{ role: "assistant", text: "Bad credentials", isError: true }]).outcome).toBe("failed");
    expect(workerReport([{ role: "assistant", text: "All checks pass", entryId: "final-1" }])).toMatchObject({ outcome: "finished", entryId: "final-1" });
    expect(workerReport(null).outcome).toBe("report unavailable");
    expect(workerReport([]).outcome).toBe("interrupted");
  });

  it("ignores trailing metadata while retaining the terminal assistant's exact entry link", () => {
    const assistant = { role: "assistant", text: "Outcome: complete\n" + "details ".repeat(500) + "Verified: passes", entryId: "real-final" };
    const metadata = ["custom", "system", "compactionSummary"].map((role) => ({ role, text: "metadata", entryId: `${role}-entry` }));
    for (const trailing of [...metadata.map((entry) => [entry]), metadata]) {
      const summary = workerReport([assistant, ...trailing]);
      expect(summary).toMatchObject({ outcome: "finished", entryId: "real-final" });
      const output = formatWorkerReport(summary, "worker-123");
      expect(output).toContain("&entryId=real-final.");
      expect(output).not.toContain("&entryId=custom-entry");
    }
    for (const role of ["user", "toolResult", "bashExecution"]) {
      expect(workerReport([assistant, { role, text: "new activity" }, ...metadata])).toMatchObject({ outcome: "interrupted", text: "new activity" });
    }
  });

  it("prioritizes terminal assistant errors over partial tool calls, but preserves explicit aborts", () => {
    const message = {
      role: "assistant", text: "[API Error] stream ended unexpectedly", isError: true,
      raw: { stopReason: "error" },
      toolCalls: [{ id: "partial-call", toolName: "bash", args: {} }],
    };
    expect(workerReport([message])).toMatchObject({ outcome: "failed", isError: true });
    expect(workerReport([{ ...message, isError: false }])).toMatchObject({ outcome: "failed", isError: true });
    expect(workerReport([{ ...message, raw: {} }])).toMatchObject({ outcome: "failed", isError: true });
    expect(workerReport([{ ...message, raw: { stopReason: "aborted" } }])).toMatchObject({ outcome: "interrupted", isError: false });
    expect(workerReport([{ role: "toolResult", text: "command failed", isError: true }])).toMatchObject({ outcome: "interrupted", isError: false });
  });

  it("keeps labelled head and evidence tail inside 2000 chars with exact final-entry link", () => {
    const head = "Outcome: fixed\nChanged: src/a.ts\nVerified: tests pass\nBlocked: none\n";
    const text = head + "middle ".repeat(700) + "TAIL: concrete evidence";
    const report = workerReport([{ role: "assistant", text, entryId: "final-123" }]);
    const output = formatWorkerReport(report, "worker-123");
    expect(output.length).toBeLessThanOrEqual(2000);
    expect(output.startsWith(head)).toBe(true);
    expect(output).toContain("TAIL: concrete evidence");
    expect(output).toMatch(/Report truncated, full final message: \/\?sessionId=worker-123&entryId=final-123\.$/);
    expect(formatWorkerReport(workerReport([{ role: "assistant", text: head }]), "worker-123")).toBe(head.trim());
  });

});

describe("sessions_spawn tool surface", () => {
  it("requests explicit scoped cross-session access and disposes it at shutdown", async () => {
    const ctx = makeCtx();
    await activate(ctx);
    expect(ctx.ui.web.createApiClient).toHaveBeenCalledWith({
      name: "session-orchestrator", sessionIds: "all",
      scopes: ["sessions.read", "sessions.create", "sessions.write", "sessions.delete"],
    });
    const client = ctx.ui.web.createApiClient.mock.results[0].value;
    handlers.get("session_shutdown")?.({}, ctx);
    expect(client.dispose).toHaveBeenCalledOnce();
  });

  it("fails clearly on older hosts without falling back to browser tokens", async () => {
    const ctx: any = makeCtx();
    delete ctx.ui.web.createApiClient;
    const result = await spawn(ctx, { name: "worker", task: "read" });
    expect(resultText(result)).toContain("scoped extension HTTP API");
    expect(calls).toEqual([]);
  });

  it("registers worker-management tools, leaving sessions_read to core", async () => {
    await activate(makeCtx());
    expect([...tools.keys()].sort()).toEqual([
      "sessions_abort",
      "sessions_prompt",
      "sessions_spawn",
      "sessions_status",
    ]);
  });

  it("takes a category name rather than a model id", async () => {
    await activate(makeCtx());
    const properties = tools.get("sessions_spawn").parameters?.properties ?? {};
    expect(Object.keys(properties)).toContain("category");
    expect(Object.keys(properties)).not.toContain("model");
  });

  it("lists category names and prose in its description but never the model mapping", async () => {
    const ctx = makeCtx({ categories: [FAST, SMART], defaultCategory: "Fast" });
    await handlers.get("session_start")?.({}, ctx);

    const description = tools.get("sessions_spawn").description as string;
    expect(description).toContain("Fast");
    expect(description).toContain("Cheap scouting.");
    expect(description).toContain("Smart");
    // The category -> model mapping stays private to the config.
    expect(description).not.toContain("anthropic:fast-1");
    expect(description).not.toContain("smart-1");
  });

  it("describes the session default when nothing is configured", async () => {
    await handlers.get("session_start")?.({}, makeCtx());
    expect(tools.get("sessions_spawn").description as string).toMatch(/no categories/i);
  });

  it("keeps the complete tool definition stable when only a category model changes", async () => {
    await activate(makeCtx({ categories: [FAST, SMART], defaultCategory: "Fast" }));
    const before = serializedSpawnDefinition();

    await activate(makeCtx({
      categories: [{ ...FAST, model: "openai:private-replacement" }, SMART],
      defaultCategory: "Fast",
    }));

    expect(serializedSpawnDefinition()).toBe(before);
  });

  it("changes the complete tool definition when a category name changes", async () => {
    await activate(makeCtx({ categories: [FAST, SMART], defaultCategory: "Smart" }));
    const before = serializedSpawnDefinition();

    await activate(makeCtx({ categories: [{ ...FAST, name: "Quick" }, SMART], defaultCategory: "Smart" }));

    expect(serializedSpawnDefinition()).not.toBe(before);
  });

  it("changes the complete tool definition when category routing prose changes", async () => {
    await activate(makeCtx({ categories: [FAST, SMART], defaultCategory: "Fast" }));
    const before = serializedSpawnDefinition();

    await activate(makeCtx({
      categories: [{ ...FAST, description: "Use for fast, bounded repository searches." }, SMART],
      defaultCategory: "Fast",
    }));

    expect(serializedSpawnDefinition()).not.toBe(before);
  });

  it("changes the complete tool definition when the default category changes", async () => {
    await activate(makeCtx({ categories: [FAST, SMART], defaultCategory: "Fast" }));
    const before = serializedSpawnDefinition();

    await activate(makeCtx({ categories: [FAST, SMART], defaultCategory: "Smart" }));

    expect(serializedSpawnDefinition()).not.toBe(before);
  });

  it("re-registers a byte-identical tool definition for identical config", async () => {
    const config = { categories: [FAST, SMART], defaultCategory: "Fast" };
    await activate(makeCtx(config));
    const before = serializedSpawnDefinition();

    await activate(makeCtx(config));

    expect(serializedSpawnDefinition()).toBe(before);
  });
});

describe("sessions_spawn fail-closed resolution", () => {
  it("dispatches on an exact category match after setting the model", async () => {
    const ctx = makeCtx({ categories: [FAST, SMART], defaultCategory: "Fast" });
    const result = await spawn(ctx, { name: "scout", task: "look around", category: "Smart" });

    expect(result.isError).toBeFalsy();
    expect(pathsFor("POST")).toContain("/api/new-chat");
    const modelCall = calls.find((call) => call.path === "/api/model");
    expect(modelCall?.body).toMatchObject({ sessionId: "worker-1", provider: "anthropic", id: "smart-1" });
    // Task dispatched only after the model was pinned.
    expect(calls.findIndex((c) => c.path === "/api/model")).toBeLessThan(calls.findIndex((c) => c.path === "/api/prompt"));
    expect(pathsFor("POST")).not.toContain("/api/sessions/delete");
    expect(ctx.ui.web.reportSettlementDependencies).toHaveBeenLastCalledWith({ sessionIds: ["worker-1"] });
  });

  it("keeps the last declaration across shutdown for atomic reload or idle handoff", async () => {
    const ctx = makeCtx({ categories: [FAST], defaultCategory: "Fast" });
    await spawn(ctx, { name: "scout", task: "look around" });
    const callsBeforeShutdown = ctx.ui.web.reportSettlementDependencies.mock.calls.length;

    await handlers.get("session_shutdown")?.({}, ctx);

    expect(ctx.ui.web.reportSettlementDependencies).toHaveBeenLastCalledWith({ sessionIds: ["worker-1"] });
    expect(ctx.ui.web.reportSettlementDependencies).toHaveBeenCalledTimes(callsBeforeShutdown);
  });

  it("returns only the category name after a successful spawn and keeps the model mapping private", async () => {
    const ctx = makeCtx({ categories: [FAST, SMART], defaultCategory: "Fast" });
    const result = await spawn(ctx, { name: "builder", task: "implement it", category: "Smart" });

    const visibleResult = `${resultText(result)}\n${JSON.stringify(result.details)}`;
    expect(result.details.sessions).toEqual([{ sessionId: "worker-1", name: "builder" }]);
    expect(visibleResult).toContain("Smart");
    expect(visibleResult).not.toContain("anthropic");
    expect(visibleResult).not.toContain("smart-1");
  });

  it("does not expose an extension version marker in spawn result text or details", async () => {
    const ctx = makeCtx({ categories: [FAST], defaultCategory: "Fast" });
    const result = await spawn(ctx, { name: "scout", task: "look around" });

    expect(`${resultText(result)}\n${JSON.stringify(result.details)}`).not.toMatch(/\[ext\s/i);
  });

  it("reports status by category without exposing the concrete model id", async () => {
    const ctx = makeCtx({ categories: [FAST], defaultCategory: "Fast" });
    await spawn(ctx, { name: "scout", task: "look around", category: "Fast" });

    const result = await tools.get("sessions_status").execute("status-1", {});
    const visibleResult = `${resultText(result)}\n${JSON.stringify(result.details)}`;
    expect(visibleResult).toContain('category "Fast"');
    expect(visibleResult).not.toContain("anthropic");
    expect(visibleResult).not.toContain("fast-1");
  });

  it("uses the configured default when category is omitted", async () => {
    const ctx = makeCtx({ categories: [FAST, SMART], defaultCategory: "Smart" });
    const result = await spawn(ctx, { name: "scout", task: "look around" });

    expect(result.isError).toBeFalsy();
    expect(calls.find((call) => call.path === "/api/model")?.body).toMatchObject({ id: "smart-1" });
  });

  it("errors without creating a session when the category is unknown", async () => {
    const ctx = makeCtx({ categories: [FAST], defaultCategory: "Fast" });
    const result = await spawn(ctx, { name: "scout", task: "look around", category: "Ghost" });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("Fast"); // menu-on-miss
    expect(calls).toHaveLength(0); // nothing created, nothing dispatched
  });

  it("rejects an explicit category when the category config is empty", async () => {
    const ctx = makeCtx();
    const result = await spawn(ctx, { name: "scout", task: "look around", category: "Ghost" });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/none configured/i);
    expect(calls).toHaveLength(0);
  });

  it("rejects an explicit category when getSettings is unavailable", async () => {
    const ctx = makeCtx();
    delete (ctx.ui.web as any).getSettings;
    await activate(ctx);

    const result = await spawn(ctx, { name: "scout", task: "look around", category: "Ghost" });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/settings are unavailable/i);
    expect(calls).toHaveLength(0);
  });

  it("errors without creating a session when no default is configured", async () => {
    const ctx = makeCtx({ categories: [FAST] });
    const result = await spawn(ctx, { name: "scout", task: "look around" });

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("deletes the unprompted session and dispatches nothing when the model is unavailable", async () => {
    stubFetch({ models: [{ provider: "anthropic", id: "something-else" }] });
    const ctx = makeCtx({ categories: [FAST], defaultCategory: "Fast" });
    const result = await spawn(ctx, { name: "scout", task: "look around", category: "Fast" });

    expect(result.isError).toBe(true);
    expect(pathsFor("POST")).toContain("/api/new-chat");
    expect(calls.find((call) => call.path === "/api/sessions/delete")?.body).toMatchObject({ sessionId: "worker-1" });
    expect(pathsFor("POST")).not.toContain("/api/prompt"); // no LLM work happened
    expect(resultText(result)).toMatch(/deleted/i);
    const visibleResult = `${resultText(result)}\n${JSON.stringify(result.details)}`;
    expect(visibleResult).toContain("Fast");
    expect(visibleResult).not.toContain("anthropic");
    expect(visibleResult).not.toContain("fast-1");
    expect(visibleResult).not.toContain("something-else");
  });

  it("reports that a session may remain when cleanup after resolution failure also fails", async () => {
    stubFetch({ models: [], deleteFails: true });
    const ctx = makeCtx({ categories: [FAST], defaultCategory: "Fast" });
    const result = await spawn(ctx, { name: "scout", task: "look around", category: "Fast" });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/may remain/i);
    expect(resultText(result)).toMatch(/please remove it/i);
    expect(resultText(result)).not.toMatch(/no orphan/i);
    // Failed tools expose the cleanup warning through the thrown error text.
  });

  it("adds the parent's region prefix to an unprefixed configured model", async () => {
    stubFetch({ models: [{ provider: "amazon-bedrock", id: "us.anthropic.claude-x-v1:0" }], parentModelId: "us.anthropic.other-v1:0" });
    const category = { name: "Bedrock", model: "amazon-bedrock:anthropic.claude-x-v1:0", description: "Region-prefixed profile." };
    const ctx = makeCtx({ categories: [category], defaultCategory: "Bedrock", parentModelId: "us.anthropic.other-v1:0" });

    const result = await spawn(ctx, { name: "scout", task: "look around", category: "Bedrock" });

    expect(result.isError).toBeFalsy();
    expect(calls.find((call) => call.path === "/api/model")?.body).toMatchObject({ id: "us.anthropic.claude-x-v1:0" });
    expect(resultText(result)).toMatch(/substituted/i);
  });

  it("fails closed rather than replacing an explicit configured region", async () => {
    stubFetch({ models: [{ provider: "amazon-bedrock", id: "us.anthropic.claude-x-v1:0" }], parentModelId: "us.anthropic.other-v1:0" });
    const category = { name: "EU", model: "amazon-bedrock:eu.anthropic.claude-x-v1:0", description: "EU residency." };
    const ctx = makeCtx({ categories: [category], defaultCategory: "EU" });

    const result = await spawn(ctx, { name: "scout", task: "look around", category: "EU" });

    expect(result.isError).toBe(true);
    expect(pathsFor("POST")).not.toContain("/api/model");
    expect(pathsFor("POST")).not.toContain("/api/prompt");
    expect(pathsFor("POST")).toContain("/api/sessions/delete");
  });

  it("leaves the worker on the session default when no categories are configured", async () => {
    const ctx = makeCtx();
    const result = await spawn(ctx, { name: "scout", task: "look around" });

    expect(result.isError).toBeFalsy();
    expect(pathsFor("POST")).toContain("/api/new-chat");
    expect(pathsFor("POST")).not.toContain("/api/model"); // virtual default: never pins a model
    expect(pathsFor("POST")).toContain("/api/prompt");
  });

  it("records the parent as the spawned session's origin", async () => {
    const ctx = makeCtx({ categories: [FAST], defaultCategory: "Fast" });
    await spawn(ctx, { name: "scout", task: "look around" });

    expect(calls.find((call) => call.path === "/api/new-chat")?.body).toMatchObject({
      cwd: "/repo",
      origin: { sessionId: "parent-1", kind: "spawn" },
    });
  });

  it("passes an explicit cwd through to the worker", async () => {
    const ctx = makeCtx({ categories: [FAST], defaultCategory: "Fast" });
    await spawn(ctx, { name: "scout", task: "look around", cwd: "/other/tree" });

    expect(calls.find((call) => call.path === "/api/new-chat")?.body).toMatchObject({ cwd: "/other/tree" });
  });

  it("sends the worker a self-contained task carrying the worker marker", async () => {
    const ctx = makeCtx({ categories: [FAST], defaultCategory: "Fast" });
    await spawn(ctx, { name: "scout", task: "inspect the drawer", category: "Fast" });

    const prompt = String(calls.find((call) => call.path === "/api/prompt")?.body?.message || "");
    expect(prompt).toContain("[pi-web orchestrated worker]");
    expect(prompt).toContain("inspect the drawer");
    expect(prompt).toContain("parent-1");
  });

  it("refuses to spawn from a worker session (depth cap)", async () => {
    const ctx = makeCtx({ categories: [FAST], defaultCategory: "Fast", worker: true });
    const result = await spawn(ctx, { name: "sub", task: "nested work" });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/depth cap/i);
    expect(calls).toHaveLength(0);
  });

  it("surfaces a creation failure without dispatching work", async () => {
    stubFetch({ newChatFails: true });
    const ctx = makeCtx({ categories: [FAST], defaultCategory: "Fast" });
    const result = await spawn(ctx, { name: "scout", task: "look around" });

    expect(result.isError).toBe(true);
    expect(pathsFor("POST")).not.toContain("/api/prompt");
  });

  it("deletes the worker and leaves it untracked when task dispatch fails", async () => {
    stubFetch({ promptFails: true });
    const ctx = makeCtx({ categories: [FAST], defaultCategory: "Fast" });
    const result = await spawn(ctx, { name: "scout", task: "look around", category: "Fast" });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/failed to confirm task admission/i);
    expect(calls.filter((call) => call.path === "/api/prompt")).toHaveLength(1);
    expect(calls.find((call) => call.path === "/api/sessions/delete")?.body).toEqual({ sessionId: "worker-1" });
    const status = await tools.get("sessions_status").execute("status-1", {});
    expect(resultText(status)).toMatch(/no tracked workers/i);
  });

  it("caps the number of concurrently tracked workers", async () => {
    const ctx = makeCtx({ categories: [FAST], defaultCategory: "Fast" });
    for (let i = 0; i < 4; i += 1) {
      const result = await spawn(ctx, { name: `worker-${i}`, task: "work" });
      expect(result.isError).toBeFalsy();
    }
    const overflow = await spawn(ctx, { name: "worker-5", task: "work" });
    expect(overflow.isError).toBe(true);
    expect(resultText(overflow)).toMatch(/cap/i);
  });

  it("reserves spawn slots before awaits so concurrent calls cannot exceed the cap", async () => {
    const ctx = makeCtx({ categories: [FAST], defaultCategory: "Fast" });
    await activate(ctx);
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) =>
      spawn(ctx, { name: `worker-${index}`, task: "work" }),
    ));

    expect(results.filter((result) => !result.isError)).toHaveLength(4);
    expect(results.filter((result) => result.isError)).toHaveLength(2);
    expect(calls.filter((call) => call.path === "/api/new-chat")).toHaveLength(4);
  });

  it("does not charge sessions_prompt watches against the spawn cap", async () => {
    const ctx = makeCtx({ categories: [FAST], defaultCategory: "Fast" });
    await activate(ctx);
    for (let i = 0; i < 4; i += 1) {
      await tools.get("sessions_prompt").execute("prompt", { id: `existing-${i}`, message: "continue" });
    }

    const result = await spawn(ctx, { name: "new worker", task: "work" });

    expect(result.isError).toBeFalsy();
    expect(pathsFor("POST")).toContain("/api/new-chat");
  });
});

function finalReply(id = "worker-1", text = "Verified: all checks pass") {
  workerMessages.get(id)!.push({ role: "assistant", text, entryId: `final-${workerMessages.get(id)!.length}` });
}
function journal() { const path = join(stateDir, "parent-1.json"); return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { version: 1, watches: [], pending: [] }; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
async function restart(ctx: any) {
  handlers.get("session_shutdown")?.({}, ctx);
  const pi = makeExtension();
  await activate(ctx);
  await vi.advanceTimersByTimeAsync(0);
  return pi;
}

describe("issue 190 durable delivery", () => {
  beforeEach(() => vi.useFakeTimers());

  it("does not acknowledge VOID SDK sends; closes only on saved host receipt", async () => {
    const pi = makeExtension();
    const ctx = makeCtx();
    await spawn(ctx, { name: "work", task: "task" });
    finalReply();
    completionPending = true;
    await vi.advanceTimersByTimeAsync(7500);
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(journal().pending).toHaveLength(1);
    expect(journal().watches).toHaveLength(1);
    const first = journal().pending[0];
    await vi.advanceTimersByTimeAsync(2500);
    const submissions = calls.filter((c) => c.path === "/api/session/completion");
    expect(submissions).toHaveLength(2);
    expect(submissions[0].body).toEqual(submissions[1].body);
    expect(saved.size).toBe(0);
    completionPending = false;
    await vi.advanceTimersByTimeAsync(2500);
    expect([...saved.keys()]).toEqual([first.deliveryId]);
    expect(journal().watches).toHaveLength(0);
    expect(journal().pending).toHaveLength(0);
  });

  it("recovers busy-parent pending delivery across restart before any parent assistant", async () => {
    const ctx = makeCtx();
    await spawn(ctx, { name: "work", task: "task" });
    finalReply(); completionPending = true;
    await vi.advanceTimersByTimeAsync(7500);
    const before = journal().pending[0];
    expect(branch.some((e) => e.message?.role === "assistant")).toBe(false);
    const pi = await restart(ctx);
    expect(journal().pending[0]).toEqual(before);
    completionPending = false;
    await vi.advanceTimersByTimeAsync(2500);
    expect(saved.size).toBe(1);
    expect(saved.has(before.deliveryId)).toBe(true);
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("shares reload and timer completion claims", async () => {
    const ctx = makeCtx();
    await spawn(ctx, { name: "work", task: "task" }); finalReply();
    await restart(ctx);
    const held = deferred<any>();
    const fetch = globalThis.fetch;
    let heldOnce = false;
    globalThis.fetch = (async (url: any, init: any) => {
      if (transcriptRoute(url) && !heldOnce) { heldOnce = true; return held.promise; }
      return fetch(url, init);
    }) as any;
    await vi.advanceTimersByTimeAsync(2500);
    await vi.advanceTimersByTimeAsync(10000);
    expect(saved.size).toBe(0);
    held.resolve({ ok: true, json: async () => ({ messages: workerMessages.get("worker-1") }) });
    await vi.advanceTimersByTimeAsync(7500);
    expect(saved.size).toBe(1);
  });

  it("renews generation while an older transcript fetch is inflight", async () => {
    const ctx = makeCtx();
    await spawn(ctx, { name: "work", task: "task" }); finalReply("worker-1", "OLD RESULT");
    await vi.advanceTimersByTimeAsync(5000);
    const oldId = journal().watches[0].watchId;
    const oldMessages = workerMessages.get("worker-1");
    const held = deferred<any>(); const fetch = globalThis.fetch;
    let hold = true;
    globalThis.fetch = (async (url: any, init: any) => transcriptRoute(url) && hold ? held.promise : fetch(url, init)) as any;
    await vi.advanceTimersByTimeAsync(2500);
    await tools.get("sessions_prompt").execute("follow", { id: "worker-1", message: "new task" });
    const newId = journal().watches[0].watchId;
    expect(newId).not.toBe(oldId);
    hold = false;
    held.resolve({ ok: true, json: async () => ({ messages: oldMessages }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(saved.size).toBe(0);
    expect(journal().watches[0].watchId).toBe(newId);
    finalReply("worker-1", "NEW RESULT");
    await vi.advanceTimersByTimeAsync(7500);
    expect([...saved.values()][0].message.content).toContain("NEW RESULT");
    expect([...saved.values()][0].message.content).not.toContain("OLD RESULT");
  });

  it("keeps a new watch when an old frozen completion is saved after reprompt", async () => {
    const ctx = makeCtx();
    await spawn(ctx, { name: "work", task: "task" }); finalReply(); completionPending = true;
    await vi.advanceTimersByTimeAsync(7500);
    const old = journal().pending[0];
    await tools.get("sessions_prompt").execute("follow", { id: "worker-1", message: "new task" });
    const renewed = journal().watches[0].watchId;
    await restart(ctx);
    expect(journal().pending[0]).toEqual(old);
    completionPending = false;
    await vi.advanceTimersByTimeAsync(2500);
    expect(journal().watches[0].watchId).toBe(renewed);
  });

  it("rejects admission without replacing an existing task watch", async () => {
    const ctx = makeCtx(); await spawn(ctx, { name: "work", task: "task" });
    const old = journal().watches[0];
    stubFetch({ promptFails: true });
    await expect(tools.get("sessions_prompt").execute("follow", { id: "worker-1", message: "rejected" })).rejects.toThrow(/prompt failed/);
    expect(journal().watches[0]).toEqual(old);
    expect(journal().pending).toHaveLength(0);
  });

  it("waits for a slow abort before redirecting, not a 500ms sleep", async () => {
    const ctx = makeCtx(); await activate(ctx);
    const held = deferred<any>(); const fetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => String(url) === "/api/abort" ? held.promise : fetch(url, init)) as any;
    const redirect = tools.get("sessions_prompt").execute("redirect", { id: "worker-1", message: "correct", interrupt: true });
    await vi.advanceTimersByTimeAsync(10000);
    expect(calls.some((c) => c.path === "/api/prompt")).toBe(false);
    held.resolve({ ok: true, json: async () => ({ ok: true, idle: true }) });
    await redirect;
    expect(calls.find((c) => c.path === "/api/prompt")?.body.waitFor).toBe("admission");
  });

  it("never treats a queued task's previous reply as the new result", async () => {
    const ctx = makeCtx(); await activate(ctx);
    const fetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      const response = await fetch(url, init);
      if (String(url) === "/api/prompt") workerMessages.set("worker-1", [{ role: "assistant", text: "OLD RESULT", entryId: "old" }]);
      return response;
    }) as any;
    await tools.get("sessions_prompt").execute("follow", { id: "worker-1", message: "queued task" });
    await vi.advanceTimersByTimeAsync(20000);
    expect(saved.size).toBe(0);
    const dispatchId = journal().watches[0].dispatchId;
    workerMessages.get("worker-1")!.push({ role: "user", text: `[pi-web-dispatch:${dispatchId}]`, entryId: "actual-task" });
    finalReply("worker-1", "NEW RESULT");
    await vi.advanceTimersByTimeAsync(7500);
    expect([...saved.values()][0].message.content).toContain("NEW RESULT");
  });

  it("requires stable idle transcript, including after reload", async () => {
    const ctx = makeCtx(); await spawn(ctx, { name: "work", task: "task" });
    for (let i = 0; i < 5; i++) { finalReply("worker-1", `progress ${i}`); await vi.advanceTimersByTimeAsync(2500); }
    expect(saved.size).toBe(0);
    await restart(ctx);
    expect(saved.size).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(saved.size).toBe(1);
  });

  it("fails closed before task dispatch when its durable intent cannot be written", async () => {
    const ctx = makeCtx(); await activate(ctx);
    const invalid = join(stateDir, "not-a-directory"); writeFileSync(invalid, "file");
    vi.stubEnv("PI_WEB_ORCHESTRATOR_STATE_DIR", invalid);
    const result = await spawn(ctx, { name: "unpersistable", task: "task" });
    expect(resultText(result)).toContain("no task was sent");
    expect(calls.some((c) => c.path === "/api/prompt")).toBe(false);
    expect(calls.some((c) => c.path === "/api/sessions/delete")).toBe(true);
  });

  it("restores the old watch if follow-up intent persistence fails before send", async () => {
    const ctx = makeCtx(); await spawn(ctx, { name: "work", task: "task" });
    const old = journal().watches[0];
    const invalid = join(stateDir, "not-a-directory"); writeFileSync(invalid, "file");
    vi.stubEnv("PI_WEB_ORCHESTRATOR_STATE_DIR", invalid);
    const prompts = calls.filter((c) => c.path === "/api/prompt").length;
    await expect(tools.get("sessions_prompt").execute("follow", { id: "worker-1", message: "not sent" })).rejects.toThrow();
    vi.stubEnv("PI_WEB_ORCHESTRATOR_STATE_DIR", stateDir);
    expect(journal().watches[0]).toEqual(old);
    expect(calls.filter((c) => c.path === "/api/prompt")).toHaveLength(prompts);
  });

  it("fails closed on journal write failure before completion submission", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = makeCtx(); await spawn(ctx, { name: "work", task: "task" }); finalReply();
    const invalid = join(stateDir, "not-a-directory"); writeFileSync(invalid, "file");
    vi.stubEnv("PI_WEB_ORCHESTRATOR_STATE_DIR", invalid);
    await vi.advanceTimersByTimeAsync(7500);
    expect(saved.size).toBe(0);
    expect(calls.some((c) => c.path === "/api/session/completion")).toBe(false);
    expect(readdirSync(stateDir).some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it.each(["spawn", "prompt"])("journals %s intent before ambiguous admission and recovers its marker after reload", async (kind) => {
    const ctx = makeCtx(); await activate(ctx);
    const held = deferred<any>(); const fetch = globalThis.fetch;
    let dispatched: any;
    globalThis.fetch = (async (url: any, init: any) => {
      if (String(url) === "/api/prompt") {
        dispatched = JSON.parse(init.body);
        workerMessages.set(dispatched.sessionId, [{ role: "user", text: `[pi-web-dispatch:${dispatched.dispatchId}]`, entryId: "actual-prompt" }, { role: "assistant", text: "NEW RESULT", entryId: "actual-final" }]);
        return held.promise;
      }
      return fetch(url, init);
    }) as any;
    const operation = kind === "spawn" ? spawn(ctx, { name: "ambiguous", task: "task" }) : tools.get("sessions_prompt").execute("follow", { id: "worker-1", message: "task" });
    const settled = Promise.resolve(operation).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(journal().watches[0]).toMatchObject({ dispatchId: dispatched.dispatchId, admissionPending: true });
    await restart(ctx);
    held.resolve({ ok: true, json: async () => ({ admission: "accepted" }) });
    await settled;
    await vi.advanceTimersByTimeAsync(5000);
    expect(saved.size).toBe(1);
    expect([...saved.values()][0].message.content).toContain("NEW RESULT");
  });

  it.each([408, 500, 502, 503, 504])("preserves ambiguous HTTP %s admission without cleanup or retransmission", async (status) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch({ promptFails: true, promptFailureStatus: status });
    const ctx = makeCtx();
    const result = await spawn(ctx, { name: "ambiguous", task: "task" });
    expect(resultText(result)).toContain("ambiguous");
    const intent = journal().watches[0];
    expect(intent.admissionPending).toBe(true);
    expect(calls.some((c) => c.path === "/api/sessions/delete")).toBe(false);
    await restart(ctx);
    await vi.advanceTimersByTimeAsync(10000);
    expect(journal().watches[0].watchId).toBe(intent.watchId);
    expect(calls.some((c) => c.path === "/api/prompt")).toBe(false);
    expect(saved.size).toBe(0);
  });

  it("retains ambiguous admission on timeout without resending or deleting the worker", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = makeCtx(); await activate(ctx);
    const fetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => { if (String(url) === "/api/prompt") throw new Error("admission timeout"); return fetch(url, init); }) as any;
    const result = await spawn(ctx, { name: "ambiguous", task: "task" });
    expect(resultText(result)).toContain("ambiguous");
    expect(journal().watches[0].admissionPending).toBe(true);
    expect(calls.some((c) => c.path === "/api/sessions/delete")).toBe(false);
    await restart(ctx);
    await vi.advanceTimersByTimeAsync(15000);
    expect(saved.size).toBe(0);
    expect(journal().watches).toHaveLength(1);
  });

  it("serializes abort with follow-up and fences a stale abort across reload", async () => {
    const ctx = makeCtx(); await spawn(ctx, { name: "work", task: "task" });
    const held = deferred<any>(); const fetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => String(url) === "/api/abort" ? held.promise : fetch(url, init)) as any;
    const abort = tools.get("sessions_abort").execute("abort", { id: "worker-1" });
    const rejected = expect(abort).rejects.toThrow(/replaced/);
    await vi.advanceTimersByTimeAsync(0);
    await restart(ctx);
    await tools.get("sessions_prompt").execute("follow", { id: "worker-1", message: "new assignment" });
    const renewed = journal();
    held.resolve({ ok: true, json: async () => ({ idle: true }) });
    await rejected;
    expect(journal()).toEqual(renewed);
  });

  it("queues follow-up behind slow abort in the same runtime", async () => {
    const ctx = makeCtx(); await spawn(ctx, { name: "work", task: "task" });
    const held = deferred<any>(); const fetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => String(url) === "/api/abort" ? held.promise : fetch(url, init)) as any;
    const before = calls.filter((c) => c.path === "/api/prompt").length;
    const abort = tools.get("sessions_abort").execute("abort", { id: "worker-1" });
    const follow = tools.get("sessions_prompt").execute("follow", { id: "worker-1", message: "new assignment" });
    await vi.advanceTimersByTimeAsync(10000);
    expect(calls.filter((c) => c.path === "/api/prompt")).toHaveLength(before);
    held.resolve({ ok: true, json: async () => ({ idle: true }) });
    await Promise.all([abort, follow]);
    expect(journal().watches).toHaveLength(1);
  });

  it.each(["/my-ext-command foo", "/template args", "/template\targs", "/skill:foo"])("rejects registered slash input %j before interrupt or intent", async (message) => {
    const ctx = makeCtx(); await spawn(ctx, { name: "existing", task: "old task" });
    const before = readFileSync(join(stateDir, "parent-1.json"), "utf8");
    calls.length = 0;
    await expect(tools.get("sessions_prompt").execute("command", { id: "worker-1", message, interrupt: true })).rejects.toThrow(/slash.*unsupported/i);
    expect(calls).toEqual([{ method: "POST", path: "/api/prompt/validate", body: { sessionId: "worker-1", message, dispatchId: expect.any(String) } }]);
    expect(readFileSync(join(stateDir, "parent-1.json"), "utf8")).toBe(before);
  });

  it.each(["plain text", "/src/foo.ts fails, fix it", "/unknown literal task", "/skill:unknown literal task", "/help explain this", "  /template literal text", "/my-ext-command\targs", "/skill:foo\targs"])("dispatches slash literal %j unchanged with server-side watermark", async (message) => {
    const ctx = makeCtx(); await spawn(ctx, { name: "existing", task: "old task" });
    calls.length = 0;
    await tools.get("sessions_prompt").execute("literal", { id: "worker-1", message, interrupt: true });
    expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /api/prompt/validate", "POST /api/abort", "POST /api/prompt",
    ]);
    const body = calls[2].body;
    expect(body).toMatchObject({ sessionId: "worker-1", message, mode: "steer", waitFor: "admission" });
    expect(body.dispatchId).toBe(calls[0].body.dispatchId);
    expect(body.dispatchId).toBe(journal().watches[0].dispatchId);
    expect(workerMessages.get("worker-1")![0].text).toBe(`${message}\\n\\n[pi-web-dispatch:${body.dispatchId}]`);
    expect(journal().watches[0].admissionPending).toBe(false);
  });

  it.each(["http", "network", "malformed", "not-valid"])("preserves prior watch when core validation fails: %s", async (failure) => {
    const ctx = makeCtx(); await spawn(ctx, { name: "existing", task: "old task" });
    const before = readFileSync(join(stateDir, "parent-1.json"), "utf8");
    const beforeBranch = JSON.stringify(branch);
    const fetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      if (String(url) !== "/api/prompt/validate") return fetch(url, init);
      calls.push({ method: init.method, path: String(url) });
      if (failure === "network") throw new Error("network unavailable");
      return { ok: failure !== "http", status: failure === "http" ? 503 : 200, json: async () => failure === "malformed" ? {} : { ok: true, valid: false } };
    }) as any;
    calls.length = 0;
    await expect(tools.get("sessions_prompt").execute("literal", { id: "worker-1", message: "plain text still requires core validation", interrupt: true })).rejects.toThrow();
    expect(calls).toEqual([{ method: "POST", path: "/api/prompt/validate" }]);
    expect(readFileSync(join(stateDir, "parent-1.json"), "utf8")).toBe(before);
    expect(JSON.stringify(branch)).toBe(beforeBranch);
  });

  it.each([true, false])("treats core validation as authoritative, regardless of message syntax (valid=%s)", async (valid) => {
    const ctx = makeCtx(); await spawn(ctx, { name: "existing", task: "old task" });
    const before = readFileSync(join(stateDir, "parent-1.json"), "utf8");
    const fetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      if (String(url) !== "/api/prompt/validate") return fetch(url, init);
      calls.push({ method: init.method, path: String(url), body: JSON.parse(init.body) });
      return { ok: valid, status: valid ? 200 : 400, json: async () => valid ? { ok: true, valid: true } : { ok: false, error: "core rejected text" } };
    }) as any;
    calls.length = 0;
    const message = valid ? "/my-ext-command foo" : "ordinary text";
    const result = tools.get("sessions_prompt").execute("core-authority", { id: "worker-1", message, interrupt: true });
    if (valid) {
      await result;
      expect(calls.map(call => call.path)).toEqual(["/api/prompt/validate", "/api/abort", "/api/prompt"]);
      expect(calls[2].body).toMatchObject({ message, dispatchId: calls[0].body.dispatchId });
    } else {
      await expect(result).rejects.toThrow(/core rejected text/);
      expect(calls.map(call => call.path)).toEqual(["/api/prompt/validate"]);
      expect(readFileSync(join(stateDir, "parent-1.json"), "utf8")).toBe(before);
    }
  });

  it("cannot dispatch a stale successful validation after runtime replacement", async () => {
    const ctx = makeCtx(); await spawn(ctx, { name: "existing", task: "old task" });
    const held = deferred<any>(); const fetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => String(url) === "/api/prompt/validate" ? held.promise : fetch(url, init)) as any;
    calls.length = 0;
    const pending = tools.get("sessions_prompt").execute("stale-validation", { id: "worker-1", message: "new task", interrupt: true });
    const rejected = expect(pending).rejects.toThrow(/replaced/);
    await vi.advanceTimersByTimeAsync(0);
    await restart(ctx);
    const before = readFileSync(join(stateDir, "parent-1.json"), "utf8");
    calls.length = 0;
    held.resolve({ ok: true, json: async () => ({ ok: true, valid: true }) });
    await rejected;
    expect(calls).toEqual([]);
    expect(readFileSync(join(stateDir, "parent-1.json"), "utf8")).toBe(before);
  });

  it("restores the old watch on definitive send rejection after successful validation", async () => {
    const ctx = makeCtx(); await spawn(ctx, { name: "existing", task: "old task" });
    const before = readFileSync(join(stateDir, "parent-1.json"), "utf8");
    stubFetch({ promptFails: true, promptFailureStatus: 400 }); calls.length = 0;
    await expect(tools.get("sessions_prompt").execute("stale", { id: "worker-1", message: "/new-command args" })).rejects.toThrow(/400/);
    expect(calls.map((call) => call.path)).toEqual(["/api/prompt/validate", "/api/prompt"]);
    expect(readFileSync(join(stateDir, "parent-1.json"), "utf8")).toBe(before);
  });

  it("delivers an immutable pending batch on the active branch after navigation", async () => {
    const ctx = makeCtx(); await spawn(ctx, { name: "work", task: "task" }); finalReply(); completionPending = true;
    await vi.advanceTimersByTimeAsync(7500);
    const original = journal().pending[0];
    branch = [];
    completionPending = false;
    await vi.advanceTimersByTimeAsync(2500);
    expect(saved.size).toBe(1);
    expect([...saved.values()][0]).toEqual({ sessionId: "parent-1", deliveryId: original.deliveryId, message: original.message });
    expect(journal().pending).toHaveLength(0);
    expect(branch.some((entry: any) => entry.customType === "orchestrator-dispatch-anchor")).toBe(false);
  });

  it("recovers pending obligations on another branch without returning to the original", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = makeCtx(); await spawn(ctx, { name: "work", task: "task" }); finalReply(); completionPending = true;
    await vi.advanceTimersByTimeAsync(7500);
    branch = []; await restart(ctx);
    completionPending = false;
    await vi.advanceTimersByTimeAsync(2500);
    expect(saved.size).toBe(1);
    expect(journal().watches).toHaveLength(0);
    expect(journal().pending).toHaveLength(0);
  });

  it("retains pending recovery records across navigation without quarantine warnings", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = makeCtx(); await spawn(ctx, { name: "work", task: "task" }); finalReply(); completionPending = true;
    await vi.advanceTimersByTimeAsync(7500);
    const original = journal();
    branch = []; // SessionManager never flushed this exceptional manually invoked parent.
    await restart(ctx);
    expect(journal().watches.map((w: any) => w.watchId)).toEqual(original.watches.map((w: any) => w.watchId));
    expect(journal().pending).toEqual(original.pending);
    const status = await tools.get("sessions_status").execute("status", {});
    expect(resultText(status)).not.toMatch(/Recovery warning|quarantined/);
    completionPending = false;
    await vi.advanceTimersByTimeAsync(10000);
    expect(saved.size).toBe(1);
  });

  it("reports legacy task attribution as unavailable rather than using old prose", async () => {
    const ctx = makeCtx();
    branch.push({ type: "custom", id: "legacy", customType: "orchestrator-watch", data: { childId: "legacy-worker", name: "legacy", spawned: false } });
    workerMessages.set("legacy-worker", [{ role: "assistant", text: "OLD RESULT" }]);
    await activate(ctx);
    await vi.advanceTimersByTimeAsync(5000);
    const report = [...saved.values()][0].message.content;
    expect(report).toContain("Task attribution unavailable");
    expect(report).not.toContain("OLD RESULT");
    expect(report).not.toContain("finished");
    expect(journal().watches).toHaveLength(0);
    expect(ctx.ui.web.reportSettlementDependencies).toHaveBeenLastCalledWith({ sessionIds: [] });
  });

  it("bounds stable idle missing-marker attribution rather than waiting silently forever", async () => {
    const ctx = makeCtx(); await spawn(ctx, { name: "work", task: "task" });
    workerMessages.set("worker-1", [{ role: "assistant", text: "unattributed terminal", entryId: "old" }]);
    await vi.advanceTimersByTimeAsync(20000);
    expect(saved.size).toBe(0);
    expect(journal().watches).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10000);
    expect(saved.size).toBe(1);
    const report = [...saved.values()][0].message.content;
    expect(report).toContain("Task attribution unavailable");
    expect(report).not.toContain("unattributed terminal");
    expect(journal().watches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10000);
    expect(saved.size).toBe(1);
  });

  it("reads the legitimate final from attribution history after context compaction", async () => {
    const ctx = makeCtx(); await spawn(ctx, { name: "long worker", task: "long task" });
    finalReply("worker-1", "LEGITIMATE COMPACTED TASK RESULT");
    historyMessages.set("worker-1", [...workerMessages.get("worker-1")!]);
    workerMessages.set("worker-1", [{ role: "compactionSummary", text: "marker omitted" }, { role: "assistant", text: "unrelated projected reply" }]);
    await vi.advanceTimersByTimeAsync(7500);
    expect(saved.size).toBe(1);
    expect([...saved.values()][0].message.content).toContain("LEGITIMATE COMPACTED TASK RESULT");
    expect([...saved.values()][0].message.content).not.toContain("unrelated projected reply");
    expect(calls.some((c) => c.path.startsWith("/api/session/history?") && c.path.includes("dispatchId="))).toBe(true);
  });

  it("keeps healthy status output and retains immutable pending ownership on re-dispatch", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = makeCtx(); await spawn(ctx, { name: "old", task: "task" }); finalReply(); completionPending = true;
    await vi.advanceTimersByTimeAsync(7500);
    branch = []; await restart(ctx);
    const status = resultText(await tools.get("sessions_status").execute("status", { ids: ["healthy-worker"] }));
    expect(status).toContain("healthy-worker");
    expect(status).not.toContain("Recovery warning");
    await tools.get("sessions_prompt").execute("follow", { id: "worker-1", message: "replacement" });
    expect(journal().watches).toHaveLength(1); // Only the current assignment is watched.
    expect(journal().pending).toHaveLength(1); // Its predecessor is owned independently by this immutable batch.
    const updated = resultText(await tools.get("sessions_status").execute("status", { ids: ["healthy-worker"] }));
    expect(updated).toContain("healthy-worker");
    expect(updated).not.toContain("Recovery warning");
  });

  it("does not prepare a fresh sibling batch while a pending batch still owns its generation", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = makeCtx();
    await spawn(ctx, { name: "B", task: "task B" }); finalReply("worker-1", "B RESULT");
    const branchWithB = [...branch];
    await spawn(ctx, { name: "A", task: "task A" }); finalReply("worker-2", "A RESULT");
    completionPending = true;
    await vi.advanceTimersByTimeAsync(7500);
    const owned = journal().pending[0];
    branch = branchWithB;
    await restart(ctx);
    await vi.advanceTimersByTimeAsync(20000);
    expect(saved.size).toBe(0);
    expect(journal().pending).toHaveLength(1);
    expect(journal().pending[0]).toEqual(owned);
    expect(journal().watches.some((w: any) => w.id === "worker-1")).toBe(true);
    completionPending = false;
    await vi.advanceTimersByTimeAsync(2500);
    expect(saved.size).toBe(1);
    expect([...saved.values()][0].deliveryId).toBe(owned.deliveryId);
  });

  it("retains a pending batch across sibling re-dispatch and journal replay without duplicate reports", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = makeCtx();
    await spawn(ctx, { name: "A", task: "task A" }); finalReply("worker-1", "A RESULT");
    await spawn(ctx, { name: "B", task: "task B" }); finalReply("worker-2", "B RESULT");
    const hostOwned = new Map<string, any>();
    const fetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      if (String(url) === "/api/session/completion") {
        const input = JSON.parse(init.body);
        const previous = hostOwned.get(input.deliveryId);
        if (previous) expect(input).toEqual(previous);
        hostOwned.set(input.deliveryId, input);
      }
      return fetch(url, init);
    }) as any;
    completionPending = true;
    await vi.advanceTimersByTimeAsync(7500);
    const originalDelivery = journal().pending[0];
    expect(originalDelivery.members).toHaveLength(2);
    expect(hostOwned.size).toBe(1);
    branch = []; await restart(ctx);
    await tools.get("sessions_prompt").execute("replace A", { id: "worker-1", message: "new A assignment" });
    expect(journal().pending[0]).toEqual(originalDelivery);
    // New A is still awaiting SDK continuation and cannot produce a completion.
    workerMessages.get("worker-1")!.push({ role: "assistant", text: "continuing", raw: { stopReason: "deferred" } });
    // Restart reconciles by replaying the extension journal, not a host disk store.
    completionPending = false;
    await restart(ctx);
    await vi.advanceTimersByTimeAsync(15000);
    expect(hostOwned.size).toBe(1);
    expect(saved.size).toBe(1);
    expect([...saved.values()][0].message.content).toContain("B RESULT");
    expect(journal().pending).toHaveLength(0);
    expect(journal().watches.some((w: any) => w.id === "worker-2")).toBe(false);
    // New A's watch is not resolved by the old batch's saved receipt.
    expect(journal().watches.some((w: any) => w.id === "worker-1" && w.watchId !== originalDelivery.members[0].watchId)).toBe(true);
  });

  it("does not create empty journals on ordinary session startup and removes resolved journals", async () => {
    const ctx = makeCtx(); await activate(ctx); await vi.advanceTimersByTimeAsync(0);
    expect(readdirSync(stateDir)).toEqual([]);
    await spawn(ctx, { name: "work", task: "task" });
    expect(existsSync(join(stateDir, "parent-1.json"))).toBe(true);
    finalReply(); await vi.advanceTimersByTimeAsync(7500);
    expect(existsSync(join(stateDir, "parent-1.json"))).toBe(false);
  });

  it("migrates legacy watch anchors without creating new anchors or sending them to the host", async () => {
    const dispatchId = "00000000-0000-4000-8000-000000000001";
    writeFileSync(join(stateDir, "parent-1.json"), JSON.stringify({ version: 1, watches: [{ id: "worker-1", name: "restored", watchId: "restored-watch", dispatchId, anchor: null, idlePolls: 0, errorPolls: 0, transcriptFailures: 0 }], pending: [] }));
    workerMessages.set("worker-1", [{ role: "user", text: `[pi-web-dispatch:${dispatchId}]` }, { role: "assistant", text: "restored result" }]);
    await activate(makeCtx()); await vi.advanceTimersByTimeAsync(5000);
    const submission = calls.find((c) => c.path === "/api/session/completion")!;
    expect(submission.body).not.toHaveProperty("branchAnchorEntryId");
    expect(branch.some((entry: any) => entry.customType === "orchestrator-dispatch-anchor")).toBe(false);
    expect(saved.size).toBe(1);
  });

  it("migrates legacy duplicate watches while preserving old batch ownership and payload", async () => {
    const old = { id: "worker-1", name: "old", categoryName: "Default", watchId: "old-watch", anchor: "abandoned", idlePolls: 0, errorPolls: 0, transcriptFailures: 0 };
    const newer = { ...old, name: "new", watchId: "new-watch", anchor: "also-abandoned" };
    const message = { customType: "worker-wakeup", content: "Frozen A+B result", display: true, details: { deliveryId: "legacy-batch" } };
    writeFileSync(join(stateDir, "parent-1.json"), JSON.stringify({ version: 1, watches: [old, { ...old, id: "worker-2", watchId: "sibling-watch" }, newer], pending: [{ deliveryId: "legacy-batch", branchAnchorEntryId: "abandoned", members: [{ id: "worker-1", watchId: "old-watch", anchor: "abandoned", resolves: true }, { id: "worker-2", watchId: "sibling-watch", anchor: "abandoned", resolves: true }], message }] }));
    completionPending = true;
    const ctx = makeCtx(); await activate(ctx); await vi.advanceTimersByTimeAsync(0);
    expect(journal().watches.find((w: any) => w.id === "worker-1").watchId).toBe("new-watch");
    expect(journal().watches.every((w: any) => !("anchor" in w))).toBe(true);
    const batch = journal().pending[0];
    expect(batch).not.toHaveProperty("branchAnchorEntryId");
    expect(batch.members.every((m: any) => !("anchor" in m))).toBe(true);
    expect(batch.message).toEqual(message);
    completionPending = false;
    await vi.advanceTimersByTimeAsync(2500);
    expect(saved.get("legacy-batch")).toEqual({ sessionId: "parent-1", deliveryId: "legacy-batch", message });
    expect(journal().watches.map((w: any) => w.watchId)).toEqual(["new-watch"]);
    expect(journal().pending).toHaveLength(0);
  });

  it("wraps slash-prefixed spawn task text as literal worker instructions", async () => {
    const task = '/template   "args"\nkeep literal spacing';
    const result = await spawn(makeCtx(), { name: "literal", task });
    expect(result.isError).toBeFalsy();
    const message = calls.find((c) => c.path === "/api/prompt")!.body.message;
    expect(message).toMatch(/^\[pi-web orchestrated worker\]/);
    expect(message).toContain(task);
    expect(calls.some((call) => call.path.startsWith("/api/commands"))).toBe(false);
    expect(branch.some((entry: any) => entry.customType === "orchestrator-dispatch-anchor")).toBe(false);
  });

  it("does not mutate a newer runtime's journal after old prompt admission returns", async () => {
    const ctx = makeCtx(); await spawn(ctx, { name: "work", task: "task" });
    const held = deferred<any>(); const fetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => String(url) === "/api/prompt" ? held.promise : fetch(url, init)) as any;
    const oldOperation = tools.get("sessions_prompt").execute("follow", { id: "worker-1", message: "late" });
    const rejected = expect(oldOperation).rejects.toThrow(/replaced/);
    await vi.advanceTimersByTimeAsync(0);
    await restart(ctx);
    const restored = journal();
    held.resolve({ ok: true, json: async () => ({ admission: "accepted" }) });
    await rejected;
    expect(journal()).toEqual(restored);
  });

  it("retries timed-out completion with the identical delivery ID and payload", async () => {
    const ctx = makeCtx(); await spawn(ctx, { name: "work", task: "task" }); finalReply();
    const fetch = globalThis.fetch;
    let first: any;
    globalThis.fetch = (async (url: any, init: any) => {
      if (String(url) === "/api/session/completion" && !first) { first = JSON.parse(init.body); throw new Error("20s timeout"); }
      return fetch(url, init);
    }) as any;
    vi.spyOn(console, "error").mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(7500);
    expect(journal().pending[0].deliveryId).toBe(first.deliveryId);
    await vi.advanceTimersByTimeAsync(2500);
    expect([...saved.values()][0]).toEqual(first);
  });

  it("retains report-unavailable watches and releases only after bounded saved notice", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = makeCtx(); await spawn(ctx, { name: "work", task: "task" });
    const fetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => { if (transcriptRoute(url)) throw new Error("unreadable"); return fetch(url, init); }) as any;
    await vi.advanceTimersByTimeAsync(2500);
    expect(saved.size).toBe(1);
    expect(journal().watches).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(47500);
    expect(saved.size).toBe(2);
    expect(journal().watches).toHaveLength(0);
  });

  it("bounds simultaneous reports and defers the fourth worker", async () => {
    const ctx = makeCtx();
    for (let i = 0; i < 4; i++) { await spawn(ctx, { name: `worker ${i}`, task: "task" }); finalReply(`worker-${i + 1}`, "HEAD" + "x".repeat(5000) + "TAIL"); }
    await vi.advanceTimersByTimeAsync(7500);
    expect(saved.size).toBe(1);
    const batch = [...saved.values()][0].message;
    expect(batch.details.workers).toHaveLength(3);
    expect(batch.content.length).toBeLessThanOrEqual(8000);
    expect(batch.content.match(/Report truncated/g)).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(2500);
    expect(saved.size).toBe(2);
  });

  it("keeps retrying a pending batch after navigating before its dispatch", async () => {
    const ctx = makeCtx();
    branch.push({ id: "shared-user", type: "message", message: { role: "user", content: "task" } });
    branch.push({ id: "assistant-before-spawn", type: "message", message: { role: "assistant" } });
    await spawn(ctx, { name: "work", task: "task" }); finalReply(); completionPending = true;
    await vi.advanceTimersByTimeAsync(7500);
    const count = calls.filter((c) => c.path === "/api/session/completion").length;
    branch = branch.slice(0, 2);
    await vi.advanceTimersByTimeAsync(10000);
    expect(calls.filter((c) => c.path === "/api/session/completion").length).toBeGreaterThan(count);
  });
});
