import { describe, expect, it, vi } from "vitest";
import { assertCompletionPayload, CompletionDeferredError, CompletionOutbox, type CompletionFact, type CompletionInitialFact, type CompletionInput, type CompletionProbe, type CompletionRuntime } from "../../server/session/completionOutbox.js";

const input: CompletionInput = { deliveryId: "task:finished", message: { customType: "completion", content: "Done", display: true, details: { result: [] } } };
const pending: CompletionFact = { state: "pending", admission: "unknown" };
function fixture() {
  const value = {};
  const probe = {
    initialize: vi.fn<CompletionProbe["initialize"]>(async () => ({ state: "pending", submission: "needed" })),
    poll: vi.fn<CompletionProbe["poll"]>(async () => pending),
    rejected: vi.fn<CompletionProbe["rejected"]>(async () => pending),
  };
  const makeProbe = vi.fn(() => probe);
  // Intentionally new wrappers for each request: only runtimeKey owns claims.
  const runtime = (key: object): CompletionRuntime => ({ runtimeKey: key, sessionId: "parent", completionProbe: makeProbe });
  const send = vi.fn(async (_value: object, _message: unknown) => {});
  const errors = vi.fn();
  const outbox = () => new CompletionOutbox(send, errors, runtime);
  return { value, probe, makeProbe, runtime, send, errors, outbox };
}

describe("generic completion ownership policy", () => {
  it("deduplicates concurrent requests, wrappers and coordinator reload by opaque runtime key", async () => {
    const f = fixture();
    const receipts = await Promise.all(Array.from({ length: 8 }, () => f.outbox().deliver(f.value, input)));
    expect(receipts.every(receipt => receipt.state === "pending")).toBe(true);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    expect(f.makeProbe).toHaveBeenCalledOnce();
    expect(f.probe.initialize).toHaveBeenCalledOnce();
    expect(f.send.mock.calls[0][1]).toEqual({ ...input.message, details: { ...input.message.details, deliveryId: input.deliveryId } });
    await f.outbox().deliver({}, input);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
  });

  it.each<CompletionInitialFact>([
    { state: "pending", submission: "observed" },
    { state: "saved", entryId: "disk-entry" },
  ])("does not submit an existing candidate (%j)", async fact => {
    const f = fixture(); f.probe.initialize.mockResolvedValue(fact);
    const receipt = await f.outbox().deliver(f.value, input);
    expect(receipt).toEqual({ sessionId: "parent", deliveryId: input.deliveryId, state: fact.state, ...(fact.state === "saved" ? { entryId: fact.entryId } : {}) });
    expect(f.send).not.toHaveBeenCalled();
  });

  it("keeps payload immutable while pending and saved", async () => {
    const f = fixture(); const outbox = f.outbox();
    await outbox.deliver(f.value, input);
    const changed = { ...input, message: { ...input.message, content: "Changed" } };
    await expect(outbox.deliver(f.value, changed)).rejects.toMatchObject({ status: 409 });
    f.probe.poll.mockResolvedValue({ state: "saved", entryId: "saved" });
    expect(await outbox.deliver(f.value, input)).toMatchObject({ state: "saved", entryId: "saved" });
    await expect(f.outbox().deliver(f.value, changed)).rejects.toMatchObject({ status: 409 });
    expect(f.send).toHaveBeenCalledOnce();
  });

  it("owns canonical payload conflicts found by persistence adapters", () => {
    const candidate = { ...input.message, details: { deliveryId: input.deliveryId, result: [] } };
    expect(() => assertCompletionPayload(input, candidate)).not.toThrow();
    expect(() => assertCompletionPayload(input, { ...candidate, display: undefined })).toThrow("different payload");
    expect(() => assertCompletionPayload(input, { ...candidate, content: "Changed" })).toThrow("different payload");
  });

  it("copies the input before yielding to asynchronous submission", async () => {
    const f = fixture(); const original = structuredClone(input);
    const delivering = f.outbox().deliver(f.value, original);
    original.message.content = "mutated";
    await delivering;
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    expect(f.send.mock.calls[0][1]).toMatchObject({ content: "Done" });
  });

  it("serializes probe polls and retries failed reads without resubmission", async () => {
    const f = fixture(); await f.outbox().deliver(f.value, input);
    let finish!: (fact: CompletionFact) => void;
    f.probe.poll.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = f.outbox().deliver(f.value, input);
    const second = f.outbox().deliver(f.value, input);
    await vi.waitFor(() => expect(f.probe.poll).toHaveBeenCalledOnce());
    finish(pending); await Promise.all([first, second]);
    expect(f.probe.poll).toHaveBeenCalledTimes(2);
    f.probe.poll.mockRejectedValueOnce(new Error("read failed"));
    await expect(f.outbox().deliver(f.value, input)).rejects.toThrow("read failed");
    expect((await f.outbox().deliver(f.value, input)).state).toBe("pending");
    expect(f.send).toHaveBeenCalledOnce();
  });

  it("releases pre-send lookup failure without invoking the runtime", async () => {
    const f = fixture(); f.probe.initialize.mockRejectedValueOnce(new Error("unverified"));
    await expect(f.outbox().deliver(f.value, input)).rejects.toThrow("unverified");
    expect(f.send).not.toHaveBeenCalled();
    await f.outbox().deliver(f.value, input);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    expect(f.probe.initialize).toHaveBeenCalledTimes(2);
  });

  it("retries a typed host refusal without asking the adapter to classify admission", async () => {
    const f = fixture(); f.send.mockRejectedValueOnce(new CompletionDeferredError("host closed"));
    await f.outbox().deliver(f.value, input);
    await vi.waitFor(() => expect(f.errors).toHaveBeenCalledOnce());
    expect(f.probe.rejected).not.toHaveBeenCalled();
    await f.outbox().deliver(f.value, input);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
  });

  it("retains unknown rejection even when later polls remain pending", async () => {
    const f = fixture(); const error = new Error("unknown"); f.send.mockRejectedValueOnce(error);
    await f.outbox().deliver(f.value, input);
    await vi.waitFor(() => expect(f.errors).toHaveBeenCalledOnce());
    expect(f.probe.rejected).toHaveBeenCalledWith(error);
    await f.outbox().deliver(f.value, input); await f.outbox().deliver(f.value, input);
    expect(f.send).toHaveBeenCalledOnce();
  });

  it.each(["rejection", "later-poll"])("releases only explicit verified non-admission (%s)", async when => {
    const f = fixture(); f.send.mockRejectedValueOnce(new Error("candidate"));
    const proof: CompletionFact = { state: "pending", admission: "proven-not-admitted" };
    if (when === "rejection") f.probe.rejected.mockResolvedValueOnce(proof);
    await f.outbox().deliver(f.value, input);
    await vi.waitFor(() => expect(f.errors).toHaveBeenCalledOnce());
    if (when === "later-poll") {
      f.probe.poll.mockResolvedValueOnce(proof);
      expect((await f.outbox().deliver(f.value, input)).state).toBe("pending");
    }
    await f.outbox().deliver(f.value, input);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
  });

  it("retains a rejected claim if adapter verification fails, then allows verification retry", async () => {
    const f = fixture(); f.send.mockRejectedValueOnce(new Error("candidate"));
    f.probe.rejected.mockRejectedValueOnce(new Error("disk uncertain"));
    await f.outbox().deliver(f.value, input);
    await vi.waitFor(() => expect(f.errors).toHaveBeenCalledTimes(2));
    expect((await f.outbox().deliver(f.value, input)).state).toBe("pending");
    expect(f.send).toHaveBeenCalledOnce();
    f.probe.poll.mockResolvedValueOnce({ state: "saved", entryId: "persisted" });
    expect(await f.outbox().deliver(f.value, input)).toMatchObject({ state: "saved", entryId: "persisted" });
  });

  it("serializes rejection verification after an already running poll", async () => {
    const f = fixture(); let reject!: (error: Error) => void;
    f.send.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    await f.outbox().deliver(f.value, input);
    let finish!: (fact: CompletionFact) => void;
    f.probe.poll.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const poll = f.outbox().deliver(f.value, input);
    await vi.waitFor(() => expect(f.probe.poll).toHaveBeenCalledOnce());
    reject(new Error("rejected")); await Promise.resolve(); await Promise.resolve();
    expect(f.probe.rejected).not.toHaveBeenCalled();
    finish(pending); await poll;
    await vi.waitFor(() => expect(f.probe.rejected).toHaveBeenCalledOnce());
  });
});
