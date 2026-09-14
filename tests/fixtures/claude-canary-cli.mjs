#!/usr/bin/env node
// Actual-native canary launcher, NOT a protocol peer. It delegates every byte to
// the pinned native CLI and adds only the caller-authorized agentic-turn budget.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { StringDecoder } from "node:string_decoder";

if (process.env.PI_WEB_CLAUDE_ACTUAL_CANARY !== "1") {
  process.stderr.write("Actual Claude canary is not enabled\n");
  process.exit(2);
}
const require = createRequire(import.meta.url);
const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
const candidates = process.platform === "linux" ? [base, `${base}-musl`] : [base];
let executable;
for (const candidate of candidates) {
  try { executable = require.resolve(`${candidate}/claude${process.platform === "win32" ? ".exe" : ""}`); break; }
  catch { /* Try the other supported libc package. */ }
}
if (!executable) throw new Error("Pinned SDK native executable is unavailable");
const args = process.argv.slice(2);
const version = args.length === 1 && args[0] === "--version";
const maxTurns = Number(process.env.PI_WEB_CLAUDE_CANARY_MAX_TURNS);
if (!version) {
  if (![1, 2].includes(maxTurns) || args.some((arg) => /^--max-turns(?:=|$)/.test(arg))) throw new Error("Invalid or conflicting native canary budget");
  args.push("--max-turns", String(maxTurns));
}
const child = spawn(executable, args, { stdio: ["inherit", "pipe", "inherit"], env: process.env });
let auditCount = 0;
function audit(value) {
  if (++auditCount > 200) return;
  if (!version && process.env.PI_WEB_CLAUDE_CANARY_AUDIT) appendFileSync(process.env.PI_WEB_CLAUDE_CANARY_AUDIT, JSON.stringify({ phase: process.env.PI_WEB_CLAUDE_CANARY_PHASE, ...value }) + "\n", { mode: 0o600 });
}
audit({ maxTurns, pid: child.pid,
  resume: args.some((arg) => arg === "--resume" || arg.startsWith("--resume=")),
  permissionModeOverride: args.some((arg) => arg === "--permission-mode" || arg.startsWith("--permission-mode=")),
});
// Forward every original byte. Diagnostics retain ONLY lifecycle scalars, never
// model text, error text, auth output, tool arguments or the environment.
const decoder = new StringDecoder("utf8");
let line = "", oversized = false;
child.stdout.on("data", (chunk) => {
  const segments = decoder.write(chunk).split("\n");
  segments.forEach((part, index) => {
    if (!oversized && line.length + part.length <= 32768) line += part;
    else { line = ""; oversized = true; }
    if (index === segments.length - 1) return;
    if (!oversized) { try {
      const value = JSON.parse(line);
      if (value.type === "result") audit({ event: "result", isError: value.is_error === true,
        subtype: ["success", "error_during_execution", "error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries"].includes(value.subtype) ? value.subtype : undefined,
        terminalReason: ["completed", "aborted_streaming", "aborted_tools", "max_turns", "api_error", "budget_exhausted"].includes(value.terminal_reason) ? value.terminal_reason : undefined,
        numTurns: Number.isFinite(value.num_turns) ? value.num_turns : undefined });
      if (value.type === "system" && value.subtype === "session_state_changed" && ["idle", "running", "requires_action"].includes(value.state)) audit({ event: "native_state", state: value.state });
      if (value.type === "assistant" && value.aborted === true) audit({ event: "native_assistant_aborted" });
    } catch { /* Malformed/oversized diagnostics cannot affect native traffic. */ } }
    line = ""; oversized = false;
  });
});
child.stdout.pipe(process.stdout);
let shutdown;
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
  child.kill(signal);
  shutdown ??= setTimeout(() => child.kill("SIGKILL"), 2000).unref();
});
child.once("error", () => { process.stderr.write("Native canary executable failed to start\n"); process.exitCode = 1; });
child.once("exit", (code, signal) => { if (shutdown) clearTimeout(shutdown); process.exitCode = code ?? (signal ? 1 : 0); });
