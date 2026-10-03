import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { expect, it } from "vitest";
import { acceptedTurn, controlPeer, peerForThread, readObserved, waitObserved } from "./fixtures/codex-peer-control.js";

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  return port;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode) return;
  const exited = new Promise<void>((done) => child.once("close", () => done()));
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 12_000);
  try { await exited; } finally { clearTimeout(timeout); }
}

/** Real HTTP/WS server and production Codex adapter; synthetic native process only.
 * This is deliberately separate from actual-harness/model canaries. */
it("routes native create, stream, approval, settlement and explicit recovery through the real application", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-codex-http-"));
  const cwd = join(root, "workspace");
  const home = join(root, "home");
  await mkdir(cwd); await mkdir(home);
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const peers = join(root, "native-peer");
  const child = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
    cwd: resolve("."), stdio: ["pipe", "pipe", "pipe"],
    // Do not inherit native homes, credentials, live-server tokens or UI metadata.
    env: { PATH: process.env.PATH, HOME: home, NODE_ENV: "test", HOST: "127.0.0.1", PORT: String(port),
      PI_WEB_DEV: "0", PI_WEB_MOCK: "0", PI_WEB_AUTH_MODE: "none", PI_WEB_AUTH_ORIGIN: origin,
      PI_CODING_AGENT_DIR: join(root, "pi-agent"), PI_WEB_CWD: cwd,
      PI_WEB_AUTH_STORE: join(root, "auth.json"), PI_WEB_SETTINGS_FILE: join(root, "settings.json"),
      PI_WEB_SESSION_UI_STATE_FILE: join(root, "ui.json"), PI_WEB_PUSH_FILE: join(root, "push.json"),
      PI_WEB_NATIVE_BINDINGS_FILE: join(root, "bindings.json"), PI_WEB_MULTI_HARNESS: "1",
      PI_WEB_CODEX_COMMAND: process.execPath, PI_WEB_CODEX_ARGS: JSON.stringify([resolve("tests/fixtures/codex-app-server-peer.mjs")]),
      PI_WEB_CODEX_PEER_DIR: peers },
  });
  let output = "";
  child.stdout!.on("data", (chunk) => { output = `${output}${chunk}`.slice(-6000); });
  child.stderr!.on("data", (chunk) => { output = `${output}${chunk}`.slice(-6000); });
  let socket: WebSocket | undefined;
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(`${origin}${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-pi-web-client-id": "native-core-test", origin },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const stateFor = async (id: string) => (await request(`/api/state?sessionId=${encodeURIComponent(id)}`)).body;
  try {
    const deadline = Date.now() + 15_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Owned test server exited: ${output}`);
      try { ready = (await request("/api/harnesses")).status === 200; } catch { /* owned server starting */ }
      if (ready) break;
      await delay(25);
    }
    expect(ready, output).toBe(true);
    const catalog = (await request("/api/harnesses")).body;
    expect(catalog).toMatchObject({ multiHarnessEnabled: true, defaultHarnessId: "pi" });
    expect(catalog.harnesses).toContainEqual(expect.objectContaining({ id: "codex", enabled: true, available: true }));
    expect((await request("/api/sessions/new", { harnessId: "invalid" })).status).toBe(400);
    const created = await request("/api/sessions/new", { cwd, harnessId: "codex" });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const id = created.body.sessionId as string;
    const nativeId = created.body.nativeSession.sessionId as string;
    expect(id).not.toBe(nativeId);
    expect(created.body).not.toHaveProperty("sessionFile");
    expect(created.body.nativeSettings).toMatchObject({ model: "native-fixture-model", reasoningEffort: "medium" });
    expect(created.body.stats).not.toHaveProperty("cost");
    expect((await request("/api/shell", { sessionId: id, command: "pwd" })).status).toBe(400);
    const ticket = (await request("/api/ws-ticket", {})).body.ticket;
    const events: any[] = [];
    socket = new WebSocket(`ws://127.0.0.1:${port}/ws?sessionId=${id}&ticket=${encodeURIComponent(ticket)}`, { headers: { origin } });
    socket.on("message", (data) => events.push(JSON.parse(String(data))));
    await new Promise<void>((done, reject) => { socket!.once("open", () => done()); socket!.once("error", reject); });
    const peer = await peerForThread(peers, nativeId);
    const nativeStart = await waitObserved(peer, (record) => record.direction === "client" && record.message.method === "thread/start");
    expect(nativeStart.message.params).toEqual({ cwd }); // no native model/policy override
    const prompted = await request("/api/prompt", { sessionId: id, mode: "prompt", message: "Synthetic native request", clientMessageId: "input-one" });
    expect(prompted.status, JSON.stringify(prompted.body)).toBe(202);
    const turn = await acceptedTurn(peer);
    expect(prompted.body).toMatchObject({ acknowledgement: "accepted", nativeExecutionId: turn.turnId });
    expect((await request("/api/abort", { sessionId: id, expectedExecutionId: "stale-host-guard" })).status).toBe(409);
    await controlPeer(peer, { action: "thinking", delta: "Observed reasoning", done: true });
    await controlPeer(peer, { action: "tool", itemId: "tool-one", command: "printf synthetic" });
    await controlPeer(peer, { action: "tool", itemId: "tool-one", delta: "synthetic tool output", done: true });
    await controlPeer(peer, { action: "approval", requestId: 0, decisions: ["accept", "decline", "cancel"] });
    await expect.poll(async () => (await stateFor(id)).pendingInteractions.length).toBe(1);
    const pending = (await stateFor(id)).pendingInteractions[0];
    expect((await stateFor(id)).activity).toBe("waiting-approval");
    const decline = pending.choices.find((choice: any) => choice.meaning === "decline");
    expect((await request("/api/interactions/respond", { sessionId: "foreign", id: pending.id, choiceID: decline.id })).status).toBe(404);
    expect((await request("/api/interactions/respond", { sessionId: id, id: pending.id, choiceID: decline.id })).status).toBe(200);
    await waitObserved(peer, (record) => record.direction === "client" && record.message.id === 0 && record.message.result?.decision === "decline");
    await expect.poll(async () => (await stateFor(id)).pendingInteractions.length).toBe(0);
    expect((await stateFor(id)).phase).not.toBe("idle");
    await controlPeer(peer, { action: "text", itemId: "answer-one", delta: "provisional", done: true, text: "Authoritative answer" });
    await controlPeer(peer, { action: "complete", idle: false });
    expect((await stateFor(id)).phase).not.toBe("idle");
    await controlPeer(peer, { action: "activity", status: { type: "idle" } });
    await expect.poll(async () => (await stateFor(id)).phase).toBe("idle");
    const messages = (await request(`/api/messages?sessionId=${id}`)).body.messages;
    const parts = messages.flatMap((message: any) => message.parts || []);
    expect(parts).toContainEqual(expect.objectContaining({ type: "text", text: "Authoritative answer" }));
    expect(parts).toContainEqual(expect.objectContaining({ type: "thinking", text: "Observed reasoning" }));
    expect(parts).toContainEqual(expect.objectContaining({ type: "toolCall", toolCallId: `codex:${turn.turnId}:tool-one`, nativeItemId: "tool-one", status: "completed" }));
    expect(JSON.stringify(parts)).not.toContain("provisionalAuthoritative");
    await expect.poll(() => events.some((event) => event.type === "message_delta" && event.sessionId === id)).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ type: "interaction_resolved", sessionId: id, id: pending.id }));

    const secondPrompt = await request("/api/prompt", { sessionId: id, mode: "prompt", message: "Interrupt this synthetic turn" });
    expect(secondPrompt.status).toBe(202);
    const secondTurn = await acceptedTurn(peer, turn.turnId);
    await controlPeer(peer, { action: "configure", interrupt: "defer" });
    const interrupting = request("/api/abort", { sessionId: id, expectedExecutionId: secondPrompt.body.executionId });
    const nativeInterrupt = await waitObserved(peer, (record) => record.direction === "client" && record.message.method === "turn/interrupt");
    expect(nativeInterrupt.message.params).toEqual({ threadId: nativeId, turnId: secondTurn.turnId });
    await controlPeer(peer, { action: "complete", status: "interrupted", idle: false });
    expect((await interrupting).body).toMatchObject({ acknowledged: true, nativeExecutionId: secondTurn.turnId });
    expect((await stateFor(id)).phase).not.toBe("idle"); // interrupt receipt is not idle
    await controlPeer(peer, { action: "activity", status: { type: "idle" } });
    await expect.poll(async () => (await stateFor(id)).phase).toBe("idle");
    const completeHistory = (await request(`/api/messages?sessionId=${id}`)).body.messages;

    // Process loss is not a new prompt. Polls keep the dead handle; explicit open
    // resumes the exact persisted native thread through a new production process.
    await controlPeer(peer, { action: "exit", code: 17 });
    await expect.poll(async () => (await stateFor(id)).phase).toBe("unavailable");
    await stateFor(id); await stateFor(id);
    const reopened = await request("/api/sessions/open", { sessionId: id });
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    expect(reopened.body).toMatchObject({ sessionId: id, nativeSession: { sessionId: nativeId }, phase: "idle" });
    const resumedPeer = await peerForThread(peers, nativeId);
    expect(resumedPeer.pid).not.toBe(peer.pid);
    const resumedWire = await readObserved(resumedPeer);
    expect(resumedWire.filter((record) => record.direction === "client" && record.message.method === "turn/start")).toHaveLength(0);
    // Host guards and live observation times are not a native replay guarantee.
    // Durable native keys, part order, content, tool results and error state are.
    const durableHistory = (items: any[]) => items.map(({ timestamp: _time, executionId: _hostGuard, ...message }) => ({
      ...message, parts: message.parts?.map(({ startedAt: _observedStart, ...part }: any) => part),
    }));
    expect(durableHistory((await request(`/api/messages?sessionId=${id}`)).body.messages)).toEqual(durableHistory(completeHistory));
    expect((await request("/api/abort", { sessionId: id, expectedExecutionId: secondPrompt.body.executionId })).status).toBe(409);
    const bindings = JSON.parse(await readFile(join(root, "bindings.json"), "utf8"));
    expect(bindings.sessions).toContainEqual(expect.objectContaining({ id, nativeSession: expect.objectContaining({ sessionId: nativeId }) }));
    expect(bindings.sessions[0]).not.toHaveProperty("sessionFile");
    expect(bindings.sessions[0]).not.toHaveProperty("messages");
  } finally {
    socket?.terminate();
    await stop(child);
    await rm(root, { recursive: true, force: true });
  }
}, 40_000);
