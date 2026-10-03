import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/app/api.js";
import type { AppState } from "../src/app/types.js";

afterEach(() => vi.unstubAllGlobals());

describe("API viewer sequencing", () => {
  it("shares increasing sequences across HTTP and reconnect URLs without exposing credentials", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: { headers: Record<string, string> }) => ({ ok: true, json: async () => ({ ticket: "one-use-ticket" }) }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("location", { href: "https://example.test/", protocol: "https:" });
    const state = { token: "secret-token", currentSessionId: "A", lastRealtimeSeq: 7 } as AppState;
    const client = createApiClient(state);
    const bootHeaders = fetchMock.mock.calls[0]?.[1]?.headers;
    const first = client.headers();
    const second = client.headers();
    expect(first["x-pi-web-client-id"]).toBe(client.clientId);
    expect(first.authorization).toBe("Bearer secret-token");
    expect(Number(second["x-pi-web-viewer-seq"])).toBe(Number(first["x-pi-web-viewer-seq"]) + 1);
    expect(Number(first["x-pi-web-viewer-seq"])).toBe(Number(bootHeaders?.["x-pi-web-viewer-seq"]) + 1);
    state.currentSessionId = "B";
    const url = await client.wsUrl();
    expect(url.searchParams.get("sessionId")).toBe("B");
    expect(url.searchParams.get("viewerSeq")).toBe(String(Number(second["x-pi-web-viewer-seq"]) + 1));
    expect(url.searchParams.get("clientId")).toBe(client.clientId);
    expect(url.searchParams.get("lastSeq")).toBe("7");
    expect(url.toString()).not.toContain("secret-token");
    const reconnect = await client.wsUrl();
    expect(Number(reconnect.searchParams.get("viewerSeq"))).toBeGreaterThan(Number(url.searchParams.get("viewerSeq")));
    expect(reconnect.searchParams.get("clientId")).toBe(client.clientId);
    expect(Number(client.headers()["x-pi-web-viewer-seq"])).toBeGreaterThan(Number(reconnect.searchParams.get("viewerSeq")));
  });
});
