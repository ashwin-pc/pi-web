import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CodexRpcError, CodexTransport, diagnostic, type NativeNotification, type NativeRequest } from "../server/session/adapters/codex/transport.js";
import { controlPeer, findPeer, readObserved, waitObserved } from "./fixtures/codex-peer-control.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function connection(options: { requestTimeoutMs?: number; maxFrameBytes?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-codex-peer-"));
  const notifications: NativeNotification[] = [];
  const requests: NativeRequest[] = [];
  const errors: CodexRpcError[] = [];
  const observations: string[] = [];
  const faults = new Set<string>();
  const transport: CodexTransport = new CodexTransport({ cwd: root, command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/codex-app-server-peer.mjs", import.meta.url))],
    env: { ...process.env, PI_WEB_CODEX_PEER_DIR: root }, ...options }, {
    notification: (message) => { if (faults.has("notification")) throw new Error("private mapper details"); notifications.push(message); },
    request: (message) => { if (faults.has("request")) throw new Error("private mapper details"); requests.push(message); },
    closed: (error) => { errors.push(error); if (faults.has("dispose")) void transport.dispose(); if (faults.has("closed")) throw new Error("closed consumer failed"); },
    observation: (kind) => { if (faults.has("observation")) throw new Error("diagnostic consumer failed"); observations.push(kind); },
  });
  cleanups.push(async () => { await transport.dispose(); await rm(root, { recursive: true, force: true }); });
  await transport.request("initialize", { clientInfo: { name: "native-test", version: "1" } });
  transport.notify("initialized");
  const peer = await findPeer(root);
  return { transport, peer, root, notifications, requests, errors, observations, faults };
}

async function start(transport: CodexTransport, cwd: string) {
  const result = await transport.request("thread/start", { cwd }) as { thread: { id: string } };
  return result.thread.id;
}

describe("Codex native stdio ingress", () => {
  it("pins the exact installed schema and native execution/permission preconditions", async () => {
    const directory = new URL("./fixtures/codex-0.154.0/", import.meta.url);
    const [bytes, pinText] = await Promise.all([readFile(new URL("schema.json", directory)), readFile(new URL("pin.json", directory), "utf8")]);
    const pin = JSON.parse(pinText) as { sha256: string };
    const schema = JSON.parse(bytes.toString()) as { definitions: { PermissionGrantScope: { enum: string[] }; v2: Record<string, { required?: string[] }> } };
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(pin.sha256);
    expect(schema.definitions.v2.TurnInterruptParams.required).toEqual(expect.arrayContaining(["threadId", "turnId"]));
    expect(schema.definitions.v2.TurnSteerParams.required).toEqual(expect.arrayContaining(["threadId", "expectedTurnId", "input"]));
    expect(schema.definitions.PermissionGrantScope.enum).toEqual(["turn", "session"]);
  });

  it("performs native handshake and returns native thread IDs without altering settings", async () => {
    const { transport, peer, root } = await connection();
    const threadId = await start(transport, root);
    expect(threadId).toBeTruthy();
    const records = await readObserved(peer);
    expect(records.filter((record) => record.direction === "client").map((record) => record.message.method))
      .toEqual(["initialize", "initialized", "thread/start"]);
    expect(records.find((record) => record.message.method === "thread/start")?.message.params).toEqual({ cwd: root });
    await expect(transport.request("initialize", {})).rejects.toMatchObject({ code: -32600, ambiguous: false });
  });

  it("keeps notifications and server control requests separate even at id zero", async () => {
    const { peer, transport, requests, notifications, observations } = await connection();
    await controlPeer(peer, { action: "emit", message: { id: 0, method: "future/required", params: { value: "synthetic" } } });
    await controlPeer(peer, { action: "emit", message: { method: "future/informational", params: { okay: true } } });
    await controlPeer(peer, { action: "emit", message: { id: 0, result: {} } });
    expect(requests).toEqual([{ id: 0, method: "future/required", params: { value: "synthetic" } }]);
    expect(notifications).toContainEqual({ method: "future/informational", params: { okay: true } });
    expect(observations).toContain("orphan-response");
    transport.reject(0);
    await waitObserved(peer, (record) => record.direction === "client" && record.message.id === 0 && record.message.error?.code === -32601);
  });

  it("frames split and coalesced JSONL without losing Unicode", async () => {
    const { peer, notifications } = await connection();
    await controlPeer(peer, { action: "raw", text: '{"method":"one","params":{"delta":"' });
    await controlPeer(peer, { action: "raw", text: 'café 😀"}}\n{"method":"two","params":{}}\n' });
    expect(notifications).toEqual([{ method: "one", params: { delta: "café 😀" } }, { method: "two", params: {} }]);
  });

  it("rejects native prompt errors without fabricating acceptance", async () => {
    const { transport, peer, root, notifications } = await connection();
    const threadId = await start(transport, root);
    await controlPeer(peer, { action: "configure", prompt: "reject" });
    await expect(transport.request("turn/start", { threadId, input: [{ type: "text", text: "ordinary input" }] }))
      .rejects.toMatchObject({ code: -32600, ambiguous: false });
    expect(notifications.some((message) => message.method === "turn/started")).toBe(false);
  });

  it("timeouts are ambiguous and never cause automatic prompt resubmission", async () => {
    const { transport, peer, root, observations } = await connection({ requestTimeoutMs: 500 });
    const threadId = await start(transport, root);
    await controlPeer(peer, { action: "configure", prompt: "defer" });
    const prompt = transport.request("turn/start", { threadId, input: [{ type: "text", text: "ordinary input" }] });
    const received = await waitObserved(peer, (record) => record.direction === "client" && record.message.method === "turn/start");
    await expect(prompt).rejects.toMatchObject({ code: "timeout", ambiguous: true });
    await controlPeer(peer, { action: "release", requestId: received.message.id, result: { turn: { id: "late-turn" } } });
    expect(observations).toContain("orphan-response");
    expect((await readObserved(peer)).filter((record) => record.direction === "client" && record.message.method === "turn/start")).toHaveLength(1);
  });

  it("observes exact-turn interruption with native acknowledgement after terminal event", async () => {
    const { transport, peer, root, notifications } = await connection();
    const threadId = await start(transport, root);
    const accepted = await transport.request("turn/start", { threadId, input: [{ type: "text", text: "ordinary input" }] }) as { turn: { id: string } };
    await controlPeer(peer, { action: "configure", interrupt: "defer" });
    await expect(transport.request("turn/interrupt", { threadId, turnId: "wrong" })).rejects.toMatchObject({ code: -32600 });
    let acknowledged = false;
    const interrupted = transport.request("turn/interrupt", { threadId, turnId: accepted.turn.id }).then(() => { acknowledged = true; });
    await waitObserved(peer, (record) => record.direction === "client" && record.message.method === "turn/interrupt" && record.message.params.turnId === accepted.turn.id);
    expect(acknowledged).toBe(false);
    await controlPeer(peer, { action: "complete", status: "interrupted" });
    await interrupted;
    expect(notifications).toContainEqual(expect.objectContaining({ method: "turn/completed" }));
    await expect(transport.request("turn/interrupt", { threadId, turnId: accepted.turn.id })).rejects.toMatchObject({ code: -32600 });
  });

  it("native process death rejects pending work and closes only this connection", async () => {
    const { transport, peer, root, errors } = await connection();
    const threadId = await start(transport, root);
    await controlPeer(peer, { action: "configure", prompt: "defer" });
    const pending = transport.request("turn/start", { threadId, input: [] });
    const rejection = expect(pending).rejects.toMatchObject({ code: "closed", ambiguous: true });
    await waitObserved(peer, (record) => record.direction === "client" && record.message.method === "turn/start");
    await controlPeer(peer, { action: "exit", code: 17 });
    await rejection;
    expect(errors.at(-1)?.message).toContain("17");
    await expect(transport.request("thread/list")).rejects.toMatchObject({ code: "closed" });
    await transport.dispose();
    await transport.dispose();
  });

  it.each(["not JSON\n", `${"x".repeat(1_025)}`])("fails closed for malformed or oversized native frames", async (text) => {
    const { peer, transport, errors, observations } = await connection({ maxFrameBytes: 1_024 });
    await controlPeer(peer, { action: "raw", text });
    await expect.poll(() => transport.closed).toBe(true);
    expect(errors.at(-1)?.code).toBe("protocol");
    expect(observations).toContain("invalid-frame");
    await transport.dispose();
  });

  it.each(["notification", "request", "observation"])("contains a throwing %s handler, rejects pending calls once and cleans only its child", async (kind) => {
    const failed = await connection();
    const healthy = await connection();
    const threadId = await start(failed.transport, failed.root);
    await controlPeer(failed.peer, { action: "configure", prompt: "defer" });
    let rejectionCount = 0;
    const pending = failed.transport.request("turn/start", { threadId, input: [] }).catch((error: unknown) => { rejectionCount++; return error; });
    await waitObserved(failed.peer, (record) => record.direction === "client" && record.message.method === "turn/start");
    failed.faults.add(kind);
    failed.faults.add("closed");
    const message = kind === "notification" ? { method: "new/event", params: {} }
      : kind === "request" ? { id: "control", method: "new/control", params: {} } : { id: "orphan", result: {} };
    await controlPeer(failed.peer, { action: "emit", message });
    expect(await pending).toMatchObject({ code: "protocol", ambiguous: true });
    await failed.transport.dispose();
    expect(rejectionCount).toBe(1);
    expect(failed.errors).toHaveLength(1);
    expect(failed.errors[0]?.message).not.toContain("private mapper");
    expect(healthy.transport.closed).toBe(false);
    await expect(healthy.transport.request("thread/loaded/list")).resolves.toMatchObject({ data: [] });
  });

  it("publishes one disposal promise before a closed consumer reenters disposal", async () => {
    const { transport, faults, errors } = await connection();
    faults.add("dispose");
    const first = transport.dispose();
    expect(transport.dispose()).toBe(first);
    await first;
    expect(errors).toHaveLength(1);
    expect(transport.closed).toBe(true);
  });

  it.each([
    "bad Authorization: Bearer abcdef api_key=private refresh_token=private https://private.test/?token=private",
    '{"access_token":"private-value","password":"private value with spaces"}',
    "failure password='private value with spaces' next=okay",
    JSON.stringify({ refreshToken: 'private \\"quoted\\" value', apiKey: "private" }),
    `{"secret":"private${"x".repeat(4_000)}`,
  ])("redacts bounded quoted and unquoted native credential diagnostics", (value) => {
    const text = diagnostic(value);
    expect(text).not.toContain("abcdef");
    expect(text).not.toContain("private");
    expect(text).toContain("[redacted]");
    expect(text.length).toBeLessThanOrEqual(2_048);
    expect(new CodexRpcError(value, -32603).message).toBe(text);
  });
});
