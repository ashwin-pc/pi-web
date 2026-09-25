import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import type { AdapterPromptInput, SessionHandle } from "../server/session/adapter.js";
import type { NativeSessionRefDto, SessionServiceEvent } from "../server/session/dto.js";
import { createClaudeAdapter } from "../server/session/adapters/claude/index.js";
import { ClaudeNativePeer } from "./fixtures/claude-native-peer.js";

const handles: SessionHandle[] = [];
afterEach(async () => { await Promise.all(handles.splice(0).map((handle) => handle.dispose())); });
const input = (executionId = "execution-1"): AdapterPromptInput => ({ executionId, message: "hello", mode: "prompt", attachments: [], clientMessageId: `client-${executionId}`, sourceClientId: "browser-1" });

function fixture(extra: Parameters<typeof createClaudeAdapter>[0] = {}) {
  const peers: ClaudeNativePeer[] = [];
  const invocations: SpawnOptions[] = [];
  const api = {
    getSessionInfo: vi.fn(async () => undefined),
    getSessionMessages: vi.fn(async () => []),
    listSessions: vi.fn(async () => []),
  };
  const adapter = createClaudeAdapter({
    pathToClaudeCodeExecutable: process.execPath,
    env: { CLAUDE_CONFIG_DIR: "/synthetic-claude-config", DISABLE_TELEMETRY: "1" },
    sessionApi: api,
    spawnClaudeCodeProcess: (options) => { invocations.push(options); const peer = new ClaudeNativePeer(); peers.push(peer); return peer; },
    ...extra,
  });
  return { adapter, api, peers, invocations };
}

async function running(extra: Parameters<typeof createClaudeAdapter>[0] = {}) {
  const f = fixture(extra);
  const handle = await f.adapter.create({ sessionId: "web-session", cwd: "/workspace" });
  handles.push(handle);
  const events: SessionServiceEvent[] = [];
  handle.subscribe((event) => events.push(event));
  const receipt = await handle.prompt(input());
  const peer = f.peers[0]!;
  const user = await peer.nextInput((message) => message.type === "user");
  if (user.type !== "user" || !user.uuid) throw new Error("No native prompt UUID");
  const nativeId = handle.state().nativeSession.sessionId!;
  const frame = (message: Record<string, unknown>) => ({ uuid: randomUUID(), session_id: nativeId, ...message });
  const send = (message: Record<string, unknown>) => { const value = frame(message); peer.send(value); return value; };
  const ack = () => send({ ...user, isReplay: true });
  const result = (overrides: Record<string, unknown> = {}) => send({
    type: "result", subtype: "success", is_error: false, result: "done", num_turns: 1,
    duration_ms: 1, duration_api_ms: 1, stop_reason: "end_turn", total_cost_usd: 0.02,
    usage: {}, modelUsage: { "claude-fixture": { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2, cacheCreationInputTokens: 1, costUSD: 0.02 } },
    permission_denials: [], result_index: 0, user_message_uuid: user.uuid, ...overrides,
  });
  const idle = () => send({ type: "system", subtype: "session_state_changed", state: "idle" });
  return { ...f, handle, events, peer, user, nativeId, frame, send, ack, result, idle, receipt };
}
const flush = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); };

function assistant(id: string, content: unknown[], extras: Record<string, unknown> = {}) {
  return { type: "assistant", parent_tool_use_id: null, message: { id, role: "assistant", model: "claude-fixture", content, stop_reason: null, stop_sequence: null, usage: {} }, ...extras };
}

describe("Claude production adapter", () => {
  it("keeps construction/create lazy, distinguishes native identity and disables unimplemented operations", async () => {
    const f = fixture();
    expect(f.peers).toHaveLength(0);
    expect(f.api.listSessions).not.toHaveBeenCalled();
    const handle = await f.adapter.create({ sessionId: "web-owned", cwd: "/workspace" });
    handles.push(handle);
    expect(f.peers).toHaveLength(0);
    const state = handle.state();
    expect(state.sessionId).toBe("web-owned");
    expect(state.nativeSession).toMatchObject({ harnessId: "claude", persistence: "persistent", status: "unmaterialized" });
    expect(state.nativeSession.sessionId).not.toBe(state.sessionId);
    expect(state).not.toHaveProperty("sessionFile");
    expect(state).not.toHaveProperty("model");
    expect(state.stats).not.toHaveProperty("tokens");
    expect(state.stats).not.toHaveProperty("cost");
    for (const capability of ["queue", "steering", "followUp", "models", "context", "attachments", "historyFork", "extensions", "tree"]) expect(state.capabilities[capability as keyof typeof state.capabilities]).toBe(false);
    for (const mode of ["steer", "followUp"]) await expect(handle.prompt({ ...input(), mode })).rejects.toThrow("does not support");
    await expect(handle.prompt({ ...input(), message: "/clear" })).rejects.toThrow("conversation-switch");
    expect(f.peers).toHaveLength(0);
  });

  it("correlates user acknowledgement, partial/final blocks and tool results without duplicate text", async () => {
    const f = await running();
    expect(f.receipt).toMatchObject({ acknowledgement: "pending", executionId: "execution-1" });
    expect(f.receipt).not.toHaveProperty("nativeExecutionId");
    expect(await f.handle.messages()).toEqual([]);
    f.ack();
    const stream = (event: Record<string, unknown>) => f.send({ type: "stream_event", parent_tool_use_id: null, event, user_message_uuid: f.user.uuid });
    stream({ type: "message_start", message: { id: "api-1" } });
    stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } });
    const completed = f.send(assistant("api-1", [{ type: "text", text: "Hello" }]));
    f.peer.send(completed);
    stream({ type: "content_block_stop", index: 0 });
    stream({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool-1", name: "Bash", input: {} } });
    stream({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":' } });
    f.send(assistant("api-1", [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } }]));
    stream({ type: "content_block_stop", index: 1 });
    stream({ type: "message_stop" });
    f.send({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "/workspace", is_error: false }] } });
    const final = f.result();
    f.peer.send(final);
    await flush();
    expect(f.handle.state()).toMatchObject({ phase: "settling", isStreaming: true, activeExecution: { id: "execution-1", owner: "host" } });
    const messages = await f.handle.messages();
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ role: "assistant", text: "Hello", nativeItemId: "api-1", parts: [
      { type: "text", text: "Hello" }, { type: "toolCall", toolCallId: "tool-1", args: { command: "pwd" }, status: "completed", result: { parts: [{ type: "text", text: "/workspace" }], isError: false } },
    ] });
    expect(f.events).toContainEqual(expect.objectContaining({ type: "message_delta", executionId: "execution-1", clientMessageId: "client-execution-1", delta: "Hello" }));
    f.idle();
    await flush();
    expect(f.handle.state()).toMatchObject({ phase: "idle", isStreaming: false, stats: { cost: 0.02, tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18 } } });
    expect(f.handle.state().activeExecution).toBeUndefined();
  });

  it.each([
    { label: "missing model usage", modelUsage: undefined },
    { label: "empty model usage", modelUsage: {} },
    { label: "missing model counters", modelUsage: { "claude-fixture": {} } },
    { label: "null model counters", modelUsage: { "claude-fixture": null } },
    { label: "partial model counters", modelUsage: { "claude-fixture": { inputTokens: 10, outputTokens: 5 } } },
    { label: "invalid model counters", modelUsage: { "claude-fixture": { inputTokens: -1, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } },
  ])("does not invent Query token totals for $label", async ({ modelUsage }) => {
    const f = await running();
    f.ack(); f.result({ modelUsage }); f.idle(); await flush();
    expect(f.handle.state().phase).toBe("idle");
    expect(f.handle.state().stats).not.toHaveProperty("tokens");
    expect(f.handle.state().stats.cost).toBe(0.02); // Independently reported money remains known.
    for (const event of f.events) if (event.type === "state") expect(event.state.stats).not.toHaveProperty("tokens");
  });

  it("publishes a measured zero rather than treating every zero as unknown", async () => {
    const f = await running();
    f.ack();
    f.result({ modelUsage: { "claude-fixture": { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }, total_cost_usd: 0 });
    f.idle(); await flush();
    expect(f.handle.state().stats.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
    expect(f.handle.state().stats.cost).toBe(0);
  });

  it("retains observed Query totals when a later result omits or zeroes accounting", async () => {
    const f = await running();
    f.ack(); f.result(); f.idle(); await flush();
    const expected = f.handle.state().stats.tokens;
    expect(expected?.total).toBe(18);
    for (const [index, modelUsage] of [{}, { "claude-fixture": { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }].entries()) {
      await f.handle.prompt(input(`later-${index}`));
      await vi.waitFor(() => expect(f.peer.received.filter((message) => message.type === "user")).toHaveLength(index + 2));
      const user = f.peer.received.filter((message) => message.type === "user").at(-1)!;
      f.result({ user_message_uuid: user.uuid, result_index: index + 1, modelUsage, total_cost_usd: 0,
        subtype: "error_during_execution", is_error: true, errors: ["Synthetic terminal error"] });
      f.idle(); await flush();
      expect(f.handle.state().stats.tokens).toEqual(expected);
      expect(f.handle.state().stats.cost).toBe(0.02);
    }
  });

  it("reports a native rejection before acknowledgement without inventing acceptance or a persisted user message", async () => {
    const f = await running();
    f.result({ subtype: "error_during_execution", is_error: true, errors: ["Native rejected input: sk-ant-synthetic-secret"], num_turns: 0,
      total_cost_usd: 0, modelUsage: {}, user_message_uuid: undefined });
    await flush();
    expect(f.handle.state().phase).toBe("settling");
    expect(await f.handle.messages()).toEqual([]);
    expect(f.events).toContainEqual(expect.objectContaining({ type: "error", clientMessageId: "client-execution-1", error: "Native rejected input: [redacted]" }));
    expect(JSON.stringify(f.events)).not.toContain("sk-ant-synthetic-secret");
    f.idle(); await flush();
    expect(f.handle.state()).toMatchObject({ phase: "error", isStreaming: false });
    expect(f.handle.state().activeExecution).toBeUndefined();
    expect(f.events.filter((event) => event.type === "error")).toHaveLength(1);
  });

  it("does not manufacture redacted thinking or sparse ordered parts", async () => {
    const f = await running();
    f.ack();
    const stream = (event: Record<string, unknown>) => f.send({ type: "stream_event", parent_tool_use_id: null, event });
    stream({ type: "message_start", message: { id: "thinking-api" } });
    stream({ type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "DO-NOT-RETAIN" } });
    stream({ type: "content_block_stop", index: 0 });
    stream({ type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } });
    stream({ type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "Synthetic exposed thinking" } });
    f.send(assistant("thinking-api", [{ type: "thinking", thinking: "Synthetic exposed thinking" }]));
    stream({ type: "content_block_stop", index: 1 });
    stream({ type: "content_block_start", index: 2, content_block: { type: "text", text: "Answer" } });
    f.send(assistant("thinking-api", [{ type: "text", text: "Answer" }]));
    await flush();
    const parts = (await f.handle.messages())[1]!.parts!;
    expect(parts).toHaveLength(2);
    expect(parts.map((part) => part.type)).toEqual(["thinking", "text"]);
    expect(JSON.stringify(f.events)).not.toContain("DO-NOT-RETAIN");
  });

  it.each([false, true])("recognizes native interruption (is_error=%s) without turning its receipt into idle", async (isError) => {
    const f = await running();
    await expect(f.handle.prompt(input("second"))).rejects.toMatchObject({ status: 409 });
    await expect(f.handle.interrupt("stale")).rejects.toMatchObject({ status: 409 });
    expect(f.peer.received.some((message) => message.type === "control_request" && message.request.subtype === "interrupt")).toBe(false);
    const interrupted = f.handle.interrupt("execution-1");
    const request = await f.peer.nextInput((message) => message.type === "control_request" && message.request.subtype === "interrupt");
    if (request.type !== "control_request") throw new Error("Expected interrupt request");
    f.peer.send({ type: "control_response", response: { subtype: "success", request_id: request.request_id, response: { still_queued: ["native-queued"] } } });
    expect(await interrupted).toEqual({ sessionId: "web-session", executionId: "execution-1", acknowledged: true, stillQueued: true });
    expect(f.handle.state().isStreaming).toBe(true);
    f.send({ type: "assistant", aborted: true, parent_tool_use_id: null, message: { id: "interrupted-api", role: "assistant", content: [{ type: "text", text: "Partial" }], stop_reason: null, usage: {} } });
    f.result({ terminal_reason: "aborted_streaming", ...(isError ? { subtype: "error_during_execution", is_error: true, errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"] } : {}) });
    await flush();
    expect(f.handle.state().phase).toBe("settling");
    f.idle(); await flush();
    expect(f.handle.state().phase).toBe("idle");
    expect(f.handle.state().error).toBeUndefined();
    expect((await f.handle.messages()).find((message) => message.role === "assistant")?.status).toBe("interrupted");
    expect(f.events.some((event) => event.type === "error")).toBe(false);
  });

  it("ignores duplicate/late finals and idle while a newer execution lacks its own result", async () => {
    const f = await running();
    f.ack(); const oldResult = f.result(); const oldIdle = f.idle(); await flush();
    await f.handle.prompt(input("execution-2"));
    const users = f.peer.received.filter((message) => message.type === "user");
    await vi.waitFor(() => expect(f.peer.received.filter((message) => message.type === "user")).toHaveLength(2));
    const latest = f.peer.received.filter((message) => message.type === "user").at(-1)!;
    if (latest.type !== "user") throw new Error("Expected second user");
    f.peer.send(oldResult); f.peer.send(oldIdle);
    f.send({ ...oldResult, uuid: randomUUID() });
    f.idle(); await flush();
    expect(f.handle.state().activeExecution?.id).toBe("execution-2");
    f.result({ user_message_uuid: latest.uuid, result_index: 1 }); f.idle(); await flush();
    expect(f.handle.state().activeExecution).toBeUndefined();
    expect(users.length).toBeGreaterThan(0);
  });

  it("routes validated native approval choices and retains exact suggested scopes", async () => {
    const f = await running();
    const suggestions = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "git status" }], behavior: "allow", destination: "session" }];
    const ask = { type: "control_request", request_id: "approval-1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "git status" }, tool_use_id: "tool-1", permission_suggestions: suggestions, default_to_no: true } };
    f.send(ask); f.send(ask);
    await vi.waitFor(() => expect(f.handle.state().pendingInteractions).toHaveLength(1));
    const request = f.handle.state().pendingInteractions[0]!;
    expect(request.choices?.[0]?.meaning).toBe("decline");
    expect(request.choices).toContainEqual(expect.objectContaining({ id: "allow-suggested", scope: "session" }));
    expect(f.handle.respondInteraction({ id: request.id, sessionId: "wrong", choiceID: "allow-once" })).toBe(false);
    expect(f.handle.respondInteraction({ id: request.id, sessionId: f.handle.sessionId, choiceID: "invented" })).toBe(false);
    expect(f.handle.respondInteraction({ id: request.id, sessionId: f.handle.sessionId, choiceID: "allow-suggested" })).toBe(true);
    expect(f.handle.respondInteraction({ id: request.id, sessionId: f.handle.sessionId, choiceID: "allow-once" })).toBe(false);
    const response = await f.peer.nextInput((message) => message.type === "control_response" && message.response.request_id === "approval-1");
    expect(response).toMatchObject({ response: { response: { behavior: "allow", updatedInput: { command: "git status" }, updatedPermissions: suggestions, toolUseID: "tool-1" } } });
    f.send(ask); await flush();
    expect(f.handle.state().pendingInteractions).toHaveLength(0);
    expect(f.events.filter((event) => event.type === "interaction")).toHaveLength(1);
    f.send({ ...ask, request: { ...ask.request, input: { command: "changed-command" } } });
    await vi.waitFor(() => expect(f.peer.received.filter((message) => message.type === "control_response" && message.response.request_id === "approval-1").at(-1)).toMatchObject({ response: { response: { behavior: "deny", message: "Native request identity changed" } } }));
  });

  it.each(["timeout", "disconnect", "native"] as const)("fails a pending decision closed on %s without pretending decline means interrupt", async (reason) => {
    const f = await running({ interactionTimeoutMs: 80 });
    f.send({ type: "control_request", request_id: "approval-close", request: { subtype: "can_use_tool", tool_name: "Write", input: { file_path: "fixture" }, tool_use_id: "tool-close", permission_suggestions: [{ type: "addDirectories", directories: ["/fixture"], destination: "session" }], suppress_always_allow_rule: true } });
    await vi.waitFor(() => expect(f.handle.state().pendingInteractions).toHaveLength(1), { interval: 5 });
    const request = f.handle.state().pendingInteractions[0]!;
    expect(request.choices?.some((choice) => choice.id === "allow-suggested")).toBe(false);
    if (reason === "disconnect") f.handle.cancelInteractions("disconnect");
    if (reason === "native") f.send({ type: "control_cancel_request", request_id: "approval-close" });
    const response = await f.peer.nextInput((message) => message.type === "control_response" && message.response.request_id === "approval-close");
    expect(response).toMatchObject({ response: { response: { behavior: "deny", toolUseID: "tool-close" } } });
    expect(response).not.toHaveProperty("response.response.interrupt", true);
    expect(f.handle.state().pendingInteractions).toHaveLength(0);
    expect(f.handle.respondInteraction({ sessionId: f.handle.sessionId, id: request.id, choiceID: "allow-once" })).toBe(false);
    expect(f.handle.state().isStreaming).toBe(true);
  });

  it("maps native AskUserQuestion answer IDs back to original labels without accepting missing/foreign answers", async () => {
    const f = await running();
    const questions = [{ question: "Which database?", header: "Database", multiSelect: false, options: [{ label: "SQLite", description: "Embedded" }, { label: "Postgres", description: "Server" }] }];
    f.send({ type: "control_request", request_id: "questions", request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", tool_use_id: "question-tool", input: { questions } } });
    await vi.waitFor(() => expect(f.handle.state().pendingInteractions).toHaveLength(1));
    const request = f.handle.state().pendingInteractions[0]!;
    expect(request.questions?.[0]?.options?.[1]?.label).toBe("Postgres — Server");
    expect(f.handle.respondInteraction({ id: request.id, sessionId: f.handle.sessionId, choiceID: "submit", answers: {} })).toBe(false);
    expect(f.handle.respondInteraction({ id: request.id, sessionId: f.handle.sessionId, choiceID: "submit", answers: { other: "value" } })).toBe(false);
    expect(f.handle.respondInteraction({ id: request.id, sessionId: f.handle.sessionId, choiceID: "submit", answers: { "question-0": "option-1" } })).toBe(true);
    expect(await f.peer.nextInput((message) => message.type === "control_response" && message.response.request_id === "questions")).toMatchObject({ response: { response: { behavior: "allow", updatedInput: { questions, answers: { "Which database?": "Postgres" } } } } });
  });

  it("bounds missing interrupt acknowledgement without inventing a successful stop", async () => {
    const f = await running({ controlTimeoutMs: 25 });
    await expect(f.handle.interrupt("execution-1")).rejects.toThrow("interrupt acknowledgement timed out");
    expect(f.handle.state()).toMatchObject({ phase: "unavailable", isStreaming: false });
    expect(f.handle.state().activeExecution).toBeUndefined();
  });

  it("marks transport loss unavailable even after a settled native error, and requires explicit reopen", async () => {
    const f = await running();
    f.result({ subtype: "error_during_execution", is_error: true, errors: ["Synthetic model error"] });
    f.idle(); await flush();
    expect(f.handle.state().phase).toBe("error");
    f.peer.exit(17);
    await vi.waitFor(() => expect(f.handle.state().phase).toBe("unavailable"));
    await expect(f.handle.prompt(input("new"))).rejects.toMatchObject({ status: 410 });
  });

  it("rejects a mismatched executable before model input or SDK process initialization", async () => {
    const adapter = createClaudeAdapter({ pathToClaudeCodeExecutable: process.execPath });
    const handle = await adapter.create({ sessionId: "version-check", cwd: "/workspace" }); handles.push(handle);
    await expect(handle.prompt(input())).rejects.toThrow("Unsupported Claude executable version");
    expect(await handle.messages()).toEqual([]);
    expect(handle.state().phase).toBe("error");
  });

  it("uses supported native readers on recovery even when host metadata missed native acceptance", async () => {
    const nativeId = randomUUID();
    const history = [{ type: "user" as const, uuid: randomUUID(), session_id: nativeId, parent_tool_use_id: null, parent_agent_id: null, message: { role: "user", content: "Persisted before host crash" } }];
    const sessionApi = {
      getSessionInfo: vi.fn(async () => ({ sessionId: nativeId, summary: "Recovered", cwd: "/workspace", lastModified: 1000 })),
      getSessionMessages: vi.fn(async () => history), listSessions: vi.fn(async () => []),
    };
    const f = fixture({ sessionApi });
    const ref: NativeSessionRefDto = { harnessId: "claude", sessionId: nativeId, persistence: "persistent", status: "unmaterialized" };
    const handle = await f.adapter.open({ sessionId: "durable-web-id", cwd: "/workspace", nativeSession: ref }); handles.push(handle);
    expect(sessionApi.getSessionInfo).toHaveBeenCalledWith(nativeId, { dir: "/workspace" });
    expect(sessionApi.getSessionMessages).toHaveBeenCalledWith(nativeId, { dir: "/workspace", includeSystemMessages: true });
    expect(handle.state().nativeSession.status).toBe("resumable");
    expect(handle.state().stats).not.toHaveProperty("tokens");
    expect((await handle.messages())[0]).toMatchObject({ text: "Persisted before host crash" });
    expect(f.peers).toHaveLength(0);
    await handle.prompt(input());
    expect(handle.state().stats).not.toHaveProperty("tokens");
    expect(f.invocations[0]!.args).toContain(`--resume=${nativeId}`);
    expect(f.invocations[0]!.args.some((arg) => arg.startsWith("--session-id"))).toBe(false);
    await f.peers[0]!.nextInput((message) => message.type === "user");
    expect(f.peers[0]!.received.filter((message) => message.type === "user")).toHaveLength(1);
  });

  it("does not recreate missing native or expired ephemeral sessions", async () => {
    const f = fixture();
    const ref: NativeSessionRefDto = { harnessId: "claude", sessionId: randomUUID(), persistence: "persistent", status: "unmaterialized" };
    await expect(f.adapter.open({ sessionId: "web", cwd: "/workspace", nativeSession: ref })).rejects.toMatchObject({ status: 410 });
    await expect(f.adapter.open({ sessionId: "web", cwd: "/workspace", nativeSession: { ...ref, persistence: "ephemeral", status: "live-only" } })).rejects.toMatchObject({ status: 410 });
    expect(f.peers).toHaveLength(0);
    expect(f.api.getSessionInfo).toHaveBeenCalledTimes(2);
    expect(f.api.getSessionInfo).toHaveBeenCalledWith(ref.sessionId);
  });

  it("marks a dead ephemeral process unavailable and never recreates it", async () => {
    const f = fixture();
    const handle = await f.adapter.create({ sessionId: "ephemeral-web", cwd: "/workspace", persistence: "ephemeral" }); handles.push(handle);
    await handle.prompt(input());
    expect(f.invocations[0]!.args).toContain("--no-session-persistence");
    f.peers[0]!.exit(17);
    await vi.waitFor(() => expect(handle.state().phase).toBe("unavailable"));
    expect(handle.state().nativeSession.status).toBe("unavailable");
    await expect(handle.prompt(input("next"))).rejects.toMatchObject({ status: 410 });
    expect(f.peers).toHaveLength(1);
  });

  it("projects native discovery without a storage path or fabricated message counts", async () => {
    const nativeId = randomUUID();
    const f = fixture({ sessionApi: { getSessionInfo, getSessionMessages, listSessions: vi.fn(async () => [{ sessionId: nativeId, summary: "Native summary", firstPrompt: "hello", lastModified: 2000, createdAt: 1000, cwd: "/workspace" }]) } });
    const [entry] = await f.adapter.list("/workspace");
    expect(entry).toMatchObject({ name: "Native summary", created: new Date(1000).toISOString(), modified: new Date(2000).toISOString(), nativeSession: { sessionId: nativeId, status: "resumable" } });
    expect(entry).not.toHaveProperty("sessionFile"); expect(entry).not.toHaveProperty("messageCount");
  });

  it("fails process death and unknown required control safely without forwarding credential payloads", async () => {
    const f = await running();
    f.send({ type: "control_request", request_id: "unknown", request: { subtype: "future_required", secret: "DO-NOT-RETAIN" } });
    await f.peer.nextInput((message) => message.type === "control_response" && message.response.request_id === "unknown");
    f.send({ type: "system", subtype: "future_info", secret: "DO-NOT-RETAIN" });
    await flush();
    expect(JSON.stringify(f.events)).not.toContain("DO-NOT-RETAIN");
    f.peer.exit(17);
    await vi.waitFor(() => expect(f.handle.state().phase).toBe("unavailable"));
    expect(f.handle.state().isStreaming).toBe(false);
    expect(f.handle.state().activeExecution).toBeUndefined();
    expect(f.events).toContainEqual(expect.objectContaining({ type: "error", clientMessageId: "client-execution-1" }));
  });
});

// Only used as unavailable test reader defaults; never opens a user's native store.
async function getSessionInfo() { return undefined; }
async function getSessionMessages() { return []; }
