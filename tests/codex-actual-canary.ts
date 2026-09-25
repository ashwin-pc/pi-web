/** Explicit, bounded actual-model browser canary; never discovered by npm test.
 * PI_WEB_CODEX_ACTUAL_CANARY=1 node --import tsx tests/codex-actual-canary.ts
 * Run under an owned tmux session. No fixture peer, route fulfillment or native override.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import type { PromptReceiptDto, SessionSnapshotDto, TranscriptMessageDto, ToolCallPartDto } from "../server/session/dto.js";
import { CodexTransport, diagnostic, object } from "../server/session/adapters/codex/transport.js";

assert.equal(process.env.PI_WEB_CODEX_ACTUAL_CANARY, "1", "Actual inference requires explicit opt-in");
const repository = resolve(import.meta.dirname, "..");
const evidence = join(repository, ".pi/web/artifacts/codex-actual-phase3");
await mkdir(evidence, { recursive: true });
const budgetFile = join(evidence, "budget.json");
const budget: { submitted: number } = JSON.parse(await readFile(budgetFile, "utf8").catch(() => '{"submitted":0}'));
const resumeOnly = process.argv.includes("--resume");
const previous = resumeOnly ? JSON.parse(await readFile(join(evidence, "report.json"), "utf8")) : undefined;
assert.equal(budget.submitted, resumeOnly ? 3 : 0, "Do not retry submitted input or reset this phase's four-turn budget");
if (resumeOnly) assert(previous.checks.actualGeneration && previous.checks.nativeOwnedFileRead && previous.turns[2].name === "exact-interrupt", "Continuation requires the original three-turn record");
const root: string = resumeOnly ? previous.root : await mkdtemp(join(tmpdir(), "pi-web-codex-actual-"));
const cwd = join(root, "workspace");
const marker = resumeOnly ? (await readFile(join(cwd, "evidence.txt"), "utf8")).trim() : `OWNED_FILE_${randomUUID()}`;
if (!resumeOnly) {
  await mkdir(cwd); await writeFile(join(cwd, "evidence.txt"), `${marker}\n`);
  execFileSync("git", ["init", "--quiet", cwd], { stdio: "ignore" });
}
const socket = createServer();
await new Promise<void>((done) => socket.listen(0, "127.0.0.1", done));
const port = (socket.address() as { port: number }).port;
await new Promise<void>((done, reject) => socket.close((error) => error ? reject(error) : done()));
const origin = `http://127.0.0.1:${port}`;
const token = randomBytes(32).toString("hex"); // Ephemeral web credential: never logged or written.
const env: NodeJS.ProcessEnv = { ...process.env,
  NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port), PI_WEB_DEV: "0", PI_WEB_MOCK: "0",
  PI_WEB_MULTI_HARNESS: "1", PI_WEB_CWD: cwd, PI_CODING_AGENT_DIR: join(root, "pi-agent"),
  PI_CODING_AGENT_SESSION_DIR: join(root, "pi-sessions"), PI_WEB_SETTINGS_FILE: join(root, "settings.json"),
  PI_WEB_SESSION_UI_STATE_FILE: join(root, "ui-state.json"), PI_WEB_NATIVE_BINDINGS_FILE: join(root, "bindings.json"),
  PI_WEB_AUTH_MODE: "legacy", PI_WEB_AUTH_POLICY: "authenticated", PI_WEB_AUTH_METHODS: "legacy",
  PI_WEB_AUTH_STORE: join(root, "web-auth.json"), PI_WEB_AUTH_ORIGIN: origin, PI_WEB_AUTH_TRUSTED_HEADER: "", PI_WEB_TOKEN: token,
  PI_WEB_NOTEPAD_DIR: join(root, "notepad"), PI_WEB_NOTEPAD_DB: join(root, "notepad-db.json"),
  PI_WEB_NOTEPAD_VAULT: join(root, "notepad-vault"), PI_WEB_DELEGATION_SPOOL: join(root, "delegation-spool"),
  PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
};
// The production adapter must resolve the installed PATH wrapper, not a test peer.
for (const key of ["PI_WEB_CODEX_COMMAND", "PI_WEB_CODEX_ARGS", "PI_WEB_CODEX_PEER_DIR"]) delete env[key];
// HOME, CODEX_HOME, XDG_* and native auth/model/policy settings are intentionally untouched.
const report: Record<string, unknown> = {
  kind: "actual-native-browser-canary", startedAt: new Date().toISOString(), root, port,
  nativeLaunch: "codex app-server --listen stdio://", nativeHomeAndAuthPreserved: true,
  mockMode: false, webAuth: "authenticated legacy token plus minted session cookie", maxTurns: 4, perTurnLimitMs: 120_000,
  verdict: "running", checks: previous?.checks ?? {}, turns: previous?.turns ?? [], wireCounts: previous?.wireCounts ?? {},
  ...(resumeOnly ? { initialStartedAt: previous.startedAt, initialCanaryAssertion: previous.blocker, continuation: "same saved web state; only unused fourth turn" } : {}),
};
const checks = report.checks as Record<string, unknown>;
const turns = report.turns as Array<Record<string, unknown>>;
const wireCounts = report.wireCounts as Record<string, number>;
let server: ChildProcess | undefined;
let browser: Browser | undefined;
let page: Page;
let sessionId = "";
let nativeSessionId = "";
let serverLog = "";
const serverPids: number[] = [];
const cleanupChecks: Array<{ pid: number; running: boolean }> = [];
const nativeCleanup: Array<{ pid: number; command: string; running: boolean }> = [];
let stopping: Promise<void> | undefined;
let turnTimeout: ReturnType<typeof setTimeout> | undefined;
let turnTimedOut = false;
const safe = (error: unknown) => diagnostic(error instanceof Error ? error.message : error).split(token).join("[redacted]");
const save = () => writeFile(join(evidence, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function start() {
  serverLog = "";
  server = spawn(process.execPath, ["--import", "tsx", "server.ts"], { cwd: repository, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  assert(server.pid); serverPids.push(server.pid);
  // Bounded, redacted setup diagnostics only. Native transport discards native stderr.
  const collect = (data: Buffer) => { serverLog = (serverLog + safe(data.toString())).slice(-8_192); };
  server.stdout!.on("data", collect); server.stderr!.on("data", collect);
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    assert.equal(server.exitCode, null, `Owned server exited: ${serverLog}`);
    try {
      const response = await fetch(`${origin}/api/harnesses`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch { /* bounded readiness */ }
    await delay(100);
  }
  throw new Error(`Owned server did not become ready: ${serverLog}`);
}
async function stop() {
  if (stopping) return stopping;
  const child = server; server = undefined;
  if (!child?.pid) return;
  const pid = child.pid;
  stopping = (async () => {
    // Inventory only this app's descendants, without command-line arguments or env.
    const rows = execFileSync("ps", ["-eo", "pid=,ppid=,comm="], { encoding: "utf8" }).trim().split("\n").map((line) => {
      const [id, parent, command] = line.trim().split(/\s+/); return { pid: Number(id), parent: Number(parent), command: command! };
    });
    const owned = new Set([pid]);
    for (let changed = true; changed;) { changed = false; for (const row of rows) if (owned.has(row.parent) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; } }
    const descendants = await Promise.all(rows.filter((row) => row.pid !== pid && owned.has(row.pid)).map(async (row) => ({ ...row,
      start: await readFile(`/proc/${row.pid}/stat`, "utf8").then((value) => value.slice(value.lastIndexOf(")") + 2).split(" ")[19], () => undefined) })));
    const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>((done) => child.once("exit", () => done()));
    child.kill("SIGTERM");
    await Promise.race([exited, delay(12_000)]);
    if (alive(pid)) { try { process.kill(-pid, "SIGKILL"); } catch { /* already exited */ } await Promise.race([exited, delay(1_000)]); }
    for (const row of descendants) {
      const fields = await readFile(`/proc/${row.pid}/stat`, "utf8").then((value) => value.slice(value.lastIndexOf(")") + 2).split(" "), () => []);
      // PID/start-time check excludes reuse by another process. Cleanup cannot hit a peer server.
      if (row.start && fields[19] === row.start && fields[0] !== "Z") {
        try { process.kill(row.pid, "SIGKILL"); } catch { /* exited */ }
        await delay(100);
      }
      const final = await readFile(`/proc/${row.pid}/stat`, "utf8").then((value) => value.slice(value.lastIndexOf(")") + 2).split(" "), () => []);
      nativeCleanup.push({ pid: row.pid, command: row.command, running: final[19] === row.start && final[0] !== undefined && final[0] !== "Z" });
    }
    cleanupChecks.push({ pid, running: alive(pid) });
  })();
  try { await stopping; } finally { stopping = undefined; }
}
async function state(): Promise<SessionSnapshotDto> {
  const response = await page.request.get(`${origin}/api/state?sessionId=${encodeURIComponent(sessionId)}`, { timeout: 3_000 });
  assert.equal(response.status(), 200); return response.json();
}
async function messages(): Promise<TranscriptMessageDto[]> {
  const response = await page.request.get(`${origin}/api/messages?sessionId=${encodeURIComponent(sessionId)}`, { timeout: 3_000 });
  assert.equal(response.status(), 200); return (await response.json()).messages;
}
const toolParts = (items: TranscriptMessageDto[]) => items.flatMap((message) => message.parts).filter((part): part is ToolCallPartDto => part.type === "toolCall");
async function checkNativeState() {
  const current = await state();
  if (current.pendingInteractions.length) {
    checks.approvalEncountered = current.pendingInteractions.map((value) => ({ kind: value.kind, choiceIds: value.choices?.map((choice) => choice.id) }));
    throw new Error("Native policy requested a decision; no automatic grant was made. Stop this canary for review.");
  }
  if (current.error || current.phase === "unavailable") throw new Error(`Native execution failed: ${safe(current.error || current.phase)}`);
  return current;
}
async function waitIdle(deadline: number) {
  while (Date.now() < deadline) {
    if ((await checkNativeState()).phase === "idle") { clearTimeout(turnTimeout); turnTimeout = undefined; return; }
    await delay(150);
  }
  throw new Error("Native turn exceeded its 120-second bound");
}
async function submit(name: string, text: string): Promise<{ receipt: PromptReceiptDto; deadline: number; entry: Record<string, unknown> }> {
  assert(budget.submitted < 4, "Maximum four submitted model turns");
  const deadline = Date.now() + 120_000;
  const entry: Record<string, unknown> = { name, startedAt: new Date().toISOString(), outcome: "pending" };
  turns.push(entry);
  clearTimeout(turnTimeout);
  turnTimeout = setTimeout(() => { turnTimedOut = true; entry.outcome = "timed-out"; void stop().catch(() => {}); }, 120_000);
  await page.locator("#prompt").fill(text);
  budget.submitted++; await writeFile(budgetFile, JSON.stringify(budget)); await save();
  const responsePromise = page.waitForResponse((value) => new URL(value.url()).pathname === "/api/prompt" && value.request().method() === "POST", { timeout: deadline - Date.now() });
  await page.locator("#primaryButton").click();
  const response = await responsePromise;
  const receipt = await response.json() as PromptReceiptDto;
  assert.equal(response.status(), 202, `Native prompt not accepted: ${safe(JSON.stringify(receipt))}`);
  assert.equal(receipt.sessionId, sessionId); assert.equal(receipt.acknowledgement, "accepted"); assert(receipt.nativeExecutionId);
  Object.assign(entry, { executionId: receipt.executionId, nativeExecutionId: receipt.nativeExecutionId, accepted: true });
  await save(); return { receipt, deadline, entry };
}
async function screenshot(name: string) {
  await page.locator("#prompt").blur();
  await page.screenshot({ path: join(evidence, `${name}.png`) });
}
async function verifyInterruptedNativeTurn(turnId: string) {
  // Supplemental zero-generation public native read, never native-home file parsing.
  // The initial browser stop got HTTP 202; an incorrect canary assertion expected 200.
  const rpc = new CodexTransport({ cwd, env }, { notification: () => {}, request: (request) => rpc.reject(request.id), closed: () => {}, observation: () => {} });
  try {
    await rpc.request("initialize", { clientInfo: { name: "pi_web_canary", version: "0.6.0" }, capabilities: { experimentalApi: true, requestAttestation: false } });
    rpc.notify("initialized");
    const result = object(await rpc.request("thread/read", { threadId: nativeSessionId, includeTurns: true }));
    const thread = object(result?.thread);
    assert.equal(thread?.id, nativeSessionId);
    const turn = (thread?.turns as Array<{ id: string; status: string }> | undefined)?.find((value) => value.id === turnId);
    assert.equal(turn?.status, "interrupted", "Native public history must confirm the observed browser stop");
    return { nativeExecutionId: turn!.id, nativeStatus: turn!.status };
  } finally { await rpc.dispose(); }
}
async function finishResume(beforeIds?: string[]) {
  const reopened = await state();
  assert.equal(reopened.sessionId, sessionId); assert.equal(reopened.nativeSession.sessionId, nativeSessionId);
  assert.equal(reopened.phase, "idle");
  const history = await messages();
  if (beforeIds) assert.deepEqual(history.map((message) => message.id), beforeIds);
  else assert.equal(history.filter((message) => message.role === "user").length, 3, "Reopen must not replay native input");
  checks.restartSameNativeIdentityAndHistory = true;
  checks.hydratedTimesOmitted = history.every((message) => message.timestamp === undefined);
  await screenshot("reopened");
  const continued = await submit("resume-generation", "Without tools, repeat the exact file contents you read earlier in this conversation. Reply with only those contents.");
  await waitIdle(continued.deadline);
  assert((await messages()).some((message) => message.role === "assistant" && message.nativeExecutionId === continued.receipt.nativeExecutionId && message.text?.includes(marker)));
  continued.entry.outcome = "passed"; checks.nativeResumeGeneration = true;
  assert((wireCounts.message_delta || 0) > 0); checks.browserWebSocketDeltas = true;
  checks.approvalEncountered ??= false; report.verdict = "passed"; await screenshot("resumed");
}
async function run() {
  await start();
  assert.equal((await fetch(`${origin}/api/harnesses`)).status, 401); checks.unauthenticatedDenied = true;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ baseURL: origin, viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  page = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => {
    try { const event = JSON.parse(String(payload)); if (event.sessionId === sessionId && typeof event.type === "string") wireCounts[event.type] = (wireCounts[event.type] || 0) + 1; } catch { /* not a retained raw frame */ }
  }));
  await page.goto(origin);
  await page.locator("#tokenInput").fill(token); await page.locator("#tokenForm button[type=submit]").click();
  await expect(page.locator("#tokenOverlay")).toBeHidden();
  assert((await context.cookies()).some((cookie) => cookie.name === "pi_web_session")); checks.browserAuthenticated = true;
  if (resumeOnly) {
    sessionId = previous.sessionId; nativeSessionId = previous.nativeSessionId;
    Object.assign(report, { sessionId, nativeSessionId, nativeSettings: previous.nativeSettings });
    if (await page.locator("#sessionDrawer").isHidden()) await page.locator("#sessionButton").click();
    await page.locator(`.sessionItem[data-session-id="${sessionId}"] .sessionItemNavBtn`).click();
    if (await page.locator("#sessionDrawer").isVisible()) await page.locator("#sessionButton").click();
    await expect(page.locator(".message.assistant", { hasText: "CODEX_CANARY_READY" })).toHaveCount(1);
    const interrupted = await verifyInterruptedNativeTurn(previous.turns[2].nativeExecutionId);
    checks.exactInterrupt = { ...interrupted, executionId: previous.turns[2].executionId, browserGuardVerified: true, observedHttpStatus: 202,
      verification: "Initial browser stop guard and HTTP status; native public read after app restart" };
    turns[2]!.outcome = "passed-native-history-confirmed";
    await save(); await finishResume(); return;
  }
  await expect(page.locator("#emptyCwdChooser")).toBeVisible();
  await page.locator("#sessionButton").click(); await page.locator("#sessionNewButton").click();
  const dialog = page.getByRole("dialog", { name: "New session", exact: true });
  await dialog.locator('[data-harness-selector="dialog"] select').selectOption("codex");
  const creating = page.waitForResponse((value) => new URL(value.url()).pathname === "/api/sessions/new" && value.request().method() === "POST", { timeout: 45_000 });
  await dialog.getByRole("button", { name: "Start session", exact: true }).click();
  const response = await creating; assert.equal(response.status(), 200, `Native creation rejected: ${safe(await response.text())}`);
  const created = await response.json() as SessionSnapshotDto;
  sessionId = created.sessionId; nativeSessionId = created.nativeSession.sessionId!;
  assert.equal(created.harnessId, "codex"); assert(nativeSessionId); assert.notEqual(nativeSessionId, sessionId);
  Object.assign(report, { sessionId, nativeSessionId, nativeSettings: created.nativeSettings }); checks.browserNativeCreation = true;
  // Desktop keeps the drawer open after creation; close it through the normal UI.
  if (await page.locator("#sessionDrawer").isVisible()) await page.locator("#sessionButton").click();
  await expect(page.locator("#sessionDrawer")).toBeHidden();
  assert.equal((await checkNativeState()).phase, "idle"); await save();

  const generation = await submit("generation", "Reply exactly CODEX_CANARY_READY. Do not use tools.");
  await waitIdle(generation.deadline);
  assert((await messages()).some((message) => message.role === "assistant" && message.text?.includes("CODEX_CANARY_READY")));
  await expect(page.locator(".message.assistant", { hasText: "CODEX_CANARY_READY" })).toHaveCount(1);
  generation.entry.outcome = "passed"; checks.actualGeneration = true; await screenshot("generation"); await save();

  const tool = await submit("owned-file-read", "Use a native read-only tool to read evidence.txt in this workspace, then reply with its exact contents. Do not inspect other files, write files or use network.");
  await waitIdle(tool.deadline);
  const readTool = toolParts(await messages()).find((part) => part.status === "completed" && part.result?.parts.some((part) => part.type === "text" && part.text.includes(marker)));
  assert(readTool, "No native tool result contains the file-only marker");
  assert.equal(await readFile(join(cwd, "evidence.txt"), "utf8"), `${marker}\n`);
  checks.nativeOwnedFileRead = { toolName: readTool.toolName, itemId: readTool.nativeItemId, resultSha256: createHash("sha256").update(marker).digest("hex"), fileUnchanged: true };
  tool.entry.outcome = "passed"; await screenshot("native-tool"); await save();

  const interrupted = await submit("exact-interrupt", "Use a native shell tool to run `sleep 30; printf CANARY_SLEEP_DONE`, then reply. Do not inspect or modify files and do not use network.");
  while (Date.now() < interrupted.deadline) {
    const current = await checkNativeState();
    assert.equal(current.activeExecution?.id, interrupted.receipt.executionId, "Turn ended before its interruption target could be observed");
    if (toolParts(await messages()).some((part) => part.nativeExecutionId === interrupted.receipt.nativeExecutionId && JSON.stringify(part.args).includes("sleep"))) break;
    await delay(100);
  }
  assert(Date.now() < interrupted.deadline, "Native tool did not start within this turn's bound");
  const aborting = page.waitForResponse((value) => new URL(value.url()).pathname === "/api/abort" && value.request().method() === "POST", { timeout: interrupted.deadline - Date.now() });
  await page.locator("#stopButton").click();
  const abortResponse = await aborting; const interrupt = await abortResponse.json();
  assert.equal(abortResponse.request().postDataJSON().expectedExecutionId, interrupted.receipt.executionId);
  assert.equal(abortResponse.status(), 202); assert.equal(interrupt.acknowledged, true); assert.equal(interrupt.nativeExecutionId, interrupted.receipt.nativeExecutionId);
  await waitIdle(interrupted.deadline);
  checks.exactInterrupt = { executionId: interrupt.executionId, nativeExecutionId: interrupt.nativeExecutionId, acknowledged: true, terminalThenIdle: true };
  interrupted.entry.outcome = "passed"; await screenshot("interrupted"); await save();

  const beforeIds = (await messages()).map((message) => message.id);
  await stop(); await start(); await page.reload();
  await expect(page.locator(".message.assistant", { hasText: "CODEX_CANARY_READY" })).toHaveCount(1);
  await finishResume(beforeIds);
}
try { await run(); }
catch (error) { report.verdict = "blocked"; report.blocker = turnTimedOut ? "Native turn exceeded its 120-second bound; owned app stopped" : safe(error); process.exitCode = 1; }
finally {
  clearTimeout(turnTimeout);
  await stop(); await browser?.close().catch(() => {});
  Object.assign(report, { finishedAt: new Date().toISOString(), submittedTurns: budget.submitted, serverPids, cleanupChecks, nativeCleanup });
  await save();
  // Deliberately retain only owned scratch metadata and these bounded artifacts;
  // never inspect or edit the native session files produced by the native API.
  console.log(JSON.stringify({ verdict: report.verdict, blocker: report.blocker, submittedTurns: budget.submitted, evidence, cleanupChecks }));
}
