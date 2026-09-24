#!/usr/bin/env node
/** Synthetic ACP v1 / Kiro 2.24.0 executable. No model, native config or native
 * private store. Commands and synthetic persistence live only in the owned root.
 * Startup, settings, catalog and error shapes follow the real 2026-09-24 zero-model
 * probe. Prompt/permission controls remain synthetic. Tests may supply the real
 * canary's rawOutput.items[].Text shape with synthetic content through fields. */
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
const root = process.env.PI_WEB_KIRO_PEER_DIR;
if (!root) throw new Error("PI_WEB_KIRO_PEER_DIR is required");
mkdirSync(root, { recursive: true });
const read = (file, fallback) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; } };
const configuration = read(join(root, "config.json"), {});
const args = process.argv.slice(2);
const stage = args[0] === "--version" ? "version" : args[0] === "chat" ? "catalog" : "acp";
appendFileSync(join(root, "launches.jsonl"), `${JSON.stringify({ stage, args, tokenKeys: Object.keys(process.env).filter((key) => key.toUpperCase() === "PI_WEB_TOKEN"), sentinel: process.env.KIRO_NATIVE_SENTINEL })}\n`);
if (stage === "version") { process.stdout.write(`kiro-cli ${configuration.version ?? "2.24.0"}\n`); process.exit(configuration.versionExit ?? 0); }
const stored = join(root, "synthetic-sessions"); mkdirSync(stored, { recursive: true });
if (stage === "catalog") {
  if (JSON.stringify(args) !== JSON.stringify(["chat", "--agent-engine", "v2", "--list-sessions", "--format", "json"])) process.exit(2);
  const sessions = readdirSync(stored).map((file) => read(join(stored, file), {})).filter((s) => s.cwd === process.cwd()).map((s) => ({ sessionId: s.id, source: "v2", title: s.title, updatedAt: s.updatedAt, messageCount: s.history.length, status: "idle" }));
  process.stdout.write(configuration.catalogRaw ?? JSON.stringify(configuration.catalog ?? [{ cwd: process.cwd(), sessions, complete: true }])); process.exit(0);
}
if (JSON.stringify(args) !== JSON.stringify(["acp", "--agent-engine", "v2"])) process.exit(2);
const directory = join(root, "peers", String(process.pid)); const commands = join(directory, "commands");
mkdirSync(commands, { recursive: true });
const observed = join(directory, "observed.jsonl"); writeFileSync(observed, "");
writeFileSync(join(directory, "ready.json"), JSON.stringify({ pid: process.pid, directory }));
process.on("exit", (code) => writeFileSync(join(directory, "closed.json"), JSON.stringify({ code })));
const log = (direction, message) => appendFileSync(observed, `${JSON.stringify({ direction, message })}\n`);
const send = (message) => { const frame = { jsonrpc: "2.0", ...message }; log("server", frame); process.stdout.write(`${JSON.stringify(frame)}\n`); };
const reply = (id, result = {}) => send({ id, result });
const reject = (id, message = "Synthetic Kiro rejection", code = -32600, data) => send({ id, error: { code, message, ...(data === undefined ? {} : { data }) } });
let session; let prompt; let serial = Promise.resolve();
let config = { interrupt: "complete", ...configuration };
const file = (id) => join(stored, `${encodeURIComponent(id)}.json`);
const save = () => { if (session?.materialized) writeFileSync(file(session.id), JSON.stringify(session)); };
function update(value) {
  const frame = { method: "session/update", params: { sessionId: session.id, update: value } };
  session.history.push(value); save(); send(frame);
}
const settings = () => ({ modes: { currentModeId: "native-fixture-mode", availableModes: [{ id: "native-fixture-mode", name: "Native fixture mode" }] },
  models: { currentModelId: "native-fixture-model", availableModels: [{ modelId: "native-fixture-model", name: "Native fixture model", description: "Synthetic model" }] } });
function startup(before) {
  const commands = () => send({ method: "_kiro.dev/commands/available", params: { sessionId: session.id,
    commands: [{ name: "synthetic", description: "x".repeat(config.startupBytes ?? 80000), meta: {} }], prompts: [], tools: [], mcpServers: [] } });
  if (before) {
    for (const serverName of ["synthetic-first", "synthetic-second"]) { send({ method: "_kiro.dev/mcp/server_initialized", params: { sessionId: session.id, serverName } }); commands(); }
    send({ method: "_kiro.dev/subagent/list_update", params: { subagents: [], pendingStages: [] } });
  } else {
    commands(); send({ method: "_kiro.dev/metadata", params: { sessionId: session.id, contextUsagePercentage: 12.5, reasoning: { support: "unavailable", effortLevels: [] } } });
  }
}
function complete(reason = "end_turn") { if (!prompt) throw new Error("No active prompt"); reply(prompt.id, { stopReason: reason }); prompt = undefined; save(); }
async function client(message) {
  log("client", message);
  if (!message.method) return;
  const { id, method, params = {} } = message;
  if (method === "initialize") return reply(id, { protocolVersion: config.protocolVersion ?? 1, agentInfo: { name: "Kiro CLI Agent", title: "Kiro CLI Agent", version: "2.24.0" }, agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: false }, mcpCapabilities: { http: true, sse: false }, sessionCapabilities: {}, auth: {} }, authMethods: [] });
  if (method === "session/new") {
    if (config.newError) return reject(id);
    session = { id: randomUUID(), cwd: params.cwd, title: "Synthetic Kiro session", updatedAt: new Date().toISOString(), history: [], materialized: true };
    save(); startup(true); reply(id, { sessionId: session.id, ...settings() }); startup(false); return;
  }
  if (method === "session/load") {
    session = read(file(params.sessionId));
    if (!session) return reject(id, "Internal error", -32603, `Failed to start session: Session not found: ${params.sessionId}`);
    startup(true);
    for (const update of session.history) send({ method: "session/update", params: { sessionId: session.id, update } });
    reply(id, settings()); startup(false); return;
  }
  if (method === "session/prompt") {
    if (!session || session.id !== params.sessionId || prompt) return reject(id);
    if (config.prompt === "reject") return reject(id, "Synthetic Kiro prompt rejection");
    prompt = message;
    session.materialized = true; session.updatedAt = new Date().toISOString();
    session.history.push({ sessionUpdate: "user_message_chunk", content: params.prompt[0] }); save();
    for (const command of config.onPrompt ?? []) await control(command);
    return;
  }
  if (method === "session/cancel") {
    if (Object.hasOwn(message, "id")) throw new Error("ACP cancel must be a notification");
    if (prompt && config.interrupt !== "defer") complete("cancelled"); return;
  }
  reject(id, "Method not found", -32601, method);
}
async function control(command) {
  switch (command.action) {
    case "configure": config = { ...config, ...command }; return;
    case "exit": process.exit(command.code ?? 17);
    case "raw": process.stdout.write(command.base64 ? Buffer.from(command.base64, "base64") : command.text); return;
    case "stderr": process.stderr.write("x".repeat(command.bytes ?? 1000000)); return;
    case "descendant": {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      writeFileSync(join(directory, "descendant.json"), JSON.stringify({ pid: child.pid })); child.unref(); return;
    }
    case "emit": {
      const message = structuredClone(command.message);
      if (message.method === "session/update" && command.persist !== false) { session.history.push(message.params.update); save(); }
      send(message); return;
    }
    case "release": send({ id: command.requestId ?? prompt?.id, ...(command.error ? { error: command.error } : { result: command.result }) }); prompt = undefined; return;
    case "text": case "thinking": update({ sessionUpdate: command.action === "text" ? "agent_message_chunk" : "agent_thought_chunk", ...(command.messageId ? { messageId: command.messageId } : {}), content: { type: "text", text: command.delta ?? "" } }); return;
    case "tool": update({ sessionUpdate: command.update ? "tool_call_update" : "tool_call", toolCallId: command.itemId ?? "tool", ...(command.update ? {} : { title: "Read owned file", kind: "read", rawInput: { path: "owned.txt" }, status: "in_progress" }), ...command.fields }); return;
    case "approval": send({ id: command.requestId ?? randomUUID(), method: "session/request_permission", params: { sessionId: session.id,
      toolCall: command.toolCall ?? { toolCallId: command.itemId ?? "permission-tool", title: "Read owned file", kind: "read", rawInput: { path: "owned.txt" } },
      options: command.options ?? [{ optionId: "native-once", name: "Allow once", kind: "allow_once" }, { optionId: "native-deny", name: "Reject once", kind: "reject_once" }, { optionId: "native-always", name: "Always allow", kind: "allow_always" }] } }); return;
    case "complete": complete(command.reason); return;
    default: throw new Error(`Unknown synthetic control ${command.action}`);
  }
}
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); }
  catch { send({ error: { code: -32700, message: "Parse error", data: { line } } }); return; }
  serial = serial.then(() => client(message)).catch((e) => { log("fixture-error", { message: e.message }); });
});
input.on("close", () => { clearInterval(timer); void serial.finally(() => process.exit(0)); });
const processed = new Set();
const timer = setInterval(() => {
  for (const name of readdirSync(commands).filter((s) => /^\d+\.json$/.test(s)).sort()) {
    if (processed.has(name)) continue; processed.add(name);
    const command = read(join(commands, name));
    serial = serial.then(() => control(command)).then(() => log("control", { file: name, action: command.action })).catch((e) => log("fixture-error", { message: e.message }));
  }
}, 10);
setTimeout(() => process.exit(124), 120000).unref();
