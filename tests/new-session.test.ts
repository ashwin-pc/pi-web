import { describe, expect, it, vi } from "vitest";
import type { SessionViewState } from "../src/app/types.js";
import { emptySessionCandidates, queueNewSession, reusableEmptySession } from "../src/sessions/newSession.js";

type State = Parameters<typeof reusableEmptySession>[0];
const cwd = "/repo";
function empty(id: string): SessionViewState {
  return { id, cwd, stats: { totalMessages: 0 } };
}
function state(...sessions: SessionViewState[]): State {
  return {
    currentSessionId: sessions[0].id,
    sessionsById: Object.fromEntries(sessions.map((session) => [session.id, session])),
    lanes: sessions.slice(1).map(({ id }) => ({ sessionId: id, lane: "pinned", since: "2026-01-01T00:00:00Z" })),
    sessionOrigins: [],
  };
}
const noDraft = () => false;

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe("new-session creation queue", () => {
  it("shares one in-flight request across entrypoints in the same folder", async () => {
    const pending = gate();
    const start = vi.fn(() => pending.promise);
    const run = queueNewSession(() => cwd, start);
    const first = run();
    expect(run(cwd)).toBe(first);
    expect(run()).toBe(first);
    expect(start).toHaveBeenCalledTimes(1);
    pending.release();
    await first;
    await run();
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("queues a different folder instead of dropping the user's request", async () => {
    const pending = gate();
    const start = vi.fn((path?: string) => path === "/other" ? Promise.resolve() : pending.promise);
    const run = queueNewSession(() => cwd, start);
    const first = run();
    const second = run("/other");
    expect(start).toHaveBeenCalledTimes(1);
    pending.release();
    await Promise.all([first, second]);
    expect(start.mock.calls).toEqual([[undefined], ["/other"]]);
  });

  it("releases a failed operation and still processes the queued folder", async () => {
    const start = vi.fn((path?: string) => path === "/other" ? Promise.resolve() : Promise.reject(new Error("offline")));
    const run = queueNewSession(() => cwd, start);
    const first = run();
    const second = run("/other");
    await expect(first).rejects.toThrow("offline");
    await second;
    expect(start.mock.calls).toEqual([[undefined], ["/other"]]);
  });
});

describe("empty new-session reuse", () => {
  it("prefers the active empty tab, even after an explicit unpin", () => {
    expect(reusableEmptySession(state(empty("active"), empty("other")), cwd, noDraft)?.id).toBe("active");
  });

  it("reuses an inactive pinned blank tab instead of making another", () => {
    const current = { ...empty("active"), stats: { totalMessages: 2 } };
    expect(reusableEmptySession(state(current, empty("other")), cwd, noDraft)?.id).toBe("other");
  });

  it("does not reuse a draft or a different workspace", () => {
    expect(reusableEmptySession(state(empty("active")), cwd, () => true)).toBeUndefined();
    expect(reusableEmptySession(state(empty("active")), "/other", noDraft)).toBeUndefined();
  });

  it.each([
    { stats: undefined },
    { stats: { totalMessages: 1 } },
    { messageCount: 1 },
    { name: "Intentional blank" },
    { firstMessage: "Work" },
    { queue: { steering: ["Work"], followUp: [] } },
  ])("does not treat content, named sessions, or unknown history as empty: %j", (patch) => {
    expect(reusableEmptySession(state({ ...empty("active"), ...patch }), cwd, noDraft)).toBeUndefined();
  });

  it("keeps cold pinned candidates for authoritative validation without assuming they are empty", () => {
    const value = state({ ...empty("active"), stats: { totalMessages: 2 } }, { id: "cold", cwd });
    expect(emptySessionCandidates(value, cwd, noDraft).map(({ id }) => id)).toEqual(["cold"]);
    expect(reusableEmptySession(value, cwd, noDraft)).toBeUndefined();
    value.sessionsById.cold.stats = { totalMessages: 0 };
    expect(reusableEmptySession(value, cwd, noDraft)?.id).toBe("cold");
  });

  it("reuses a metadata-only snapshot when its refreshed conversational count is zero", () => {
    expect(reusableEmptySession(state({
      id: "active",
      cwd,
      stats: { totalMessages: 2, conversationMessages: 0 },
    }), cwd, noDraft)?.id).toBe("active");
  });

  it.each([
    { messageCount: 0, stats: { totalMessages: 3, conversationMessages: 1 } },
    { messageCount: 1, stats: { totalMessages: 2, conversationMessages: 0 } },
    { messageCount: 1, stats: { totalMessages: 1, conversationMessages: 1 } },
    { firstMessage: "Custom extension report", stats: { totalMessages: 1, conversationMessages: 0 } },
  ])("does not reuse a positive conversational count or visible content: %j", (patch) => {
    expect(reusableEmptySession(state({ ...empty("active"), ...patch }), cwd, noDraft)).toBeUndefined();
  });

  it("can use an exact empty list count without a loaded transcript", () => {
    expect(reusableEmptySession(state({ id: "active", cwd, messageCount: 0 }), cwd, noDraft)?.id).toBe("active");
  });

  it.each(["isRunning", "isStreaming", "isRetrying", "isCompacting", "pendingMessageCount"] as const)("excludes busy tabs (%s)", (flag) => {
    const runtime = { loaded: true, isRunning: false, isStreaming: false, isRetrying: false, isCompacting: false, pendingMessageCount: 0, [flag]: flag === "pendingMessageCount" ? 1 : true };
    expect(reusableEmptySession(state({ ...empty("active"), runtime }), cwd, noDraft)).toBeUndefined();
  });

  it("excludes spawned workers and intentionally parked/bookmarked tabs", () => {
    const value = state(empty("worker"));
    value.sessionOrigins = [{ sessionId: "worker", originSessionId: "parent", kind: "spawn", updatedAt: "2026-01-01T00:00:00Z" }];
    expect(reusableEmptySession(value, cwd, noDraft)).toBeUndefined();
    value.sessionOrigins = [];
    for (const lane of ["parked", "bookmarks"] as const) {
      value.lanes = [{ sessionId: "worker", lane, since: "2026-01-01T00:00:00Z" }];
      expect(reusableEmptySession(value, cwd, noDraft)).toBeUndefined();
    }
  });
});
