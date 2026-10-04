import { describe, expect, it, vi } from "vitest";
import type { SessionViewState } from "../src/app/types.js";
import { emptySessionCandidates as candidates, queueNewSession, reusableEmptySession as reusable } from "../src/sessions/newSession.js";

type State = Parameters<typeof reusable>[0];
const legacySelection = { harnessId: "pi", defaultHarnessId: "pi" };
const emptySessionCandidates = (state: State, cwd: string, draft: (id: string) => boolean, selection: Parameters<typeof candidates>[3] = legacySelection) => candidates(state, cwd, draft, selection);
const reusableEmptySession = (state: State, cwd: string, draft: (id: string) => boolean, selection = legacySelection) => reusable(state, cwd, draft, selection);
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
  it("filters active, pinned, cold hydration and post-open rechecks by selected harness", () => {
    const value = state({ ...empty("active"), harnessId: "codex" }, { ...empty("pi"), harnessId: "pi", stats: undefined }, { ...empty("other"), harnessId: "codex", stats: undefined });
    const selection = { harnessId: "pi", defaultHarnessId: "pi" };
    expect(reusableEmptySession(value, cwd, noDraft, selection)).toBeUndefined();
    expect(emptySessionCandidates(value, cwd, noDraft, { ...selection, hydrateActive: true }).map((session) => session.id)).toEqual(["pi"]);
    value.sessionsById.pi.stats = { totalMessages: 0 };
    expect(reusableEmptySession(value, cwd, noDraft, selection)?.id).toBe("pi");
    value.currentSessionId = "pi";
    value.sessionsById.pi.harnessId = "codex"; // authoritative recheck changed the candidate
    expect(reusableEmptySession(value, cwd, noDraft, selection)).toBeUndefined();
  });
  it("uses the declared default only for legacy records without harness identity", () => {
    const value = state(empty("legacy"));
    expect(reusableEmptySession(value, cwd, noDraft, { harnessId: "codex", defaultHarnessId: "pi" })).toBeUndefined();
    expect(reusableEmptySession(value, cwd, noDraft, { harnessId: "pi", defaultHarnessId: "pi" })?.id).toBe("legacy");
  });
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
