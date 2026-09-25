import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionMessage, SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { createMockHarness } from "../server/mock.js";
import { createPiAdapter } from "../server/session/adapters/pi/index.js";
import { createClaudeAdapter } from "../server/session/adapters/claude/index.js";
import { LocalSessionService } from "../server/session/service.js";
import { SessionActivity } from "../server/session/activity.js";
import { createHostSessionEventHandler } from "../server/session/hostEvents.js";
import { ClaudeNativePeer } from "./fixtures/claude-native-peer.js";

const roots: string[] = [];
const services: LocalSessionService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.disposeAll()));
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(cwd?: string, history: SessionMessage[] = [], info?: SDKSessionInfo) {
  if (!cwd) { cwd = await mkdtemp(join(tmpdir(), "pi-web-claude-service-")); roots.push(cwd); }
  vi.stubEnv("PI_WEB_SETTINGS_FILE", join(cwd, "settings.json"));
  const root = cwd;
  const mock = createMockHarness({ piCwd: root });
  const pi = createPiAdapter({
    modelRuntime: {} as Parameters<typeof createPiAdapter>[0]["modelRuntime"],
    peer: { create: async ({ path }) => ({ session: mock.createMockSession(path) }), list: async () => mock.mockSessions, newSessionAfterCreate: true },
    additionalExtensionPaths: () => [], defaultsFor: async () => ({}), globalCwd: () => root, clientCount: () => 1,
  });
  const peers: ClaudeNativePeer[] = [];
  const argumentsSeen: string[][] = [];
  const native = createClaudeAdapter({ pathToClaudeCodeExecutable: process.execPath,
    env: { CLAUDE_CONFIG_DIR: root, DISABLE_TELEMETRY: "1" },
    spawnClaudeCodeProcess: (options) => { const peer = new ClaudeNativePeer(); peers.push(peer); argumentsSeen.push(options.args); return peer; },
    sessionApi: { getSessionInfo: async () => info, getSessionMessages: async () => history, listSessions: async () => info ? [info] : [] },
  });
  const service = new LocalSessionService({ pi, adapters: [native], nativeBindingsFile: join(root, "native.json"), multiHarnessEnabled: true,
    finalizeCreatedSession: async () => undefined, globalCwd: () => root });
  services.push(service);
  const wire: unknown[] = [];
  const activity = new SessionActivity((id) => service.sessionForPath(id)?.state());
  service.subscribe(createHostSessionEventHandler({
    sessionForId: (id) => service.sessionForId(id), projectState: (handle) => service.projectState(handle), webUiEntries: (handle) => service.webUiEntries(handle),
    sessionActivity: activity, broadcast: (value) => wire.push(value), markSessionUnreadCompleted: () => undefined,
  }));
  return { cwd: root, service, peers, argumentsSeen, wire };
}

it("runs Claude through the one real service/host path, with native approvals, settlement and stale-binding recovery", async () => {
  const first = await fixture();
  const created = await first.service.create(undefined, first.cwd, "claude");
  expect(created.harnessId).toBe("claude");
  expect(created.sessionId).not.toBe(created.nativeSession!.sessionId);
  expect(created).not.toHaveProperty("sessionFile");
  const receipt = await first.service.prompt(created.sessionId, { message: "Service prompt", mode: "prompt", attachments: [], clientMessageId: "service-client", sourceClientId: "browser" });
  expect(receipt).toMatchObject({ acknowledgement: "pending" });
  const peer = first.peers[0]!;
  const input = await peer.nextInput((message) => message.type === "user");
  if (input.type !== "user" || !input.uuid) throw new Error("Native input missing");
  const nativeId = created.nativeSession!.sessionId!;
  const send = (message: Record<string, unknown>) => peer.send({ uuid: randomUUID(), session_id: nativeId, ...message });
  send({ ...input, isReplay: true });
  send({ type: "assistant", parent_tool_use_id: null, message: { id: "service-api", role: "assistant", model: "claude-fixture", content: [{ type: "tool_use", id: "service-tool", name: "Bash", input: { command: "pwd" } }], stop_reason: null, usage: {} } });
  send({ type: "control_request", request_id: "service-permission", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "pwd" }, tool_use_id: "service-tool" } });
  await vi.waitFor(async () => expect((await first.service.state(created.sessionId)).pendingInteractions).toHaveLength(1));
  const request = (await first.service.state(created.sessionId)).pendingInteractions![0]!;
  expect(first.wire).toContainEqual(expect.objectContaining({ type: "interaction_request", id: request.id, sessionId: created.sessionId }));
  expect(first.service.respondInteraction({ id: request.id, choiceID: "allow-once" })).toBe(false);
  expect(first.service.respondInteraction({ id: request.id, sessionId: created.sessionId, choiceID: "deny" })).toBe(true);
  expect(await peer.nextInput((message) => message.type === "control_response" && message.response.request_id === "service-permission")).toMatchObject({ response: { response: { behavior: "deny", toolUseID: "service-tool" } } });
  send({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "service-tool", content: "User declined", is_error: true }] } });
  send({ type: "result", subtype: "success", is_error: false, result: "Handled denial", user_message_uuid: input.uuid, result_index: 0,
    duration_ms: 1, duration_api_ms: 0, num_turns: 1, stop_reason: "end_turn", total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [] });
  await vi.waitFor(async () => expect((await first.service.state(created.sessionId)).phase).toBe("settling"));
  expect((await first.service.state(created.sessionId)).activeExecution?.id).toBe(receipt.executionId);
  send({ type: "system", subtype: "session_state_changed", state: "idle" });
  await vi.waitFor(async () => expect((await first.service.state(created.sessionId)).phase).toBe("idle"));
  expect(first.wire).toContainEqual(expect.objectContaining({ type: "message_part", sessionId: created.sessionId, part: expect.objectContaining({ type: "toolCall", toolCallId: "service-tool", status: "error" }) }));
  expect(first.wire).not.toContainEqual(expect.objectContaining({ type: "agent_event" }));
  const liveMessages = await first.service.messages(created.sessionId);
  expect(liveMessages).toHaveLength(2);
  expect(liveMessages[0]).toMatchObject({ role: "user", text: "Service prompt" });
  expect(liveMessages[1]?.parts?.[0]).toMatchObject({ type: "toolCall", result: { isError: true } });
  await first.service.disposeAll();
  const saved = JSON.parse(await readFile(join(first.cwd, "native.json"), "utf8"));
  const row = saved.sessions.find((entry: { id: string }) => entry.id === created.sessionId);
  expect(row.nativeSession.status).toBe("unmaterialized"); // Deliberately stale host observation.
  expect(row).not.toHaveProperty("messages");
  expect(row).not.toHaveProperty("sessionFile");

  // Native accepted/persisted immediately before host binding update/crash. The
  // supported SDK reader, not stale host metadata, now supplies that evidence.
  const history: SessionMessage[] = [{ type: "user", uuid: input.uuid, session_id: nativeId, parent_tool_use_id: null, parent_agent_id: null,
    message: { role: "user", content: "Service prompt" } }];
  const second = await fixture(first.cwd, history, { sessionId: nativeId, summary: "Recovered native session", cwd: first.cwd, lastModified: Date.now() });
  const reopened = await second.service.open(created.sessionId);
  expect(reopened.nativeSession).toMatchObject({ sessionId: nativeId, status: "resumable" });
  expect(second.peers).toHaveLength(0);
  expect((await second.service.messages(created.sessionId))[0]).toMatchObject({ text: "Service prompt" });
  await second.service.prompt(created.sessionId, { message: "Explicit new input", mode: "prompt", attachments: [] });
  expect(second.argumentsSeen[0]).toContain(`--resume=${nativeId}`);
  const newInput = await second.peers[0]!.nextInput((message) => message.type === "user");
  expect(newInput).toMatchObject({ message: { content: "Explicit new input" } });
  expect(second.peers[0]!.received.filter((message) => message.type === "user")).toHaveLength(1); // No replay/recreation.
}, 15_000);
