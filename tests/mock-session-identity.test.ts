import { expect, it, vi } from "vitest";
import { createMockHarness } from "../server/mock.js";

it("allocates distinct mock session identities even within the same clock tick", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(12345);
  try {
    const harness = createMockHarness({ piCwd: "/tmp", broadcast: () => {}, isCurrentSession: () => false, currentState: () => ({}) });
    const session = harness.createMockSession();
    session.sessionManager.newSession();
    const first = session.sessionId;
    session.sessionManager.newSession();
    expect(session.sessionId).toMatch(/^mock-/);
    expect(session.sessionId).not.toBe(first);
  } finally { clock.mockRestore(); }
});
