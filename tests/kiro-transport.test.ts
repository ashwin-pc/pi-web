import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KiroRpcError, KiroTransport, type NativeNotification, type NativeRequest } from "../server/session/adapters/kiro/transport.js";
import { createKiroAdapter } from "../server/session/adapters/kiro/index.js";
import { controlPeer, findPeer, readObserved, waitObserved } from "./fixtures/kiro-peer-control.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); });
async function connection(options: { requestTimeoutMs?: number; maxFrameBytes?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "kiro-transport-"));
  const notifications: NativeNotification[] = []; const requests: NativeRequest[] = []; const errors: KiroRpcError[] = []; const observations: string[] = []; const faults = new Set<string>();
  const transport = new KiroTransport({ cwd: root, command: resolve("tests/fixtures/kiro-acp-peer.mjs"), env: { ...process.env, PI_WEB_KIRO_PEER_DIR: root }, ...options }, {
    notification: (m) => { if (faults.has("notification")) throw Error("private details"); notifications.push(m); },
    request: (m) => { if (faults.has("request")) throw Error("private details"); requests.push(m); },
    closed: (e) => { errors.push(e); if (faults.has("dispose")) void transport.dispose(); if (faults.has("closed")) throw Error("private details"); },
    observation: (k) => { if (faults.has("observation")) throw Error("private details"); observations.push(k); },
  });
  cleanups.push(async () => { await transport.dispose(); await rm(root, { recursive: true, force: true }); });
  await transport.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  return { root, transport, peer: await findPeer(root), notifications, requests, errors, observations, faults };
}
describe("Kiro bounded stdio transport", () => {
  it("pins the ACP v1 schema hash", async () => {
    const bytes = await readFile("node_modules/@agentclientprotocol/sdk/schema/schema.json");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("2a920d3c0f76443e07ffa7801443e3cdf008e2a3095e565581a0433fd728ce41");
  });
  it("correlates request id zero, unknown required controls and orphan replies", async () => {
    const { peer, transport, requests, observations } = await connection();
    expect((await readObserved(peer))[0].message.id).toBe(0);
    await controlPeer(peer, { action: "emit", message: { id: 0, method: "future/required", params: {} } });
    expect(requests).toContainEqual({ id: 0, method: "future/required", params: {} });
    transport.reject(0); await waitObserved(peer, (r) => r.direction === "client" && r.message.id === 0 && r.message.error);
    await controlPeer(peer, { action: "emit", message: { id: 0, result: {} } });
    expect(observations).toContain("orphan-response");
  });
  it("decodes byte-fragmented UTF-8 and coalesced frames", async () => {
    const { peer, notifications } = await connection();
    const bytes = Buffer.from('{"jsonrpc":"2.0","method":"one","params":{"text":"😀"}}\n');
    const index = bytes.indexOf(Buffer.from("😀")) + 2;
    await controlPeer(peer, { action: "raw", base64: bytes.subarray(0, index).toString("base64") });
    await controlPeer(peer, { action: "raw", base64: bytes.subarray(index).toString("base64") });
    await controlPeer(peer, { action: "raw", text: '{"jsonrpc":"2.0","method":"two"}\n{"jsonrpc":"2.0","method":"three"}\n' });
    expect(notifications.map((m) => m.method)).toEqual(["one", "two", "three"]); expect(notifications[0].params).toEqual({ text: "😀" });
  });
  it.each(["not json\n", "x".repeat(1025), `${JSON.stringify({ jsonrpc: "2.0", method: "x", params: "x".repeat(1100) })}\n`, '{"id":1,"result":{}}\n'])("rejects invalid, oversized and unterminated frames", async (text) => {
    const { peer, transport, observations } = await connection({ maxFrameBytes: 1024 });
    await controlPeer(peer, { action: "raw", text });
    await expect.poll(() => transport.closed).toBe(true); expect(observations).toContain("invalid-frame");
  });
  it.each(["notification", "request", "observation"])("contains throwing %s callbacks and rejects pending work once", async (kind) => {
    const broken = await connection(); const healthy = await connection();
    const session = await broken.transport.request("session/new", { cwd: broken.root, mcpServers: [] }) as { sessionId: string };
    const pending = broken.transport.request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "ordinary" }] }, null).catch((e) => e);
    await waitObserved(broken.peer, (r) => r.message.method === "session/prompt");
    broken.faults.add(kind); broken.faults.add("closed");
    await controlPeer(broken.peer, { action: "emit", message: kind === "notification" ? { method: "future/info" } : kind === "request" ? { id: "control", method: "future/required" } : { id: "orphan", result: {} } });
    expect(await pending).toMatchObject({ code: "protocol" }); await broken.transport.dispose();
    expect(broken.errors).toHaveLength(1); expect(broken.errors[0].message).not.toContain("private details"); expect(healthy.transport.closed).toBe(false);
  });
  it("drains stderr and cleans up with one reentrant disposal promise", async () => {
    const { transport, peer, faults, errors } = await connection();
    await controlPeer(peer, { action: "stderr", bytes: 2000000 }); faults.add("dispose");
    const disposed = transport.dispose(); expect(transport.dispose()).toBe(disposed); await disposed;
    expect(errors).toHaveLength(1); expect(() => process.kill(peer.pid, 0)).toThrow();
  });
  it.skipIf(process.platform === "win32")("cleans wrapper descendants even after their leader exits", async () => {
    const { transport, peer } = await connection();
    await controlPeer(peer, { action: "descendant" });
    const { pid } = JSON.parse(await readFile(join(peer.directory, "descendant.json"), "utf8"));
    await transport.dispose();
    await expect.poll(async () => {
      try { process.kill(pid, 0); } catch { return false; }
      if (process.platform === "linux") return !(await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "")).match(/\) Z /);
      return true;
    }).toBe(false);
  });
  it("does not retry a timed out request or a long prompt", async () => {
    const { transport, peer, root } = await connection({ requestTimeoutMs: 300 });
    const { sessionId } = await transport.request("session/new", { cwd: root, mcpServers: [] }) as { sessionId: string };
    const pending = transport.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "ordinary" }] }, null);
    await new Promise((r) => setTimeout(r, 400)); expect(transport.closed).toBe(false);
    transport.notify("session/cancel", { sessionId }); expect(await pending).toEqual({ stopReason: "cancelled" });
    expect((await readObserved(peer)).filter((r) => r.message.method === "session/prompt")).toHaveLength(1);
  });
  it.each([false, true])("excludes host token at preflight, catalog and runtime with explicit env=%s", async (explicit) => {
    const root = await mkdtemp(join(tmpdir(), "kiro-env-"));
    const token = "synthetic-control-secret";
    const inherited = { ...process.env, PI_WEB_TOKEN: token, pi_web_token: token, PI_WEB_KIRO_PEER_DIR: root, KIRO_NATIVE_SENTINEL: "native-configuration-preserved" };
    if (!explicit) for (const key of ["PI_WEB_TOKEN", "pi_web_token", "PI_WEB_KIRO_PEER_DIR", "KIRO_NATIVE_SENTINEL"]) vi.stubEnv(key, inherited[key]);
    const env = Object.freeze(inherited); const before = { ...env };
    const adapter = createKiroAdapter({ command: resolve("tests/fixtures/kiro-acp-peer.mjs"), ...(explicit ? { env } : {}) });
    const handle = await adapter.create({ cwd: root });
    try {
      await adapter.list(root);
      const launches = (await readFile(join(root, "launches.jsonl"), "utf8")).trim().split("\n").map((s) => JSON.parse(s));
      expect(launches.map((v) => v.stage)).toEqual(["version", "acp", "version", "catalog"]);
      expect(launches.every((v) => v.tokenKeys.length === 0 && v.sentinel === "native-configuration-preserved")).toBe(true);
      expect(env).toEqual(before);
      if (!explicit) expect(process.env.PI_WEB_TOKEN).toBe(token);
    } finally { await handle.dispose(); await rm(root, { recursive: true, force: true }); }
  });
});
