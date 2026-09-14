import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionHandle } from "../server/session/adapter.js";
import { jsonRoundTrip, type SessionServiceEvent, type ToolCallPartDto } from "../server/session/dto.js";
import { createCodexAdapter, type CodexAdapterOptions } from "../server/session/adapters/codex/index.js";
import { acceptedTurn, controlPeer, peerForThread, readObserved, waitObserved, type CodexPeer } from "./fixtures/codex-peer-control.js";
import { codexFixturePng, mcpImageEvents } from "./fixtures/codex-native-events.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(options: Partial<CodexAdapterOptions> = {}, ephemeral = false) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-codex-adapter-"));
  const handles: SessionHandle[] = [];
  cleanups.push(async () => { await Promise.all(handles.map((handle) => handle.dispose())); await rm(root, { recursive: true, force: true }); });
  const adapter = createCodexAdapter({ command: process.execPath, args: [fileURLToPath(new URL("./fixtures/codex-app-server-peer.mjs", import.meta.url))],
    env: { ...process.env, PI_WEB_CODEX_PEER_DIR: root }, ...options });
  expect(await readdir(join(root, "peers")).catch(() => [])).toEqual([]); // Catalog construction is lazy.
  const handle = await adapter.create({ cwd: root, sessionId: "web-session", ...(ephemeral ? { persistence: "ephemeral" as const } : {}) });
  handles.push(handle);
  const peer = await peerForThread(root, handle.state().nativeSession.sessionId!);
  const events: SessionServiceEvent[] = [];
  handle.subscribe((event) => events.push(event));
  return { root, adapter, handle, peer, events, handles };
}
const prompt = (handle: SessionHandle, executionId = "guard-1") => handle.prompt({ message: "Ordinary user input", mode: "prompt", attachments: [], executionId, clientMessageId: `client-${executionId}` });
const tools = async (handle: SessionHandle): Promise<ToolCallPartDto[]> => (await handle.messages()).flatMap((message) => message.parts ?? []).filter((part): part is ToolCallPartDto => part.type === "toolCall");
const clientRequests = async (peer: CodexPeer, method: string) => (await readObserved(peer)).filter((record) => record.direction === "client" && record.message.method === method);

describe("Codex production adapter through native process ingress", () => {
  it("creates independent identity and uses native effective settings, not catalog or Pi defaults", async () => {
    const { handle, peer, root, adapter } = await fixture();
    const state = handle.state();
    expect(state).toMatchObject({ sessionId: "web-session", harnessId: "codex", phase: "idle", nativeSession: { persistence: "persistent", status: "unmaterialized" },
      nativeSettings: { model: "native-fixture-model", reasoningEffort: "medium", permissionMode: "on-request (user)", sandboxMode: "readOnly" } });
    expect(state.nativeSession.sessionId).not.toBe(state.sessionId);
    expect(state.sessionFile).toBeUndefined();
    expect(state.stats.cost).toBeUndefined();
    expect(adapter.harness.capabilities).toMatchObject({ steering: false, queue: false, attachments: false, models: false, extensions: false, tree: false });
    expect((await clientRequests(peer, "thread/start"))[0]?.message.params).toEqual({ cwd: root });
    const initialize = (await clientRequests(peer, "initialize"))[0]!.message;
    expect(initialize.params.capabilities).toEqual({ experimentalApi: true, requestAttestation: false });
    expect(await clientRequests(peer, "model/list")).toHaveLength(0);
    await expect(adapter.open({ sessionId: "other", cwd: root, nativeSession: { harnessId: "pi", sessionId: state.nativeSession.sessionId, persistence: "persistent", status: "resumable" } })).rejects.toThrow("another harness");
  });

  it("retains native acceptance, ordered thinking/text/tools and authoritative final replacement", async () => {
    const { handle, peer, events } = await fixture();
    const receipt = await prompt(handle);
    expect(receipt).toMatchObject({ sessionId: "web-session", executionId: "guard-1", acknowledgement: "accepted" });
    expect(receipt.nativeExecutionId).toBeTruthy();
    expect(handle.state().activeExecution).toEqual({ id: "guard-1", owner: "host", nativeExecutionId: receipt.nativeExecutionId });
    // Acceptance can precede the native user-item commit/materialization event.
    await expect.poll(() => handle.state().nativeSession.status).toBe("resumable");
    await controlPeer(peer, { action: "thinking", delta: "Native summary" });
    await controlPeer(peer, { action: "tool", itemId: "read", command: "printf native", delta: "one" });
    await controlPeer(peer, { action: "tool", itemId: "read", delta: " two", done: true });
    await controlPeer(peer, { action: "text", delta: "Draft text" });
    await controlPeer(peer, { action: "text", delta: "!", done: true, text: "Authoritative final" });
    const messages = await handle.messages();
    expect(messages.map((message) => message.parts?.[0]?.type)).toEqual(["text", "thinking", "toolCall", "text"]);
    expect(messages.at(-1)?.text).toBe("Authoritative final");
    expect((await tools(handle))[0]).toMatchObject({ status: "completed", result: { parts: [{ type: "text", text: "one two" }] } });
    expect(messages.every((message) => message.id && message.parts?.every((part) => part.id))).toBe(true);
    expect(messages.every((message) => message.raw === undefined)).toBe(true);
    await controlPeer(peer, { action: "complete", idle: false });
    expect(handle.state().phase).toBe("settling"); // A terminal native turn is not thread idle.
    await controlPeer(peer, { action: "activity", status: { type: "idle" } });
    expect(handle.state().phase).toBe("idle");
    expect(events.some((event) => event.type === "message_delta")).toBe(true);
    for (const event of events) expect(jsonRoundTrip(event)).toStrictEqual(event);
  });

  it("streams keyed nested tool text with linear wire growth, including a null initial result", async () => {
    const run = async (chunks: number) => {
      const { handle, peer, events } = await fixture();
      const receipt = await prompt(handle);
      const threadId = handle.state().nativeSession.sessionId!;
      const itemId = "stream-command";
      await controlPeer(peer, { action: "emit", message: { method: "item/started", params: { threadId, turnId: receipt.nativeExecutionId, startedAtMs: Date.now(),
        item: { id: itemId, type: "commandExecution", command: "printf native", cwd: "/synthetic", processId: null, source: "agent", commandActions: [],
          pluginId: null, scriptPath: null, status: "inProgress", aggregatedOutput: null, exitCode: null, durationMs: null } } } });
      const delta = "x".repeat(256);
      for (let index = 0; index < chunks; index++) await controlPeer(peer, { action: "tool", itemId, delta });
      expect((await tools(handle))[0]?.result?.parts[0]).toMatchObject({ type: "text", text: delta.repeat(chunks) });
      await controlPeer(peer, { action: "tool", itemId, done: true });
      const message = (await handle.messages()).find((value) => value.nativeItemId === itemId)!;
      const wire = events.filter((event) => ("messageId" in event && event.messageId === message.id)
        || ("message" in event && typeof event.message === "object" && event.message?.id === message.id));
      const deltas = wire.filter((event) => event.type === "message_delta");
      const resultPart = (await tools(handle))[0]!.result!.parts[0]!;
      expect(deltas).toHaveLength(chunks);
      expect(deltas.every((event) => event.type === "message_delta" && event.partId === resultPart.id && event.delta === delta)).toBe(true);
      expect(wire.filter((event) => event.type === "message_part")).toHaveLength(1); // Establish the initially-null result once.
      expect(wire.filter((event) => event.type === "message_replace")).toHaveLength(1); // Authoritative final aggregate only.
      expect(resultPart).toMatchObject({ type: "text", text: delta.repeat(chunks) });
      await handle.dispose();
      return Buffer.byteLength(JSON.stringify(wire));
    };
    const small = await run(20);
    const large = await run(40);
    expect(large / small).toBeLessThan(2.1); // Prefix resends grow quadratically and fail this bound.
  });

  it("retains native MCP image output and correlated file diff in canonical tool result parts/details", async () => {
    const { handle, peer } = await fixture();
    await prompt(handle);
    const { threadId, turnId } = await acceptedTurn(peer);
    for (const message of mcpImageEvents(threadId, turnId)) await controlPeer(peer, { action: "emit", message });
    expect((await tools(handle))[0]?.result?.parts).toEqual([
      expect.objectContaining({ type: "text", text: "Native image result" }),
      expect.objectContaining({ type: "image", mediaType: "image/png", data: codexFixturePng }),
    ]);
    await controlPeer(peer, { action: "approval", kind: "file", changes: [{ path: "hello.ts", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-old\n+new" }] });
    const approval = handle.state().pendingInteractions[0]!;
    expect(approval.body).toContain("hello.ts");
    expect(approval.body).toContain("-old\n+new");
    expect((await tools(handle)).at(-1)?.result?.details).toEqual({ diff: "@@ -1 +1 @@\n-old\n+new" });
    expect(handle.respondInteraction({ id: approval.id, sessionId: handle.sessionId, choiceID: "accept" })).toBe(true);
    await controlPeer(peer, { action: "complete" });
  });

  it("renders native plans/diffs contextually and preserves token metrics without invented cost or occupancy", async () => {
    const { handle, peer } = await fixture();
    const receipt = await prompt(handle);
    const threadId = handle.state().nativeSession.sessionId!;
    await controlPeer(peer, { action: "emit", message: { method: "turn/plan/updated", params: { threadId, turnId: receipt.nativeExecutionId, explanation: null, plan: [{ step: "Check result", status: "inProgress" }] } } });
    await controlPeer(peer, { action: "emit", message: { method: "turn/diff/updated", params: { threadId, turnId: receipt.nativeExecutionId, diff: "@@ -1 +1 @@\n-before\n+after" } } });
    await controlPeer(peer, { action: "emit", message: { method: "thread/tokenUsage/updated", params: { threadId, turnId: receipt.nativeExecutionId, tokenUsage: { total: { inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 5, outputTokens: 30, totalTokens: 130, reasoningOutputTokens: 10 }, last: { totalTokens: 130 }, modelContextWindow: 1_000 } } } });
    expect((await handle.messages()).some((message) => message.text?.includes("Check result"))).toBe(true);
    expect((await handle.messages()).some((message) => message.text?.includes("-before\n+after"))).toBe(true);
    expect(handle.state().stats.tokens).toEqual({ input: 100, output: 30, cacheRead: 20, cacheWrite: 5, total: 130 });
    expect(handle.state().stats.cost).toBeUndefined();
    expect(handle.state().stats.contextUsage).toBeUndefined();
    expect(handle.state().model?.contextWindow).toBe(1_000);
  });

  it("rejects unsupported modes/attachments and concurrent input at the adapter boundary", async () => {
    const { handle, peer } = await fixture();
    for (const mode of ["steer", "followUp", "normal"]) await expect(handle.prompt({ message: "input", mode, attachments: [], executionId: "x" })).rejects.toThrow("not supported");
    await expect(handle.prompt({ message: "input", mode: "prompt", attachments: [], executionId: "x", expectedExecutionId: "old" })).rejects.toThrow("steering is disabled");
    await expect(handle.prompt({ message: "input", mode: "prompt", executionId: "x", attachments: [{ type: "file", id: "f", name: "image", mediaType: "image/png", bytes: 1, path: "/synthetic/image", contentUrl: "/synthetic/image" }] })).rejects.toThrow("attachments");
    expect(await clientRequests(peer, "turn/start")).toHaveLength(0);
    await prompt(handle);
    await expect(prompt(handle, "guard-2")).rejects.toThrow("already active");
    expect(await clientRequests(peer, "turn/start")).toHaveLength(1);
    expect(await clientRequests(peer, "turn/steer")).toHaveLength(0);
  });

  it("does not fabricate acceptance or materialization on native prompt rejection", async () => {
    const { handle, peer } = await fixture();
    await controlPeer(peer, { action: "configure", prompt: "reject" });
    await expect(prompt(handle)).rejects.toThrow("Synthetic native prompt rejection");
    expect(handle.state()).toMatchObject({ phase: "idle", nativeSession: { status: "unmaterialized" } });
    expect(handle.state().activeExecution).toBeUndefined();
    expect(await handle.messages()).toEqual([]);
  });

  it("does not resurrect a turn whose native events finish before the acceptance response", async () => {
    const { handle, peer } = await fixture();
    await controlPeer(peer, { action: "configure", prompt: "defer" });
    const pending = prompt(handle);
    const request = await waitObserved(peer, (record) => record.direction === "client" && record.message.method === "turn/start");
    await controlPeer(peer, { action: "accept", requestId: request.message.id, reply: false });
    const { turnId } = await acceptedTurn(peer);
    await controlPeer(peer, { action: "text", delta: "Finished", done: true });
    await controlPeer(peer, { action: "complete" });
    await controlPeer(peer, { action: "release", requestId: request.message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
    expect(await pending).toMatchObject({ acknowledgement: "accepted", nativeExecutionId: turnId });
    expect(handle.state().phase).toBe("idle");
    expect(handle.state().activeExecution).toBeUndefined();
  });

  it("targets exact native execution for interrupt and rejects stale host guards without dispatch", async () => {
    const { handle, peer } = await fixture();
    const receipt = await prompt(handle);
    await controlPeer(peer, { action: "tool", delta: "still running" });
    await controlPeer(peer, { action: "configure", interrupt: "defer" });
    await expect(handle.interrupt("wrong-guard")).rejects.toThrow("no longer active");
    expect(await clientRequests(peer, "turn/interrupt")).toHaveLength(0);
    const interrupt = handle.interrupt(receipt.executionId);
    const request = await waitObserved(peer, (record) => record.direction === "client" && record.message.method === "turn/interrupt");
    expect(request.message.params).toEqual({ threadId: handle.state().nativeSession.sessionId, turnId: receipt.nativeExecutionId });
    expect(handle.state().phase).toBe("running");
    await controlPeer(peer, { action: "complete", status: "interrupted", idle: false });
    expect(await interrupt).toMatchObject({ acknowledged: true, nativeExecutionId: receipt.nativeExecutionId });
    expect(handle.state().phase).toBe("settling");
    expect((await tools(handle))[0]?.status).toBe("cancelled");
    await expect(handle.interrupt(receipt.executionId)).rejects.toThrow("no longer active");
    await controlPeer(peer, { action: "activity", status: { type: "idle" } });
    await prompt(handle, "next-guard");
    await expect(handle.interrupt(receipt.executionId)).rejects.toThrow("no longer active");
  });

  it("validates server-owned offered choices, exact session scope and single two-client resolution", async () => {
    const { handle, peer, events } = await fixture();
    await prompt(handle);
    await controlPeer(peer, { action: "approval", decisions: ["accept", "acceptForSession", "decline", "cancel"], requestId: 0 });
    const pending = handle.state().pendingInteractions[0]!;
    expect(pending.id).not.toBe("0");
    expect(pending.choices).toContainEqual({ id: "acceptForSession", label: "Allow for this session", meaning: "accept", scope: "session" });
    expect(handle.respondInteraction({ id: pending.id, sessionId: "other", choiceID: "accept" })).toBe(false);
    expect(handle.respondInteraction({ id: pending.id, sessionId: handle.sessionId, choiceID: "accept", scope: "session" })).toBe(false);
    expect(handle.respondInteraction({ id: pending.id, sessionId: handle.sessionId, cancelled: true })).toBe(false);
    const nativeRequest = await waitObserved(peer, (record) => record.direction === "server" && record.message.id === 0 && !!record.message.method);
    await controlPeer(peer, { action: "emit", message: nativeRequest.message });
    expect(events.filter((event) => event.type === "interaction")).toHaveLength(1);
    const response = { id: pending.id, sessionId: handle.sessionId, choiceID: "acceptForSession" };
    expect(handle.respondInteraction(response)).toBe(true);
    expect(handle.respondInteraction(response)).toBe(false);
    const nativeResponse = await waitObserved(peer, (record) => record.direction === "client" && record.message.id === 0 && !!record.message.result);
    expect(nativeResponse.message.result).toEqual({ decision: "acceptForSession" });
    expect(handle.state().pendingInteractions).toEqual([]);
  });

  it.each(["decline", "cancel"])("preserves native %s rather than collapsing both negative decisions", async (choiceID) => {
    const { handle, peer } = await fixture();
    await prompt(handle);
    await controlPeer(peer, { action: "approval" });
    const pending = handle.state().pendingInteractions[0]!;
    expect(handle.respondInteraction({ id: pending.id, sessionId: handle.sessionId, choiceID })).toBe(true);
    await expect.poll(async () => (await tools(handle))[0]?.status).toBe(choiceID === "cancel" ? "cancelled" : "error");
    await expect.poll(() => handle.state().phase).toBe(choiceID === "cancel" ? "idle" : "running");
    if (choiceID === "decline") expect(handle.state().activeExecution).toBeDefined();
  });

  it.each(["allowTurn", "allowSession"])("maps %s only to the exact requested native permission profile", async (choiceID) => {
    const { handle, peer } = await fixture();
    await prompt(handle);
    await controlPeer(peer, { action: "approval", kind: "permissions", requestId: "permissions", params: { environmentId: null, cwd: "/synthetic", reason: "Native request", permissions: { network: { enabled: true }, fileSystem: null } } });
    const pending = handle.state().pendingInteractions[0]!;
    expect(handle.respondInteraction({ id: pending.id, sessionId: handle.sessionId, choiceID, permissions: { network: { enabled: true } } })).toBe(false);
    expect(handle.respondInteraction({ id: pending.id, sessionId: handle.sessionId, choiceID })).toBe(true);
    const result = await waitObserved(peer, (record) => record.direction === "client" && record.message.id === "permissions" && !!record.message.result);
    expect(result.message.result).toEqual({ permissions: { network: { enabled: true } }, scope: choiceID === "allowTurn" ? "turn" : "session" });
  });

  it("expires/disconnects controls without approval, rejects late/native-resolved responses", async () => {
    const { handle, peer } = await fixture({ interactionTimeoutMs: 100 });
    await prompt(handle);
    await controlPeer(peer, { action: "approval", requestId: "expiring" });
    const pending = handle.state().pendingInteractions[0]!;
    await waitObserved(peer, (record) => record.direction === "client" && record.message.id === "expiring" && record.message.result?.decision === "cancel");
    expect(handle.respondInteraction({ id: pending.id, sessionId: handle.sessionId, choiceID: "accept" })).toBe(false);
    await expect.poll(() => handle.state().phase).toBe("idle");
    await prompt(handle, "second");
    await controlPeer(peer, { action: "approval", requestId: "disconnecting" });
    handle.cancelInteractions("disconnect");
    await waitObserved(peer, (record) => record.direction === "client" && record.message.id === "disconnecting" && record.message.result?.decision === "cancel");
    await expect.poll(() => handle.state().phase).toBe("idle");
    await prompt(handle, "third");
    await controlPeer(peer, { action: "approval", requestId: "resolved" });
    const resolved = handle.state().pendingInteractions[0]!;
    await controlPeer(peer, { action: "emit", message: { method: "serverRequest/resolved", params: { threadId: handle.state().nativeSession.sessionId, requestId: "resolved" } } });
    expect(handle.respondInteraction({ id: resolved.id, sessionId: handle.sessionId, choiceID: "accept" })).toBe(false);
  });

  it("fails closed at native ingress for unknown required controls and unsupported permission scopes", async () => {
    const { handle, peer } = await fixture();
    const receipt = await prompt(handle);
    const threadId = handle.state().nativeSession.sessionId!;
    await controlPeer(peer, { action: "emit", message: { id: "future", method: "future/required", params: { threadId, turnId: receipt.nativeExecutionId, secret: "native-only" } } });
    const error = await waitObserved(peer, (record) => record.direction === "client" && record.message.id === "future" && !!record.message.error);
    expect(error.message.error.code).toBe(-32601);
    expect((await clientRequests(peer, "turn/interrupt"))[0]?.message.params.turnId).toBe(receipt.nativeExecutionId);
    await expect.poll(() => handle.state().phase).toBe("idle");
    await prompt(handle, "next");
    await controlPeer(peer, { action: "approval", kind: "permissions", requestId: "bad-permissions", params: { permissions: { unknownPrivilege: true } } });
    const denied = await waitObserved(peer, (record) => record.direction === "client" && record.message.id === "bad-permissions" && !!record.message.result);
    expect(denied.message.result).toEqual({ permissions: {}, scope: "turn" });
    expect(handle.state().pendingInteractions).toHaveLength(0);
  });

  it("rejects stale/foreign approval callbacks without cancelling the newer native turn", async () => {
    const { handle, peer } = await fixture();
    const old = await prompt(handle);
    await controlPeer(peer, { action: "complete" });
    const current = await prompt(handle, "new-guard");
    const threadId = handle.state().nativeSession.sessionId!;
    const common = { itemId: "old-item", startedAtMs: Date.now() };
    for (const request of [
      { id: "old-command", method: "item/commandExecution/requestApproval", params: { ...common, threadId, turnId: old.nativeExecutionId,
        kind: "command", environmentId: null, command: "printf unused", cwd: "/synthetic", availableDecisions: ["accept", "decline", "cancel"] } },
      { id: "foreign-file", method: "item/fileChange/requestApproval", params: { ...common, threadId: "another-native-thread", turnId: current.nativeExecutionId } },
      { id: "old-permissions", method: "item/permissions/requestApproval", params: { ...common, threadId, turnId: old.nativeExecutionId,
        environmentId: null, cwd: "/synthetic", reason: null, permissions: { network: { enabled: true }, fileSystem: null } } },
    ]) {
      await controlPeer(peer, { action: "emit", message: request });
      const response = await waitObserved(peer, (record) => record.direction === "client" && record.message.id === request.id);
      expect(response.message.error?.code).toBe(-32600);
      expect(response.message.result).toBeUndefined();
      expect(handle.state()).toMatchObject({ phase: "running", activeExecution: { id: "new-guard", nativeExecutionId: current.nativeExecutionId }, pendingInteractions: [] });
      expect(handle.state().error).toBeUndefined();
    }
    expect(await clientRequests(peer, "turn/interrupt")).toHaveLength(0);
    await controlPeer(peer, { action: "text", delta: "New turn survives", done: true });
    await controlPeer(peer, { action: "complete" });
    expect((await handle.messages()).at(-1)?.text).toBe("New turn survives");
  });

  it("does not close a healthy transport when an unsupported control's cancel wins the interrupt race", async () => {
    const { handle, peer } = await fixture();
    await prompt(handle);
    await controlPeer(peer, { action: "approval", requestId: "unsupported", decisions: ["future-decision"] });
    await waitObserved(peer, (record) => record.direction === "client" && record.message.id === "unsupported" && record.message.result?.decision === "cancel");
    await expect.poll(() => handle.state().phase).toBe("idle");
    expect((await prompt(handle, "new-guard")).acknowledgement).toBe("accepted");
    expect(handle.state().activeExecution?.id).toBe("new-guard");
  });

  it("bounds/redacts additive native observations and preserves existing transcript through unknown items", async () => {
    const { handle, peer, events } = await fixture();
    const receipt = await prompt(handle);
    await controlPeer(peer, { action: "text", delta: "Keep this text", done: true });
    const before = await handle.messages();
    for (let index = 0; index < 40; index++) await controlPeer(peer, { action: "emit", message: { method: "future/info", params: { threadId: handle.state().nativeSession.sessionId, turnId: receipt.nativeExecutionId, access_token: "do-not-retain", url: "https://private.test/token" } } });
    await controlPeer(peer, { action: "emit", message: { method: "item/completed", params: { threadId: handle.state().nativeSession.sessionId, turnId: receipt.nativeExecutionId, item: { type: "futureItem", id: "new", password: "do-not-retain" } } } });
    expect(await handle.messages()).toEqual(before);
    const observations = events.filter((event) => event.type === "wire");
    expect(observations).toHaveLength(32);
    expect(JSON.stringify(observations)).not.toContain("do-not-retain");
    expect(JSON.stringify(observations)).not.toContain("private.test");
  });

  it("keeps native retry nonterminal and ignores stale error/text after completion", async () => {
    const { handle, peer } = await fixture();
    const receipt = await prompt(handle);
    await controlPeer(peer, { action: "error", willRetry: true, message: "Native retry" });
    expect(handle.state()).toMatchObject({ phase: "running", activity: "retrying", isRetrying: true });
    await controlPeer(peer, { action: "text", delta: "Done", done: true });
    await controlPeer(peer, { action: "complete" });
    const before = await handle.messages();
    await prompt(handle, "second");
    await controlPeer(peer, { action: "emit", message: { method: "error", params: { threadId: handle.state().nativeSession.sessionId, turnId: receipt.nativeExecutionId, error: { message: "stale error" }, willRetry: false } } });
    await controlPeer(peer, { action: "emit", message: { method: "item/agentMessage/delta", params: { threadId: handle.state().nativeSession.sessionId, turnId: receipt.nativeExecutionId, itemId: "answer", delta: "should-not-append" } } });
    expect((await handle.messages()).slice(0, before.length)).toEqual(before);
    expect(handle.state().error).not.toBe("stale error");
    expect(handle.state().activeExecution?.id).toBe("second");
  });

  it("marks native process loss unavailable and never resubmits pending input", async () => {
    const { handle, peer } = await fixture();
    await controlPeer(peer, { action: "configure", prompt: "defer" });
    const submission = prompt(handle);
    const rejection = expect(submission).rejects.toThrow("exited");
    await waitObserved(peer, (record) => record.direction === "client" && record.message.method === "turn/start");
    await controlPeer(peer, { action: "exit" });
    await rejection;
    expect(handle.state()).toMatchObject({ phase: "unavailable", activity: "idle", pendingInteractions: [], isStreaming: false });
    expect(handle.state().activeExecution).toBeUndefined();
    expect(await clientRequests(peer, "turn/start")).toHaveLength(1);
  });

  it("closes the owned transport after native thread closure and leaves no running tool or fresh dispatch", async () => {
    const { handle, peer } = await fixture();
    await prompt(handle);
    await controlPeer(peer, { action: "tool", delta: "partial output" });
    await controlPeer(peer, { action: "emit", message: { method: "thread/closed", params: { threadId: handle.state().nativeSession.sessionId } } });
    expect(handle.state()).toMatchObject({ phase: "unavailable", isStreaming: false });
    expect((await tools(handle))[0]?.status).toBe("error");
    await expect.poll(() => readFile(join(peer.directory, "closed.json"), "utf8").then((value) => JSON.parse(value).code, () => undefined)).toBe(0);
    await expect(prompt(handle, "after-close")).rejects.toThrow("closed");
    expect((await clientRequests(peer, "turn/start"))).toHaveLength(1);
  });

  it("recovers native materialization after host metadata stayed stale, without new identity or prompt replay", async () => {
    const { root, adapter, handle, peer, handles } = await fixture();
    const stale = handle.state().nativeSession;
    expect(stale.status).toBe("unmaterialized");
    await controlPeer(peer, { action: "configure", prompt: "defer" });
    const submission = prompt(handle);
    const rejection = expect(submission).rejects.toThrow("exited");
    const request = await waitObserved(peer, (record) => record.direction === "client" && record.message.method === "turn/start");
    await controlPeer(peer, { action: "accept", requestId: request.message.id, reply: false });
    await controlPeer(peer, { action: "exit" });
    await rejection;
    const reopened = await adapter.open({ sessionId: handle.sessionId, cwd: root, nativeSession: stale }); handles.push(reopened);
    expect(reopened.state()).toMatchObject({ sessionId: "web-session", phase: "idle", nativeSession: { sessionId: stale.sessionId, status: "resumable" } });
    expect((await reopened.messages())[0]?.text).toBe("Ordinary user input");
    const resumedPeer = await peerForThread(root, stale.sessionId!);
    expect(await clientRequests(resumedPeer, "thread/start")).toHaveLength(0);
    expect(await clientRequests(resumedPeer, "turn/start")).toHaveLength(0);
    expect((await adapter.list(root))[0]?.nativeSession.sessionId).toBe(stale.sessionId);
  });

  it("omits unknown hydrated item times instead of rebasing the conversation to reopen time", async () => {
    const { root, adapter, handle, peer, handles } = await fixture();
    await prompt(handle);
    await controlPeer(peer, { action: "tool", delta: "Known native output", done: true });
    await controlPeer(peer, { action: "text", delta: "Durable answer", done: true });
    await controlPeer(peer, { action: "complete" });
    const before = await handle.messages();
    expect(before.every((message) => message.timestamp !== undefined)).toBe(true);
    expect((await tools(handle))[0]?.startedAt).toBeDefined();
    const nativeSession = handle.state().nativeSession;
    await handle.dispose();
    const reopened = await adapter.open({ sessionId: handle.sessionId, cwd: root, nativeSession }); handles.push(reopened);
    const after = await reopened.messages();
    expect(after.map((message) => message.id)).toEqual(before.map((message) => message.id));
    expect(after.every((message) => message.timestamp === undefined)).toBe(true);
    expect((await tools(reopened))[0]?.startedAt).toBeUndefined();
    expect((await tools(reopened))[0]?.result).toEqual((before.find((message) => message.parts?.[0]?.type === "toolCall")!.parts![0] as ToolCallPartDto).result);
    expect(after.at(-1)?.text).toBe("Durable answer");
  });

  it("probes actual unmaterialized persistent IDs and reports failure rather than recreating", async () => {
    const { root, adapter, handle, handles } = await fixture();
    const ref = handle.state().nativeSession;
    await handle.dispose();
    const reopened = await adapter.open({ sessionId: handle.sessionId, cwd: root, nativeSession: ref }); handles.push(reopened);
    expect(reopened.state()).toMatchObject({ phase: "unavailable", nativeSession: { sessionId: ref.sessionId } });
    expect(reopened.state().error).toContain("no rollout");
    expect(await reopened.messages()).toEqual([]);
    expect(await adapter.list(root)).toEqual([]);
  });

  it("keeps ephemeral live history in its handle, then exposes expiry without launching native resume", async () => {
    const { root, adapter, handle, peer, handles } = await fixture({}, true);
    expect(handle.state().nativeSession.status).toBe("live-only");
    await prompt(handle);
    await controlPeer(peer, { action: "text", delta: "Ephemeral text", done: true });
    await controlPeer(peer, { action: "complete" });
    expect((await handle.messages()).at(-1)?.text).toBe("Ephemeral text");
    expect(await adapter.list(root)).toEqual([]);
    const before = (await readdir(join(root, "peers"))).length;
    const ref = handle.state().nativeSession;
    await handle.dispose();
    const reopened = await adapter.open({ sessionId: handle.sessionId, cwd: root, nativeSession: ref }); handles.push(reopened);
    expect(reopened.state()).toMatchObject({ phase: "unavailable", nativeSession: { persistence: "ephemeral", status: "unavailable" } });
    expect((await readdir(join(root, "peers"))).length).toBe(before);
    await expect(prompt(reopened)).rejects.toThrow("expired");
  });
});
