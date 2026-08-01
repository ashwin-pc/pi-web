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

function makeExtension() {
  tools = new Map();
  handlers = new Map();
  const pi: any = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (event: string, handler: any) => handlers.set(event, handler),
    sendMessage: vi.fn(),
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
function stubFetch(options: { models?: any[]; parentModelId?: string; newChatFails?: boolean } = {}) {
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
  });

  it("reports a region-prefix substitution instead of silently swapping models", async () => {
    stubFetch({ models: [{ provider: "amazon-bedrock", id: "us.anthropic.claude-x-v1:0" }], parentModelId: "us.anthropic.other-v1:0" });
    const category = { name: "Bedrock", model: "amazon-bedrock:anthropic.claude-x-v1:0", description: "Region-prefixed profile." };
    const ctx = makeCtx({ categories: [category], defaultCategory: "Bedrock", parentModelId: "us.anthropic.other-v1:0" });

    const result = await spawn(ctx, { name: "scout", task: "look around", category: "Bedrock" });

    expect(result.isError).toBeFalsy();
    expect(calls.find((call) => call.path === "/api/model")?.body).toMatchObject({ id: "us.anthropic.claude-x-v1:0" });
    expect(resultText(result)).toMatch(/substituted/i);
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
});
