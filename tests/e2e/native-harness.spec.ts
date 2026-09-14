import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test as base, expect, type Page, type Response, type TestInfo } from "@playwright/test";
import type { HarnessCatalogDto, InteractionRequestDto, SessionSnapshotDto } from "../../server/session/dto.js";
import { acceptedTurn, controlPeer, findPeer, peerForThread, readObserved, waitObserved } from "../fixtures/codex-peer-control.js";
import { codexFixturePng, mcpImageEvents } from "../fixtures/codex-native-events.js";
import { openLauncherAction } from "./helpers/actionLauncher.js";

const repository = resolve(import.meta.dirname, "../..");

type NativeServer = { root: string; workspace: string; peerDir: string; claudePeerDir: string; baseURL: string; restart: () => Promise<void> };

async function unusedPort() {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function isolatedServer(testInfo: TestInfo, claudeEnabled: boolean) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-native-browser-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  const peerDir = join(root, "codex-peer");
  const claudePeerDir = join(root, "claude-peer");
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
    PI_WEB_CLAUDE_EXECUTABLE: claudeEnabled ? join(repository, "tests/fixtures/claude-native-cli.mjs") : join(root, "not-installed-claude"),
    PI_WEB_CLAUDE_PEER_DIR: claudePeerDir,
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
    const serverLog = testInfo.outputPath("native-server.log");
    await mkdir(dirname(serverLog), { recursive: true });
    await writeFile(serverLog, output);
    await testInfo.attach("native-server.log", { path: serverLog, contentType: "text/plain" });
    if (testInfo.status !== testInfo.expectedStatus) {
      for (const [harness, directory] of [["codex", peerDir], ["claude", claudePeerDir]]) {
        for (const pid of await readdir(join(directory, "peers")).catch(() => [])) {
          const observed = await readFile(join(directory, "peers", pid, "observed.jsonl"), "utf8").catch(() => "");
          if (observed) {
            const name = `synthetic-${harness}-peer-${pid}.jsonl`;
            const file = testInfo.outputPath(name);
            await writeFile(file, observed);
            await testInfo.attach(name, { path: file, contentType: "application/x-ndjson" });
          }
        }
      }
    }
    await rm(root, { recursive: true, force: true });
  }
  return { value: { root, workspace, peerDir, claudePeerDir, baseURL, restart: async () => { await stop(); await start(); } } satisfies NativeServer, start, cleanup };
}

const test = base.extend<{ nativeServer: NativeServer; claudeEnabled: boolean }>({
  claudeEnabled: [false, { option: true }],
  nativeServer: async ({ claudeEnabled }, use, testInfo) => {
    const server = await isolatedServer(testInfo, claudeEnabled);
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

// The drawer rehydrates after creation; landing adopts the create snapshot and
// sends directly, so it must not wait for a GET that its flow never requests.
function postCreateState(page: Page, previousId: string) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    const id = url.searchParams.get("sessionId");
    return response.request().method() === "GET" && url.pathname === "/api/state" && Boolean(id && id !== previousId);
  });
}

async function nativeComposerReady(page: Page, response: Response, sessionId: string) {
  expect(response.ok(), await response.text()).toBe(true);
  expect((await response.json()).sessionId).toBe(sessionId);
  await response.finished();
  // Creation's HTTP receipt precedes state hydration and overlay close. Desktop
  // intentionally retains its side-by-side drawer; only overlays must disappear.
  if (await page.evaluate(() => matchMedia("(max-width: 1024px), (max-height: 520px)").matches)) {
    await expect(page.locator("#sessionDrawer")).toBeHidden();
  }
}

async function submitNativePrompt(page: Page) {
  // A programmatic fill can type behind an overlay, then its late close restores
  // focus to Sessions. Activate the ready composer exactly as a user would.
  await page.locator("#prompt").click();
  await page.locator("#primaryButton").click();
}

async function createCodex(page: Page, server: NativeServer, flow: "landing" | "drawer", prompt = true) {
  await page.goto("/");
  await expect(page.locator("#emptyCwdChooser")).toBeVisible();
  const initial = await stateOf(page);
  const readyState = flow === "drawer" ? postCreateState(page, initial.sessionId) : undefined;
  expect(initial.harnessId).toBe("pi");
  await expect(page.locator('[data-harness-selector="landing"] select')).toHaveValue("pi");
  const createdResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/sessions/new" && response.request().method() === "POST");
  if (flow === "landing") {
    await page.locator('[data-harness-selector="landing"] select').selectOption("codex");
    await page.locator("#prompt").fill("Inspect this isolated workspace.");
    await submitNativePrompt(page);
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
  if (readyState) await nativeComposerReady(page, await readyState, created.sessionId);
  if (flow === "drawer" && prompt) {
    await page.locator("#prompt").fill("Inspect this isolated workspace.");
    await submitNativePrompt(page);
  }
  if (flow === "landing" || prompt) await acceptedTurn(peer);
  return { sessionId: created.sessionId, peer };
}

test("drawer: native prompt submission handles delayed creation focus restoration", async ({ page, nativeServer }) => {
  const overlay = await page.evaluate(() => matchMedia("(max-width: 1024px), (max-height: 520px)").matches);
  let creating = false;
  let previousId: string | undefined;
  let held = false;
  let signalHeld!: () => void;
  let release!: () => void;
  const requestHeld = new Promise<void>((resolve) => { signalHeld = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/sessions/new") {
      creating = true;
      previousId = request.postDataJSON().sessionId;
    }
  });
  // Delay one real GET, never its contents. An HTTP create receipt can precede
  // post-create state hydration and the overlay's focus restoration.
  await page.route("**/api/state?**", async (route) => {
    const id = new URL(route.request().url()).searchParams.get("sessionId");
    if (creating && id && id !== previousId && !held) {
      held = true; signalHeld(); await barrier;
    }
    await route.continue();
  });
  const creation = createCodex(page, nativeServer, "drawer", false);
  try {
    await requestHeld;
    await expect(page.locator("#sessionDrawer")).toBeVisible();
    // Reproduce the old helper's premature programmatic fill, behind the overlay.
    await page.locator("#prompt").fill("Inspect this isolated workspace.");
    await expect(page.locator("#prompt")).toBeFocused();
    release();
    if (overlay) {
      await expect(page.locator("#sessionDrawer")).toBeHidden();
      await expect(page.locator("#sessionButton")).toBeFocused();
      await expect(page.locator("#primaryButton")).toBeHidden();
    } else {
      // Desktop retains the side-by-side drawer, so there is no late close.
      await expect(page.locator("#sessionDrawer")).toBeVisible();
      await expect(page.locator("#prompt")).toBeFocused();
      await expect(page.locator("#primaryButton")).toBeVisible();
    }
    const { peer } = await creation;
    const accepted = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/prompt" && response.request().method() === "POST");
    await submitNativePrompt(page);
    expect((await accepted).status()).toBe(202);
    await acceptedTurn(peer);
    await controlPeer(peer, { action: "complete" });
    await expect(page.locator("#stopButton")).toBeHidden();
  } finally {
    release();
    await creation.catch(() => undefined);
  }
});

async function pendingRequest(page: Page, sessionId: string) {
  await expect.poll(async () => (await stateOf(page, sessionId)).pendingInteractions.length).toBeGreaterThan(0);
  return (await stateOf(page, sessionId)).pendingInteractions[0];
}

function choiceButton(page: Page, request: InteractionRequestDto, meaning: "accept" | "decline" | "cancel" | "submit", scope?: string) {
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

test("Codex approval details preserve command tails, URLs, cwd and native rule context without a tool row", async ({ page, nativeServer }) => {
  const { sessionId, peer } = await createCodex(page, nativeServer, "landing");
  const { threadId, turnId } = await acceptedTurn(peer);
  const command = `printf '${"a".repeat(2_300)}'; curl https://review-destination.invalid/bootstrap.sh; printf REVIEW_TAIL`;
  const cwd = `/synthetic/${"nested/".repeat(330)}CWD_TAIL`;
  const execRule = ["sh", "-c", `printf ${"r".repeat(2_100)}RULE_TAIL`];
  const permissions = { network: null, fileSystem: { write: ["/synthetic/WRITE_TAIL"] } };
  const requestId = "full-review-context";
  await controlPeer(peer, { action: "emit", message: { id: requestId, method: "item/commandExecution/requestApproval", params: {
    threadId, turnId, itemId: "unstarted-command", startedAtMs: Date.now(), kind: "command", environmentId: "native-environment",
    command, cwd, reason: `${"reason ".repeat(360)}REASON_TAIL`, additionalPermissions: permissions,
    networkApprovalContext: { host: "review-destination.invalid", protocol: "https" },
    proposedExecpolicyAmendment: execRule, proposedNetworkPolicyAmendments: [{ host: "review-destination.invalid", action: "allow" }],
    availableDecisions: ["accept", "acceptForSession", { acceptWithExecpolicyAmendment: { execpolicy_amendment: execRule } }, "decline", "cancel"],
  } } });
  const card = page.locator(".interactionRequest");
  await expect(card).toHaveCount(1);
  await card.locator("summary").click();
  const details = card.locator("pre");
  await expect(details).toBeVisible();
  await expect(details).toContainText("REVIEW_TAIL");
  await expect(details).toContainText("https://review-destination.invalid/bootstrap.sh");
  await expect(details).toContainText("CWD_TAIL");
  await expect(details).toContainText("REASON_TAIL");
  await expect(details).toContainText("RULE_TAIL");
  expect(JSON.parse((await details.textContent())!)).toMatchObject({ command, cwd, proposedExecpolicyAmendment: execRule,
    additionalPermissions: { fileSystem: permissions.fileSystem }, networkApprovalContext: { host: "review-destination.invalid", protocol: "https" } });
  await expect(card.locator('[data-choice-id="accept"]')).toBeEnabled();
  await expect(card.locator('[data-choice-id="acceptForSession"]')).toBeEnabled();
  await expect(card.locator('[data-choice-id="acceptWithExecpolicyAmendment"]')).toHaveCount(0);
  const pending = (await stateOf(page, sessionId)).pendingInteractions[0]!;
  expect(pending.payload?.messageId).toBeUndefined();
  await card.locator('[data-choice-id="decline"]').click();
  await waitObserved(peer, (record) => record.direction === "client" && record.message.id === requestId && record.message.result?.decision === "decline");
  await expect(card).toHaveCount(0); // Every added review request is declined, never executed.
  // Actual native Network presentation supplies neither a command nor cwd.
  await controlPeer(peer, { action: "emit", message: { id: "network-review", method: "item/commandExecution/requestApproval", params: {
    threadId, turnId, itemId: "unstarted-network", startedAtMs: Date.now(), kind: "command", environmentId: null,
    command: null, cwd: null, commandActions: null, networkApprovalContext: { host: "review-destination.invalid", protocol: "https" },
    availableDecisions: ["accept", "decline", "cancel"],
  } } });
  await expect(card).toHaveCount(1); await card.locator("summary").click();
  await expect(card.locator("pre")).toBeVisible();
  expect(JSON.parse((await card.locator("pre").textContent())!)).toMatchObject({ command: null, cwd: null,
    networkApprovalContext: { host: "review-destination.invalid", protocol: "https" } });
  await expect(card.locator("pre")).toContainText("Native network access");
  await expect(card.locator('[data-choice-id="accept"]')).toBeEnabled();
  await card.locator('[data-choice-id="decline"]').click();
  await waitObserved(peer, (record) => record.direction === "client" && record.message.id === "network-review" && record.message.result?.decision === "decline");
  await expect(card).toHaveCount(0);
});

test("Codex approval details retain permission paths and file rename/diff/root context", async ({ page, nativeServer }) => {
  const { peer } = await createCodex(page, nativeServer, "landing");
  const path = `/synthetic/${"p".repeat(1_800)}PATH_TAIL`;
  const permissions = { network: null, fileSystem: { entries: [{ path: { type: "glob_pattern", pattern: `${path}/**` }, access: "write" }] } };
  await controlPeer(peer, { action: "approval", kind: "permissions", requestId: "review-permissions", params: { permissions,
    environmentId: "permission-environment", cwd: nativeServer.workspace, reason: "Review exact requested paths" } });
  const card = page.locator(".interactionRequest");
  await expect(card).toHaveCount(1); await card.locator("summary").click();
  await expect(card.locator("pre")).toBeVisible();
  expect(JSON.parse((await card.locator("pre").textContent())!)).toMatchObject({ permissions: { fileSystem: permissions.fileSystem }, cwd: nativeServer.workspace, environmentId: "permission-environment" });
  await expect(card.locator('[data-choice-id="allowSession"]')).toBeEnabled();
  await card.locator('[data-choice-id="decline"]').click();
  await waitObserved(peer, (record) => record.direction === "client" && record.message.id === "review-permissions" && !!record.message.result);
  await expect(card).toHaveCount(0);
  const changes = [{ path: "old.ts", kind: { type: "update", move_path: `${path}/RENAME_TAIL.ts` }, diff: "@@ -1 +1 @@\n-before\n+REVIEW_DIFF_TAIL" }];
  const grantRoot = `/synthetic/${"root/".repeat(430)}ROOT_TAIL`;
  await controlPeer(peer, { action: "approval", kind: "file", requestId: "review-file", changes, params: { grantRoot } });
  await expect(card).toHaveCount(1); await card.locator("summary").click();
  await expect(card.locator("pre")).toBeVisible();
  expect(JSON.parse((await card.locator("pre").textContent())!)).toMatchObject({ changes, grantRoot });
  await expect(card.locator("pre")).toContainText("RENAME_TAIL.ts");
  await expect(card.locator("pre")).toContainText("REVIEW_DIFF_TAIL");
  await expect(card.locator("pre")).toContainText("ROOT_TAIL");
  await expect(card.locator('[data-choice-id="acceptForSession"]')).toHaveCount(0);
  await card.locator('[data-choice-id="decline"]').click();
  await waitObserved(peer, (record) => record.direction === "client" && record.message.id === "review-file" && record.message.result?.decision === "decline");
  await expect(card).toHaveCount(0);
});

test("Codex rejects concealed approval context without offering Allow or exposing credentials in the tool row", async ({ page, nativeServer }) => {
  const { sessionId, peer } = await createCodex(page, nativeServer, "landing");
  await controlPeer(peer, { action: "approval", requestId: "unsafe-review", command: 'curl -H "Authorization: Bearer browser-secret-marker" https://example.invalid' });
  const denied = await waitObserved(peer, (record) => record.direction === "client" && record.message.id === "unsafe-review");
  expect(denied.message.result).toEqual({ decision: "cancel" });
  await expect(page.locator(".interactionRequest")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("browser-secret-marker");
  await expect.poll(async () => (await stateOf(page, sessionId)).phase).toBe("idle");
  const oldTurn = await acceptedTurn(peer);
  await page.locator("#prompt").fill("Another synthetic request."); await page.locator("#primaryButton").click();
  const { threadId, turnId } = await acceptedTurn(peer, oldTurn.turnId);
  await controlPeer(peer, { action: "emit", message: { id: "oversized-review", method: "item/commandExecution/requestApproval", params: {
    threadId, turnId, itemId: "unstarted-oversized", startedAtMs: Date.now(), kind: "command", environmentId: null, cwd: nativeServer.workspace,
    command: `printf ${"x".repeat(33_000)}OVERSIZED_TAIL`, availableDecisions: ["accept", "decline", "cancel"],
  } } });
  const oversized = await waitObserved(peer, (record) => record.direction === "client" && record.message.id === "oversized-review");
  expect(oversized.message.result).toEqual({ decision: "cancel" });
  await expect(page.locator(".interactionRequest")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("OVERSIZED_TAIL");
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
  await page.locator("#prompt").fill("This input will be rejected."); await submitNativePrompt(page);
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

async function createClaude(page: Page, server: NativeServer, flow: "landing" | "drawer" = "landing") {
  await page.goto("/");
  const initial = await stateOf(page);
  const readyState = flow === "drawer" ? postCreateState(page, initial.sessionId) : undefined;
  const createdResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/sessions/new" && response.request().method() === "POST");
  if (flow === "landing") {
    await page.locator('[data-harness-selector="landing"] select').selectOption("claude");
    await page.locator("#prompt").fill("Inspect this Claude workspace.");
    await submitNativePrompt(page);
  } else {
    await page.locator("#sessionButton").click();
    await page.locator("#sessionNewButton").click();
    const dialog = page.getByRole("dialog", { name: "New session", exact: true });
    await dialog.locator('[data-harness-selector="dialog"] select').selectOption("claude");
    await dialog.getByRole("button", { name: "Start session" }).click();
  }
  const response = await createdResponse;
  expect(response.ok(), await response.text()).toBe(true);
  const created = await response.json() as SessionSnapshotDto;
  expect(created.harnessId).toBe("claude");
  expect(created.sessionId).not.toBe(initial.sessionId);
  expect(created.nativeSession.sessionId).toBeTruthy();
  expect(created.nativeSession.sessionId).not.toBe(created.sessionId);
  expect(created.nativeSession.status).toBe("unmaterialized");
  expect(created.sessionFile).toBeUndefined();
  if (readyState) await nativeComposerReady(page, await readyState, created.sessionId);
  if (flow === "drawer") {
    // Unlike Codex, creating a Claude handle has not started its native process.
    expect(await readdir(join(server.claudePeerDir, "peers")).catch(() => [])).toHaveLength(0);
    await page.locator("#prompt").fill("Inspect this Claude workspace.");
    await submitNativePrompt(page);
  }
  const peer = await findPeer(server.claudePeerDir, (record) => record.direction === "client" && record.message.type === "user" && record.message.session_id === created.nativeSession.sessionId);
  const user = (await waitObserved(peer, (record) => record.direction === "client" && record.message.type === "user")).message;
  await expect(page.locator(".message.user", { hasText: "Inspect this Claude workspace." })).toHaveCount(1);
  return { sessionId: created.sessionId, nativeId: created.nativeSession.sessionId!, peer, user };
}

type ClaudeRun = Awaited<ReturnType<typeof createClaude>>;
let claudeControlSerial = 0;
async function controlClaude(run: ClaudeRun, command: Record<string, unknown>) {
  const testControlId = randomUUID();
  const file = join(run.peer.directory, "commands", `${String(++claudeControlSerial).padStart(8, "0")}.json`);
  await writeFile(`${file}.tmp`, JSON.stringify({ ...command, testControlId }));
  await rename(`${file}.tmp`, file);
  if (command.action !== "exit") await waitObserved(run.peer, (record) => record.direction === "control" && record.message.testControlId === testControlId);
}
const emitClaude = (run: ClaudeRun, message: Record<string, unknown>) => controlClaude(run, { action: "emit", message });
const streamClaude = (run: ClaudeRun, event: Record<string, unknown>) => emitClaude(run, { type: "stream_event", parent_tool_use_id: null, user_message_uuid: run.user.uuid, event });
const assistantClaude = (id: string, content: unknown[]) => ({ type: "assistant", parent_tool_use_id: null, message: { id, role: "assistant", model: "claude-fixture", content, stop_reason: null, stop_sequence: null, usage: {} } });
async function finishClaude(run: ClaudeRun, overrides: Record<string, unknown> = {}, idle = true) {
  await emitClaude(run, { type: "result", subtype: "success", is_error: false, result: "done", num_turns: 1,
    duration_ms: 1, duration_api_ms: 1, stop_reason: "end_turn", total_cost_usd: 0.02, usage: {},
    modelUsage: { "claude-fixture": { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2, cacheCreationInputTokens: 1, costUSD: 0.02 } },
    permission_denials: [], result_index: 0, user_message_uuid: run.user.uuid, ...overrides });
  if (idle) await emitClaude(run, { type: "system", subtype: "session_state_changed", state: "idle" });
}
const claudeResponse = (run: ClaudeRun, id: string) => waitObserved(run.peer, (record) => record.direction === "client" && record.message.type === "control_response" && record.message.response?.request_id === id);

// The same service fixture and existing UI, through the pinned SDK and executable peer.
// SDK history readers are deliberately NOT substituted and no private transcript store is fabricated.
test.describe("Claude native", () => {
  test.use({ claudeEnabled: true });

  for (const flow of ["landing", "drawer"] as const) {
    test(`${flow}: SDK stream, per-block finals, tools/images and authoritative idle`, async ({ page, nativeServer }) => {
      const run = await createClaude(page, nativeServer, flow);
      const initial = await stateOf(page, run.sessionId);
      expect(initial.activeExecution?.owner).toBe("host");
      expect(initial.activeExecution?.nativeExecutionId).toBeUndefined();
      expect(initial.stats.cost).toBeUndefined();
      await streamClaude(run, { type: "message_start", message: { id: "claude-api-1" } });
      await streamClaude(run, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      await streamClaude(run, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Claude provisional intro." } });
      await expect(page.locator(".message.assistant")).toContainText("Claude provisional intro.");
      await emitClaude(run, assistantClaude("claude-api-1", [{ type: "text", text: "Claude authoritative intro." }]));
      await streamClaude(run, { type: "content_block_stop", index: 0 });
      await streamClaude(run, { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } });
      await streamClaude(run, { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "Exposed Claude summary." } });
      await emitClaude(run, assistantClaude("claude-api-1", [{ type: "thinking", thinking: "Exposed Claude summary." }]));
      await streamClaude(run, { type: "content_block_stop", index: 1 });
      await streamClaude(run, { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "claude-read", name: "Read", input: {} } });
      await streamClaude(run, { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"file_path":' } });
      await emitClaude(run, assistantClaude("claude-api-1", [{ type: "tool_use", id: "claude-read", name: "Read", input: { file_path: "hello.txt" } }]));
      await streamClaude(run, { type: "content_block_stop", index: 2 });
      await streamClaude(run, { type: "message_stop" });
      await emitClaude(run, { type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "claude-read", is_error: false, content: [
        { type: "text", text: "Native Claude tool output." }, { type: "image", source: { type: "base64", media_type: "image/png", data: codexFixturePng } },
      ] }] } });
      await emitClaude(run, assistantClaude("claude-api-2", [{ type: "text", text: "Claude final answer." }]));
      await expect(page.locator("#messages")).not.toContainText("Claude provisional intro.");
      await expect(page.locator(".toolCard--thinking")).toContainText("Exposed Claude summary.");
      await expect(page.locator('.toolCard[data-tool-name="Read"]')).toHaveCount(1);
      await revealNativeImage(page);
      await expect(page.locator(".message.user")).toHaveCount(1); // A tool result is not another user prompt.
      const parts = (await (await page.request.get(`/api/messages?sessionId=${run.sessionId}`)).json()).messages.find((message: any) => message.nativeItemId === "claude-api-1").parts;
      expect(parts.map((part: any) => part.type)).toEqual(["text", "thinking", "toolCall"]);
      expect(parts[2]).toMatchObject({ status: "completed", args: { file_path: "hello.txt" } });
      await finishClaude(run, {}, false);
      await expect.poll(async () => (await stateOf(page, run.sessionId)).phase).toBe("settling");
      await expect(page.locator("#stopButton")).toBeVisible();
      await emitClaude(run, { type: "system", subtype: "session_state_changed", state: "idle" });
      await expect(page.locator("#stopButton")).toBeHidden();
      expect((await stateOf(page, run.sessionId)).stats.cost).toBe(0.02);
      await page.reload(); // Live-handle hydration, not a claim of persisted SDK history.
      await expect(page.locator("#messages")).toContainText("Claude final answer.");
      await revealNativeImage(page);
      expect((await stateOf(page, run.sessionId)).nativeSession.status).toBe("unmaterialized");
      await page.locator("#modelSettingsButton").click();
      await expect(page.locator(".modelSettingsNative")).toContainText(initial.nativeSettings!.model!);
      await expect(page.locator("#modelSelect")).toBeHidden();
      await expect(page.locator("#attachButton")).toBeHidden();
    });
  }

  test("two clients reconcile native deny, suggested session scope and cancel", async ({ page, browser, nativeServer }) => {
    const run = await createClaude(page, nativeServer);
    const other = await browser.newContext({ baseURL: nativeServer.baseURL, viewport: page.viewportSize()! });
    const second = await other.newPage();
    let dialogs = 0;
    for (const client of [page, second]) client.on("dialog", async (dialog) => { dialogs++; await dialog.dismiss(); });
    try {
      await second.goto(`/?sessionId=${run.sessionId}`);
      const suggestions = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "git status" }], behavior: "allow", destination: "session" }];
      const ask = (id: string) => emitClaude(run, { type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "git status" }, tool_use_id: `tool-${id}`, permission_suggestions: id === "claude-scope" ? suggestions : [], default_to_no: true } });
      await ask("claude-deny");
      const deny = await pendingRequest(page, run.sessionId);
      await expect(page.locator(".interactionSummary")).toContainText("git status");
      await expect(page.locator(".interactionCaution")).toBeVisible();
      await second.reload();
      await expect(second.locator(".interactionRequest")).toHaveCount(1);
      await choiceButton(second, deny, "decline").click();
      expect((await claudeResponse(run, "claude-deny")).message.response.response).toMatchObject({ behavior: "deny" });
      await expect(page.locator(".interactionRequest")).toHaveCount(0);
      await expect(page.locator("#stopButton")).toBeVisible();
      const stale = await page.request.post("/api/interactions/respond", { data: { sessionId: run.sessionId, id: deny.id, choiceID: "allow-once" } });
      expect(stale.ok()).toBe(false);
      await ask("claude-scope");
      const scope = await pendingRequest(page, run.sessionId);
      await page.locator(".interactionRequest summary").click();
      await expect(page.locator(".interactionRequest pre")).toBeVisible();
      await expect(page.locator(".interactionRequest pre")).toContainText("Proposed permission changes: addRules: Bash(git status) [session]");
      await choiceButton(page, scope, "accept", "session").click();
      expect((await claudeResponse(run, "claude-scope")).message.response.response).toMatchObject({ behavior: "allow", updatedInput: { command: "git status" }, updatedPermissions: suggestions });
      await expect(second.locator(".interactionRequest")).toHaveCount(0);
      await ask("claude-cancel");
      const cancel = await pendingRequest(page, run.sessionId);
      await choiceButton(page, cancel, "cancel").click();
      expect((await claudeResponse(run, "claude-cancel")).message.response.response).toMatchObject({ behavior: "deny", interrupt: true });
      await expect(second.locator(".interactionRequest")).toHaveCount(0);
      await expect(page.locator("#stopButton")).toBeVisible(); // Native cancellation reply is not idle.
      await finishClaude(run, { terminal_reason: "aborted_tools" });
      await expect(page.locator("#stopButton")).toBeHidden();
      expect(dialogs).toBe(0);
    } finally { await other.close(); }
  });

  test("questions retain answers across another pending request and submit native labels", async ({ page, nativeServer }) => {
    const run = await createClaude(page, nativeServer);
    await emitClaude(run, { type: "control_request", request_id: "claude-question", request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", tool_use_id: "question-tool", input: { questions: [
      { question: "Which database?", header: "Database", multiSelect: false, options: [{ label: "SQLite", description: "Embedded" }, { label: "Postgres", description: "Server" }] },
    ] } } });
    const request = await pendingRequest(page, run.sessionId);
    await choiceButton(page, request, "submit").click();
    await expect(page.locator(".interactionStatus")).toContainText("Answer required");
    const answer = request.questions![0].options![1];
    await page.getByRole("combobox", { name: "Which database?", exact: true }).selectOption(answer.id);
    await page.getByRole("combobox", { name: "Which database?", exact: true }).focus();
    await emitClaude(run, { type: "control_request", request_id: "parallel-approval", request: { subtype: "can_use_tool", tool_name: "Read", tool_use_id: "parallel-read", input: { file_path: "hello.txt" } } });
    await expect(page.locator(".interactionRequest")).toHaveCount(2);
    await expect(page.getByRole("combobox", { name: "Which database?", exact: true })).toHaveValue(answer.id);
    await expect(page.getByRole("combobox", { name: "Which database?", exact: true })).toBeFocused();
    await choiceButton(page, request, "submit").click();
    expect((await claudeResponse(run, "claude-question")).message.response.response).toMatchObject({ behavior: "allow", updatedInput: { answers: { "Which database?": "Postgres" } } });
    await emitClaude(run, { type: "control_cancel_request", request_id: "parallel-approval" });
    await expect(page.locator(".interactionRequest")).toHaveCount(0);
    await finishClaude(run);
    await expect(page.locator("#stopButton")).toBeHidden();
  });

  test("guarded SDK interrupt acknowledgement and result are not idle", async ({ page, nativeServer }) => {
    const run = await createClaude(page, nativeServer);
    const stale = await page.request.post("/api/abort", { data: { sessionId: run.sessionId, expectedExecutionId: "stale-execution" } });
    expect(stale.ok()).toBe(false);
    await page.locator("#stopButton").click();
    await waitObserved(run.peer, (record) => record.direction === "client" && record.message.type === "control_request" && record.message.request?.subtype === "interrupt");
    await expect(page.locator("#stopButton")).toBeVisible();
    await finishClaude(run, { terminal_reason: "aborted_streaming" }, false);
    await expect.poll(async () => (await stateOf(page, run.sessionId)).phase).toBe("settling");
    await expect(page.locator("#stopButton")).toBeVisible();
    await emitClaude(run, { type: "system", subtype: "session_state_changed", state: "idle" });
    await expect(page.locator("#stopButton")).toBeHidden();
  });

  test("process death invalidates decisions; absent SDK history fails closed after restart", async ({ page, nativeServer }) => {
    const run = await createClaude(page, nativeServer);
    await emitClaude(run, { type: "control_request", request_id: "claude-dies", request: { subtype: "can_use_tool", tool_name: "Write", tool_use_id: "write-dies", input: { file_path: "hello.txt", content: "proposal" } } });
    await expect(page.locator(".interactionRequest")).toHaveCount(1);
    await controlClaude(run, { action: "exit", code: 42 });
    await expect(page.locator(".interactionRequest")).toHaveCount(0);
    await expect(page.locator("#stopButton")).toBeHidden();
    await expect.poll(async () => (await stateOf(page, run.sessionId)).phase).toMatch(/error|unavailable/);
    const peers = await readdir(join(nativeServer.claudePeerDir, "peers"));
    await nativeServer.restart();
    const reopened = await page.request.post("/api/sessions/open", { data: { sessionId: run.sessionId } });
    expect(reopened.ok()).toBe(false);
    expect(await reopened.text()).toContain("no resumable native history");
    expect(await readdir(join(nativeServer.claudePeerDir, "peers"))).toEqual(peers);
  });
});
