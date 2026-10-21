import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureOriginalAgentPrompt } from "../../server/session/sdkIdentityAudit.js";
import { ModelRuntime, type AgentSession } from "@earendil-works/pi-coding-agent";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.doUnmock("../../server/session/sdkIdentityAudit.js");
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe("optional SDK identity proof", () => {
  it("captures the genuine public SDK agent prompt on the supported SDK", async () => {
    expect(await captureOriginalAgentPrompt()).toBeTypeOf("function");
  });

  it.each(["resolve", "import"])("boots and keeps ambiguous claims when %s fails", async failure => {
    const capture = () => captureOriginalAgentPrompt(
      () => { if (failure === "resolve") throw new Error("exports changed"); return "missing-sdk"; },
      async () => { throw new Error("import failed"); },
    );
    expect(await capture()).toBeUndefined();
    vi.resetModules();
    vi.doMock("../../server/session/sdkIdentityAudit.js", () => ({ captureOriginalAgentPrompt: capture }));
    // Importing the service/factory must still succeed when the optional audit
    // cannot resolve or import the SDK's transitive dependency.
    const { LocalSessionService } = await import("../../server/session/service.js");
    const { PiSessionFactory } = await import("../../server/session/piFactory.js");
    const { PiSessionHandle } = await import("../../server/session/piHandle.js");
    const { CompletionOutbox } = await import("../../server/session/completionOutbox.js");
    const cwd = await mkdtemp(join(tmpdir(), "pi-sdk-audit-"));
    cleanups.push(() => rm(cwd, { recursive: true, force: true }));
    const path = join(cwd, "session.jsonl");
    await writeFile(path, `${JSON.stringify({ type: "session", version: 3, id: "audit", cwd })}\n`);
    vi.stubEnv("PI_CODING_AGENT_DIR", cwd);
    const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
    const factory = new PiSessionFactory({ noSession: false, modelRuntime, additionalExtensionPaths: () => [], sessionCwd: manager => manager.getCwd(), rememberCwd: () => {}, readSession: async () => { throw new Error("unused"); } });
    const { session: raw } = await factory.create({ path, cwd });
    const session = raw as unknown as AgentSession;
    const service = new LocalSessionService({ modelRuntime, sessionFactory: { create: async () => ({ session: raw }), list: async () => [] }, additionalExtensionPaths: () => [], sessionConfig: { defaultsFor: async () => ({}), finalizeCreatedSession: async () => {} }, globalCwd: () => cwd, clientCount: () => 0 });
    await service.initialize();
    cleanups.push(() => service.disposeAll());
    expect((await service.state(raw.sessionId)).sessionId).toBe(raw.sessionId);
    const handle = new PiSessionHandle(raw);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    session.agent.transformContext = async () => { await gate; throw new Error("offline provider"); };
    const running = session.agent.prompt("independent SDK run");
    await vi.waitFor(() => expect(session.agent.state.isStreaming).toBe(true));
    try {
      const errors = vi.fn();
      const outbox = new CompletionOutbox((_value, message) => handle.sendCompletion(message), errors);
      const input = { deliveryId: "audit-failure", message: { customType: "wakeup", content: "Done", display: true } };
      await outbox.deliver(raw, input);
      await vi.waitFor(() => expect(errors).toHaveBeenCalledOnce());
      expect(errors.mock.calls[0][1].constructor.name).toBe("Error");
      release(); await running;
      expect((await outbox.deliver(raw, input)).state).toBe("pending");
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(errors).toHaveBeenCalledOnce(); // Unknown claim was not cleared/retried.
      // Ordinary custom delivery remains usable; audit failure is not a gate.
      await session.sendCustomMessage({ customType: "ordinary", content: "still usable", display: true });
      expect(session.sessionManager.getEntries().some((entry: any) => entry.customType === "ordinary")).toBe(true);
    } finally { release(); await running; }
  });
});
