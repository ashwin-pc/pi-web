import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalSessionService, type LocalSessionServiceDependencies } from "../server/session/service.js";
import type { PiWebSession } from "../server/types.js";
import { parseAttachmentMarkup } from "../server/shared/attachments.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); });
const dispatchId = "12345678-1234-1234-1234-123456789abc";
async function fixture(settleTimeoutMs?: number) {
  if (settleTimeoutMs !== undefined) vi.stubEnv("PI_WEB_OPERATION_SETTLE_TIMEOUT_MS", String(settleTimeoutMs));
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-admission-"));
  const model = { provider: "test", id: "model" };
  const raw = {
    sessionId: "parent", sessionFile: join(cwd, "parent.jsonl"), isStreaming: false,
    model, thinkingLevel: "off", systemPrompt: "", messages: [], agent: { state: { messages: [] } },
    sessionManager: { getCwd: () => cwd, buildSessionContext: () => ({ messages: [] }), getBranch: () => [{ id: "anchor" }], getSessionName: () => "Parent" },
    modelRuntime: { getAvailableSnapshot: () => [model], getModel: () => model },
    getAvailableThinkingLevels: () => ["off"], setModel: async () => {}, setThinkingLevel: () => {},
    prompt: vi.fn(async (_text, options) => { options?.preflightResult?.(true); }),
    abort: vi.fn(async () => {}), subscribe: () => () => {},
    navigateTree: vi.fn(async () => ({ cancelled: false })),
    sendCustomMessage: vi.fn(async () => {}),
  } as unknown as PiWebSession;
  const service = new LocalSessionService({
    modelRuntime: {} as LocalSessionServiceDependencies["modelRuntime"],
    sessionFactory: { create: async () => ({ session: raw }), list: async () => [] },
    additionalExtensionPaths: () => [],
    sessionConfig: { defaultsFor: async () => ({}), finalizeCreatedSession: async () => {} },
    globalCwd: () => cwd, clientCount: () => 0,
  });
  await service.initialize();
  cleanups.push(async () => { await service.disposeAll(); await rm(cwd, { recursive: true, force: true }); });
  return { raw, service };
}
const prompt = { message: "Inspect workspace", mode: "steer", attachments: [], waitFor: "admission" as const, dispatchId };
const completion = { deliveryId: "completion-1", branchAnchorEntryId: "anchor", message: { customType: "wakeup", content: "Done", display: true } };

describe("host prompt admission and settled interruption", () => {
  it("confirms SDK preflight, not HTTP acceptance or whole-run completion, and appends exact dispatch marker", async () => {
    const { raw, service } = await fixture();
    let admit!: () => void;
    let finish!: () => void;
    raw.prompt = vi.fn((_message, options) => new Promise<void>(resolve => {
      admit = () => options?.preflightResult?.(true); finish = resolve;
    }));
    let settled = false;
    const request = service.prompt(raw.sessionId, prompt).then(result => { settled = true; return result; });
    await vi.waitFor(() => expect(raw.prompt).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    expect(vi.mocked(raw.prompt).mock.calls[0][0]).toBe(`Inspect workspace\n\n[pi-web-dispatch:${dispatchId}]`);
    admit();
    expect(await request).toEqual({ sessionId: "parent", admission: "accepted", dispatchId });
    expect(service.hasActiveWorkForPath(raw.sessionFile)).toBe(true);
    finish();
    await vi.waitFor(() => expect(service.hasActiveWorkForPath(raw.sessionFile)).toBe(false));
  });

  it.each(["compaction in progress", "no model available"])("rejects admission: %s", async error => {
    const { raw, service } = await fixture();
    raw.prompt = vi.fn(async (_message, options) => { options?.preflightResult?.(false); throw new Error(error); });
    await expect(service.prompt(raw.sessionId, prompt)).rejects.toThrow(error);
    expect(service.hasActiveWorkForPath(raw.sessionFile)).toBe(false);
  });

  it("releases Stop's visible lease but fences mutations and cancels late idle preflight before a run", async () => {
    const { raw, service } = await fixture();
    let admit!: () => void;
    const run = vi.fn();
    raw.prompt = vi.fn((_message, options) => new Promise<void>((resolve, reject) => {
      admit = () => {
        try { options?.preflightResult?.(true); run(); resolve(); }
        catch (error) { reject(error); }
      };
    }));
    const request = service.prompt(raw.sessionId, prompt);
    const rejected = expect(request).rejects.toMatchObject({ status: 409 });
    await vi.waitFor(() => expect(raw.prompt).toHaveBeenCalledOnce());
    await service.abort(raw.sessionId);
    expect(raw.isStreaming).toBe(false);
    expect(service.hasActiveWorkForPath(raw.sessionFile)).toBe(false);
    expect((await service.state(raw.sessionId)).sessionId).toBe(raw.sessionId);
    for (const mutation of [
      () => service.prompt(raw.sessionId, prompt), () => service.retry(raw.sessionId),
      () => service.navigate(raw.sessionId, "earlier", {}), () => service.setModel(raw.sessionId, "test", "model"),
      () => service.reloadExtensions(raw.sessionId), () => service.executeCommand(raw.sessionId, "/reload"),
      () => service.deliverCompletion(raw.sessionId, completion), () => service.rename(raw.sessionId, "Renamed"),
      () => service.executeShell(raw.sessionId, "true", false), () => service.invokeContribution(raw.sessionId, {}),
      () => service.invokeHeaderAction(raw.sessionId, "key"), () => service.invokeArtifactAction(raw.sessionId, {}),
      () => service.invokeGitTab(raw.sessionId, {}), () => service.invokePanel(raw.sessionId, {}),
    ]) await expect(mutation()).rejects.toMatchObject({ status: 409, recoveryRequired: true });
    expect(raw.navigateTree).not.toHaveBeenCalled();
    admit(); await rejected;
    expect(run).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(service.hasActiveWorkForPath(raw.sessionFile)).toBe(false));
    await service.navigate(raw.sessionId, "earlier", {}); // Fence retires only after actual finally.
  });

  it("waits for SDK-idle preflight before disposal and rejects new admission while closing", async () => {
    const { raw, service } = await fixture();
    let finish!: () => void;
    raw.prompt = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    await service.prompt(raw.sessionId, { message: "pending preflight", mode: "steer", attachments: [] });
    let disposed = false;
    const disposal = service.disposeAll().then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);
    await expect(service.prompt(raw.sessionId, prompt)).rejects.toMatchObject({ status: 409 });
    finish(); await disposal;
    expect(disposed).toBe(true);
  });

  it("treats accepted streaming admission only as queue acceptance", async () => {
    const { raw, service } = await fixture();
    raw.isStreaming = true;
    expect(await service.prompt(raw.sessionId, prompt)).toMatchObject({ admission: "accepted" });
    expect(vi.mocked(raw.prompt).mock.calls[0][1]).toMatchObject({ streamingBehavior: "steer" });
    expect(raw.agent.state.messages).toEqual([]); // No false claim of consumption.
  });

  it("preserves fire-and-forget prompting without the admission option", async () => {
    const { raw, service } = await fixture();
    let finish!: () => void;
    raw.prompt = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    expect(await service.prompt(raw.sessionId, { message: "legacy", mode: "steer", attachments: [] })).toEqual({ sessionId: "parent" });
    expect(vi.mocked(raw.prompt).mock.calls[0]).toEqual(["legacy", { preflightResult: expect.any(Function) }]);
    finish();
  });

  it("rejects invalid dispatch identifiers without SDK admission", async () => {
    const { raw, service } = await fixture();
    await expect(service.prompt(raw.sessionId, { ...prompt, dispatchId: "not-a-uuid" })).rejects.toThrow("UUID");
    expect(raw.prompt).not.toHaveBeenCalled();
  });

  it("waits for a slow abort and propagates abort rejection", async () => {
    const { raw, service } = await fixture();
    let finish!: () => void;
    raw.abort = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    let settled = false;
    const request = service.abort(raw.sessionId, "idle").then(result => { settled = true; return result; });
    await vi.waitFor(() => expect(raw.abort).toHaveBeenCalledOnce());
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    finish();
    expect(await request).toEqual({ sessionId: "parent", idle: true });
    raw.abort = vi.fn(async () => { throw new Error("abort failed"); });
    await expect(service.abort(raw.sessionId, "idle")).rejects.toThrow("abort failed");
    raw.abort = vi.fn(async () => {}); // Allow fixture disposal to settle.
  });
});

describe("owned completion/navigation admission boundary", () => {
  it("blocks history navigation while idle custom-message preflight is still active", async () => {
    const { raw, service } = await fixture();
    let finish!: () => void;
    raw.sendCustomMessage = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    expect((await service.deliverCompletion(raw.sessionId, completion)).state).toBe("pending");
    await vi.waitFor(() => expect(raw.sendCustomMessage).toHaveBeenCalledOnce());
    expect(raw.isStreaming).toBe(false);
    await expect(service.navigate(raw.sessionId, "earlier", {})).rejects.toMatchObject({ status: 409 });
    expect(raw.navigateTree).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(service.hasActiveWorkForPath(raw.sessionFile)).toBe(false));
    // Queue acceptance alone must not permit branch changes during idle flicker.
    await expect(service.navigate(raw.sessionId, "earlier", {})).rejects.toMatchObject({ status: 409 });
    const message = vi.mocked(raw.sendCustomMessage!).mock.calls[0][0];
    await appendFile(raw.sessionFile, `${JSON.stringify({ type: "custom_message", id: "saved", ...message })}\n`);
    await service.navigate(raw.sessionId, "earlier", {});
    expect(raw.navigateTree).toHaveBeenCalledOnce();
  });

  it("does not inject during navigation already admitted by the host", async () => {
    const { raw, service } = await fixture();
    let finish!: () => void;
    raw.navigateTree = vi.fn(() => new Promise(resolve => { finish = () => resolve({ cancelled: false }); }));
    const navigation = service.navigate(raw.sessionId, "earlier", {});
    await vi.waitFor(() => expect(raw.navigateTree).toHaveBeenCalledOnce());
    await service.abort(raw.sessionId);
    expect(service.hasActiveWorkForPath(raw.sessionFile)).toBe(false);
    await expect(service.deliverCompletion(raw.sessionId, completion)).rejects.toMatchObject({ status: 409, recoveryRequired: true });
    await Promise.resolve();
    expect(raw.sendCustomMessage).not.toHaveBeenCalled();
    finish(); await navigation;
    await service.deliverCompletion(raw.sessionId, completion);
    await vi.waitFor(() => expect(raw.sendCustomMessage).toHaveBeenCalledOnce());
  });
});


describe("dispatch history and attachment projection", () => {
  it("keeps dispatch markers before the attachment fence so attachments still project", async () => {
    const { raw, service } = await fixture();
    const attachment = { type: "quote-reply" as const, id: "quote-1", label: "Review comment", quote: "hello", question: "Explain this", source: { startOffset: 0, endOffset: 5 } };
    await service.prompt(raw.sessionId, { ...prompt, attachments: [attachment] });
    const submitted = vi.mocked(raw.prompt).mock.calls[0][0];
    const parsed = parseAttachmentMarkup(submitted);
    expect(parsed.text).toBe(`Inspect workspace\n\n[pi-web-dispatch:${dispatchId}]`);
    expect(parsed.attachments).toEqual([attachment]);
    expect(submitted.endsWith("\n~~~")).toBe(true);
  });

  it("finds a consumed dispatch through compaction without returning inline images or alternate branches", async () => {
    const { raw, service } = await fixture();
    const entries = [
      { id: "old", type: "message", message: { role: "assistant", content: "Older result" } },
      { id: "dispatch", type: "message", message: { role: "user", content: [{ type: "text", text: `Task\n\n[pi-web-dispatch:${dispatchId}]` }, { type: "image", mimeType: "image/png", data: "private-image-bytes" }] } },
      { id: "compaction", type: "compaction", summary: "Compacted task" },
      { id: "final", parentId: "compaction", type: "message", message: { role: "assistant", content: "Final task result", stopReason: "stop" } },
    ];
    raw.messages = [{ role: "compactionSummary", content: "Compacted task" }, entries[3].message];
    raw.agent.state.messages = raw.messages;
    raw.sessionManager.getBranch = () => entries;
    const history = await service.history(raw.sessionId, dispatchId);
    expect(history.map(message => message.entryId)).toEqual(["dispatch", "final"]);
    expect(history[1].text).toBe("Final task result");
    expect(JSON.stringify(history)).not.toContain("private-image-bytes");
    expect(history[0].raw).toMatchObject({ content: [{ type: "text" }, { type: "image", omitted: true }] });
    expect(await service.history(raw.sessionId, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).toEqual([]);
    await expect(service.history(raw.sessionId, "invalid")).rejects.toMatchObject({ status: 400 });
  });
});

describe("bounded recovery without unsafe runtime replacement", () => {
  it.each([true, false])("allows independent steering/model after admitted Stop, while whole-operation delivery barriers remain (streaming=%s)", async stillStreaming => {
    const { raw, service } = await fixture();
    let finish!: () => void;
    let first = true;
    raw.prompt = vi.fn((_text, options) => {
      options?.preflightResult?.(true);
      if (!first) return Promise.resolve();
      first = false;
      raw.isStreaming = true;
      return new Promise<void>(resolve => { finish = resolve; });
    });
    raw.abort = vi.fn(async () => { raw.isStreaming = stillStreaming; });
    raw.setSessionName = vi.fn();
    await service.prompt(raw.sessionId, { message: "accepted work", mode: "steer", attachments: [] });
    try {
      await service.abort(raw.sessionId);
      expect((await service.setModel(raw.sessionId, "test", "model")).model).toMatchObject({ provider: "test", id: "model" });
      await service.rename(raw.sessionId, "Renamed");
      for (const mode of ["steer", "followUp"]) {
        expect(await service.prompt(raw.sessionId, { ...prompt, mode })).toMatchObject({ admission: "accepted" });
        if (stillStreaming) expect(vi.mocked(raw.prompt).mock.calls.at(-1)?.[1]).toMatchObject({ streamingBehavior: mode });
      }
      await expect(service.navigate(raw.sessionId, "earlier", {})).rejects.toMatchObject({ status: 409 });
      expect((await service.deliverCompletion(raw.sessionId, completion)).state).toBe("pending");
      await Promise.resolve();
      expect(raw.sendCustomMessage).not.toHaveBeenCalled();
    } finally { raw.isStreaming = false; finish(); }
    await vi.waitFor(() => expect(service.hasActiveWorkForPath(raw.sessionFile)).toBe(false));
    await vi.waitFor(async () => {
      await service.deliverCompletion(raw.sessionId, completion);
      expect(raw.sendCustomMessage).toHaveBeenCalledOnce();
    });
    // Even after user work settles, an unsaved CUSTOM completion still owns its
    // independent navigation barrier (not the SDK's user pending-message count).
    await expect(service.navigate(raw.sessionId, "earlier", {})).rejects.toMatchObject({ status: 409 });
  });

  it("returns recoveryRequired instead of idle:true while canceled navigation remains unresolved", async () => {
    const { raw, service } = await fixture(15);
    let finish!: () => void;
    raw.navigateTree = vi.fn(() => new Promise(resolve => { finish = () => resolve({ cancelled: false }); }));
    const navigation = service.navigate(raw.sessionId, "earlier", {});
    await vi.waitFor(() => expect(raw.navigateTree).toHaveBeenCalledOnce());
    await expect(service.abort(raw.sessionId, "idle")).rejects.toMatchObject({ status: 503, recoveryRequired: true });
    expect(service.hasActiveWorkForPath(raw.sessionFile)).toBe(false);
    expect((await service.state(raw.sessionId)).sessionId).toBe(raw.sessionId);
    await expect(service.prompt(raw.sessionId, prompt)).rejects.toMatchObject({ status: 409, recoveryRequired: true });
    finish(); await navigation;
    expect(await service.abort(raw.sessionId, "idle")).toMatchObject({ idle: true });
  });

  it("bounds disposal, keeps reads accessible, and never replaces a runtime with delayed persistence", async () => {
    const { raw, service } = await fixture(15);
    let finish!: () => void;
    raw.sendCustomMessage = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    await service.deliverCompletion(raw.sessionId, completion);
    await vi.waitFor(() => expect(raw.sendCustomMessage).toHaveBeenCalledOnce());
    await expect(service.disposeAll()).rejects.toMatchObject({ status: 503, recoveryRequired: true });
    expect((await service.state(raw.sessionId)).sessionId).toBe(raw.sessionId);
    expect(await service.require(raw.sessionId)).toBe(raw);
    await expect(service.prompt(raw.sessionId, prompt)).rejects.toMatchObject({ status: 409, recoveryRequired: true });
    await expect(service.disposeAll()).rejects.toMatchObject({ status: 503, recoveryRequired: true });
    finish();
    await service.disposeAll(); // Joins the same retirement; no replacement/replay.
  });

  it("resets disposing on interrupt rejection so reads and a later delete/disposal attempt remain possible", async () => {
    const { raw, service } = await fixture(15);
    raw.abort = vi.fn(async () => { throw new Error("interrupt rejected"); });
    await expect(service.disposeAll()).rejects.toThrow("interrupt rejected");
    expect((await service.state(raw.sessionId)).sessionId).toBe(raw.sessionId);
    expect(await service.require(raw.sessionId)).toBe(raw);
    raw.abort = vi.fn(async () => {});
    await service.disposeAll();
  });

  it("recovers canceled USER queue ambiguity only at known SDK idle/empty without releasing CUSTOM claims", async () => {
    const { raw, service } = await fixture(15);
    raw.isStreaming = true;
    const queued: string[] = [];
    Object.defineProperty(raw, "isIdle", { configurable: true, get: () => !raw.isStreaming });
    Object.defineProperty(raw, "pendingMessageCount", { configurable: true, get: () => queued.length });
    await service.deliverCompletion(raw.sessionId, completion);
    await vi.waitFor(() => expect(raw.sendCustomMessage).toHaveBeenCalledOnce());
    let admit!: () => void;
    raw.prompt = vi.fn((text, options) => new Promise<void>((resolve, reject) => {
      admit = () => {
        queued.push(text); // SDK streaming path queues BEFORE the callback.
        try { options?.preflightResult?.(true); resolve(); } catch (error) { reject(error); }
      };
    }));
    const request = service.prompt(raw.sessionId, prompt);
    const rejected = expect(request).rejects.toMatchObject({ status: 503, recoveryRequired: true });
    await vi.waitFor(() => expect(raw.prompt).toHaveBeenCalledOnce());
    raw.abort = vi.fn(async () => { raw.isStreaming = false; });
    await service.abort(raw.sessionId);
    expect(raw.isStreaming).toBe(false); // Queue lane survives Stop's transition to idle.
    expect(raw.pendingMessageCount).toBe(0);
    // An idle/empty observation CANNOT clear a still-pending canceled input hook:
    // that future can queue after this observation, before its callback fires.
    await expect(service.setModel(raw.sessionId, "test", "model")).rejects.toMatchObject({ status: 409, recoveryRequired: true });
    admit(); await rejected;
    expect(queued).toHaveLength(1);
    await expect(service.setModel(raw.sessionId, "test", "model")).rejects.toMatchObject({ status: 409, recoveryRequired: true });
    await expect(service.abort(raw.sessionId, "idle")).rejects.toMatchObject({ status: 503, recoveryRequired: true });
    queued.splice(0); // Simulate the SDK consuming/dropping only user text.
    expect(await service.abort(raw.sessionId, "idle")).toMatchObject({ idle: true });
    expect((await service.setModel(raw.sessionId, "test", "model")).model).toMatchObject({ id: "model" });
    await service.deliverCompletion(raw.sessionId, completion);
    expect(raw.sendCustomMessage).toHaveBeenCalledOnce(); // No duplicate custom injection.
    await expect(service.navigate(raw.sessionId, "earlier", {})).rejects.toMatchObject({ status: 409 });
  });

  it("recovers a captured streaming submission that actually reaches idle preflight without queueing", async () => {
    const { raw, service } = await fixture();
    raw.isStreaming = true;
    Object.defineProperty(raw, "isIdle", { configurable: true, value: false, writable: true });
    raw.pendingMessageCount = undefined; // Missing count is not empty-queue proof.
    let admit!: () => void;
    raw.prompt = vi.fn((_text, options) => new Promise<void>((resolve, reject) => {
      admit = () => { try { options?.preflightResult?.(true); resolve(); } catch (error) { reject(error); } };
    }));
    const request = service.prompt(raw.sessionId, prompt);
    const rejected = expect(request).rejects.toMatchObject({ status: 503, recoveryRequired: true });
    await vi.waitFor(() => expect(raw.prompt).toHaveBeenCalledOnce());
    raw.abort = vi.fn(async () => { raw.isStreaming = false; });
    await service.abort(raw.sessionId);
    admit(); await rejected; // Conservative captured-lane detection remains intact.
    await expect(service.setModel(raw.sessionId, "test", "model")).rejects.toMatchObject({ status: 409 });
    Object.defineProperty(raw, "isIdle", { value: true });
    await expect(service.setModel(raw.sessionId, "test", "model")).rejects.toMatchObject({ status: 409 });
    raw.pendingMessageCount = 0;
    expect((await service.setModel(raw.sessionId, "test", "model")).model).toMatchObject({ id: "model" });
    raw.prompt = vi.fn(async (_text, options) => { options?.preflightResult?.(true); });
    expect(await service.prompt(raw.sessionId, prompt)).toMatchObject({ admission: "accepted" });
  });
});
