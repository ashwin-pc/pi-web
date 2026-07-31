import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSessionList } from "../src/sessions/sessionDrawer.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("session list request lifecycle", () => {
  it("aborts a hung request and allows the trailing retry to succeed", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const fetchMock = vi.fn()
      .mockImplementationOnce((_url, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessions: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const first = expect(fetchSessionList("/api/sessions", {}, 25)).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(25);
    await first;
    await expect(fetchSessionList("/api/sessions", {}, 25)).resolves.toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
