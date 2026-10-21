import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompletionDeferredError, CompletionOutbox, type CompletionInput, type CompletionMessage } from "../../server/session/completionOutbox.js";
import { PiSessionHandle } from "../../server/session/piHandle.js";
import type { PiWebSession } from "../../server/types.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const input: CompletionInput = { deliveryId: "worker:task-1:finished", message: { customType: "worker-wakeup", content: "Outcome: done", display: true, details: { workers: [] } } };
const header = `${JSON.stringify({ type: "session", version: 3, id: "parent", cwd: "/tmp" })}\n`;
function record(id = "saved", nested = false) {
  const message = { ...input.message, details: { ...input.message.details, deliveryId: input.deliveryId } };
  return JSON.stringify(nested ? { type: "message", id, message: { role: "custom", ...message } } : { type: "custom_message", id, ...message });
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-completion-")); directories.push(directory);
  const path = join(directory, "parent.jsonl"); await writeFile(path, header);
  return runtime(path);
}
function runtime(path: string) {
  const queue: CompletionMessage[] = [];
  const entries: any[] = [];
  const errors = vi.fn();
  const raw = {
    sessionId: "parent", sessionFile: path, isStreaming: false, isIdle: true, pendingMessageCount: 0,
    agent: { state: { messages: [] as unknown[] } }, sessionManager: { getEntries: () => entries },
    abort: vi.fn(async () => {}), subscribe: () => () => {}, dispose: vi.fn(),
    sendCustomMessage: vi.fn(async (message: CompletionMessage) => { queue.push(message); }),
  } as unknown as PiWebSession;
  const makeOutbox = () => new CompletionOutbox((value, message) => new PiSessionHandle(value).sendCompletion(message), errors);
  async function consume(persist = true) {
    for (const message of queue.splice(0)) {
      const entry = { type: "custom_message", id: `saved-${entries.length}`, ...message };
      entries.push(entry); raw.agent.state.messages.push({ role: "custom", ...message });
      if (persist) await appendFile(path, `${JSON.stringify(entry)}\n`);
    }
  }
  return { raw, entries, path, errors, makeOutbox, consume, queue };
}

describe("runtime completion ownership and disk receipts", () => {
  it("deduplicates concurrent requests and reload without a second durable payload store", async () => {
    const f = await fixture();
    const receipts = await Promise.all(Array.from({ length: 8 }, () => f.makeOutbox().deliver(f.raw, input)));
    expect(receipts.every(receipt => receipt.state === "pending")).toBe(true);
    await vi.waitFor(() => expect(f.raw.sendCustomMessage).toHaveBeenCalledOnce());
    expect((await f.makeOutbox().deliver(f.raw, input)).state).toBe("pending");
    await f.consume();
    expect(await f.makeOutbox().deliver(f.raw, input)).toMatchObject({ state: "saved", entryId: "saved-0" });
    expect(await readdir(join(f.path, ".."))).toEqual(["parent.jsonl"]);
  });
  it("reconciles journal resubmission after saved-before-ack restart across branches", async () => {
    const f = await fixture(); await f.makeOutbox().deliver(f.raw, input);
    await vi.waitFor(() => expect(f.queue).toHaveLength(1)); await f.consume();
    const replacement = runtime(f.path);
    expect((await replacement.makeOutbox().deliver(replacement.raw, input)).state).toBe("saved");
    expect(replacement.raw.sendCustomMessage).not.toHaveBeenCalled();
  });
  it("does not release invisible custom queues using idle or USER count", async () => {
    const f = await fixture(); await f.makeOutbox().deliver(f.raw, input);
    await vi.waitFor(() => expect(f.queue).toHaveLength(1)); f.queue.splice(0);
    expect((await f.makeOutbox().deliver(f.raw, input)).state).toBe("pending");
    expect(f.raw.sendCustomMessage).toHaveBeenCalledOnce();
    await new PiSessionHandle(f.raw).dispose("replace");
    const replacement = runtime(f.path); await replacement.makeOutbox().deliver(replacement.raw, input);
    await vi.waitFor(() => expect(replacement.queue).toHaveLength(1));
  });
  it.each(["unknown", "enqueue", "memory", "disk"])("preserves ambiguous rejection ownership (%s)", async mode => {
    const f = await fixture();
    f.raw.sendCustomMessage = vi.fn(async message => {
      if (mode === "enqueue") f.queue.push(message);
      if (mode === "memory") f.entries.push({ type: "custom_message", id: "memory", ...message });
      if (mode === "disk") await appendFile(f.path, `${record()}\n`);
      throw new Error("send rejected");
    });
    await f.makeOutbox().deliver(f.raw, input); await vi.waitFor(() => expect(f.errors).toHaveBeenCalled());
    expect((await f.makeOutbox().deliver(f.raw, input)).state).toBe(mode === "disk" ? "saved" : "pending");
    expect(f.raw.sendCustomMessage).toHaveBeenCalledOnce();
  });
  it("retries typed host pre-invocation refusal on the SAME runtime", async () => {
    const f = await fixture(); let refuse = true;
    const outbox = new CompletionOutbox(async (value, message) => {
      if (refuse) throw new CompletionDeferredError("navigating");
      await value.sendCustomMessage!(message);
    }, f.errors);
    await outbox.deliver(f.raw, input); await vi.waitFor(() => expect(f.errors).toHaveBeenCalled());
    expect(f.raw.sendCustomMessage).not.toHaveBeenCalled(); refuse = false;
    await outbox.deliver(f.raw, input); await vi.waitFor(() => expect(f.queue).toHaveLength(1));
  });
  it.each(["absent", "memory", "agent", "disk", "uncertain"])("replaced prompt rejection retains unknown ownership (%s)", async mode => {
    const f = await fixture(); const cwd = join(f.path, "..");
    const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true }); await loader.reload();
    const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
    const { session } = await createAgentSession({ cwd, agentDir: cwd, modelRuntime, settingsManager: SettingsManager.inMemory(), sessionManager: SessionManager.open(f.path), resourceLoader: loader });
    const raw = session as unknown as PiWebSession;
    const handle = new PiSessionHandle(raw);
    // SDK send is intact, but a replaced public agent.prompt is UNKNOWN even
    // when no admission is visible. No runtime replacement may release its claim.
    const prompt = vi.spyOn(session.agent, "prompt").mockImplementationOnce(async () => {
      const message = { ...input.message, details: { ...input.message.details, deliveryId: input.deliveryId } };
      if (mode === "memory") vi.spyOn(session.sessionManager, "getEntries").mockReturnValue([{ type: "custom_message", id: "memory-only", ...message } as any]);
      if (mode === "agent") session.agent.state.messages.push({ role: "custom", ...message, timestamp: Date.now() });
      if (mode === "disk") await appendFile(f.path, `${record()}\n`);
      if (mode === "uncertain") { await rm(f.path); await mkdir(f.path); }
      throw new Error("immediate rejection");
    });
    prompt.mockImplementationOnce(async () => { await appendFile(f.path, `${record()}\n`); });
    const outbox = new CompletionOutbox((_value, message) => "sendCompletion" in handle
      ? handle.sendCompletion(message)
      : raw.sendCustomMessage!(message, { triggerTurn: true, deliverAs: "steer" }), f.errors);
    await outbox.deliver(raw, input); await vi.waitFor(() => expect(f.errors).toHaveBeenCalled());
    expect(session.isIdle).toBe(true);
    if (mode === "uncertain") { await rm(f.path, { recursive: true }); await writeFile(f.path, header); }
    await outbox.deliver(raw, input);
    expect(prompt).toHaveBeenCalledOnce();
    expect((await outbox.deliver(raw, input)).state).toBe(mode === "disk" ? "saved" : "pending");
    session.dispose();
  });
  it.each(["instance-prompt", "prototype-prompt", "instance-send", "prototype-send"])("keeps one invisible queued copy after replacement enqueue-then-reject (%s)", async replacement => {
    const f = await fixture(); const cwd = join(f.path, "..");
    const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true }); await loader.reload();
    const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
    const { session } = await createAgentSession({ cwd, agentDir: cwd, modelRuntime, settingsManager: SettingsManager.inMemory(), sessionManager: SessionManager.open(f.path), resourceLoader: loader });
    const raw = session as unknown as PiWebSession;
    const enqueueThenReject = vi.fn(async (message: any) => {
      session.agent.steer({ role: "custom", ...message, timestamp: Date.now() });
      throw new Error("rejected after invisible enqueue");
    });
    const override = replacement === "prototype-send" ? vi.spyOn(AgentSession.prototype, "sendCustomMessage")
      : replacement === "instance-send" ? vi.spyOn(session, "sendCustomMessage")
      : replacement === "prototype-prompt" ? vi.spyOn(Object.getPrototypeOf(session.agent), "prompt")
      : vi.spyOn(session.agent, "prompt");
    override.mockImplementation(enqueueThenReject);
    try {
      const outbox = new CompletionOutbox((_value, message) => new PiSessionHandle(raw).sendCompletion(message), f.errors);
      await outbox.deliver(raw, input);
      await vi.waitFor(() => expect(f.errors).toHaveBeenCalled());
      expect(session.isIdle).toBe(true); expect(session.pendingMessageCount).toBe(0);
      expect(session.agent.state.messages).toEqual([]);
      expect(session.sessionManager.getEntries().some((entry: any) => entry.details?.deliveryId === input.deliveryId)).toBe(false);
      expect((await outbox.deliver(raw, input)).state).toBe("pending");
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(enqueueThenReject).toHaveBeenCalledOnce();
      expect(session.agent.peekQueuedMessages()).toHaveLength(1);
      expect(f.errors.mock.calls[0][1].constructor.name).toBe("Error");
    } finally { override.mockRestore(); session.dispose(); }
  });

  it("retries the real SDK's busy-agent rejection with no send/prompt replacement", async () => {
    const f = await fixture(); const cwd = join(f.path, "..");
    const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true }); await loader.reload();
    const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
    const { session } = await createAgentSession({ cwd, agentDir: cwd, modelRuntime, settingsManager: SettingsManager.inMemory(), sessionManager: SessionManager.open(f.path), resourceLoader: loader });
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    // Public transform hook holds an independent raw agent run. Throwing after
    // release makes this offline; neither SDK send nor agent.prompt is stubbed.
    session.agent.transformContext = async () => { await gate; throw new Error("offline test provider"); };
    const independent = session.agent.prompt("independent raw SDK run");
    await vi.waitFor(() => expect(session.agent.state.isStreaming).toBe(true));
    const raw = session as unknown as PiWebSession;
    const handle = new PiSessionHandle(raw);
    const outbox = new CompletionOutbox((_value, message) => "sendCompletion" in handle
      ? handle.sendCompletion(message)
      : raw.sendCustomMessage!(message, { triggerTurn: true, deliverAs: "steer" }), f.errors);
    await outbox.deliver(raw, input);
    await vi.waitFor(() => expect(f.errors).toHaveBeenCalled());
    const error = f.errors.mock.calls.at(-1)?.[1];
    expect(String(error?.cause ?? error)).toContain("already processing");
    release(); await independent;
    await outbox.deliver(raw, input);
    await vi.waitFor(async () => expect((await outbox.deliver(raw, input)).state).toBe("saved"));
    expect(session.sessionManager.getEntries().filter((entry: any) => entry.details?.deliveryId === input.deliveryId)).toHaveLength(1);
    session.dispose();
  });
  it("retries missing-API host refusal after the API becomes available", async () => {
    const f = await fixture(); const send = f.raw.sendCustomMessage; f.raw.sendCustomMessage = undefined;
    const outbox = f.makeOutbox(); await outbox.deliver(f.raw, input);
    await vi.waitFor(() => expect(f.errors).toHaveBeenCalled());
    f.raw.sendCustomMessage = send; await outbox.deliver(f.raw, input);
    await vi.waitFor(() => expect(f.queue).toHaveLength(1));
  });
  it("keeps payloads immutable while pending AND after saved/reopen; ignores obsolete anchors", async () => {
    const f = await fixture(); await f.makeOutbox().deliver(f.raw, { ...input, branchAnchorEntryId: "obsolete" } as CompletionInput);
    const changed = { ...input, message: { ...input.message, content: "changed" } };
    await expect(f.makeOutbox().deliver(f.raw, changed)).rejects.toMatchObject({ status: 409 });
    await vi.waitFor(() => expect(f.queue).toHaveLength(1)); await f.consume();
    await expect(f.makeOutbox().deliver(f.raw, changed)).rejects.toMatchObject({ status: 409 });
    const replacement = runtime(f.path);
    await expect(replacement.makeOutbox().deliver(replacement.raw, changed)).rejects.toMatchObject({ status: 409 });
    expect((await replacement.makeOutbox().deliver(replacement.raw, input)).state).toBe("saved");
  });
  it.each([false, true])("acknowledges SDK-decoded complete disk entries without an assistant (nested=%s)", async nested => {
    const f = await fixture(); await appendFile(f.path, `${record("disk", nested)}\n`);
    expect(await f.makeOutbox().deliver(f.raw, input)).toMatchObject({ state: "saved", entryId: "disk" });
    expect(f.raw.sendCustomMessage).not.toHaveBeenCalled();
  });
  it("never repairs a nonterminated final record", async () => {
    const f = await fixture(); await appendFile(f.path, record()); const before = await readFile(f.path, "utf8");
    expect((await f.makeOutbox().deliver(f.raw, input)).state).toBe("pending");
    expect(await readFile(f.path, "utf8")).toBe(before);
    await appendFile(f.path, "\n"); expect((await f.makeOutbox().deliver(f.raw, input)).state).toBe("saved");
  });
  it("treats missing files as pending, identity/read uncertainty as unverified", async () => {
    const f = await fixture(); await rm(f.path);
    expect((await f.makeOutbox().deliver(f.raw, input)).state).toBe("pending");
    const other = await fixture(); await writeFile(other.path, header.replace("parent", "wrong"));
    await expect(other.makeOutbox().deliver(other.raw, input)).rejects.toMatchObject({ status: 503 });
    expect(other.raw.sendCustomMessage).not.toHaveBeenCalled();
    await rm(other.path); await mkdir(other.path);
    await expect(other.makeOutbox().deliver(other.raw, input)).rejects.toBeDefined();
    expect(other.raw.sendCustomMessage).not.toHaveBeenCalled();
  });
  it.each([false, true])("requires real SessionManager disk persistence, including failed writes (firstFlushFailure=%s)", async firstFlushFailure => {
    const f = await fixture(); const manager = SessionManager.create(join(f.path, ".."), join(f.path, ".."));
    const path = manager.getSessionFile()!;
    const raw = { ...f.raw, sessionId: manager.getSessionId(), sessionFile: path, sessionManager: manager } as unknown as PiWebSession;
    raw.sendCustomMessage = vi.fn(async message => { manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details); });
    const outbox = f.makeOutbox(); await outbox.deliver(raw, input); await vi.waitFor(() => expect(raw.sendCustomMessage).toHaveBeenCalledOnce());
    expect((await outbox.deliver(raw, input)).state).toBe("pending");
    const assistant = { role: "assistant", content: [], timestamp: Date.now(), stopReason: "stop" } as any;
    if (firstFlushFailure) {
      await mkdir(path);
      expect(() => manager.appendMessage(assistant)).toThrow();
      expect(manager.getEntries().some(entry => entry.type === "message" && entry.message.role === "assistant")).toBe(true);
      await expect(outbox.deliver(raw, input)).rejects.toBeDefined();
    } else {
      manager.appendMessage(assistant);
      expect((await outbox.deliver(raw, input)).state).toBe("saved");
      // Once flushed, failed appends also leave entries in SDK memory.
      const second = { ...input, deliveryId: "second" }; await rm(path); await mkdir(path);
      expect(() => manager.appendCustomMessageEntry(input.message.customType, input.message.content, true, { ...input.message.details, deliveryId: second.deliveryId })).toThrow();
      expect(manager.getEntries().some((entry: any) => entry.details?.deliveryId === second.deliveryId)).toBe(true);
      await expect(outbox.deliver(raw, second)).rejects.toBeDefined();
    }
  });
  it("never acknowledges an in-memory SessionManager even with an assistant", async () => {
    const f = await fixture(); await rm(f.path);
    const manager = SessionManager.inMemory();
    manager.appendMessage({ role: "assistant", content: [], timestamp: Date.now(), stopReason: "stop" } as any);
    manager.appendCustomMessageEntry(input.message.customType, input.message.content, input.message.display, { ...input.message.details, deliveryId: input.deliveryId });
    const raw = { ...f.raw, sessionId: manager.getSessionId(), sessionManager: manager } as unknown as PiWebSession;
    expect((await f.makeOutbox().deliver(raw, input)).state).toBe("pending");
    expect(f.raw.sendCustomMessage).not.toHaveBeenCalled();
  });
  it("settles abort before disposing a delayed persistence hook", async () => {
    const f = await fixture(); let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    f.raw.abort = vi.fn(() => pending); const handle = new PiSessionHandle(f.raw);
    const disposal = handle.dispose("replace"); await Promise.resolve(); expect((f.raw as any).dispose).not.toHaveBeenCalled();
    finish(); await disposal; expect((f.raw as any).dispose).toHaveBeenCalledOnce();
  });
});
