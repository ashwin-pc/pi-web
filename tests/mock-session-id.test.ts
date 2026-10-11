import { describe, expect, it, vi } from "vitest";
import { createMockHarness } from "../server/mock.js";

describe("mock session identifiers", () => {
  it("allocates unique IDs for synchronous replacements in the same millisecond", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const harness = createMockHarness({ piCwd: "/tmp/mock-id-fixture", broadcast: () => {}, isCurrentSession: () => false, currentState: () => ({}) });
      const session = harness.createMockSession();
      const ids: string[] = [];
      for (let i = 0; i < 20; i++) {
        session.sessionManager.newSession();
        ids.push(session.sessionId);
      }
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(/^mock-[0-9a-f-]{36}$/);
    } finally { clock.mockRestore(); }
  });
});
