import {
  streamSimple,
  type Api,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { RuntimeRequest, RuntimeRequestHandler } from "./protocol.js";

export const MODEL_BROKER_API = "pi-web-model-broker";

export type BrokerModel = Pick<Model<Api>,
  | "provider"
  | "id"
  | "name"
  | "reasoning"
  | "thinkingLevelMap"
  | "input"
  | "cost"
  | "contextWindow"
  | "maxTokens"
  | "compat"
>;

export type BrokerModelCatalog = {
  ok: true;
  models: BrokerModel[];
};

type BrokerStreamParams = {
  provider?: unknown;
  id?: unknown;
  context?: unknown;
  options?: unknown;
};

const allowedOptionKeys = new Set([
  "temperature",
  "maxTokens",
  "transport",
  "cacheRetention",
  "sessionId",
  "timeoutMs",
  "websocketConnectTimeoutMs",
  "maxRetries",
  "maxRetryDelayMs",
  "metadata",
  "reasoning",
  "thinkingBudgets",
]);

function brokerModel(model: Model<Api>): BrokerModel {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    compat: model.compat,
  };
}

function safeStreamOptions(value: unknown): SimpleStreamOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, option] of Object.entries(value as Record<string, unknown>)) {
    if (!allowedOptionKeys.has(key) || typeof option === "function") continue;
    result[key] = option;
  }
  return result as SimpleStreamOptions;
}

function asContext(value: unknown): Context {
  if (!value || typeof value !== "object" || !Array.isArray((value as Context).messages)) {
    throw new Error("Model broker context is invalid");
  }
  return value as Context;
}

/**
 * Host-owned model transport for network-isolated managed containers.
 *
 * The runner may select an available provider/model and provide model context,
 * but it cannot supply a URL, credentials, headers, environment, or callbacks.
 * The authoritative host registry resolves both the model endpoint and auth.
 */
export class HostModelBroker {
  constructor(private readonly modelRegistry: ModelRegistry) {}

  createRequestHandler(): RuntimeRequestHandler {
    const active = new Map<string, AbortController>();
    const handler: RuntimeRequestHandler = async (request, transport) => {
      if (request.method === "host.models.list") {
        return { ok: true, models: this.modelRegistry.getAvailable().map(brokerModel) } satisfies BrokerModelCatalog;
      }
      if (request.method === "host.models.abort") {
        const targetId = String((request.params as Record<string, unknown> | undefined)?.requestId || "");
        active.get(targetId)?.abort();
        return { ok: true, requestId: targetId };
      }
      if (request.method !== "host.models.stream") throw new Error(`Host method is not allowed: ${request.method}`);

      const params = (request.params || {}) as BrokerStreamParams;
      const provider = String(params.provider || "").trim();
      const id = String(params.id || "").trim();
      if (!provider || !id) throw new Error("Model provider and id are required");
      const model = this.modelRegistry.find(provider, id);
      if (!model || !this.modelRegistry.hasConfiguredAuth(model)) throw new Error("Requested model is not available on the host");

      const auth = await this.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) throw new Error(auth.error);
      const controller = new AbortController();
      active.set(request.id, controller);
      try {
        const options = safeStreamOptions(params.options);
        const stream = streamSimple(model, asContext(params.context), {
          ...options,
          signal: controller.signal,
          apiKey: auth.apiKey,
          headers: auth.headers,
          env: auth.env,
        });
        for await (const event of stream) {
          transport.sendEvent("host.models.stream.event", { requestId: request.id, event: event satisfies AssistantMessageEvent });
        }
        return { ok: true };
      } finally {
        active.delete(request.id);
      }
    };
    handler.dispose = () => {
      for (const controller of active.values()) controller.abort();
      active.clear();
    };
    return handler;
  }
}
