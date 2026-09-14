import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test as base, expect, type Page, type TestInfo } from "@playwright/test";
import type { HarnessCatalogDto, InteractionRequestDto, SessionSnapshotDto } from "../../server/session/dto.js";
import { acceptedTurn, controlPeer, peerForThread, readObserved, waitObserved } from "../fixtures/codex-peer-control.js";
import { mcpImageEvents } from "../fixtures/codex-native-events.js";
import { openLauncherAction } from "./helpers/actionLauncher.js";

const repository = resolve(import.meta.dirname, "../..");

type NativeServer = { root: string; workspace: string; peerDir: string; baseURL: string; restart: () => Promise<void> };

async function unusedPort() {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function isolatedServer(testInfo: TestInfo) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-native-browser-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  const peerDir = join(root, "codex-peer");
  const port = await unusedPort();
  const baseURL = `http://127.0.0.1:${port}`;
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await mkdir(join(workspace, ".pi", "web", "artifacts"), { recursive: true });
  await writeFile(join(workspace, "hello.txt"), "Native workspace fixture\n");
  await writeFile(join(workspace, ".pi", "web", "artifacts", "native-report.html"), "<!doctype html><h1>Native artifact</h1>");
  execFileSync("git", ["init", "--quiet", workspace], { env: { PATH: process.env.PATH, HOME: home }, stdio: "pipe" });
  // Allowlist, rather than clone, the agent environment: no real credentials, extensions or native homes.
  const env: NodeJS.ProcessEnv = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, USER: "native-browser-test", LOGNAME: "native-browser-test",
    XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
    NODE_ENV: "test", CI: "1", HOST: "127.0.0.1", PORT: String(port), PI_WEB_DEV: "0", PI_WEB_MOCK: "0",
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), PI_CODING_AGENT_SESSION_DIR: join(root, "pi-sessions"),
    PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
    CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: join(home, ".claude"),
    PI_WEB_AUTH_MODE: "none", PI_WEB_AUTH_STORE: join(root, "auth.json"), PI_WEB_AUTH_ORIGIN: baseURL,
    PI_WEB_CWD: workspace, PI_WEB_SETTINGS_FILE: join(root, "settings.json"), PI_WEB_SESSION_UI_STATE_FILE: join(root, "ui-state.json"),
    PI_WEB_NATIVE_BINDINGS_FILE: join(root, "native-bindings.json"), PI_WEB_MULTI_HARNESS: "1",
    PI_WEB_CODEX_COMMAND: process.execPath, PI_WEB_CODEX_ARGS: JSON.stringify([join(repository, "tests/fixtures/codex-app-server-peer.mjs")]),
    PI_WEB_CODEX_PEER_DIR: peerDir,
    PI_WEB_CLAUDE_EXECUTABLE: join(root, "not-installed-claude"),
  };
  let child: ChildProcess | undefined;
  let output = "";
  const ownedGroups: number[] = [];
  function signalOwned(pid: number, signal: NodeJS.Signals) {
    try { process.kill(process.platform === "win32" ? pid : -pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
  async function stop() {
    const running = child; child = undefined;
    if (!running?.pid) return;
    const exited = running.exitCode !== null || running.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => running.once("exit", () => resolve()));
    signalOwned(running.pid, "SIGTERM");
    await Promise.race([exited, delay(2_000)]);
    // The process group contains only this fixture's server and native children.
    signalOwned(running.pid, "SIGKILL");
    await Promise.race([exited, delay(1_000)]);
  }
  async function start() {
    output += "\n--- starting isolated production service ---\n";
    const running = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
      cwd: repository, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    });
    child = running;
    if (running.pid) ownedGroups.push(running.pid);
    running.stdout?.on("data", (chunk) => { output += String(chunk); });
    running.stderr?.on("data", (chunk) => { output += String(chunk); });
    let spawnError: Error | undefined;
    running.once("error", (error) => { spawnError = error; });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (spawnError || running.exitCode !== null) throw new Error(`Native service failed to start: ${spawnError?.message || running.exitCode}\n${output}`);
      try {
        const response = await fetch(`${baseURL}/api/harnesses`, { signal: AbortSignal.timeout(500) });
        if (response.ok) return;
      } catch { /* Startup is bounded below, including a listener not yet bound. */ }
      await delay(50);
    }
    throw new Error(`Timed out starting the isolated native service\n${output}`);
  }
  async function cleanup() {
    await stop();
    for (const pid of ownedGroups) signalOwned(pid, "SIGKILL");
    await testInfo.attach("native-server.log", { body: output, contentType: "text/plain" });
    if (testInfo.status !== testInfo.expectedStatus) {
      for (const pid of await readdir(join(peerDir, "peers")).catch(() => [])) {
        const observed = await readFile(join(peerDir, "peers", pid, "observed.jsonl"), "utf8").catch(() => "");
        if (observed) await testInfo.attach(`synthetic-codex-peer-${pid}.jsonl`, { body: observed, contentType: "application/x-ndjson" });
      }
    }
    await rm(root, { recursive: true, force: true });
  }
  return { value: { root, workspace, peerDir, baseURL, restart: async () => { await stop(); await start(); } } satisfies NativeServer, start, cleanup };
}

const test = base.extend<{ nativeServer: NativeServer }>({
  nativeServer: async ({}, use, testInfo) => {
    const server = await isolatedServer(testInfo);
    try { await server.start(); await use(server.value); }
    finally { await server.cleanup(); }
  },
  baseURL: async ({ nativeServer }, use) => { await use(nativeServer.baseURL); },
});
test.setTimeout(45_000);

async function stateOf(page: Page, sessionId?: string): Promise<SessionSnapshotDto> {
  const response = await page.request.get(`/api/state${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function createCodex(page: Page, server: NativeServer, flow: "landing" | "drawer", prompt = true) {
  await page.goto("/");
  await expect(page.locator("#emptyCwdChooser")).toBeVisible();
  const initial = await stateOf(page);
  expect(initial.harnessId).toBe("pi");
  await expect(page.locator('[data-harness-selector="landing"] select')).toHaveValue("pi");
  const createdResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/sessions/new" && response.request().method() === "POST");
  if (flow === "landing") {
    await page.locator('[data-harness-selector="landing"] select').selectOption("codex");
    await page.locator("#prompt").fill("Inspect this isolated workspace.");
    await page.locator("#primaryButton").click();
  } else {
    await page.locator("#sessionButton").click();
    await page.locator("#sessionNewButton").click();
    const dialog = page.getByRole("dialog", { name: "New session", exact: true });
    await dialog.locator('[data-harness-selector="dialog"] select').selectOption("codex");
    await dialog.getByRole("button", { name: "Start session" }).click();
  }
  const response = await createdResponse;
  expect(response.ok(), await response.text()).toBe(true);
  const created = await response.json() as SessionSnapshotDto;
  expect(created.sessionId).not.toBe(initial.sessionId);
  expect(created.harnessId).toBe("codex");
  expect(created.sessionFile).toBeUndefined();
  expect(created.nativeSession.sessionId).toBeTruthy();
  expect(created.nativeSession.sessionId).not.toBe(created.sessionId);
  const peer = await peerForThread(server.peerDir, created.nativeSession.sessionId!);
  if (flow === "drawer" && prompt) {
    await page.locator("#prompt").fill("Inspect this isolated workspace.");
    await page.locator("#primaryButton").click();
  }
  if (flow === "landing" || prompt) await acceptedTurn(peer);
  return { sessionId: created.sessionId, peer };
}

async function pendingRequest(page: Page, sessionId: string) {
  await expect.poll(async () => (await stateOf(page, sessionId)).pendingInteractions.length).toBeGreaterThan(0);
  return (await stateOf(page, sessionId)).pendingInteractions[0];
}

function choiceButton(page: Page, request: InteractionRequestDto, meaning: "accept" | "decline" | "cancel", scope?: string) {
  const choice = request.choices?.find((value) => value.meaning === meaning && (!scope || value.scope?.includes(scope)));
  expect(choice, `Missing offered ${meaning} ${scope || ""} choice`).toBeTruthy();
  return page.locator(`[data-request-id="${request.id}"] [data-choice-id="${choice!.id}"]`);
}

async function revealNativeImage(page: Page) {
  const card = page.locator(".toolCard").filter({ has: page.locator(".toolCardImage img") });
  const expand = card.locator('.toolCardExpandToggle[aria-expanded="false"]');
  if (await expand.isVisible()) await expand.click();
  await expect(card.locator(".toolCardImage img")).toBeVisible();
  await expect.poll(() => card.locator(".toolCardImage img").evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
}

for (const flow of ["landing", "drawer"] as const) {
  test(`${flow}: real native create, ordered stream/tools, final replacement and resume`, async ({ page, nativeServer }) => {
    const mutations: Array<{ path: string; body: Record<string, unknown> }> = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === "POST" && ["/api/sessions/new", "/api/prompt"].includes(path)) mutations.push({ path, body: request.postDataJSON() });
    });
    const { sessionId, peer } = await createCodex(page, nativeServer, flow);
    expect(mutations[0]).toMatchObject({ path: "/api/sessions/new", body: { harnessId: "codex" } });
    expect(mutations[1]).toMatchObject({ path: "/api/prompt", body: { sessionId, mode: "prompt" } });
    await controlPeer(peer, { action: "text", itemId: "intro", delta: "Before the tool.", done: true });
    await controlPeer(peer, { action: "thinking", delta: "Native reasoning summary.", done: true });
    await controlPeer(peer, { action: "tool", command: "printf exact-output", delta: "Partial output" });
    await expect(page.locator(".toolCard--running")).toHaveCount(1);
    await expect(page.locator(".toolCard--thinking")).toContainText("Native reasoning summary.");
    await controlPeer(peer, { action: "tool", delta: "\nExact completed output", done: true });
    const turn = await acceptedTurn(peer);
    for (const message of mcpImageEvents(turn.threadId, turn.turnId)) await controlPeer(peer, { action: "emit", message });
    await expect(page.locator(".toolCardImage img")).toHaveCount(1);
    await revealNativeImage(page);
    await controlPeer(peer, { action: "text", itemId: "outro", delta: "Temporary answer" });
    await expect(page.locator(".message.assistant", { hasText: "Temporary answer" })).toHaveCount(1);
    await controlPeer(peer, { action: "text", itemId: "outro", delta: " suffix", done: true, text: "Authoritative final answer." });
    await expect(page.locator(".message.assistant", { hasText: "Authoritative final answer." })).toHaveCount(1);
    await expect(page.locator(".message.assistant", { hasText: "Temporary answer" })).toHaveCount(0);
    await expect(page.locator("#stopButton")).toBeVisible(); // A finalized item is not idle.
    const order = await page.locator("[data-message-id]").evaluateAll((nodes) => nodes.map((node) => node.textContent || ""));
    const positions = ["Before the tool.", "Native reasoning summary.", "Exact completed output", "Authoritative final answer."].map((text) => order.findIndex((value) => value.includes(text)));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    await controlPeer(peer, { action: "complete", idle: false });
    await expect(page.locator("#stopButton")).toBeVisible(); // Turn completion and thread activity are distinct.
    await controlPeer(peer, { action: "activity", status: { type: "idle" } });
    await expect(page.locator("#stopButton")).toBeHidden();
    await page.reload();
    await expect(page.locator(".message.assistant", { hasText: "Authoritative final answer." })).toHaveCount(1);
    await expect(page.locator(".toolCard--running")).toHaveCount(0);
    await expect(page.locator(".toolCard--thinking")).toContainText("Native reasoning summary.");
    await expect(page.locator(".toolCardImage img")).toHaveCount(1);
    await revealNativeImage(page);
    expect((await stateOf(page, sessionId)).nativeSession.status).toBe("resumable");
    if (await page.locator("#sessionDrawer").isHidden()) await page.locator("#sessionButton").click();
    await expect(page.locator(`.sessionItem[data-session-id="${sessionId}"] .sessionHarnessBadge`)).toHaveText("Codex");
  });
}

test("two clients reconcile native decline/session-allow/cancel choices and pending reconnect", async ({ page, browser, nativeServer }) => {
  const { sessionId, peer } = await createCodex(page, nativeServer, "landing");
  const other = await browser.newContext({ baseURL: nativeServer.baseURL, viewport: page.viewportSize()! });
  const second = await other.newPage();
  let dialogs = 0;
  for (const client of [page, second]) client.on("dialog", async (dialog) => { dialogs += 1; await dialog.dismiss(); });
  try {
    await second.goto(`/?sessionId=${encodeURIComponent(sessionId)}`);
    await controlPeer(peer, { action: "approval", requestId: "decline-native", decisions: ["accept", "acceptForSession", "decline", "cancel"] });
    const request = await pendingRequest(page, sessionId);
    await expect(page.locator(".interactionRequest")).toHaveCount(1);
    await expect(second.locator(".interactionRequest")).toHaveCount(1);
    await second.reload();
    await expect(second.locator(".interactionRequest")).toHaveCount(1);
    await choiceButton(page, request, "decline").click();
    await waitObserved(peer, (record) => record.direction === "client" && record.message.id === "decline-native" && record.message.result?.decision === "decline");
    await expect(second.locator(".interactionRequest")).toHaveCount(0);
    await expect(page.locator("#stopButton")).toBeVisible(); // Decline continues, unlike cancel.
    await expect(page.locator('.toolCard--error[data-tool-name="command"]')).toHaveCount(1);
    await expect(page.locator(".runtimeErrorCard")).toHaveCount(0); // A declined tool is not an assistant/model failure.
    const stale = await second.request.post("/api/interactions/respond", { data: { sessionId, id: request.id, choiceID: request.choices![0].id } });
    expect(stale.ok()).toBe(false);
    expect((await readObserved(peer)).filter((record) => record.direction === "client" && record.message.id === "decline-native")).toHaveLength(1);

    await controlPeer(peer, { action: "approval", requestId: "session-native", itemId: "session-command", decisions: ["acceptForSession", "decline", "cancel"] });
    const sessionRequest = await pendingRequest(page, sessionId);
    await choiceButton(second, sessionRequest, "accept", "session").click();
    await waitObserved(peer, (record) => record.direction === "client" && record.message.id === "session-native" && record.message.result?.decision === "acceptForSession");
    await expect(page.locator(".interactionRequest")).toHaveCount(0);
    await expect(page.locator("#stopButton")).toBeVisible();

    // Permission grants have their own native turn/session scope, not command approval booleans.
    for (const scope of ["turn", "session"]) {
      await controlPeer(peer, { action: "approval", kind: "permissions", requestId: `permission-${scope}`, params: { permissions: { network: { enabled: true } } } });
      const permissionRequest = await pendingRequest(page, sessionId);
      await choiceButton(page, permissionRequest, "accept", scope).click();
      await waitObserved(peer, (record) => record.direction === "client" && record.message.id === `permission-${scope}` && record.message.result?.scope === scope && record.message.result?.permissions?.network?.enabled === true);
      await expect(second.locator(".interactionRequest")).toHaveCount(0);
    }

    await controlPeer(peer, { action: "approval", kind: "file", requestId: "file-native", itemId: "approved-file", changes: [{ path: "example.ts", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-before\n+after" }] });
    const fileRequest = await pendingRequest(page, sessionId);
    await expect(page.locator(`[data-request-id="${fileRequest.id}"]`)).toContainText("example.ts");
    await choiceButton(page, fileRequest, "accept").click();
    await waitObserved(peer, (record) => record.direction === "client" && record.message.id === "file-native" && record.message.result?.decision === "accept");
    const fileCard = page.locator('.toolCard[data-tool-name="file changes"]');
    const expandFile = fileCard.locator('.toolCardExpandToggle[aria-expanded="false"]');
    if (await expandFile.isVisible()) await expandFile.click();
    await expect(page.locator(".nativeToolDiff")).toBeVisible();
    await expect(page.locator(".nativeToolDiff")).toContainText("after");

    await controlPeer(peer, { action: "approval", requestId: "cancel-native", itemId: "cancel-command", decisions: ["accept", "decline", "cancel"] });
    const cancelRequest = await pendingRequest(page, sessionId);
    await choiceButton(page, cancelRequest, "cancel").click();
    await waitObserved(peer, (record) => record.direction === "client" && record.message.id === "cancel-native" && record.message.result?.decision === "cancel");
    await expect(second.locator(".interactionRequest")).toHaveCount(0);
    await expect(page.locator("#stopButton")).toBeHidden();
    expect(dialogs).toBe(0);
  } finally { await other.close(); }
});

test("interrupt targets the observed execution and acknowledgement is not settlement", async ({ page, nativeServer }) => {
  const { sessionId, peer } = await createCodex(page, nativeServer, "landing");
  await controlPeer(peer, { action: "configure", interrupt: "defer" });
  const state = await stateOf(page, sessionId);
  expect(state.activeExecution?.id).toBeTruthy();
  const stale = await page.request.post("/api/abort", { data: { sessionId, expectedExecutionId: "old-host-execution" } });
  expect(stale.ok()).toBe(false);
  await page.locator("#stopButton").click();
  const interrupt = await waitObserved(peer, (record) => record.direction === "client" && record.message.method === "turn/interrupt");
  expect(interrupt.message.params.turnId).toBe(state.activeExecution?.nativeExecutionId);
  await controlPeer(peer, { action: "release", requestId: interrupt.message.id, result: {} });
  await expect(page.locator("#stopButton")).toBeVisible();
  expect((await stateOf(page, sessionId)).activeExecution?.id).toBe(state.activeExecution?.id);
  await controlPeer(peer, { action: "complete", status: "interrupted" });
  await expect(page.locator("#stopButton")).toBeHidden();
});

test("native configuration stays separate, unsupported controls reject, host artifacts/files/git remain", async ({ page, nativeServer }) => {
  const { sessionId, peer } = await createCodex(page, nativeServer, "landing");
  let modelCatalogRequests = 0;
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/models") modelCatalogRequests += 1; });
  const state = await stateOf(page, sessionId);
  expect(state.nativeSettings?.reasoningEffort).toBe("medium"); // Native effective value, not catalog default low.
  expect(state.stats.cost).toBeUndefined();
  await page.locator("#modelSettingsButton").click();
  await expect(page.locator(".modelSettingsNative")).toContainText("Reasoning: medium");
  await expect(page.locator("#modelSelect")).toBeHidden();
  await expect(page.locator("#thinkingSelect")).toBeHidden();
  await page.locator("#messages").click({ position: { x: 4, y: 4 } });
  await expect(page.locator("#modelSettingsPopover")).toBeHidden();
  await expect(page.locator("#queueToggle")).toBeHidden();
  await expect(page.locator("#attachButton")).toBeHidden();
  await expect(page.locator("#conversationTreeButton")).toBeHidden();
  await expect(page.locator("#extensionFooter")).toBeEmpty();
  const model = await page.request.post("/api/model", { data: { sessionId, provider: "not-pi", id: "not-a-pi-model" } });
  expect(model.ok()).toBe(false);
  const compact = await page.request.post("/api/command", { data: { sessionId, command: "/compact" } });
  expect(compact.ok()).toBe(false);
  await controlPeer(peer, { action: "text", delta: "[Native artifact](/api/artifacts/native-report.html)", done: true });
  await controlPeer(peer, { action: "complete" });
  const preview = page.locator(".artifactPreview--html");
  await expect(preview).toHaveCount(1);
  await expect(preview.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
  await page.locator("#prompt").blur();
  await page.locator(".actionLauncherToggle").click();
  await expect(page.locator(".actionLauncherItem", { hasText: "Conversation tree" })).toHaveCount(0);
  await page.locator(".actionLauncherItem", { hasText: "File explorer" }).click();
  await expect(page.locator("#filesPanel")).toBeVisible();
  await expect(page.locator('.fileTreeFile[title="hello.txt"]')).toBeVisible();
  await page.locator("#filesCloseButton").click();
  await openLauncherAction(page, "Git");
  await expect(page.locator("#gitPanel")).toBeVisible();
  const git = await page.request.get(`/api/git/status?sessionId=${encodeURIComponent(sessionId)}`);
  expect(git.ok()).toBe(true); expect((await git.json()).isRepo).toBe(true);
  await page.locator("#gitCloseButton").click();
  await openLauncherAction(page, "Session details");
  await expect(page.locator("#sessionInfoPanel")).toContainText(`Native session: ${state.nativeSession.sessionId}`);
  await expect(page.locator("#sessionInfoInspectPrompt")).toBeHidden();
  await expect(page.locator("#sessionInfoCostValue")).toHaveText("—");
  await page.locator("#sessionInfoCloseButton").click();
  if (await page.locator("#sessionDrawer").isHidden()) await page.locator("#sessionButton").click();
  await page.locator("#sessionDrawerSettingsButton").click();
  await page.locator("#settingsNavExtensions").click();
  await expect(page.locator("#extensionReloadButton")).toBeHidden();
  await expect(page.locator("#extensionStatusMessage")).toContainText("Pi extensions do not run");
  await expect(page.locator("#extensionSettingsContainer")).toHaveAttribute("inert", "");
  if (await page.locator("#settingsBackButton").isVisible()) await page.locator("#settingsBackButton").click();
  await page.locator("#settingsNavNewSessions").click();
  await expect(page.locator("#settingSaveModelDefaultsButton")).toBeDisabled();
  expect(modelCatalogRequests).toBe(0);
  const catalog = await (await page.request.get("/api/harnesses")).json() as HarnessCatalogDto;
  const claude = catalog.harnesses.find((harness) => harness.id === "claude");
  if (claude) { expect(claude.available).toBe(false); expect(claude.unavailableReason).toBeTruthy(); }
});

test("durable web identity resumes through native API after service restart", async ({ page, nativeServer }) => {
  const { sessionId, peer } = await createCodex(page, nativeServer, "landing");
  await controlPeer(peer, { action: "text", delta: "Saved native response.", done: true });
  await controlPeer(peer, { action: "complete" });
  await expect(page.locator("#stopButton")).toBeHidden();
  const before = await stateOf(page, sessionId);
  await nativeServer.restart();
  await page.reload();
  await expect(page.locator(".message.assistant", { hasText: "Saved native response." })).toHaveCount(1);
  const after = await stateOf(page, sessionId);
  expect(after.sessionId).toBe(sessionId);
  expect(after.nativeSession.sessionId).toBe(before.nativeSession.sessionId);
  expect(after.sessionFile).toBeUndefined();
  const resumed = await peerForThread(nativeServer.peerDir, after.nativeSession.sessionId!);
  await waitObserved(resumed, (record) => record.direction === "client" && record.message.method === "thread/resume" && record.message.params.threadId === before.nativeSession.sessionId);
  await page.locator("#prompt").fill("Continue after restart."); await page.locator("#primaryButton").click();
  await acceptedTurn(resumed);
  await controlPeer(resumed, { action: "text", itemId: "resumed-answer", delta: "Resumed correctly.", done: true });
  await controlPeer(resumed, { action: "complete" });
  await expect(page.locator(".message.assistant", { hasText: "Resumed correctly." })).toHaveCount(1);
});

test("explicit drawer reopen recovers a lost persistent peer without replay or poll respawn", async ({ page, nativeServer }) => {
  const { sessionId, peer } = await createCodex(page, nativeServer, "landing");
  const nativeId = (await stateOf(page, sessionId)).nativeSession.sessionId!;
  await controlPeer(peer, { action: "text", text: "Preserve this completed native response.", done: true });
  await controlPeer(peer, { action: "complete" });
  await expect(page.locator("#stopButton")).toBeHidden();
  await controlPeer(peer, { action: "exit", code: 7 });
  await expect.poll(async () => (await stateOf(page, sessionId)).phase).toBe("unavailable");
  const peersBefore = await readdir(join(nativeServer.peerDir, "peers"));
  await stateOf(page, sessionId);
  expect((await page.request.get(`/api/messages?sessionId=${encodeURIComponent(sessionId)}`)).ok()).toBe(true);
  expect(await readdir(join(nativeServer.peerDir, "peers"))).toEqual(peersBefore);
  if (await page.locator("#sessionDrawer").isHidden()) await page.locator("#sessionButton").click();
  await page.locator(`.sessionItem[data-session-id="${sessionId}"] .sessionItemNavBtn`).click();
  await expect.poll(async () => (await stateOf(page, sessionId)).phase).toBe("idle");
  const recovered = await peerForThread(nativeServer.peerDir, nativeId);
  expect(recovered.pid).not.toBe(peer.pid);
  expect((await readObserved(recovered)).filter((record) => record.direction === "client" && record.message.method === "turn/start")).toHaveLength(0);
  await expect(page.locator(".message.assistant")).toContainText("Preserve this completed native response.");
  await expect(page.locator("#stopButton")).toBeHidden();
});

test("native rejection is visible without a fabricated accepted user message", async ({ page, nativeServer }) => {
  const { sessionId, peer } = await createCodex(page, nativeServer, "drawer", false);
  await controlPeer(peer, { action: "configure", prompt: "reject" });
  await page.locator("#prompt").fill("This input will be rejected."); await page.locator("#primaryButton").click();
  await expect(page.locator("body")).toContainText(/Synthetic native (prompt )?rejection/);
  await expect(page.locator(".message.user")).toHaveCount(0);
  await expect(page.locator("#stopButton")).toBeHidden();
  const state = await stateOf(page, sessionId);
  expect(["idle", "error"]).toContain(state.phase);
});

test("native process death invalidates pending decisions and running controls", async ({ page, nativeServer }) => {
  const { sessionId, peer } = await createCodex(page, nativeServer, "landing");
  await controlPeer(peer, { action: "approval", requestId: "dies-pending" });
  await expect(page.locator(".interactionRequest")).toHaveCount(1);
  await controlPeer(peer, { action: "exit", code: 17 });
  await expect(page.locator(".interactionRequest")).toHaveCount(0);
  await expect(page.locator("#stopButton")).toBeHidden();
  await expect.poll(async () => (await stateOf(page, sessionId)).phase).toMatch(/error|unavailable/);
  await expect(page.locator("#runtimeStatus")).toBeVisible();
});
