import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { expect, it } from "vitest";
import { controlPeer, peerForSession, readObserved, waitObserved } from "./fixtures/kiro-peer-control.js";

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

/** Real HTTP/WS server and production Kiro adapter; synthetic native process only.
 * This is deliberately separate from actual-harness/model canaries. */
it("routes native create, stream, approval, settlement and explicit recovery through the real application", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-kiro-http-"));
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
      PI_WEB_KIRO_COMMAND: resolve("tests/fixtures/kiro-acp-peer.mjs"),
      PI_WEB_KIRO_PEER_DIR: peers },
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
    expect(catalog.harnesses).toContainEqual(expect.objectContaining({ id: "kiro", enabled: true, available: true }));
    expect((await request("/api/sessions/new", { harnessId: "invalid" })).status).toBe(400);
    const created = await request("/api/sessions/new", { cwd, harnessId: "kiro" });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const id = created.body.sessionId as string;
    const nativeId = created.body.nativeSession.sessionId as string;
    expect(id).not.toBe(nativeId);
    expect(created.body).not.toHaveProperty("sessionFile");
    expect(created.body.nativeSettings).toMatchObject({ model: "native-fixture-model" });
    expect(created.body.stats).not.toHaveProperty("cost");
    expect((await request("/api/shell", { sessionId: id, command: "pwd" })).status).toBe(400);
    const ticket = (await request("/api/ws-ticket", {})).body.ticket;
    const events: any[] = [];
    socket = new WebSocket(`ws://127.0.0.1:${port}/ws?sessionId=${id}&ticket=${encodeURIComponent(ticket)}`, { headers: { origin } });
    socket.on("message", (data) => events.push(JSON.parse(String(data))));
    await new Promise<void>((done, reject) => { socket!.once("open", () => done()); socket!.once("error", reject); });
    const peer = await peerForSession(peers, nativeId);
    const prompted = await request("/api/prompt", { sessionId: id, mode: "prompt", message: "Ordinary HTTP input" });
    expect(prompted.status).toBe(202); expect(prompted.body.acknowledgement).toBe("not-exposed");
    await controlPeer(peer, { action: "thinking", delta: "Native thought" });
    await controlPeer(peer, { action: "text", delta: "Retained partial" });
    await controlPeer(peer, { action: "approval", requestId: 0 });
    await expect.poll(async () => (await stateFor(id)).pendingInteractions.length).toBe(1);
    const pending = (await stateFor(id)).pendingInteractions[0];
    expect((await request("/api/interactions/respond", { sessionId: "other", id: pending.id, choiceID: "option-0" })).status).toBe(404);
    expect((await request("/api/interactions/respond", { sessionId: id, id: pending.id, choiceID: "option-1" })).status).toBe(200);
    expect((await waitObserved(peer, (r) => r.direction === "client" && r.message.id === 0 && !!r.message.result)).message.result).toEqual({ outcome: { outcome: "selected", optionId: "native-deny" } });
    await controlPeer(peer, { action: "configure", interrupt: "defer" });
    expect((await request("/api/abort", { sessionId: id, expectedExecutionId: "stale" })).status).toBe(409);
    expect((await request("/api/abort", { sessionId: id, expectedExecutionId: prompted.body.executionId })).status).toBe(202);
    expect((await stateFor(id)).phase).toBe("settling");
    await controlPeer(peer, { action: "complete", reason: "cancelled" });
    await expect.poll(async () => (await stateFor(id)).phase).toBe("idle");
    const messages = (await request(`/api/messages?sessionId=${id}`)).body.messages;
    expect(messages.some((m: any) => m.text === "Retained partial" && m.stopReason === "cancelled")).toBe(true);
    await expect.poll(() => events.some((e) => e.type === "message_delta" && e.delta === "Retained partial")).toBe(true);
    expect(events.some((e) => e.type === "interaction_resolved")).toBe(true);
    await controlPeer(peer, { action: "exit" });
    await expect.poll(async () => (await stateFor(id)).phase).toBe("unavailable");
    const opened = await request("/api/sessions/open", { sessionId: id });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    expect(opened.body).toMatchObject({ sessionId: id, nativeSession: { sessionId: nativeId }, phase: "idle" });
    const next = await peerForSession(peers, nativeId);
    expect(next.pid).not.toBe(peer.pid);
    expect((await readObserved(next)).some((r) => r.message.method === "session/prompt")).toBe(false);
    expect((await request(`/api/messages?sessionId=${id}`)).body.messages.some((m: any) => m.text === "Retained partial")).toBe(true);
  } finally {
    socket?.terminate(); await stop(child); await rm(root, { recursive: true, force: true });
  }
}, 40_000);
