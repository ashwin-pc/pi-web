import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiWebSessionTool, normalizePiWebMessages, normalizePiWebSessionState } from "../.pi/extensions/pi-web-session.js";

const originalEnv = { ...process.env };

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
});

describe("pi_web_session bundled tool", () => {
  it("normalizes and truncates message output without raw payloads", () => {
    const result = normalizePiWebMessages({
      messages: [
        { role: "user", text: "first", raw: { secret: true } },
        { role: "assistant", text: "second" },
        { role: "toolResult", toolName: "bash", text: "x".repeat(250) },
      ],
    }, { tail: 2, maxTextChars: 200 });

    expect(result.count).toBe(3);
    expect(result.returned).toBe(2);
    expect(result.messages.map((message) => message.role)).toEqual(["assistant", "toolResult"]);
    expect(result.messages[1].text).toContain("truncated");
    expect(result.messages[0]).not.toHaveProperty("raw");
  });

  it("summarizes running state across top-level and runtime flags", () => {
    expect(normalizePiWebSessionState({ ok: true, runtime: { isRunning: true } }).isRunning).toBe(true);
    expect(normalizePiWebSessionState({ ok: true, isStreaming: true }).isRunning).toBe(true);
    expect(normalizePiWebSessionState({ ok: true }).isRunning).toBe(false);
  });

  it("sends prompts through pi-web API with auth and follow-up mode by default", async () => {
    process.env.PORT = "9999";
    process.env.PI_WEB_TOKEN = "secret";
    delete process.env.PI_WEB_BASE_URL;
    delete process.env.PI_WEB_INTERNAL_BASE_URL;

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, sessionId: "s1" }), {
      status: 202,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const tool = createPiWebSessionTool();
    const result = await tool.execute("call-1", { action: "prompt", sessionId: "s1", message: "please continue" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:9999/api/prompt");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret");
    expect(JSON.parse(String(init.body))).toEqual({ sessionId: "s1", message: "please continue", mode: "followUp" });
    expect(result.details).toMatchObject({ ok: true, action: "prompt", mode: "followUp", sessionId: "s1" });
  });
});
