import type { AppState } from "./types.js";

export type ApiHeaders = () => Record<string, string>;

export type ApiClient = {
  clientId: string;
  headers: ApiHeaders;
  wsUrl: () => URL;
};

export function createApiClient(state: AppState): ApiClient {
  const clientId = crypto.randomUUID?.() || `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    clientId,
    headers() {
      return {
        "content-type": "application/json",
        "x-pi-web-client-id": clientId,
        ...(state.currentRuntimeRef?.id ? { "x-pi-web-runtime-id": state.currentRuntimeRef.id } : {}),
        ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
      };
    },
    wsUrl() {
      const url = new URL("/ws", location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      if (state.token) url.searchParams.set("token", state.token);
      url.searchParams.set("clientId", clientId);
      if (state.currentSessionId) url.searchParams.set("sessionId", state.currentSessionId);
      if (state.currentRuntimeRef?.id && state.currentRuntimeRef.id !== "local") url.searchParams.set("runtimeId", state.currentRuntimeRef.id);
      if (state.lastRealtimeSeq > 0) url.searchParams.set("lastSeq", String(state.lastRealtimeSeq));
      return url;
    },
  };
}
