/** Opt-in actual CLI + production server + browser canary. Never part of npm test. */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import type { InteractionRequestDto, MessageDto, SessionSnapshotDto } from "../server/session/dto.js";
import { CLAUDE_CODE_VERSION, CLAUDE_SDK_VERSION } from "../server/session/adapters/claude/native.js";

if (process.env.PI_WEB_CLAUDE_ACTUAL_CANARY !== "1") throw new Error("Set PI_WEB_CLAUDE_ACTUAL_CANARY=1 to authorize the bounded actual canary");
const repository = resolve(import.meta.dirname, "..");
const continuationPath = process.env.PI_WEB_CLAUDE_CANARY_CONTINUATION;
const continuation = continuationPath ? JSON.parse(await readFile(continuationPath, "utf8")) as { cwd: string; nativeSessionId: string; marker: string; priorAgenticTurns: number } : undefined;
if (continuation && (!/^\/tmp\/pi-web-claude-actual-[A-Za-z0-9]+\/workspace$/.test(continuation.cwd) || !/^[0-9a-f-]{36}$/.test(continuation.nativeSessionId) || !/^CLAUDE_CANARY_[0-9a-f]{12}$/.test(continuation.marker) || ![2, 3].includes(continuation.priorAgenticTurns))) throw new Error("Invalid owned-canary continuation manifest");
const resumeOnly = continuation?.priorAgenticTurns === 3;
const output = join(repository, ".pi/web/artifacts/claude-actual-canary", resumeOnly ? "resume" : continuation ? "continuation" : "");
const root = await mkdtemp(join(tmpdir(), "pi-web-claude-actual-"));
const workspace = continuation?.cwd ?? join(root, "workspace");
const fixtureFile = join(workspace, "canary.txt");
const marker = continuation?.marker ?? `CLAUDE_CANARY_${randomBytes(6).toString("hex")}`; // Non-secret owned-file test content.
const token = randomBytes(24).toString("hex"); // Isolated app credential; never retained in evidence.
const auditFile = join(root, "native-launches.jsonl");
const timeline: Array<Record<string, unknown>> = [];
const assertions: Record<string, boolean | number | string> = {};
const started = Date.now();
let browser: Browser | undefined;
let page: Page | undefined;
let child: ChildProcess | undefined;
let sessionId: string | undefined;
let nativeId: string | undefined;
let phase = "setup";
let inputCount = 0;
let logBytesDiscarded = 0;
const modelStarts = new Set<string>();
let authorizedPrompt: string | undefined;
let unexpectedInput = false;
let turnDeadline = 0;
let blocker: string | undefined;
const requestedPrompts: string[] = [];
const MAX_INPUTS = resumeOnly ? 1 : continuation ? 2 : 3;
const MAX_MODEL_TURNS = continuation ? 4 - continuation.priorAgenticTurns : 4; // CLI caps: 2+1+1, or the remaining 1+1. One input per process.
let turnWatchdog: ReturnType<typeof setTimeout> | undefined;
const MAX_TURN_MS = 120_000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
function note(event: string, fields: Record<string, unknown> = {}) { if (timeline.length < 200) timeline.push({ ms: Date.now() - started, phase, event, ...fields }); }
function requireThat(condition: unknown, name: string): asserts condition { if (!condition) throw new Error(name); assertions[name] = true; }
function errorClass(value: unknown): string {
  const text = typeof value === "string" ? value : value instanceof Error ? value.message : "";
  if (/credential|authenticat|login|unauthoriz|401|403|access.denied|forbidden/i.test(text)) return "native_auth_or_policy";
  if (/timeout|timed out/i.test(text)) return "timeout";
  if (/max.turn|maximum.turn/i.test(text)) return "native_turn_budget";
  if (/interrupt|aborted|cancelled/i.test(text)) return "native_interrupted";
  if (/version/i.test(text)) return "native_version";
  if (/not found|unavailable|ENOENT/i.test(text)) return "unavailable";
  return "unclassified";
}
const socket = createServer();
await new Promise<void>((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
const port = (socket.address() as { port: number }).port;
await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
const baseURL = `http://127.0.0.1:${port}`;
const createdWorkspace = await mkdir(workspace, { recursive: true });
await mkdir(join(root, "pi-agent"), { recursive: true });
await mkdir(output, { recursive: true });
if (!continuation) await writeFile(fixtureFile, `${marker}\n`, { mode: 0o600 });

// Keep HOME, native config roots, PATH and native auth exactly inherited. Only
// pi-web/Pi-owned stores and the explicitly authorized canary budget are changed.
const inherited = { ...process.env };
for (const key of Object.keys(inherited)) if (key.startsWith("PI_")) delete inherited[key];
const env: NodeJS.ProcessEnv = { ...inherited, HOST: "127.0.0.1", PORT: String(port), NODE_ENV: "test", PI_WEB_DEV: "0", PI_WEB_MOCK: "0",
  PI_WEB_CLAUDE_ACTUAL_CANARY: "1",
  PI_WEB_MULTI_HARNESS: "1", PI_CODING_AGENT_DIR: join(root, "pi-agent"), PI_CODING_AGENT_SESSION_DIR: join(root, "pi-sessions"),
  PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_WEB_CWD: workspace,
  PI_WEB_TOKEN: token, PI_WEB_AUTH_MODE: "legacy", PI_WEB_AUTH_POLICY: "", PI_WEB_AUTH_METHODS: "", PI_WEB_AUTH_TRUSTED_HEADER: "", PI_WEB_AUTH_PROXY_PEERS: "",
  PI_WEB_AUTH_STORE: join(root, "auth.json"), PI_WEB_AUTH_ORIGIN: baseURL,
  PI_WEB_SETTINGS_FILE: join(root, "settings.json"), PI_WEB_SESSION_UI_STATE_FILE: join(root, "ui-state.json"),
  PI_WEB_NATIVE_BINDINGS_FILE: join(root, "native-bindings.json"), PI_WEB_PUSH_FILE: join(root, "push.json"),
  PI_WEB_NOTEPAD_DIR: join(root, "notepad"), PI_WEB_NOTEPAD_DB: join(root, "notepad-db.json"), PI_WEB_NOTEPAD_VAULT: join(root, "notepad-vault"),
  PI_WEB_DELEGATION_SPOOL: join(root, "delegation-spool"),
  PI_WEB_CLAUDE_EXECUTABLE: join(repository, "tests/fixtures/claude-canary-cli.mjs"), PI_WEB_CLAUDE_CANARY_AUDIT: auditFile,
} satisfies NodeJS.ProcessEnv;
delete env.PI_WEB_CLAUDE_PEER_DIR;
delete env.PI_WEB_CODEX_PEER_DIR;

async function api<T>(path: string, data?: unknown): Promise<T> {
  const response = await fetch(`${baseURL}${path}`, { headers: { authorization: `Bearer ${token}`, ...(data ? { "content-type": "application/json" } : {}) },
    ...(data ? { method: "POST", body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`api_${path.split("?")[0]}_${response.status}`);
  return response.json() as Promise<T>;
}
const state = () => api<SessionSnapshotDto>(`/api/state?sessionId=${sessionId}`);
const messages = async () => (await api<{ messages: MessageDto[] }>(`/api/messages?sessionId=${sessionId}`)).messages;
function messageIds(messages: MessageDto[]): string[] {
  return messages.map((message) => { requireThat(typeof message.id === "string" && !!message.id, "native_message_ids_present"); return message.id; });
}
async function stop() {
  const running = child; child = undefined;
  if (!running?.pid) return;
  const exit = running.exitCode !== null || running.signalCode !== null ? Promise.resolve() : new Promise<void>((resolve) => running.once("exit", () => resolve()));
  const kill = (signal: NodeJS.Signals) => { try { process.kill(process.platform === "win32" ? running.pid! : -running.pid!, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } };
  kill("SIGTERM"); await Promise.race([exit, delay(2000)]); kill("SIGKILL"); await Promise.race([exit, delay(1000)]);
  note("owned_server_stopped");
}
async function start(maxTurns: 1 | 2) {
  const running = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
    cwd: repository, env: { ...env, PI_WEB_CLAUDE_CANARY_MAX_TURNS: String(maxTurns), PI_WEB_CLAUDE_CANARY_PHASE: phase },
    detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  });
  child = running;
  running.stdout?.on("data", (chunk: Buffer) => { logBytesDiscarded += chunk.length; });
  running.stderr?.on("data", (chunk: Buffer) => { logBytesDiscarded += chunk.length; });
  let failed = false; running.once("error", () => { failed = true; });
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    if (failed || running.exitCode !== null) throw new Error("isolated_server_start_failed");
    try { await api("/api/harnesses"); note("owned_server_started", { maxTurns }); return; } catch { await delay(100); }
  }
  throw new Error("isolated_server_start_timeout");
}
function attachObservers(page: Page) {
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const path = new URL(request.url()).pathname;
    if (path === "/api/prompt") {
      inputCount++;
      const data = request.postDataJSON() as { message?: unknown; mode?: unknown; sessionId?: unknown };
      note("browser_prompt", { input: inputCount, mode: data.mode, knownPrompt: requestedPrompts.includes(String(data.message)), correctSession: data.sessionId === sessionId });
    }
    if (path === "/api/abort") {
      const data = request.postDataJSON() as { expectedExecutionId?: string };
      note("browser_interrupt", { expectedExecutionHash: hash(data.expectedExecutionId || "") });
    }
  });
  page.on("websocket", (ws) => ws.on("framereceived", ({ payload }) => {
    try {
      const event = JSON.parse(payload.toString()) as Record<string, any>;
      if (event.sessionId !== sessionId) return;
      if (event.type === "message_start" && event.message?.role === "assistant" && typeof event.message.nativeItemId === "string") modelStarts.add(event.message.nativeItemId);
      if (event.type === "state_changed") {
        const last = [...timeline].reverse().find((item) => item.event === "state" && item.phase === phase);
        if (last?.nativePhase !== event.phase) note("state", { nativePhase: event.phase, activity: event.activity, active: !!event.activeExecution, streaming: event.isStreaming });
      }
      if (event.type === "server_error") note("native_error", { category: errorClass(event.error) });
    } catch { /* No raw frames retained, including malformed input. */ }
  }));
}
async function interact(requests: InteractionRequestDto[]) {
  for (const request of requests) {
    const payload = request.payload as { toolName?: unknown; input?: { file_path?: unknown } };
    const allowed = phase === "generation-tool" && payload.toolName === "Read" && payload.input?.file_path === fixtureFile;
    if (!allowed) throw new Error("unexpected_native_interaction");
    const choice = request.choices?.find((choice) => choice.id === "allow-once");
    requireThat(choice, "native_exact_read_allow_once_offered");
    await page!.locator(`[data-request-id="${request.id}"] [data-choice-id="${choice.id}"]`).click();
    note("owned_read_approved_once");
  }
}
async function checkTurn(): Promise<SessionSnapshotDto> {
  if (unexpectedInput || inputCount > MAX_INPUTS) throw new Error("unexpected_prompt_replay_or_input_budget");
  if (Date.now() > turnDeadline) throw new Error("native_turn_timeout");
  if (modelStarts.size > MAX_MODEL_TURNS) throw new Error("native_model_budget_exceeded");
  const value = await state();
  if (value.nativeSettings?.permissionMode === "bypassPermissions") throw new Error("inherited_bypass_mode_not_accepted_as_canary_evidence");
  if (value.pendingInteractions?.length) await interact(value.pendingInteractions);
  if (value.error || value.phase === "error" || value.phase === "unavailable") throw new Error(`native_execution_${errorClass(value.error)}`);
  return value;
}
async function send(prompt: string) {
  requireThat(inputCount < MAX_INPUTS, "input_budget_available");
  requestedPrompts.push(prompt); authorizedPrompt = prompt; turnDeadline = Date.now() + MAX_TURN_MS;
  turnWatchdog = setTimeout(() => {
    note("hard_turn_deadline");
    const running = child;
    if (running?.pid) { try { process.kill(process.platform === "win32" ? running.pid : -running.pid, "SIGTERM"); } catch { /* Group already exited. */ } }
  }, MAX_TURN_MS);
  await page!.locator("#prompt").fill(prompt);
  const response = page!.waitForResponse((response) => new URL(response.url()).pathname === "/api/prompt" && response.request().method() === "POST", { timeout: MAX_TURN_MS });
  await page!.locator("#primaryButton").click();
  const result = await response;
  requireThat(result.ok(), "browser_prompt_http_accepted");
}
async function settled() {
  while (true) {
    const value = await checkTurn();
    if (value.phase === "idle" && !value.activeExecution && !value.isStreaming) { clearTimeout(turnWatchdog); return value; }
    await delay(100);
  }
}
async function reopen() {
  const before = inputCount;
  await page!.reload({ waitUntil: "domcontentloaded" });
  await expect(page!.locator("#prompt")).toBeVisible();
  const opened = await api<SessionSnapshotDto>("/api/sessions/open", { sessionId });
  requireThat(opened.nativeSession.sessionId === nativeId && opened.harnessId === "claude", "same_persistent_native_identity");
  requireThat(!opened.sessionFile, "no_fabricated_pi_file");
  await delay(300);
  requireThat(inputCount === before, "reopen_did_not_replay_input");
  return opened;
}
try {
  phase = resumeOnly ? "resume" : continuation ? "interrupt" : "generation-tool";
  await start(continuation ? 1 : 2);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, baseURL });
  page = await context.newPage(); page.setDefaultTimeout(10_000); attachObservers(page);
  // A budget guard, never a fake response/controller: any unsolicited or replayed
  // input is blocked and fails the canary instead of spending another model turn.
  await page.route(`${baseURL}/api/prompt`, async (route) => {
    const data = route.request().postDataJSON() as { message?: string; mode?: string; sessionId?: string };
    if (!authorizedPrompt || data.message !== authorizedPrompt || data.mode !== "prompt" || data.sessionId !== sessionId) {
      unexpectedInput = true; note("unsolicited_input_blocked"); await route.abort(); return;
    }
    authorizedPrompt = undefined; await route.continue();
  });
  await page.goto("/");
  await expect(page.locator("#tokenOverlay")).toBeVisible();
  await page.locator("#tokenInput").fill(token);
  await page.locator('#tokenForm button[type="submit"]').click();
  await expect(page.locator("#tokenOverlay")).toBeHidden();
  await expect(page.locator('[data-harness-selector="landing"] select')).toHaveValue("pi");
  let durableIds: string[];
  if (continuation) {
    // Import genuine SDK-discovered history through the ordinary application
    // drawer. No seeded host binding, private transcript or manufactured reply.
    const discovered = await api<{ sessions: Array<{ id: string; nativeSession?: { sessionId?: string } }> }>("/api/sessions");
    const row = discovered.sessions.find((entry) => entry.nativeSession?.sessionId === continuation.nativeSessionId);
    requireThat(row, "supported_native_discovery");
    sessionId = row.id; nativeId = continuation.nativeSessionId;
    await page.locator("#sessionButton").click();
    await page.locator(`.sessionItem[data-session-id="${sessionId}"] .sessionItemNavBtn`).click();
    await expect(page.locator(".message.assistant", { hasText: marker })).toBeVisible();
    durableIds = messageIds(await messages());
    requireThat((await state()).nativeSession.sessionId === nativeId, "original_native_history_identity");
    await page.locator(".message.assistant", { hasText: marker }).last().screenshot({ path: join(output, "native-history-answer.png") });
    note("continued_actual_history", { priorAgenticTurns: continuation.priorAgenticTurns, nativeSessionHash: hash(nativeId) });
  } else {
  await page.locator("#sessionButton").click();
  await page.locator("#sessionNewButton").click();
  const dialog = page.getByRole("dialog", { name: "New session", exact: true });
  await dialog.locator('[data-harness-selector="dialog"] select').selectOption("claude");
  const creation = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/sessions/new" && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "Start session" }).click();
  const created = await (await creation).json() as SessionSnapshotDto;
  sessionId = created.sessionId; nativeId = created.nativeSession.sessionId;
  requireThat(created.harnessId === "claude" && sessionId !== nativeId && !created.sessionFile, "browser_native_creation_identity");
  note("created", { webSessionHash: hash(sessionId), nativeSessionHash: hash(nativeId!) });
  await send("Read canary.txt in the current working directory with the native Read tool exactly once. Then reply with exactly its single line. Do not call other tools or change any files.");
  const first = await settled();
  const content = await messages();
  requireThat(content.some((message) => message.role === "assistant" && message.text?.trim() === marker), "actual_generation_matches_unprompted_file_content");
  const tool = content.flatMap((message) => message.parts || []).find((part) => part.type === "toolCall" && part.toolName === "Read");
  requireThat(tool?.type === "toolCall" && tool.result && !tool.result.isError, "actual_owned_read_completed");
  requireThat((await readFile(fixtureFile, "utf8")) === `${marker}\n`, "owned_file_unchanged");
  await expect(page.locator(".message.assistant", { hasText: marker })).toBeVisible();
  await expect(page.locator("#stopButton")).toBeHidden();
  // Capture only the exact known answer; not arbitrary native hooks/errors/auth UI.
  await page.locator(".message.assistant", { hasText: marker }).last().screenshot({ path: join(output, "native-answer.png") });
  note("native_generation_verified", { assistantIds: modelStarts.size, reportedTokens: first.stats?.tokens.total, reportedCost: first.stats?.cost,
    permissionMode: first.nativeSettings?.permissionMode, model: typeof first.nativeSettings?.model === "string" && !first.nativeSettings.model.startsWith("arn:") ? first.nativeSettings.model : "native-configured" });
  durableIds = messageIds(content);
  }

  if (!resumeOnly) {
  phase = "interrupt";
  if (!continuation) { await stop(); await start(1); await reopen(); }
  requireThat((await messages()).some((message) => message.role === "assistant" && message.text?.trim() === marker), "native_history_loaded_after_restart");
  const before = modelStarts.size;
  await send("Do not use any tools. Begin immediately with the line INTERRUPT_CANARY, then write a numbered list of 1000 short neutral words. Do not ask a question.");
  let active: SessionSnapshotDto;
  while (true) {
    active = await checkTurn();
    if (active.activeExecution && modelStarts.size > before && await page.locator("#stopButton").isVisible()) break;
    if (!active.activeExecution) throw new Error("native_finished_before_interrupt_evidence");
    await delay(50);
  }
  const expected = active.activeExecution!.id;
  const interruptResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/abort" && response.request().method() === "POST");
  await page.locator("#stopButton").click();
  const response = await interruptResponse;
  requireThat(response.ok(), "browser_interrupt_http_accepted");
  const receipt = await response.json() as { acknowledged?: boolean; executionId?: string };
  requireThat(receipt.acknowledged && receipt.executionId === expected, "interrupt_ack_exact_execution");
  await settled();
  await expect(page.locator("#stopButton")).toBeHidden();
  requireThat((await messages()).some((message) => message.status === "interrupted"), "native_interrupted_transcript");
  note("interrupt_settled", { executionHash: hash(expected) });
  }

  phase = "resume";
  await stop(); await start(1); await reopen();
  const recovered = await messages();
  requireThat(durableIds.every((id) => recovered.some((message) => message.id === id)), "stable_native_history_ids");
  await send("Do not use any tools. What was the exact single line read from canary.txt earlier in this conversation? Reply only with that line.");
  await settled();
  const final = await messages();
  requireThat(final.filter((message) => message.role === "assistant" && message.text?.trim() === marker).length >= 2, "actual_resume_remembers_unreplayed_marker");
  requireThat(requestedPrompts.every((prompt) => final.filter((message) => message.role === "user" && message.text === prompt).length === 1), "no_duplicated_user_inputs");
  requireThat(inputCount === MAX_INPUTS && modelStarts.size <= MAX_MODEL_TURNS, "actual_budget_respected");
  note("completed", { inputs: inputCount, assistantIds: modelStarts.size });
} catch (error) {
  // Error messages from assertions are ours; native/HTTP/browser payloads never
  // enter the retained report. Native error detail is classified in memory only.
  const message = error instanceof Error ? error.message : "canary_failed";
  blocker = /^[a-z0-9_/:.-]{1,140}$/.test(message) ? message : `canary_${errorClass(message)}`;
  note("blocked", { reason: blocker });
  if (sessionId && child) {
    try { const value = await state(); if (value.activeExecution) await api("/api/abort", { sessionId, expectedExecutionId: value.activeExecution.id }); } catch { /* Owned group is closed below. */ }
  }
  process.exitCode = 1;
} finally {
  clearTimeout(turnWatchdog);
  await browser?.close().catch(() => undefined); await stop();
  const nativeLog = (await readFile(auditFile, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const launches = nativeLog.filter((entry) => "maxTurns" in entry);
  const report = { kind: "actual-native-generation-browser-canary", scope: resumeOnly ? "resume-only" : continuation ? "interrupt-and-resume" : "full-workflow", sdkVersion: CLAUDE_SDK_VERSION, cliVersion: CLAUDE_CODE_VERSION,
    verdict: blocker ? "BLOCKED" : "PASS", blocker, phase, assertions, inputCount, observedAssistantIds: modelStarts.size,
    limits: { maxInputs: MAX_INPUTS, maxAgenticTurns: MAX_MODEL_TURNS, priorAgenticTurns: continuation?.priorAgenticTurns ?? 0, millisecondsPerInput: MAX_TURN_MS, perProcessNativeCaps: resumeOnly ? [1] : continuation ? [1, 1] : [2, 1, 1] },
    isolation: { nativeHomeAndAuthInherited: true, piStateIsolated: true, privateHistoryParsing: false, protocolPeerUsed: false, permissionBypassEnabled: false,
      rawServerAndNativeLogsRetained: false, logBytesDiscarded }, port, launches, nativeLifecycle: nativeLog.filter((entry) => "event" in entry), timeline };
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await rm(root, { recursive: true, force: true });
  if (continuation && createdWorkspace) await rm(workspace, { recursive: true, force: true });
  console.log(JSON.stringify({ verdict: report.verdict, blocker, phase, inputs: inputCount, assistantIds: modelStarts.size, report: `.pi/web/artifacts/claude-actual-canary/${resumeOnly ? "resume/" : continuation ? "continuation/" : ""}report.json` }));
}
