import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionHandle } from "../server/session/adapter.js";
import type { SessionServiceEvent, ToolCallPartDto } from "../server/session/dto.js";
import { createKiroAdapter, type KiroAdapterOptions } from "../server/session/adapters/kiro/index.js";
import { controlPeer, peerForSession, readObserved, waitObserved } from "./fixtures/kiro-peer-control.js";
import { codexFixturePng } from "./fixtures/codex-native-events.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(options: Partial<KiroAdapterOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-kiro-")); const handles: SessionHandle[] = [];
  cleanups.push(async () => { await Promise.all(handles.map((h) => h.dispose())); await rm(root, { recursive: true, force: true }); });
  const adapter = createKiroAdapter({ command: resolve("tests/fixtures/kiro-acp-peer.mjs"), env: { ...process.env, PI_WEB_KIRO_PEER_DIR: root }, ...options });
  expect(await readdir(join(root, "peers")).catch(() => [])).toEqual([]);
  const handle = await adapter.create({ cwd: root, sessionId: "web-kiro" }); handles.push(handle);
  const peer = await peerForSession(root, handle.state().nativeSession.sessionId!);
  const events: SessionServiceEvent[] = []; handle.subscribe((e) => events.push(e));
  return { root, handle, handles, adapter, peer, events };
}
const prompt = (handle: SessionHandle, executionId = "guard-1") => handle.prompt({ mode: "prompt", message: "Ordinary input", attachments: [], executionId });
const tools = async (h: SessionHandle) => (await h.messages()).flatMap((m) => m.parts ?? []).filter((p): p is ToolCallPartDto => p.type === "toolCall");

describe("Kiro production ACP handle", () => {
  it("pins initialization, preserves native config and returns independent pathless identity", async () => {
    const { handle, peer, root } = await fixture();
    expect(handle.state()).toMatchObject({ sessionId: "web-kiro", harnessId: "kiro", phase: "idle", nativeSettings: { model: "native-fixture-model" }, nativeSession: { persistence: "persistent", status: "unmaterialized" } });
    expect(handle.state().nativeSession.sessionId).not.toBe("web-kiro"); expect(handle.state().sessionFile).toBeUndefined();
    expect(handle.state().stats.cost).toBeUndefined();
    const client = (await readObserved(peer)).filter((r) => r.direction === "client");
    expect(client.map((r) => r.message.method)).toEqual(["initialize", "session/new"]);
    expect(client[0].message).toMatchObject({ jsonrpc: "2.0", id: 0, params: { protocolVersion: 1, clientCapabilities: {} } });
    expect(client[1].message.params).toEqual({ cwd: root, mcpServers: [] });
    expect(Object.entries(handle.state().capabilities).filter(([key, value]) => key !== "harness" && value)).toEqual([["interactions", true]]);
  });
  it("rejects ephemeral, foreign identity and unsupported input without native dispatch", async () => {
    const { handle, adapter, root, peer } = await fixture();
    await expect(adapter.create({ cwd: root, persistence: "ephemeral" })).rejects.toMatchObject({ status: 400 });
    await expect(adapter.open({ cwd: root, sessionId: "x", nativeSession: { harnessId: "kiro", sessionId: "x", persistence: "ephemeral", status: "unavailable" } })).rejects.toMatchObject({ status: 410 });
    await expect(adapter.open({ cwd: root, sessionId: "x", nativeSession: { harnessId: "pi", persistence: "persistent", status: "resumable" } })).rejects.toMatchObject({ status: 400 });
    for (const mode of ["steer", "followUp"]) await expect(handle.prompt({ message: "x", executionId: "x", mode, attachments: [] })).rejects.toMatchObject({ status: 400 });
    await expect(handle.prompt({ message: "x", executionId: "x", mode: "prompt", attachments: [], expectedExecutionId: "stale" })).rejects.toMatchObject({ status: 400 });
    await expect(handle.prompt({ message: "x", executionId: "x", mode: "prompt", attachments: [{ type: "file", id: "x", name: "x", mediaType: "image/png", path: "/x", contentUrl: "/x", bytes: 1 }] })).rejects.toMatchObject({ status: 400 });
    expect((await readObserved(peer)).some((r) => r.message.method === "session/prompt")).toBe(false);
  });
  it("streams text, thinking, sparse tool updates, images and diffs without premature settlement", async () => {
    const { handle, peer, events } = await fixture();
    expect(await prompt(handle)).toEqual({ sessionId: "web-kiro", executionId: "guard-1", acknowledgement: "not-exposed" });
    await controlPeer(peer, { action: "text", delta: "Before" });
    await controlPeer(peer, { action: "thinking", delta: "Native thought" });
    await controlPeer(peer, { action: "tool" });
    await controlPeer(peer, { action: "tool", update: true, fields: { title: null, rawOutput: null, content: [
      { type: "content", content: { type: "text", text: "Read output" } },
      { type: "content", content: { type: "image", mimeType: "image/png", data: codexFixturePng } },
      { type: "diff", path: "owned.txt", oldText: "old", newText: "new" },
    ] } });
    await controlPeer(peer, { action: "tool", update: true, fields: { status: "completed" } });
    expect((await tools(handle))[0]).toMatchObject({ toolName: "Read owned file", args: { path: "owned.txt" }, status: "completed", result: { parts: [{ type: "text", text: "Read output" }, { type: "image", data: codexFixturePng }] } });
    expect((await tools(handle))[0].result?.details).toEqual({ diff: "--- owned.txt\n+++ owned.txt\n-old\n+new" });
    expect(handle.state().phase).toBe("running");
    await expect(prompt(handle, "concurrent")).rejects.toMatchObject({ status: 409 });
    await controlPeer(peer, { action: "text", delta: "After" });
    await controlPeer(peer, { action: "complete" });
    await expect.poll(() => handle.state().phase).toBe("idle");
    expect((await handle.messages()).flatMap((m) => m.parts?.map((p) => p.type) ?? [])).toEqual(["text", "text", "thinking", "toolCall", "text"]);
    expect(events.filter((e) => e.type === "message_delta").map((e) => e.delta)).toContain("Native thought");
  });
  it.each(["end_turn", "cancelled", "max_tokens", "max_turn_requests", "refusal"])("preserves terminal reason %s and partial content", async (reason) => {
    const { handle, peer } = await fixture(); await prompt(handle);
    await controlPeer(peer, { action: "text", delta: "Partial" }); await controlPeer(peer, { action: "tool" });
    await controlPeer(peer, { action: "complete", reason });
    await expect.poll(() => handle.state().phase).toBe("idle");
    expect((await handle.messages()).find((m) => m.role === "assistant")).toMatchObject({ text: "Partial", stopReason: reason, status: reason === "cancelled" ? "interrupted" : "completed" });
    expect((await tools(handle))[0].status).toBe(reason === "cancelled" ? "cancelled" : "error");
  });
  it("keeps long prompts active and cancel as a guarded notification until the prompt response", async () => {
    const { handle, peer } = await fixture({ requestTimeoutMs: 1000 }); await prompt(handle);
    await controlPeer(peer, { action: "configure", interrupt: "defer" });
    await controlPeer(peer, { action: "text", delta: "Retained" });
    await expect(handle.interrupt("stale")).rejects.toMatchObject({ status: 409 });
    expect(await handle.interrupt("guard-1")).toMatchObject({ acknowledged: true });
    const cancel = await waitObserved(peer, (r) => r.direction === "client" && r.message.method === "session/cancel");
    expect(cancel.message.id).toBeUndefined(); expect(handle.state().phase).toBe("settling");
    await new Promise((resolve) => setTimeout(resolve, 1050)); expect(handle.state().activeExecution?.id).toBe("guard-1");
    await controlPeer(peer, { action: "complete", reason: "cancelled" }); await expect.poll(() => handle.state().phase).toBe("idle");
    await prompt(handle, "new-guard"); await expect(handle.interrupt("guard-1")).rejects.toMatchObject({ status: 409 });
  });
  it.each(["accept", "decline"])("maps only offered once %s choices, exact id zero and duplicate hydration", async (meaning) => {
    const { handle, peer, events } = await fixture(); await prompt(handle);
    await controlPeer(peer, { action: "approval", requestId: 0 });
    const pending = handle.state().pendingInteractions[0];
    expect(pending.choices?.map((c) => c.meaning)).toEqual(["accept", "decline", "cancel"]);
    expect(pending.choices?.find((c) => c.meaning === "accept")?.scope).toBe("once");
    const native = await waitObserved(peer, (r) => r.direction === "server" && r.message.id === 0 && r.message.method === "session/request_permission");
    await controlPeer(peer, { action: "emit", message: native.message });
    expect(events.filter((e) => e.type === "interaction")).toHaveLength(1);
    expect(handle.respondInteraction({ id: pending.id, sessionId: "other", choiceID: "option-0" })).toBe(false);
    expect(handle.respondInteraction({ id: pending.id, sessionId: handle.sessionId, choiceID: "option-2" })).toBe(false);
    const response = { id: pending.id, sessionId: handle.sessionId, choiceID: pending.choices!.find((c) => c.meaning === meaning)!.id };
    expect(handle.respondInteraction(response)).toBe(true); expect(handle.respondInteraction(response)).toBe(false);
    const result = await waitObserved(peer, (r) => r.direction === "client" && r.message.id === 0 && r.message.result);
    expect(result.message.result).toEqual({ outcome: { outcome: "selected", optionId: meaning === "accept" ? "native-once" : "native-deny" } });
    expect(handle.state().phase).toBe("running");
  });
  it.each(["timeout", "disconnect", "disposed", "cancel"])("cancels owning permission and turn on %s", async (reason) => {
    const { handle, peer } = await fixture({ interactionTimeoutMs: reason === "timeout" ? 100 : 10000 }); await prompt(handle);
    await controlPeer(peer, { action: "approval", requestId: "pending" });
    const pending = handle.state().pendingInteractions[0];
    if (reason === "cancel") expect(handle.respondInteraction({ id: pending.id, sessionId: handle.sessionId, cancelled: true })).toBe(true);
    else if (reason !== "timeout") handle.cancelInteractions(reason as "disconnect" | "disposed");
    const result = await waitObserved(peer, (r) => r.direction === "client" && r.message.id === "pending");
    expect(result.message.result).toEqual({ outcome: { outcome: "cancelled" } });
    await expect.poll(() => handle.state().phase).toBe("idle");
    await prompt(handle, "next"); expect(handle.respondInteraction({ id: pending.id, sessionId: handle.sessionId, choiceID: "option-0" })).toBe(false);
  });
  it.each([
    { title: "Unsafe", kind: "execute", rawInput: { command: "printf Authorization: Bearer secret-marker" } },
    { title: "Oversized", kind: "execute", rawInput: { command: "x".repeat(33000) } },
    { title: "Missing input", kind: "execute" },
    { title: "Unknown kind", kind: "future", rawInput: { command: "pwd" } },
  ])("never grants ambiguous or unsafe permission: $title", async (fields) => {
    const { handle, peer, events } = await fixture(); await prompt(handle);
    await controlPeer(peer, { action: "approval", requestId: "unsafe", toolCall: { toolCallId: "unsafe", ...fields } });
    expect((await waitObserved(peer, (r) => r.direction === "client" && r.message.id === "unsafe")).message.result).toEqual({ outcome: { outcome: "cancelled" } });
    expect(events.some((e) => e.type === "interaction")).toBe(false); expect(JSON.stringify(events)).not.toContain("secret-marker");
  });
  it("joins sparse approval only to its exact live tool context", async () => {
    const { handle, peer } = await fixture(); await prompt(handle);
    await controlPeer(peer, { action: "tool", itemId: "exact" });
    await controlPeer(peer, { action: "approval", requestId: "joined", toolCall: { toolCallId: "exact" } });
    expect(JSON.parse(handle.state().pendingInteractions[0].body!).toolCall.rawInput).toEqual({ path: "owned.txt" });
    handle.cancelInteractions("disconnect"); await expect.poll(() => handle.state().phase).toBe("idle");
    await prompt(handle, "second");
    await controlPeer(peer, { action: "approval", requestId: "stale", toolCall: { toolCallId: "exact" } });
    expect((await waitObserved(peer, (r) => r.direction === "client" && r.message.id === "stale")).message.error?.code).toBe(-32600);
    expect(handle.state()).toMatchObject({ phase: "running", activeExecution: { id: "second" } });
  });
  it("contains unknown variants and required requests without discarding text or granting", async () => {
    const { handle, peer, events } = await fixture(); await prompt(handle); await controlPeer(peer, { action: "text", delta: "Keep" });
    for (let n = 0; n < 35; n++) await controlPeer(peer, { action: "emit", message: { method: "future/info", params: { token: "secret-marker" } } });
    expect(events.filter((e) => e.type === "wire")).toHaveLength(32); expect(JSON.stringify(events)).not.toContain("secret-marker");
    await controlPeer(peer, { action: "emit", message: { id: "required", method: "fs/read_text_file", params: { sessionId: handle.state().nativeSession.sessionId } } });
    expect((await waitObserved(peer, (r) => r.direction === "client" && r.message.id === "required")).message.error.code).toBe(-32601);
    await expect.poll(() => handle.state().phase).toBe("idle");
    expect((await handle.messages()).some((m) => m.text === "Keep")).toBe(true);
  });
  it("distinguishes prompt RPC error from process loss, and reopens replay without prompt resend", async () => {
    const { handle, adapter, root, peer, handles } = await fixture();
    await controlPeer(peer, { action: "configure", prompt: "reject" }); await prompt(handle);
    await expect.poll(() => handle.state().phase).toBe("error");
    await controlPeer(peer, { action: "configure", prompt: "accept" }); await prompt(handle, "second");
    await controlPeer(peer, { action: "text", delta: "Saved" }); await controlPeer(peer, { action: "tool" });
    await controlPeer(peer, { action: "exit" }); await expect.poll(() => handle.state().phase).toBe("unavailable");
    expect((await tools(handle))[0].status).toBe("error");
    const reopened = await adapter.open({ cwd: root, sessionId: handle.sessionId, nativeSession: handle.state().nativeSession }); handles.push(reopened);
    expect(reopened.state()).toMatchObject({ phase: "idle", nativeSession: { status: "resumable", sessionId: handle.state().nativeSession.sessionId } });
    expect((await reopened.messages()).some((m) => m.text === "Saved")).toBe(true);
    expect((await reopened.messages()).every((m) => m.timestamp === undefined)).toBe(true);
    const next = await peerForSession(root, handle.state().nativeSession.sessionId!);
    expect((await readObserved(next)).filter((r) => r.message.method === "session/prompt")).toHaveLength(0);
    const listed = await adapter.list(root); expect(listed).toHaveLength(1); expect(listed[0].created).toBeUndefined();
    const fresh = createKiroAdapter({ command: resolve("tests/fixtures/kiro-acp-peer.mjs"), env: { ...process.env, PI_WEB_KIRO_PEER_DIR: root } });
    expect(await fresh.list(root)).toEqual([]); // Unverified source cannot authorize broad native discovery.
  });
  it("retains a terminal stop reason even when the native turn emits no assistant content", async () => {
    const { handle, peer } = await fixture(); await prompt(handle);
    await controlPeer(peer, { action: "complete", reason: "refusal" });
    await expect.poll(() => handle.state().phase).toBe("idle");
    expect((await handle.messages()).some((m) => m.role === "assistant" && m.stopReason === "refusal")).toBe(true);
  });
  it("fails closed on version mismatch without launching ACP", async () => {
    const { root, adapter } = await fixture(); await writeFile(join(root, "config.json"), JSON.stringify({ version: "2.99.0" }));
    const before = (await readFile(join(root, "launches.jsonl"), "utf8")).trim().split("\n").length;
    await expect(adapter.create({ cwd: root })).rejects.toThrow("expected 2.24.0");
    const lines = (await readFile(join(root, "launches.jsonl"), "utf8")).trim().split("\n").slice(before).map((s) => JSON.parse(s));
    expect(lines.map((v) => v.stage)).toEqual(["version"]);
  });
});
