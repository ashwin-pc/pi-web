import { describe, expect, it } from "vitest";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, registerApiProvider, unregisterApiProviders, type SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { HostModelBroker } from "../server/runtime/modelBroker.js";

function usage() {
  return { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

describe("HostModelBroker", () => {
  it("uses the authoritative host model and strips runner-supplied auth options", async () => {
    const provider = `broker-test-${Date.now()}`;
    const api = `${provider}-api`;
    const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
    let receivedOptions: SimpleStreamOptions | undefined;
    registry.registerProvider(provider, {
      api,
      apiKey: "host-only-secret",
      baseUrl: "https://provider.invalid",
      models: [{ id: "safe-model", name: "Safe Model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }],
    });
    const sourceId = `${provider}-source`;
    const fakeStream = (model: any, _context: any, options?: SimpleStreamOptions) => {
      receivedOptions = options;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.push({
        type: "done",
        reason: "stop",
        message: { role: "assistant", content: [{ type: "text", text: "safe" }], api: model.api, provider: model.provider, model: model.id, usage: usage(), stopReason: "stop", timestamp: Date.now() },
      }));
      return stream;
    };
    registerApiProvider({ api, stream: fakeStream, streamSimple: fakeStream }, sourceId);

    const events: Array<{ event: string; data?: unknown }> = [];
    const handler = new HostModelBroker(registry).createRequestHandler();
    try {
      const catalog = await handler({ id: "list", method: "host.models.list" }, { sendEvent: (event, data) => events.push({ event, data }) });
      const listed = catalog as { models: Array<{ provider: string; id: string }> };
      expect(listed.models).toEqual(expect.arrayContaining([expect.objectContaining({ provider, id: "safe-model" })]));
      expect(JSON.stringify(catalog)).not.toContain("host-only-secret");
      expect(JSON.stringify(catalog)).not.toContain("provider.invalid");

      await handler({
        id: "stream",
        method: "host.models.stream",
        params: {
          provider,
          id: "safe-model",
          context: { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
          options: { apiKey: "runner-attack", headers: { authorization: "runner-attack" }, env: { SECRET: "runner-attack" }, baseUrl: "https://runner.invalid", url: "https://runner.invalid", maxTokens: 42, transport: { smuggled: true }, timeoutMs: "forever" },
        },
      }, { sendEvent: (event, data) => events.push({ event, data }) });

      expect(receivedOptions).toMatchObject({ apiKey: "host-only-secret", maxTokens: 42 });
      expect(receivedOptions?.headers).toBeUndefined();
      expect(receivedOptions?.env).toBeUndefined();
      expect((receivedOptions as Record<string, unknown> | undefined)?.baseUrl).toBeUndefined();
      expect((receivedOptions as Record<string, unknown> | undefined)?.url).toBeUndefined();
      expect(receivedOptions?.transport).toBeUndefined();
      expect(receivedOptions?.timeoutMs).toBeUndefined();
      expect(JSON.stringify(events)).not.toContain("host-only-secret");
      expect(JSON.stringify(events)).not.toContain("runner-attack");
      expect(events).toMatchObject([{ event: "host.models.stream.event", data: { requestId: "stream", event: { type: "done" } } }]);
    } finally {
      unregisterApiProviders(sourceId);
      registry.unregisterProvider(provider);
    }
  });

  it("bounds concurrent streams and rejects duplicate runner request ids", async () => {
    const provider = `broker-limit-${Date.now()}`;
    const api = `${provider}-api`;
    const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
    registry.registerProvider(provider, {
      api,
      apiKey: "host-secret",
      baseUrl: "https://provider.invalid",
      models: [{ id: "model", name: "Model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }],
    });
    const sourceId = `${provider}-source`;
    const fakeStream = (model: any, _context: any, options?: SimpleStreamOptions) => {
      const stream = createAssistantMessageEventStream();
      options?.signal?.addEventListener("abort", () => stream.push({
        type: "error",
        reason: "aborted",
        error: { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: usage(), stopReason: "aborted", timestamp: Date.now() },
      }), { once: true });
      return stream;
    };
    registerApiProvider({ api, stream: fakeStream, streamSimple: fakeStream }, sourceId);
    const handler = new HostModelBroker(registry, 1).createRequestHandler();
    const transport = { sendEvent: () => undefined };
    const params = { provider, id: "model", context: { messages: [] } };
    try {
      const first = handler({ id: "stream-1", method: "host.models.stream", params }, transport);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await expect(handler({ id: "stream-1", method: "host.models.stream", params }, transport)).rejects.toThrow(/Duplicate/);
      await expect(handler({ id: "stream-2", method: "host.models.stream", params }, transport)).rejects.toThrow(/limit/);
      handler.dispose?.();
      await expect(first).resolves.toMatchObject({ ok: true });
    } finally {
      handler.dispose?.();
      unregisterApiProviders(sourceId);
      registry.unregisterProvider(provider);
    }
  });

  it("rejects arbitrary host methods and unavailable models", async () => {
    const broker = new HostModelBroker(ModelRegistry.inMemory(AuthStorage.inMemory()));
    const handler = broker.createRequestHandler();
    const transport = { sendEvent: () => undefined };
    await expect(handler({ id: "bad", method: "host.fetch", params: { url: "https://example.com" } }, transport)).rejects.toThrow(/not allowed/);
    await expect(handler({ id: "bad-model", method: "host.models.stream", params: { provider: "missing", id: "missing", context: { messages: [] } } }, transport)).rejects.toThrow(/not available/);
  });
});
