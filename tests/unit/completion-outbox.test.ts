import { appendFile, mkdtemp, open, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompletionOutbox, syncCompletionDirectory, type CompletionInput, type CompletionMessage } from "../../server/session/completionOutbox.js";
import { PiSessionHandle } from "../../server/session/piHandle.js";
import type { PiWebSession } from "../../server/types.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const input: CompletionInput = { deliveryId: "worker:task-1:finished", message: { customType: "worker-wakeup", content: "Outcome: done", display: true, details: { workers: [] } } };

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-completion-"));
  directories.push(directory);
  const path = join(directory, "parent.jsonl");
  await writeFile(path, `${JSON.stringify({ type: "session", id: "parent" })}\n`);
  return runtime(path);
}
function runtime(path: string) {
  let queue: CompletionMessage[] = [];
  const entries: any[] = [];
  let branch = [{ id: "anchor" }];
  const errors = vi.fn();
  const raw = {
    sessionId: "parent", sessionFile: path, isStreaming: true, isCompacting: false,
    agent: { state: { messages: [] as unknown[] } },
    sessionManager: { getEntries: () => entries, getBranch: () => branch },
    abort: vi.fn(async () => {}), subscribe: () => () => {}, dispose: vi.fn(),
    sendCustomMessage: vi.fn(async (message: CompletionMessage) => { queue.push(message); }),
  } as unknown as PiWebSession;
  const makeOutbox = () => new CompletionOutbox((value, message) => value.sendCustomMessage!(message, { triggerTurn: true, deliverAs: "steer" }), errors);
  async function consume(persist = true) {
    const batch = queue.splice(0);
    for (const message of batch) {
      const custom = { role: "custom", ...message };
      const entry = { type: "custom_message", id: `saved-${entries.length}`, ...message };
      entries.push(entry); raw.agent.state.messages.push(custom);
      if (persist) await appendFile(path, `${JSON.stringify(entry)}\n`);
    }
  }
  return { raw, entries, path, errors, makeOutbox, consume, clear: () => { queue = []; }, setBranch: (value: typeof branch) => { branch = value; }, queued: () => queue.length };
}
async function savedCount(path: string) {
  return (await readFile(path, "utf8")).split("\n").filter(line => line && JSON.parse(line).details?.deliveryId === input.deliveryId).length;
}

describe("durable completion outbox", () => {
  it("tolerates only unsupported Windows directory fsync, not other storage failures", async () => {
    const failure = (code: string) => async () => { throw Object.assign(new Error("directory handle failure"), { code }); };
    for (const code of ["EPERM", "EISDIR", "EINVAL", "ENOTSUP", "EBADF"]) {
      await expect(syncCompletionDirectory("unused", "win32", failure(code))).resolves.toBeUndefined();
    }
    await expect(syncCompletionDirectory("unused", "win32", failure("ENOENT"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(syncCompletionDirectory("unused", "linux", failure("EPERM"))).rejects.toMatchObject({ code: "EPERM" });
    // Unsupported fsync after a successful directory open also closes its handle.
    const close = vi.fn(async () => {});
    await expect(syncCompletionDirectory("unused", "win32", async () => ({ sync: failure("EINVAL"), close }))).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  });
  it("persists before submission and deduplicates concurrent requests and extension reload with a surviving busy runtime", async () => {
    const f = await fixture();
    const first = f.makeOutbox();
    const receipts = await Promise.all([first.deliver(f.raw, input), first.deliver(f.raw, input)]);
    expect(receipts.every(receipt => receipt.state === "pending")).toBe(true);
    await vi.waitFor(() => expect(f.raw.sendCustomMessage).toHaveBeenCalledTimes(1));
    const files = await readdir(`${f.path}.completions`);
    expect(files).toHaveLength(1);
    expect(JSON.parse(await readFile(join(`${f.path}.completions`, files[0]), "utf8"))).toEqual(input);
    expect((await f.makeOutbox().deliver(f.raw, input)).state).toBe("pending");
    expect(f.queued()).toBe(1);
    await f.consume();
    expect(await first.deliver(f.raw, input)).toMatchObject({ state: "saved", entryId: "saved-0" });
    expect(await savedCount(f.path)).toBe(1);
  });

  it("reconciles saved-before-ack on restart without replaying", async () => {
    const f = await fixture();
    await f.makeOutbox().deliver(f.raw, input);
    await vi.waitFor(() => expect(f.queued()).toBe(1));
    await f.consume(); // Simulate process dying before caller receives saved ack.
    const replacement = runtime(f.path);
    await replacement.makeOutbox().resume(replacement.raw);
    expect(replacement.raw.sendCustomMessage).not.toHaveBeenCalled();
    expect((await replacement.makeOutbox().deliver(replacement.raw, input)).state).toBe("saved");
    expect(await savedCount(f.path)).toBe(1);
  });

  it("keeps canceled queues pending in the same runtime and replays only in a replacement", async () => {
    const f = await fixture();
    await f.makeOutbox().deliver(f.raw, input);
    await vi.waitFor(() => expect(f.queued()).toBe(1));
    f.clear(); // Third-party raw SDK clearQueue: absence is not proof to retry.
    expect((await f.makeOutbox().deliver(f.raw, input)).state).toBe("pending");
    expect(f.raw.sendCustomMessage).toHaveBeenCalledTimes(1);
    await new PiSessionHandle(f.raw).dispose("replace");
    const replacement = runtime(f.path);
    await replacement.makeOutbox().resume(replacement.raw);
    await vi.waitFor(() => expect(replacement.queued()).toBe(1));
    await replacement.consume();
    expect(await savedCount(f.path)).toBe(1);
  });

  it("does not treat pre-first-assistant in-memory entries as saved", async () => {
    const f = await fixture();
    await f.makeOutbox().deliver(f.raw, input);
    await vi.waitFor(() => expect(f.queued()).toBe(1));
    await f.consume(false);
    expect(f.entries).toHaveLength(1);
    expect((await f.makeOutbox().deliver(f.raw, input)).state).toBe("pending");
    expect(f.raw.sendCustomMessage).toHaveBeenCalledTimes(1);
    // SDK eventually flushes its memory-only entries with the first assistant.
    await appendFile(f.path, `${JSON.stringify(f.entries[0])}\n`);
    expect((await f.makeOutbox().deliver(f.raw, input)).state).toBe("saved");
  });

  it("fails closed on asynchronous rejection after enqueue or partial append", async () => {
    const f = await fixture();
    f.raw.sendCustomMessage = vi.fn(async message => {
      f.entries.push({ type: "custom_message", id: "memory", ...message });
      throw new Error("failed after append");
    });
    await f.makeOutbox().deliver(f.raw, input);
    await vi.waitFor(() => expect(f.errors).toHaveBeenCalled());
    expect((await f.makeOutbox().deliver(f.raw, input)).state).toBe("pending");
    expect(f.raw.sendCustomMessage).toHaveBeenCalledTimes(1);
  });

  it("requires immutable payloads, including the branch anchor, but tolerates object key order", async () => {
    const f = await fixture();
    await f.makeOutbox().deliver(f.raw, input);
    await expect(f.makeOutbox().deliver(f.raw, { ...input, message: { ...input.message, content: "different" } })).rejects.toMatchObject({ status: 409 });
    await expect(f.makeOutbox().deliver(f.raw, { ...input, branchAnchorEntryId: "anchor" })).rejects.toMatchObject({ status: 409 });
    expect((await f.makeOutbox().deliver(f.raw, { message: input.message, deliveryId: input.deliveryId })).state).toBe("pending");
  });

  it("keeps wrong-branch payload pending and retries when its actual anchor is active", async () => {
    const f = await fixture();
    const anchored = { ...input, branchAnchorEntryId: "other-branch" };
    expect((await f.makeOutbox().deliver(f.raw, anchored)).state).toBe("pending");
    await Promise.resolve();
    expect(f.raw.sendCustomMessage).not.toHaveBeenCalled();
    f.setBranch([{ id: "other-branch" }]);
    await f.makeOutbox().deliver(f.raw, anchored);
    await vi.waitFor(() => expect(f.queued()).toBe(1));
    await f.consume();
    expect((await f.makeOutbox().deliver(f.raw, anchored)).state).toBe("saved");
  });

  it("settles an in-flight message-end persistence hook before replacement replay", async () => {
    const f = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const hookEntered = new Promise<void>(resolve => { entered = resolve; });
    const hook = new Promise<void>(resolve => { release = resolve; });
    let persistence!: Promise<void>;
    f.raw.sendCustomMessage = vi.fn(async message => {
      persistence = (async () => {
        entered(); await hook;
        await appendFile(f.path, `${JSON.stringify({ type: "custom_message", id: "late-entry", ...message })}\n`);
      })();
      await persistence;
    });
    f.raw.abort = vi.fn(async () => { await persistence; });
    await f.makeOutbox().deliver(f.raw, input);
    await hookEntered;
    let disposed = false;
    const disposal = new PiSessionHandle(f.raw).dispose("replace").then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);
    expect((f.raw as unknown as { dispose: ReturnType<typeof vi.fn> }).dispose).not.toHaveBeenCalled();
    release(); await disposal;
    const replacement = runtime(f.path);
    await replacement.makeOutbox().resume(replacement.raw);
    expect(replacement.raw.sendCustomMessage).not.toHaveBeenCalled();
    expect(await savedCount(f.path)).toBe(1);
  });

  it("rejects non-string delivery identifiers with a validation error", async () => {
    const f = await fixture();
    for (const deliveryId of [123, null, {}, []]) {
      await expect(f.makeOutbox().deliver(f.raw, { ...input, deliveryId } as unknown as CompletionInput)).rejects.toMatchObject({ status: 400 });
    }
    expect(f.raw.sendCustomMessage).not.toHaveBeenCalled();
    expect((await f.makeOutbox().deliver(f.raw, { ...input, branchAnchorEntryId: null } as unknown as CompletionInput)).state).toBe("pending");
    // Null and omitted anchors normalize to the same immutable payload.
    expect((await f.makeOutbox().deliver(f.raw, input)).state).toBe("pending");
  });

  it("scans disk only once when unchanged, then reads only the appended tail across IDs", async () => {
    const f = await fixture();
    const handle = await open(f.path, "r");
    const read = vi.spyOn(Object.getPrototypeOf(handle), "read");
    await handle.close();
    try {
      const outbox = f.makeOutbox();
      await outbox.deliver(f.raw, input);
      const initialReads = read.mock.calls.length;
      expect(initialReads).toBeGreaterThan(0);
      await outbox.deliver(f.raw, input);
      await outbox.deliver(f.raw, { ...input, deliveryId: "another-completion" });
      expect(read.mock.calls).toHaveLength(initialReads);
      const originalSize = (await stat(f.path)).size;
      await appendFile(f.path, `${JSON.stringify({ type: "message", id: "tail", message: { role: "assistant", content: "Other work" } })}\n`);
      await outbox.deliver(f.raw, input);
      expect(read.mock.calls).toHaveLength(initialReads + 2); // <=64-byte boundary check + appended tail.
      expect(read.mock.calls.at(-1)?.[3]).toBe(originalSize);
    } finally { read.mockRestore(); }
  });

  it("invalidates cached IDs on truncation, replacement and same-size rewrite", async () => {
    const f = await fixture();
    const record = `${JSON.stringify({ type: "custom_message", id: "saved", ...input.message, details: { deliveryId: input.deliveryId } })}\n`;
    await writeFile(f.path, record);
    const outbox = f.makeOutbox();
    expect((await outbox.deliver(f.raw, input)).state).toBe("saved");
    const rewritten = record.replace(input.deliveryId, "worker:task-2:finished");
    expect(rewritten.length).toBe(record.length);
    await writeFile(f.path, rewritten);
    await utimes(f.path, new Date(), new Date(Date.now() + 2000));
    expect((await outbox.deliver(f.raw, input)).state).toBe("pending");
    await writeFile(f.path, record);
    expect((await outbox.deliver(f.raw, input)).state).toBe("saved");
    await writeFile(f.path, "{}\n");
    expect((await outbox.deliver(f.raw, input)).state).toBe("pending");
    await writeFile(f.path, record);
    expect((await outbox.deliver(f.raw, input)).state).toBe("saved");
    const replacement = `${f.path}.replacement`;
    await writeFile(replacement, rewritten);
    await rename(replacement, f.path);
    expect((await outbox.deliver(f.raw, input)).state).toBe("pending");
  });

  it("does not acknowledge a partially written final JSONL line", async () => {
    const f = await fixture();
    await f.makeOutbox().deliver(f.raw, input);
    const record = JSON.stringify({ type: "custom_message", id: "partial", ...input.message, details: { deliveryId: input.deliveryId } });
    await appendFile(f.path, record);
    expect((await f.makeOutbox().deliver(f.raw, input)).state).toBe("pending");
    await appendFile(f.path, "\n");
    expect(await f.makeOutbox().deliver(f.raw, input)).toMatchObject({ state: "saved", entryId: "partial" });
  });

  it("does not inject when disk verification is uncertain", async () => {
    const f = await fixture();
    await appendFile(f.path, "{broken\n");
    await expect(f.makeOutbox().deliver(f.raw, input)).rejects.toMatchObject({ status: 503 });
    expect(f.raw.sendCustomMessage).not.toHaveBeenCalled();
  });
});
