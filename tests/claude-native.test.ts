import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Options, PermissionResult, Query, SDKMessage, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import {
  CLAUDE_CODE_VERSION,
  CLAUDE_SDK_VERSION,
  createClaudeQuery,
  preserveNativePermissionMode,
  type ClaudeIngressObservation,
} from "../server/session/adapters/claude/native.js";
import { ClaudeNativePeer } from "./fixtures/claude-native-peer.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const live: Array<{ query: Query; peer: ClaudeNativePeer; end: () => void; consumed: Promise<unknown> }> = [];

async function setup(options: Options = {}, peer = new ClaudeNativePeer()) {
  const end = deferred<void>();
  const observations: ClaudeIngressObservation[] = [];
  let invocation!: SpawnOptions;
  const query = createClaudeQuery({
    prompt: (async function* () { await end.promise; })(),
    options: {
      cwd: "/synthetic-claude-workspace",
      pathToClaudeCodeExecutable: process.execPath,
      env: { CLAUDE_CONFIG_DIR: "/synthetic-claude-config", ANTHROPIC_API_KEY: "synthetic-not-a-credential" },
      ...options,
      spawnClaudeCodeProcess: (args) => { invocation = args; return peer; },
    },
    observe: (observation) => observations.push(observation),
  });
  const events: SDKMessage[] = [];
  const consumed = (async () => {
    try { for await (const message of query) events.push(message); return undefined; }
    catch (error) { return error; }
  })();
  live.push({ query, peer, end: () => end.resolve(), consumed });
  await query.initializationResult();
  return { query, peer, events, consumed, observations, invocation };
}

afterEach(async () => {
  for (const { query, peer, end } of live) { end(); query.close(); peer.exit(); }
  await Promise.all(live.splice(0).map(({ consumed }) => consumed));
});

describe("Claude pinned native SDK ingress", () => {
  it("pins the SDK and matching bundled CLI rather than upgrading the system claude", () => {
    const require = createRequire(import.meta.url);
    const pkg = JSON.parse(readFileSync(join(dirname(require.resolve("@anthropic-ai/claude-agent-sdk")), "package.json"), "utf8"));
    expect(pkg.version).toBe(CLAUDE_SDK_VERSION);
    expect(pkg.claudeCodeVersion).toBe(CLAUDE_CODE_VERSION);
    expect(Object.values(pkg.optionalDependencies)).toEqual(expect.arrayContaining([CLAUDE_SDK_VERSION]));
  });

  it("preserves native auth/config/tools and uses the actual Claude Code prompt preset", async () => {
    const { peer, invocation } = await setup();
    expect(invocation.cwd).toBe("/synthetic-claude-workspace");
    expect(invocation.env.ANTHROPIC_API_KEY).toBe("synthetic-not-a-credential");
    expect(invocation.env.CLAUDE_CONFIG_DIR).toBe("/synthetic-claude-config");
    expect(invocation.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe("1");
    expect(invocation.args).toEqual(expect.arrayContaining([
      "--input-format", "stream-json", "--output-format", "stream-json",
      "--setting-sources=user,project,local", "--include-partial-messages", "--replay-user-messages",
      // No native permission override: the native CLI resolves its settings.
    ]));
    for (const flag of ["--permission-mode", "--tools", "--allowedTools", "--disallowedTools", "--strict-mcp-config", "--model", "--effort", "--settings", "--bare", "--safe-mode", "--allow-dangerously-skip-permissions", "--dangerously-skip-permissions"]) {
      expect(invocation.args).not.toContain(flag);
    }
    const initialize = peer.received.find((message) => message.type === "control_request" && message.request.subtype === "initialize");
    expect(initialize).toMatchObject({ type: "control_request", request: { subtype: "initialize" } });
    expect(initialize).not.toHaveProperty("request.systemPrompt");
  });

  it("keeps explicit permissions, plugin/agent/hook configuration and other supported overrides intact", async () => {
    const { peer, invocation } = await setup({
      permissionMode: "plan",
      settingSources: ["user", "project", "local"],
      plugins: [{ type: "local", path: "/synthetic-plugin" }],
      agents: { reviewer: { description: "Review", prompt: "Synthetic instructions" } },
      hooks: { PreToolUse: [{ hooks: [async () => ({})] }] },
      additionalDirectories: ["/synthetic-additional"],
    });
    const index = invocation.args.indexOf("--permission-mode");
    expect(invocation.args[index + 1]).toBe("plan");
    expect(invocation.args).toEqual(expect.arrayContaining(["--plugin-dir", "/synthetic-plugin", "--add-dir", "/synthetic-additional"]));
    const initialize = peer.received.find((message) => message.type === "control_request" && message.request.subtype === "initialize");
    expect(initialize).toMatchObject({ request: {
      agents: { reviewer: { description: "Review", prompt: "Synthetic instructions" } },
      hooks: { PreToolUse: [{ hookCallbackIds: [expect.any(String)] }] },
    } });
  });

  it.each([
    [], ["--permission-mode"], ["--permission-mode", "plan"], ["--permission-mode=default"],
    ["--permission-mode", "default", "--permission-mode", "plan"],
    ["--permission-mode", "default", "--permission-mode=plan"],
  ])("fails closed on an unexpected inherited-mode invocation: %j", (...args: string[]) => {
    expect(() => preserveNativePermissionMode(args, undefined)).toThrow("cannot safely inherit native permission mode");
  });

  it("never removes an explicit mode or any unrelated guardrail", () => {
    const args = ["--permission-mode", "plan", "--strict-mcp-config", "--disallowedTools", "Write"];
    expect(preserveNativePermissionMode(args, "plan")).toEqual(args);
    expect(preserveNativePermissionMode(["--permission-mode", "default", ...args.slice(2)], undefined)).toEqual(args.slice(2));
  });

  it("rejects raw mode arguments rather than ambiguously stripping a user override", () => {
    const spawn = vi.fn();
    expect(() => createClaudeQuery({
      prompt: (async function* () {})(),
      options: { extraArgs: { "permission-mode": "plan" }, spawnClaudeCodeProcess: spawn },
    })).toThrow("Use the Claude permissionMode option");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("observes unknown required controls before the SDK fails closed and preserves additive info", async () => {
    const { peer, events, observations } = await setup();
    peer.send({ type: "system", subtype: "future_info", session_id: "synthetic-session", private: "DO-NOT-RETAIN" });
    peer.send({ type: "future_message", private: "DO-NOT-RETAIN" });
    peer.send({ type: "control_request", request_id: "future-control", request: { subtype: "future_required", credential: "DO-NOT-RETAIN" } });
    const reply = await peer.nextInput((message) => message.type === "control_response" && message.response.request_id === "future-control");
    expect(reply).toMatchObject({ response: { subtype: "error", error: expect.stringContaining("Unsupported control request subtype") } });
    await delay(0);
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "future_message" }), expect.objectContaining({ subtype: "future_info" })]));
    expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "control_request" })]));
    expect(observations).toContainEqual(expect.objectContaining({ kind: "message", type: "control_request", subtype: "future_required" }));
    expect(JSON.stringify(observations)).not.toContain("DO-NOT-RETAIN");
  });

  it("bounds malformed/oversized observations without dropping native messages or split UTF-8", async () => {
    const { peer, events, observations } = await setup();
    peer.sendRaw("not-json DO-NOT-RETAIN\n");
    const text = Buffer.from(JSON.stringify({ type: "system", subtype: "informational", content: "📖" }) + "\n");
    const emoji = text.indexOf(Buffer.from("📖"));
    peer.sendRaw(text.subarray(0, emoji + 2));
    peer.sendRaw(text.subarray(emoji + 2));
    peer.send({ type: "system", subtype: "future_large", text: "x".repeat(128 * 1024) });
    peer.send({ type: "system", subtype: "future_after_large" });
    await delay(10);
    expect(observations).toEqual(expect.arrayContaining([
      { kind: "invalid-json", bytes: 22 },
      expect.objectContaining({ kind: "oversized" }),
      expect.objectContaining({ type: "system", subtype: "future_after_large" }),
    ]));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: "📖" }),
      expect.objectContaining({ subtype: "future_large", text: expect.any(String) }),
    ]));
    expect(JSON.stringify(observations)).not.toContain("DO-NOT-RETAIN");
    expect(JSON.stringify(observations).length).toBeLessThan(1024);
  });

  it("retains native permission IDs/scopes/caution flags and deduplicates an in-flight ask", async () => {
    const decision = deferred<PermissionResult>();
    const canUseTool = vi.fn<NonNullable<Options["canUseTool"]>>(() => decision.promise);
    const { peer } = await setup({ canUseTool });
    const request = { type: "control_request", request_id: "permission-1", request: {
      subtype: "can_use_tool", tool_name: "Bash", input: { command: "synthetic" }, tool_use_id: "tool-1", agent_id: "agent-1",
      permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "synthetic" }], behavior: "allow", destination: "session" }],
      default_to_no: true, suppress_always_allow_rule: true,
    } };
    peer.send(request); peer.send(request);
    await delay(0);
    expect(canUseTool).toHaveBeenCalledTimes(1);
    expect(canUseTool).toHaveBeenCalledWith("Bash", { command: "synthetic" }, expect.objectContaining({
      requestId: "permission-1", toolUseID: "tool-1", agentID: "agent-1", defaultToNo: true, suppressAlwaysAllowRule: true,
      suggestions: request.request.permission_suggestions,
    }));
    decision.resolve({ behavior: "deny", message: "User declined", interrupt: false });
    const reply = await peer.nextInput((message) => message.type === "control_response" && message.response.request_id === "permission-1");
    expect(reply).toMatchObject({ response: { response: { behavior: "deny", message: "User declined", interrupt: false, toolUseID: "tool-1" } } });
  });

  it("delivers native cancellation to the approval signal", async () => {
    const decision = deferred<PermissionResult>();
    let signal: AbortSignal | undefined;
    const { peer } = await setup({ canUseTool: (_tool, _input, options) => { signal = options.signal; return decision.promise; } });
    peer.send({ type: "control_request", request_id: "cancelled-permission", request: {
      subtype: "can_use_tool", tool_name: "Bash", input: {}, tool_use_id: "cancelled-tool",
    } });
    await delay(0);
    expect(signal?.aborted).toBe(false);
    peer.send({ type: "control_cancel_request", request_id: "cancelled-permission" });
    await delay(0);
    expect(signal?.aborted).toBe(true);
    decision.resolve({ behavior: "deny", message: "Request cancelled" });
  });

  it("returns the native interrupt receipt without inventing an execution ID or idle", async () => {
    const { query, peer, events } = await setup();
    const receipt = query.interrupt();
    const request = await peer.nextInput((message) => message.type === "control_request" && message.request.subtype === "interrupt");
    if (request.type !== "control_request") throw new Error("Expected control request");
    expect(request.request).toEqual({ subtype: "interrupt" });
    peer.send({ type: "control_response", response: { subtype: "success", request_id: request.request_id, response: { still_queued: ["queued-user"] } } });
    expect(await receipt).toEqual({ still_queued: ["queued-user"] });
    expect(events).toEqual([]);
  });

  it("surfaces process failure rather than manufacturing a successful terminal result", async () => {
    const { peer, consumed, events } = await setup();
    peer.exit(42);
    expect(await consumed).toBeInstanceOf(Error);
    expect(events.some((event) => event.type === "result")).toBe(false);
  });
});
