import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalSessionService, type LocalSessionServiceDependencies } from "../server/session/service.js";
import type { PiWebSession } from "../server/types.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const dispatchId = "12345678-1234-1234-1234-123456789abc";
async function fixture() {
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

  it("preserves a host preflight lease across SDK-idle abort and blocks navigation", async () => {
    const { raw, service } = await fixture();
    let admit!: () => void;
    let finish!: () => void;
    raw.prompt = vi.fn((_message, options) => new Promise<void>(resolve => {
      admit = () => options?.preflightResult?.(true); finish = resolve;
    }));
    const request = service.prompt(raw.sessionId, prompt);
    await vi.waitFor(() => expect(raw.prompt).toHaveBeenCalledOnce());
    await service.abort(raw.sessionId, "idle");
    expect(raw.isStreaming).toBe(false);
    expect(service.hasActiveWorkForPath(raw.sessionFile)).toBe(true);
    await expect(service.navigate(raw.sessionId, "earlier", {})).rejects.toMatchObject({ status: 409 });
    expect(raw.navigateTree).not.toHaveBeenCalled();
    admit(); await request; finish();
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
    expect(vi.mocked(raw.prompt).mock.calls[0]).toEqual(["legacy", {}]);
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
    await service.abort(raw.sessionId, "idle");
    expect(service.hasActiveWorkForPath(raw.sessionFile)).toBe(true);
    await service.deliverCompletion(raw.sessionId, completion);
    await Promise.resolve();
    expect(raw.sendCustomMessage).not.toHaveBeenCalled();
    finish(); await navigation;
    await service.deliverCompletion(raw.sessionId, completion);
    await vi.waitFor(() => expect(raw.sendCustomMessage).toHaveBeenCalledOnce());
  });
});
