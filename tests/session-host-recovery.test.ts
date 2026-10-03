import { describe, expect, it } from "vitest";
import { decorateHostSessionState } from "../server/session/hostEvents.js";
import type { SessionActivity } from "../server/session/activity.js";
import type { BaseSessionStateDto } from "../server/session/dto.js";
import type { PiWebSession } from "../server/types.js";

describe("host recovery state decoration", () => {
  it("retains queued work and host lease runtime for a non-streaming background source", () => {
    const runtime = { loaded: true, isRunning: true, isStreaming: false, isRetrying: false, isCompacting: false, pendingMessageCount: 3 };
    const activity = {
      runtimeForPath: () => runtime,
      startedAtForPath: () => "2026-01-01T00:00:00.000Z",
      lastActivityAtForPath: () => "2026-01-01T00:00:01.000Z",
    } as unknown as SessionActivity;
    const base = { sessionId: "background", isStreaming: false, isRetrying: false, isCompacting: false, thinkingLevels: [] } as unknown as BaseSessionStateDto;
    const session = { sessionFile: "/background.jsonl" } as PiWebSession;
    const recovered = decorateHostSessionState(base, session, activity, () => ({ webContributions: [] }));
    expect(recovered.runtime).toEqual(runtime);
    expect(recovered.runtimeStartedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(recovered.runtimeLastActivityAt).toBe("2026-01-01T00:00:01.000Z");
    expect(recovered.isStreaming).toBe(false);
  });
});
