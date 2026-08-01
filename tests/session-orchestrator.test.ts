import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sessionOrchestrator, {
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
    appendEntry: vi.fn(),
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
  const branch = options.worker
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
        registerSettings: vi.fn(async () => ({ registered: true, migrated: false, usedBackup: false })),
        getSettings: vi.fn(async () => ({
          schemaVersion: 1,
          values: {
            categories: options.categories ?? [],
            defaultCategory: options.defaultCategory ?? "",
          },
        })),
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
    } else if (path.startsWith("/api/models")) {
      payload = { ok: true, models: options.models ?? registry };
    } else if (path.startsWith("/api/state")) {
      payload = { ok: true, model: { provider: "anthropic", id: options.parentModelId ?? "fast-1" } };
    } else if (path.startsWith("/api/messages")) {
      payload = { ok: true, messages: [] };
    } else if (path === "/api/prompt" && (options.promptFails || (options.wakeupPromptFails && body?.sessionId === "parent-1"))) {
      payload = { ok: false, error: "prompt failed" };
    } else if (path === "/api/sessions/delete" && options.deleteFails) {
      payload = { ok: false, error: "delete failed" };
    }
    return { ok: payload.ok !== false, status: payload.ok === false ? 500 : 200, json: async () => payload } as any;
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
  return tool.execute("call-1", params, undefined, undefined, ctx);
}

function resultText(result: any) {
  return String(result?.content?.[0]?.text || "");
}

beforeEach(() => {
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
});

describe("sessions_spawn tool surface", () => {
  it("registers the orchestration tools", async () => {
    await activate(makeCtx());
    expect([...tools.keys()].sort()).toEqual([
      "sessions_abort",
      "sessions_prompt",
      "sessions_read",
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
    expect(result.details.cleanedUp).toBe(false);
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
    expect(resultText(result)).toMatch(/failed to dispatch/i);
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
    const tool = tools.get("sessions_spawn");

    const results = await Promise.all(Array.from({ length: 6 }, (_, index) =>
      tool.execute(`call-${index}`, { name: `worker-${index}`, task: "work" }, undefined, undefined, ctx),
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

describe("watcher lifecycle and wakeup retries", () => {
  it("keeps a ledger watch after a transient re-arm failure and later delivers its wakeup", async () => {
    vi.useFakeTimers();
    const pi = makeExtension();
    let stateCalls = 0;
    globalThis.fetch = (async (url: any, init: any = {}) => {
      const method = String(init.method || "GET");
      const path = String(url).replace(/^https?:\/\/[^/]+/, "");
      calls.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
      if (path === "/api/state?sessionId=ledger-worker") {
        stateCalls += 1;
        if (stateCalls === 1) {
          return { ok: false, status: 503, json: async () => ({ ok: false, error: "restarting" }) } as any;
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, runtime: { isRunning: false, pendingMessageCount: 0 } }) } as any;
      }
      if (path === "/api/messages?sessionId=ledger-worker") {
        return { ok: true, status: 200, json: async () => ({ ok: true, messages: [{ role: "assistant", text: "finished after restart" }] }) } as any;
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as any;
    }) as any;

    const ctx = makeCtx();
    ctx.sessionManager.getBranch = () => [{
      type: "custom",
      customType: "orchestrator-watch",
      data: { childId: "ledger-worker", name: "ledger worker", categoryName: "Fast", spawned: true },
    }];
    await handlers.get("session_start")?.({}, ctx);
    await vi.advanceTimersByTimeAsync(0);

    expect(pi.appendEntry).not.toHaveBeenCalledWith("orchestrator-watch-resolved", expect.anything());
    const statusBefore = await tools.get("sessions_status").execute("status", {});
    expect(resultText(statusBefore)).toContain("ledger-worker");

    await vi.advanceTimersByTimeAsync(10_000);

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(String(pi.sendMessage.mock.calls[0][0].content)).toContain("finished after restart");
    expect(pi.appendEntry).toHaveBeenCalledWith("orchestrator-watch-resolved", { childId: "ledger-worker" });
    expect(stateCalls).toBe(6); // re-arm failure + status check + four settled polls
  });

  it("resolves a ledger watch after a definitive not-found without polling forever", async () => {
    vi.useFakeTimers();
    const pi = makeExtension();
    let stateCalls = 0;
    globalThis.fetch = (async (url: any, init: any = {}) => {
      const method = String(init.method || "GET");
      const path = String(url).replace(/^https?:\/\/[^/]+/, "");
      calls.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
      if (path === "/api/state?sessionId=missing-worker") {
        stateCalls += 1;
        return { ok: false, status: 404, json: async () => ({ ok: false, error: "session not found" }) } as any;
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as any;
    }) as any;

    const ctx = makeCtx();
    ctx.sessionManager.getBranch = () => [{
      type: "custom",
      customType: "orchestrator-watch",
      data: { childId: "missing-worker", name: "missing worker", categoryName: "Fast", spawned: true },
    }];
    await handlers.get("session_start")?.({}, ctx);
    await vi.advanceTimersByTimeAsync(0);

    expect(pi.appendEntry).toHaveBeenCalledWith("orchestrator-watch-resolved", { childId: "missing-worker" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stateCalls).toBe(1);
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("does not re-arm polling when a pending ledger re-arm finishes after shutdown", async () => {
    vi.useFakeTimers();
    let resolveState!: (response: any) => void;
    const pendingState = new Promise<any>((resolve) => { resolveState = resolve; });
    globalThis.fetch = (async (url: any, init: any = {}) => {
      const method = String(init.method || "GET");
      const path = String(url).replace(/^https?:\/\/[^/]+/, "");
      calls.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
      if (path.startsWith("/api/state?sessionId=ledger-worker")) return pendingState;
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as any;
    }) as any;

    const ctx = makeCtx();
    ctx.sessionManager.getBranch = () => [{
      type: "custom",
      customType: "orchestrator-watch",
      data: { childId: "ledger-worker", name: "ledger worker", categoryName: "Fast" },
    }];
    await handlers.get("session_start")?.({}, ctx);
    expect(calls.filter((call) => call.path.includes("ledger-worker"))).toHaveLength(1);

    handlers.get("session_shutdown")?.({}, ctx);
    resolveState({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, runtime: { isRunning: true, pendingMessageCount: 0 } }),
    });
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(calls.filter((call) => call.path.includes("ledger-worker"))).toHaveLength(1);
  });

  it("keeps a completed worker watched and retries after every wakeup delivery path fails", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch({ wakeupPromptFails: true });
    const pi = makeExtension({ wakeupFails: true });
    const ctx = makeCtx({ categories: [FAST], defaultCategory: "Fast" });
    await activate(ctx);
    await spawn(ctx, { name: "scout", task: "look around", category: "Fast" });

    await vi.advanceTimersByTimeAsync(10_000); // four idle polls settle a fast worker
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(calls.filter((call) => call.path === "/api/state?sessionId=worker-1")).toHaveLength(4);

    await vi.advanceTimersByTimeAsync(2_500);
    expect(pi.sendMessage).toHaveBeenCalledTimes(2);
    expect(calls.filter((call) => call.path === "/api/state?sessionId=worker-1")).toHaveLength(5);
    const status = await tools.get("sessions_status").execute("status-1", {});
    expect(resultText(status)).toContain("worker-1");
  });
});
