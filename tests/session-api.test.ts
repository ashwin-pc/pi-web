import { describe, expect, it } from "vitest";
import {
  serializeSessionTransport,
  type ArtifactBase64DTO,
  type JsonValue,
  type ServiceResult,
  type SessionServiceEvent,
  type SessionStateFactDTO,
} from "../server/session/api.js";

function jsonRoundTrip<T extends JsonValue>(value: T): T {
  return serializeSessionTransport(value);
}

describe("SessionService transport contract", () => {
  it("round-trips representative method results without host filesystem paths", () => {
    const artifact: ArtifactBase64DTO = {
      name: "report.png",
      mimeType: "image/png",
      base64: "cG5n",
    };
    const result: ServiceResult<ArtifactBase64DTO> = { ok: true, value: artifact };

    expect(jsonRoundTrip(result as unknown as JsonValue)).toEqual({ ok: true, value: artifact });
    expect("file" in artifact).toBe(false);
    expect("path" in artifact).toBe(false);
  });

  it("round-trips raw box facts without browser activity decoration", () => {
    const state: SessionStateFactDTO = {
      cwd: "/workspace",
      sessionFile: "/workspace/.pi/sessions/session.jsonl",
      sessionId: "session-1",
      sessionName: null,
      sessionTitle: "Session",
      isStreaming: true,
      isRetrying: false,
      isCompacting: false,
      runtime: {
        loaded: true,
        isRunning: true,
        isStreaming: true,
        isRetrying: false,
        isCompacting: false,
        pendingMessageCount: 0,
        model: null,
      },
      model: null,
      thinkingLevel: "medium",
      stats: {
        userMessages: 1,
        assistantMessages: 0,
        toolResults: 0,
        totalMessages: 1,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
        contextUsage: null,
      },
      webFooters: [],
      webHeaderActions: [],
      webGitTabs: [],
    };
    const event: SessionServiceEvent = {
      type: "models_updated",
      sessionId: "session-1",
      models: [{
        provider: "example",
        id: "model-1",
        name: "Model 1",
        reasoning: true,
        contextWindow: 128000,
        maxTokens: 8192,
        metadata: { vendorMetadata: { tier: "preview" } },
      }],
    };

    expect(jsonRoundTrip({ state, event })).toEqual({ state, event });
    expect("runtimeStartedAt" in state).toBe(false);
    expect("runtimeLastActivityAt" in state).toBe(false);
    expect("startedAt" in state.runtime).toBe(false);
    expect("lastActivityAt" in state.runtime).toBe(false);
  });

  it("rejects explicit undefined instead of silently dropping it during JSON serialization", () => {
    expect(() => serializeSessionTransport({ value: undefined } as unknown as JsonValue)).toThrow("undefined");
  });
});
