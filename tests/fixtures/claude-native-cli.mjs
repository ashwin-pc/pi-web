#!/usr/bin/env node
// Synthetic executable peer for real server.ts + real Agent SDK browser tests.
// Never reads/writes a native agent home or transcript store. Node >=24 strips
// the fixture's erasable TypeScript types; no extra loader/process framework.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { ClaudeNativePeer } from "./claude-native-peer.ts";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("2.1.270 (synthetic Claude Code peer)");
  process.exit(0);
}
const root = process.env.PI_WEB_CLAUDE_PEER_DIR;
if (!root) throw new Error("Synthetic Claude CLI requires PI_WEB_CLAUDE_PEER_DIR");
const option = (name) => {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const nativeSessionId = option("--resume") ?? option("--session-id") ?? randomUUID();
const directory = join(resolve(root), "peers", String(process.pid));
const commands = join(directory, "commands");
mkdirSync(commands, { recursive: true });
const observed = join(directory, "observed.jsonl");
const record = (direction, message) => appendFileSync(observed, `${JSON.stringify({ direction, message })}\n`);
const peer = new ClaudeNativePeer();
const send = (message) => peer.send({ uuid: randomUUID(), session_id: nativeSessionId, ...message });
const init = () => send({
  type: "system", subtype: "init", claude_code_version: "2.1.270", cwd: process.cwd(),
  apiKeySource: "none", model: "claude-fixture", permissionMode: option("--permission-mode") ?? "default",
  tools: ["Read", "Bash", "AskUserQuestion"], mcp_servers: [], slash_commands: [],
  output_style: "default", skills: [], plugins: [], capabilities: ["interrupt_receipt_v1"],
});
let output = "";
const decoder = new StringDecoder("utf8");
peer.stdout.on("data", (chunk) => {
  output += decoder.write(chunk);
  let newline;
  while ((newline = output.indexOf("\n")) !== -1) {
    const line = output.slice(0, newline);
    output = output.slice(newline + 1);
    try { record("server", JSON.parse(line)); }
    catch { record("fixture-error", { reason: "non-JSON output", bytes: Buffer.byteLength(line) }); }
  }
});
peer.stdout.pipe(process.stdout);
peer.on("input", (message) => {
  record("client", message);
  if (message.type === "user") {
    init();
    if (args.includes("--replay-user-messages")) send({ ...message, session_id: nativeSessionId, uuid: message.uuid ?? randomUUID(), isReplay: true });
    if (message.shouldQuery !== false) send({ type: "system", subtype: "session_state_changed", state: "running" });
  }
  if (message.type === "control_request" && message.request.subtype === "interrupt") {
    // Acknowledge the command, not settlement. Tests emit result/idle separately.
    peer.send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { still_queued: [] } } });
  }
});
process.stdin.pipe(peer.stdin);
peer.stdin.on("error", () => { record("fixture-error", { reason: "invalid SDK input" }); peer.exit(65); });
const processed = new Set();
const poll = setInterval(() => {
  for (const filename of readdirSync(commands).filter((name) => /^\d+.*\.json$/.test(name)).sort()) {
    if (processed.has(filename)) continue;
    processed.add(filename);
    try {
      const text = readFileSync(join(commands, filename), "utf8");
      if (text.length > 1024 * 1024) throw new Error("command too large");
      const command = JSON.parse(text);
      record("control", command);
      if (command.action === "emit" && command.message && typeof command.message === "object") send(command.message);
      else if (command.action === "raw" && typeof command.data === "string") peer.sendRaw(command.data);
      else if (command.action === "exit" && Number.isInteger(command.code) && command.code >= 0 && command.code <= 255) { peer.exit(command.code); return; }
      else throw new Error("unsupported fixture command");
    } catch {
      record("fixture-error", { reason: "invalid scratch command", filename });
      peer.exit(65);
      return;
    }
  }
}, 20);
// Finite by default; browser harnesses must clean up their own server/children.
const maximumMs = Math.min(300_000, Math.max(1000, Number(process.env.PI_WEB_CLAUDE_PEER_MAX_MS) || 120_000));
const lifetime = setTimeout(() => peer.exit(70), maximumMs);
peer.on("exit", (code, signal) => {
  clearInterval(poll);
  clearTimeout(lifetime);
  process.stdin.pause();
  writeFileSync(join(directory, "exit.json"), JSON.stringify({ code, signal }));
  process.stdout.write("", () => process.exit(code ?? 1));
});
const manifest = { pid: process.pid, directory, nativeSessionId, cwd: process.cwd(), resume: Boolean(option("--resume")) };
writeFileSync(join(directory, "ready.tmp"), JSON.stringify(manifest));
renameSync(join(directory, "ready.tmp"), join(directory, "ready.json"));
