#!/usr/bin/env node
/** Synthetic Codex 0.154.0 app-server peer. No models, credentials or real native files.
 * Control uses atomic numbered JSON files in PI_WEB_CODEX_PEER_DIR/peers/<pid>/commands.
 * Both directions of the native wire are recorded in observed.jsonl. User text never
 * selects a scenario: controls are independent of submitted prompts.
 */
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const root = process.env.PI_WEB_CODEX_PEER_DIR;
if (!root) throw new Error("PI_WEB_CODEX_PEER_DIR is required for the synthetic peer");
const dir = join(root, "peers", String(process.pid));
const commands = join(dir, "commands");
const stored = join(root, "threads");
mkdirSync(commands, { recursive: true });
mkdirSync(stored, { recursive: true });
const observed = join(dir, "observed.jsonl");
writeFileSync(observed, "");
writeFileSync(join(dir, "ready.json"), JSON.stringify({ pid: process.pid, directory: dir }));
process.on("exit", (code) => { writeFileSync(join(dir, "closed.json"), JSON.stringify({ code })); });

const threads = new Map();
const controls = new Map();
const held = new Map();
const processed = new Set();
let initialized = false;
let currentThread;
let currentTurn;
let configuration = { prompt: "accept", interrupt: "complete", onTurn: [] };
let serial = Promise.resolve();

function log(direction, message) {
  appendFileSync(observed, `${JSON.stringify({ direction, message })}\n`);
}
function send(message) { log("server", message); process.stdout.write(`${JSON.stringify(message)}\n`); }
function response(id, result = {}) { send({ id, result }); }
function reject(id, message, code = -32600) { send({ id, error: { code, message } }); }
function notify(method, params) { send({ method, params }); }
function threadFile(id) { return join(stored, `${encodeURIComponent(id)}.json`); }
function save(thread) {
  if (!thread.ephemeral && thread.materialized) writeFileSync(threadFile(thread.id), JSON.stringify(thread));
}
function view(thread, includeTurns = false) {
  const { materialized, ...value } = thread;
  return { ...value, turns: includeTurns ? value.turns : [] };
}
function settings(thread) {
  return { thread: view(thread), model: "native-fixture-model", modelProvider: "native-fixture", cwd: thread.cwd,
    serviceTier: null, runtimeWorkspaceRoots: [thread.cwd], instructionSources: [], approvalPolicy: "on-request", approvalsReviewer: "user",
    sandbox: { type: "readOnly", networkAccess: false }, activePermissionProfile: null, reasoningEffort: "medium", multiAgentMode: "explicitRequestOnly" };
}
function selected(command = {}) {
  const thread = threads.get(command.threadId ?? currentThread);
  if (!thread) throw new Error("No selected synthetic thread");
  const turn = thread.turns.find((value) => value.id === (command.turnId ?? currentTurn));
  return { thread, turn };
}
function activity(thread, status) {
  thread.status = status;
  notify("thread/status/changed", { threadId: thread.id, status });
  save(thread);
}
function itemEvent(method, thread, turn, item) {
  const index = turn.items.findIndex((entry) => entry.id === item.id);
  if (index < 0) turn.items.push(item); else turn.items[index] = item;
  notify(method, { threadId: thread.id, turnId: turn.id, item,
    ...(method === "item/completed" ? { completedAtMs: Date.now() } : { startedAtMs: Date.now() }) });
  save(thread);
}
function itemFor(thread, turn, id, type, fields) {
  let item = turn.items.find((entry) => entry.id === id);
  if (!item) {
    item = { type, id, ...fields };
    itemEvent("item/started", thread, turn, item);
  }
  return item;
}
function settle(thread, turn, status = "completed", idle = true) {
  for (const item of turn.items) {
    if (item.type === "agentMessage" || item.type === "reasoning") itemEvent("item/completed", thread, turn, item);
  }
  turn.status = status;
  turn.completedAt = Math.floor(Date.now() / 1000);
  notify("turn/completed", { threadId: thread.id, turn: { ...turn, items: [] } });
  for (const [id, request] of held) {
    if (request.method === "turn/interrupt" && request.params.turnId === turn.id) { response(id); held.delete(id); }
  }
  for (const [id, request] of controls) {
    if (request.params.turnId === turn.id) {
      controls.delete(id);
      notify("serverRequest/resolved", { threadId: thread.id, requestId: id });
    }
  }
  if (idle) activity(thread, { type: "idle" });
  save(thread);
}
function storeNative(message) {
  const params = message.params ?? {};
  const thread = threads.get(params.threadId);
  if (!thread) return;
  if (message.method === "thread/status/changed") thread.status = params.status;
  const turn = thread.turns.find((value) => value.id === (params.turnId ?? params.turn?.id));
  if (turn && (message.method === "item/started" || message.method === "item/completed")) {
    const index = turn.items.findIndex((item) => item.id === params.item.id);
    if (index < 0) turn.items.push(params.item); else turn.items[index] = params.item;
  }
  if (turn && message.method === "turn/completed") Object.assign(turn, params.turn, { items: turn.items });
  save(thread);
}

async function acceptTurn(request, reply = true) {
  const thread = threads.get(request.params.threadId);
  if (!thread) return reject(request.id, "thread not loaded");
  const active = thread.turns.findLast((turn) => turn.status === "inProgress");
  const turn = active ?? { id: randomUUID(), items: [], itemsView: "notLoaded", status: "inProgress", error: null,
    startedAt: Math.floor(Date.now() / 1000), completedAt: null, durationMs: null };
  if (!active) thread.turns.push(turn);
  currentThread = thread.id;
  currentTurn = turn.id;
  thread.materialized = true;
  thread.updatedAt = Math.floor(Date.now() / 1000);
  if (!thread.preview) thread.preview = (request.params.input ?? []).filter((input) => input.type === "text").map((input) => input.text).join("\n");
  save(thread);
  if (reply) response(request.id, { turn: { ...turn, items: [] } });
  if (!active) {
    notify("turn/started", { threadId: thread.id, turn: { ...turn, items: [] } });
    activity(thread, { type: "active", activeFlags: [] });
  }
  const user = { type: "userMessage", id: randomUUID(), clientId: request.params.clientUserMessageId ?? null, content: request.params.input };
  itemEvent("item/started", thread, turn, user);
  itemEvent("item/completed", thread, turn, user);
  for (const command of configuration.onTurn ?? []) await control(command);
}

async function client(message) {
  log("client", message);
  if (!message.method) {
    const request = controls.get(message.id);
    if (!request) return;
    controls.delete(message.id);
    const thread = threads.get(request.params?.threadId);
    if (!thread) return;
    const turn = thread.turns.find((value) => value.id === request.params?.turnId);
    notify("serverRequest/resolved", { threadId: thread.id, requestId: message.id });
    const decision = message.result?.decision;
    const item = turn?.items.find((entry) => entry.id === request.params.itemId);
    if (item && ["commandExecution", "fileChange"].includes(item.type)) {
      item.status = message.error ? "failed" : ["decline", "cancel"].includes(decision) ? "declined" : "completed";
      if (item.type === "commandExecution") Object.assign(item, { aggregatedOutput: "synthetic result", exitCode: decision === "accept" ? 0 : null, durationMs: 1 });
      itemEvent("item/completed", thread, turn, item);
    }
    if (decision === "cancel" && turn) settle(thread, turn, "interrupted");
    else if (turn) activity(thread, { type: "active", activeFlags: [] });
    return;
  }
  const { method, id, params = {} } = message;
  if (method === "initialize") {
    if (initialized) return reject(id, "Already initialized");
    initialized = true;
    return response(id, { userAgent: "codex-native-peer/0.154.0 (synthetic)", codexHome: "/synthetic/native-home", platformFamily: "unix", platformOs: "linux" });
  }
  if (method === "initialized") return;
  if (!initialized) return reject(id, "Not initialized");
  if (method === "model/list") return response(id, { data: [{ id: "native-fixture-model", model: "native-fixture-model", displayName: "Native fixture", isDefault: true, hidden: false,
    upgrade: null, upgradeInfo: null, availabilityNux: null, description: "Synthetic native catalog", modelSpecialty: null,
    multiAgentVersion: null, additionalSpeedTiers: [], serviceTiers: [], defaultServiceTier: null,
    supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Low" }, { reasoningEffort: "medium", description: "Medium" }], defaultReasoningEffort: "low", inputModalities: ["text"], supportsPersonality: false }], nextCursor: null });
  if (method === "account/read") return response(id, { account: { type: "amazonBedrock" }, requiresOpenaiAuth: false });
  if (method === "thread/start") {
    const thread = { id: randomUUID(), sessionId: null, forkedFromId: null, parentThreadId: null, preview: "", ephemeral: Boolean(params.ephemeral),
      environments: null, extra: null, section: null, sectionEnteredAt: null, projectId: null, recencyAt: null,
      canAcceptDirectInput: true, threadSource: null, agentNickname: null, agentRole: null, gitInfo: null, daybreakEnabled: null,
      path: params.ephemeral ? null : "/synthetic/unstable-path", cwd: params.cwd ?? process.cwd(), status: { type: "idle" },
      historyMode: "legacy", modelProvider: "native-fixture", model: "native-fixture-model", reasoningEffort: "medium",
      createdAt: Math.floor(Date.now() / 1000), updatedAt: Math.floor(Date.now() / 1000), source: "appServer", originator: "native-fixture", cliVersion: "0.154.0", name: null, turns: [], materialized: false };
    thread.sessionId = thread.id;
    threads.set(thread.id, thread); currentThread = thread.id;
    response(id, settings(thread)); notify("thread/started", { thread: view(thread) }); return;
  }
  if (method === "thread/resume" || method === "thread/read") {
    let thread = threads.get(params.threadId);
    if (method === "thread/resume" && (!thread || !thread.materialized || thread.ephemeral)) {
      if (!existsSync(threadFile(params.threadId))) return reject(id, "no rollout found for thread id");
      thread = JSON.parse(readFileSync(threadFile(params.threadId), "utf8"));
      thread.status = { type: "idle" };
    }
    if (!thread && existsSync(threadFile(params.threadId))) thread = JSON.parse(readFileSync(threadFile(params.threadId), "utf8"));
    if (!thread) return reject(id, "no rollout found for thread id");
    if (params.includeTurns && (thread.ephemeral || !thread.materialized)) return reject(id, "includeTurns unavailable for this thread");
    if (method === "thread/read") return response(id, { thread: view(thread, params.includeTurns) });
    threads.set(thread.id, thread); currentThread = thread.id; currentTurn = thread.turns.at(-1)?.id;
    response(id, { ...settings(thread), thread: view(thread, true), initialTurnsPage: null, turnsBackwardsCursor: null, itemsBackwardsCursor: null });
    notify("thread/started", { thread: view(thread) }); return;
  }
  if (method === "thread/list") {
    const data = readdirSync(stored).map((file) => JSON.parse(readFileSync(join(stored, file), "utf8")))
      .filter((thread) => !params.cwd || (Array.isArray(params.cwd) ? params.cwd.includes(thread.cwd) : thread.cwd === params.cwd));
    return response(id, { data: data.map((thread) => view(thread)), nextCursor: null });
  }
  if (method === "thread/loaded/list") return response(id, { data: [...threads.keys()], nextCursor: null });
  if (method === "thread/unsubscribe") return response(id, { status: threads.has(params.threadId) ? "unsubscribed" : "notLoaded" });
  if (method === "thread/delete") { threads.delete(params.threadId); rmSync(threadFile(params.threadId), { force: true }); return response(id); }
  if (method === "thread/name/set") {
    const thread = threads.get(params.threadId);
    if (!thread) return reject(id, "thread not loaded");
    thread.name = params.name; save(thread); response(id); notify("thread/name/updated", { threadId: thread.id, threadName: params.name }); return;
  }
  if (method === "turn/start") {
    if (configuration.prompt === "reject") return reject(id, "Synthetic native prompt rejection");
    if (configuration.prompt === "defer") { held.set(id, message); return; }
    return acceptTurn(message);
  }
  if (method === "turn/steer" || method === "turn/interrupt") {
    const thread = threads.get(params.threadId);
    const turn = thread?.turns.findLast((value) => value.status === "inProgress");
    if (!turn) return reject(id, "no active turn");
    if ((params.expectedTurnId ?? params.turnId) !== turn.id) return reject(id, "expected active turn id mismatch");
    if (method === "turn/steer") return response(id, { turnId: turn.id });
    held.set(id, message);
    if (configuration.interrupt !== "defer") settle(thread, turn, "interrupted");
    return;
  }
  reject(id, `Unsupported synthetic native method: ${method}`, -32601);
}

async function control(command) {
  if (command.action === "configure") { configuration = { ...configuration, ...command }; return; }
  if (command.action === "exit") { process.exit(command.code ?? 17); }
  if (command.action === "raw") { process.stdout.write(command.text); return; }
  if (command.action === "emit") {
    if (command.message.method && Object.hasOwn(command.message, "id")) controls.set(command.message.id, command.message);
    storeNative(command.message); send(command.message); return;
  }
  if (command.action === "accept" || command.action === "reject" || command.action === "release") {
    const pair = command.requestId !== undefined ? [command.requestId, held.get(command.requestId)] : [...held].findLast(([, request]) => request.method === "turn/start");
    if (!pair?.[1]) throw new Error("No held synthetic request");
    const [id, request] = pair;
    if (command.action !== "accept" || command.reply !== false) held.delete(id);
    if (command.action === "reject") return reject(id, command.message ?? "Synthetic native rejection");
    if (command.action === "release") return command.error ? send({ id, error: command.error }) : response(id, command.result);
    return acceptTurn(request, command.reply !== false);
  }
  const { thread, turn } = selected(command);
  if (command.action === "activity") return activity(thread, command.status);
  if (!turn) throw new Error("No selected synthetic turn");
  const ids = { threadId: thread.id, turnId: turn.id };
  if (command.action === "text") {
    const item = itemFor(thread, turn, command.itemId ?? "answer", "agentMessage", { text: "", phase: "final_answer", memoryCitation: null, delivery: null, questions: null });
    item.text += command.delta ?? "";
    notify("item/agentMessage/delta", { ...ids, itemId: item.id, delta: command.delta ?? "" });
    if (command.done) { if (command.text !== undefined) item.text = command.text; itemEvent("item/completed", thread, turn, item); }
  } else if (command.action === "thinking") {
    const item = itemFor(thread, turn, command.itemId ?? "reasoning", "reasoning", { summary: [], content: [] });
    const index = command.summaryIndex ?? 0;
    item.summary[index] = (item.summary[index] ?? "") + (command.delta ?? "");
    notify("item/reasoning/summaryTextDelta", { ...ids, itemId: item.id, delta: command.delta ?? "", summaryIndex: index });
    if (command.done) itemEvent("item/completed", thread, turn, item);
  } else if (command.action === "tool") {
    const item = itemFor(thread, turn, command.itemId ?? "command", "commandExecution", {
      command: command.command ?? "printf synthetic", cwd: thread.cwd, processId: "synthetic-process", source: "agent", status: "inProgress",
      commandActions: [], aggregatedOutput: "", exitCode: null, durationMs: null, pluginId: null, scriptPath: null });
    if (command.delta !== undefined) { item.aggregatedOutput += command.delta; notify("item/commandExecution/outputDelta", { ...ids, itemId: item.id, delta: command.delta }); }
    if (command.done) { Object.assign(item, { status: command.status ?? "completed", exitCode: command.exitCode ?? 0, durationMs: 1 }); itemEvent("item/completed", thread, turn, item); }
  } else if (command.action === "approval") {
    const itemId = command.itemId ?? "approved-command";
    const kind = command.kind ?? "command";
    if (kind === "command") itemFor(thread, turn, itemId, "commandExecution", { command: command.command ?? "printf approved", cwd: thread.cwd,
      processId: null, source: "agent", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null, pluginId: null, scriptPath: null });
    if (kind === "file") itemFor(thread, turn, itemId, "fileChange", { changes: command.changes ?? [{ path: "example.txt", kind: { type: "add" }, diff: "+synthetic" }], status: "inProgress" });
    const method = kind === "command" ? "item/commandExecution/requestApproval" : kind === "file" ? "item/fileChange/requestApproval" : kind === "permissions" ? "item/permissions/requestApproval" : kind === "input" ? "item/tool/requestUserInput" : "mcpServer/elicitation/request";
    const params = { ...ids, itemId, startedAtMs: Date.now(), ...(kind === "command" ? { kind: "command", environmentId: null, command: command.command ?? "printf approved", cwd: thread.cwd, commandActions: [], availableDecisions: command.decisions ?? ["accept", "decline", "cancel"] } : {}), ...command.params };
    const request = { id: command.requestId ?? `approval-${randomUUID()}`, method, params };
    controls.set(request.id, request); send(request);
    activity(thread, { type: "active", activeFlags: ["waitingOnApproval"] });
  } else if (command.action === "complete") settle(thread, turn, command.status ?? "completed", command.idle !== false);
  else if (command.action === "error") notify("error", { ...ids, willRetry: Boolean(command.willRetry), error: { message: command.message ?? "Synthetic native failure", codexErrorInfo: "other", additionalDetails: null, misalignment: null } });
  else throw new Error(`Unknown control action ${command.action}`);
  save(thread);
}

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  serial = serial.then(() => client(JSON.parse(line))).catch((error) => { log("fixture-error", { message: error.message }); process.exitCode = 1; });
});
input.on("close", () => { clearInterval(timer); void serial.finally(() => process.exit(process.exitCode ?? 0)); });
const timer = setInterval(() => {
  for (const file of readdirSync(commands).filter((name) => /^\d+\.json$/.test(name)).sort()) {
    if (processed.has(file)) continue;
    processed.add(file);
    const command = JSON.parse(readFileSync(join(commands, file), "utf8"));
    serial = serial.then(() => control(command)).then(() => log("control", { file, action: command.action }))
      .catch((error) => { log("fixture-error", { file, message: error.message }); process.exitCode = 1; });
  }
}, 10);
