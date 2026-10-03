import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "@playwright/test";
import { acceptedTurn, controlPeer, peerForThread, waitObserved } from "../fixtures/codex-peer-control.js";

test.setTimeout(45_000);

/** No route fulfillment, alternate agent, or prompt-selected scenario: production UI/host/transport. */
test("native browser lifecycle through the production UI and owned native protocol peer", async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-native-browser-"));
  const cwd = join(root, "cwd"); const home = join(root, "home"); const peers = join(root, "peers");
  await mkdir(cwd); await mkdir(home);
  const listener = createServer();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((done) => listener.close(() => done()));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--import", "tsx", "server.ts"], { cwd: resolve("."), stdio: ["ignore", "pipe", "pipe"], env: {
    PATH: process.env.PATH, HOME: home, NODE_ENV: "test", HOST: "127.0.0.1", PORT: String(port), PI_WEB_DEV: "0", PI_WEB_MOCK: "0",
    PI_WEB_AUTH_MODE: "none", PI_WEB_AUTH_ORIGIN: origin, PI_WEB_CWD: cwd, PI_CODING_AGENT_DIR: join(root, "pi-agent"),
    PI_WEB_AUTH_STORE: join(root, "auth.json"), PI_WEB_SETTINGS_FILE: join(root, "settings.json"),
    PI_WEB_SESSION_UI_STATE_FILE: join(root, "ui.json"), PI_WEB_NATIVE_BINDINGS_FILE: join(root, "bindings.json"), PI_WEB_MULTI_HARNESS: "1",
    PI_WEB_CODEX_COMMAND: process.execPath, PI_WEB_CODEX_ARGS: JSON.stringify([resolve("tests/fixtures/codex-app-server-peer.mjs")]), PI_WEB_CODEX_PEER_DIR: peers,
  } });
  let diagnostics = ""; child.stdout.on("data", (bytes) => { diagnostics = (diagnostics + bytes).slice(-4000); }); child.stderr.on("data", (bytes) => { diagnostics = (diagnostics + bytes).slice(-4000); });
  const json = async (path: string) => (await fetch(origin + path)).json() as Promise<any>;
  try {
    const deadline = Date.now() + 15_000;
    while (true) {
      if (child.exitCode !== null) throw new Error(diagnostics);
      try { if ((await fetch(origin + "/api/harnesses")).ok) break; } catch { /* owned startup */ }
      if (Date.now() > deadline) throw new Error("Owned server startup timeout");
      await delay(25);
    }
    await page.goto(origin);
    await page.locator(".agentChoice").selectOption("codex");
    await page.locator("#sessionButton").click();
    await page.locator("#sessionNewButton").click();
    await expect.poll(async () => (await json("/api/state" + new URL(page.url()).search)).harnessId).toBe("codex");
    const id = new URL(page.url()).searchParams.get("sessionId")!;
    const state = await json(`/api/state?sessionId=${id}`);
    const peer = await peerForThread(peers, state.nativeSession.sessionId);
    await page.evaluate(async () => { await fetch("/api/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ defaults: { pinNewSessions: true } }) }); });
    await page.reload();
    await page.locator(".agentChoice").selectOption("pi");
    if (!await page.locator("#sessionNewButton").isVisible()) await page.locator("#sessionButton").click();
    await page.locator("#sessionNewButton").click();
    await expect.poll(async () => (await json("/api/state" + new URL(page.url()).search)).harnessId).toBe("pi");
    expect(new URL(page.url()).searchParams.get("sessionId")).not.toBe(id);
    await page.goto(`${origin}/?sessionId=${id}`);
    await expect.poll(async () => (await json("/api/state" + new URL(page.url()).search)).harnessId).toBe("codex");
    expect(id).not.toBe(state.nativeSession.sessionId);
    expect(await page.locator("#attachButton").isVisible()).toBe(false);
    expect(await page.locator("#modelSettingsButton").isDisabled()).toBe(true);
    if (await page.locator("#sessionCloseButton").isVisible()) await page.locator("#sessionCloseButton").click();
    await page.locator("#prompt").fill("Native peer input");
    await page.locator("#primaryButton").click();
    const turn = await acceptedTurn(peer);
    await controlPeer(peer, { action: "text", itemId: "answer", delta: "Visible streamed " });
    await expect.poll(() => page.locator("#messages").innerText()).toContain("Visible streamed");
    await controlPeer(peer, { action: "text", itemId: "answer", delta: "answer", done: true });
    await controlPeer(peer, { action: "tool", itemId: "command", command: "printf peer" });
    await controlPeer(peer, { action: "tool", itemId: "command", delta: "Owned native output", done: true });
    for (const item of [
      { id: "diff", type: "fileChange", status: "completed", changes: [{ path: "owned.txt", kind: { type: "add" }, diff: "+DIFF_SENTINEL <img src=x onerror=window.__nativeInjected=1>" }] },
      { id: "structured", type: "mcpToolCall", status: "completed", server: "peer", tool: "structured", arguments: {}, result: { content: [], structuredContent: { sentinel: "STRUCTURED_SENTINEL <script>window.__nativeInjected=1</script>" } } },
    ]) await controlPeer(peer, { action: "emit", message: { method: "item/completed", params: { threadId: state.nativeSession.sessionId, turnId: turn.turnId, item } } });
    await expect.poll(() => page.locator("#messages").textContent()).toContain("DIFF_SENTINEL");
    await expect.poll(() => page.locator("#messages").textContent()).toContain("STRUCTURED_SENTINEL");
    await page.locator("#messages details").evaluateAll((nodes) => nodes.forEach((node) => { (node as HTMLDetailsElement).open = true; }));
    expect(await page.locator("#messages").innerText()).toContain("DIFF_SENTINEL");
    expect(await page.locator("#messages").innerText()).toContain("STRUCTURED_SENTINEL");
    expect(await page.locator("#messages img").count()).toBe(0);
    expect(await page.evaluate(() => (window as any).__nativeInjected)).toBeUndefined();
    await page.locator("#messages details").evaluateAll((nodes) => nodes.forEach((node) => { (node as HTMLDetailsElement).open = false; }));
    await controlPeer(peer, { action: "approval", requestId: 0, decisions: ["accept", "decline", "cancel"] });
    await expect.poll(() => page.locator(".pendingInteractions").innerText()).toContain("Decline");
    await page.locator(".pendingInteractions button").filter({ hasText: "Decline" }).click();
    await waitObserved(peer, (row) => row.direction === "client" && row.message.id === 0 && row.message.result?.decision === "decline");
    await page.locator("#stopButton").click();
    const interrupt = await waitObserved(peer, (row) => row.direction === "client" && row.message.method === "turn/interrupt");
    expect(interrupt.message.params).toEqual({ threadId: state.nativeSession.sessionId, turnId: turn.turnId });
    await expect.poll(async () => (await json(`/api/state?sessionId=${id}`)).phase).toBe("idle");
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.evaluate(() => { (window as any).__stopRejections = []; window.addEventListener("unhandledrejection", (event) => (window as any).__stopRejections.push(String(event.reason))); });
    await page.locator("#prompt").fill("Second protocol-peer turn");
    await page.locator("#primaryButton").click();
    await acceptedTurn(peer, turn.turnId);
    const guarded = await json(`/api/state?sessionId=${id}`);
    const stopBodies: any[] = [];
    await page.route("**/api/abort", async (route) => {
      stopBodies.push(route.request().postDataJSON());
      await controlPeer(peer, { action: "complete" });
      await expect.poll(async () => (await json(`/api/state?sessionId=${id}`)).phase).toBe("idle");
      await route.continue(); // genuine host 409; never retry against a new execution
    });
    const rejectedStop = page.waitForResponse((response) => response.url().endsWith("/api/abort"));
    await page.locator("#stopButton").click();
    expect((await rejectedStop).status()).toBe(409);
    await expect.poll(() => page.locator("#messages").textContent()).toContain("Stop failed:");
    expect(stopBodies).toEqual([{ sessionId: id, expectedExecutionId: guarded.activeExecution.id }]);
    expect(pageErrors).toEqual([]);
    expect(await page.evaluate(() => (window as any).__stopRejections)).toEqual([]);
    await page.unroute("**/api/abort");
    await controlPeer(peer, { action: "exit", code: 17 });
    await expect.poll(async () => (await json(`/api/state?sessionId=${id}`)).phase).toBe("unavailable");
    const reopened = await page.evaluate(async (sessionId) => {
      const response = await fetch("/api/sessions/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId }) });
      return response.status;
    }, id);
    expect(reopened).toBe(200);
    await page.reload();
    await expect.poll(() => page.locator("#messages").innerText()).toContain("Visible streamed answer");
    expect(await page.locator("#messages .user").count()).toBe(2);
    await expect.poll(() => page.locator("#messages").textContent()).toContain("DIFF_SENTINEL");
    await expect.poll(() => page.locator("#messages").textContent()).toContain("STRUCTURED_SENTINEL");
    await page.locator("#messages details").evaluateAll((nodes) => nodes.forEach((node) => { (node as HTMLDetailsElement).open = true; }));
    expect(await page.locator("#messages").innerText()).toContain("DIFF_SENTINEL");
    expect(await page.locator("#messages").innerText()).toContain("STRUCTURED_SENTINEL");
    expect(await page.locator("#messages img").count()).toBe(0);
    expect(await page.locator("#messages .user time[datetime]").count()).toBe(0);
    expect((await json(`/api/state?sessionId=${id}`)).nativeSession.sessionId).toBe(state.nativeSession.sessionId);
  } finally {
    const exit = new Promise<void>((done) => child.once("close", () => done()));
    if (child.exitCode === null && !child.signalCode) {
      child.kill("SIGTERM"); const watchdog = setTimeout(() => child.kill("SIGKILL"), 12_000);
      await exit; clearTimeout(watchdog);
    }
    await rm(root, { recursive: true, force: true });
  }
});
