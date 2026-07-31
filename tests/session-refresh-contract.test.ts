import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { shouldRefreshSessionsForPiEvent } from "../src/realtime/realtime.js";

describe("session refresh fanout contract", () => {
  it("refreshes only for persisted messages, not terminal or metadata events", () => {
    expect(shouldRefreshSessionsForPiEvent({ type: "message_end" } as any)).toBe(true);
    for (const type of ["agent_end", "compaction_end", "session_info_changed"]) {
      expect(shouldRefreshSessionsForPiEvent({ type } as any)).toBe(false);
    }
  });

  it("coalesces a turn and patches rename/delete without snapshots", async () => {
    const source = await readFile(new URL("../src/realtime/realtime.ts", import.meta.url), "utf8");
    expect(source).toContain("if (sessionRefreshTimer !== undefined) return;");
    expect(source).toContain("if (sessionRefreshInFlight) {\n      sessionRefreshQueued = true;");
    expect(source).toContain("sessions.removeSession(String(data.sessionId || \"\"))");
    expect(source).toContain("sessions.updateSessionName(String(data.sessionId || \"\"), String(data.event.name || \"\"))");
    expect(source).not.toMatch(/session_deleted[\s\S]{0,100}scheduleSessionRefresh/);
  });
});
