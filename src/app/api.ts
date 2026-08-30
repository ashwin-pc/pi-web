import type { AppState } from "./types.js";

export type ApiHeaders = () => Record<string, string>;

export type ApiClient = {
  clientId: string;
  headers: ApiHeaders;
  wsUrl: () => Promise<URL>;
};

export function createApiClient(state: AppState): ApiClient {
  const clientId = crypto.randomUUID?.() || `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    clientId,
    headers() {
      return {
        "content-type": "application/json",
        "x-pi-web-client-id": clientId,
        ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
      };
    },
    async wsUrl() {
      const response = await fetch("/api/ws-ticket", { method: "POST", headers: this.headers(), credentials: "same-origin" });
      if (!response.ok) throw new Error(`WebSocket ticket failed (${response.status})`);
      const { ticket } = await response.json() as { ticket: string };
      const url = new URL("/ws", location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("ticket", ticket);
      url.searchParams.set("clientId", clientId);
      if (state.currentSessionId) url.searchParams.set("sessionId", state.currentSessionId);
      if (state.lastRealtimeSeq > 0) url.searchParams.set("lastSeq", String(state.lastRealtimeSeq));
      return url;
    },
  };
}
