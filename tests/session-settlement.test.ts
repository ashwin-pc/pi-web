import { describe, expect, it, vi } from "vitest";
import {
  SessionSettlementTracker,
  type SessionSettlementEvent,
  type SessionSettlementRuntime,
} from "../server/session/settlement.js";

function fixture(initial: Record<string, Partial<SessionSettlementRuntime> | undefined>) {
  const runtimes = new Map<string, SessionSettlementRuntime | undefined>();
  for (const [id, value] of Object.entries(initial)) {
    runtimes.set(id, value && {
      sessionId: value.sessionId || id,
      isRunning: Boolean(value.isRunning),
      pendingMessageCount: Number(value.pendingMessageCount || 0),
    });
  }
  const emitted: SessionSettlementEvent[] = [];
  const loadRuntime = vi.fn(async (id: string) => runtimes.get(id));
  const tracker = new SessionSettlementTracker(loadRuntime, (event) => emitted.push(event));
  return { tracker, runtimes, emitted, loadRuntime };
}

async function drain(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("SessionSettlementTracker", () => {
  it("derives idle, running, queued, and unavailable leaf states", async () => {
    const { tracker } = fixture({
      idle: {},
      running: { isRunning: true },
      queued: { pendingMessageCount: 1 },
      missing: undefined,
    });

    await expect(tracker.status("idle")).resolves.toMatchObject({ state: "idle", settled: true });
    await expect(tracker.status("running")).resolves.toMatchObject({ state: "running", settled: false });
    await expect(tracker.status("queued")).resolves.toMatchObject({ state: "running", settled: false });
    await expect(tracker.status("missing")).resolves.toEqual({
      sessionId: "missing",
      state: "unavailable",
      trackedWorkers: [],
      pendingWakeups: 0,
      settled: false,
    });
  });

  it("replaces and deduplicates direct dependencies", async () => {
    const { tracker } = fixture({ parent: {}, a: { isRunning: true }, b: { isRunning: true } });
    tracker.report("parent", ["a", "a", "", "parent"]);
    expect(await tracker.status("parent")).toMatchObject({
      trackedWorkers: [{ id: "a", state: "running", settled: false }],
      pendingWakeups: 0,
      settled: false,
    });

    tracker.report("parent", ["b", "b"]);
    expect(await tracker.status("parent")).toMatchObject({
      trackedWorkers: [{ id: "b", state: "running", settled: false }],
    });
  });

  it("counts direct settled children as pending wakeups", async () => {
    const { tracker } = fixture({ parent: {}, done: {}, active: { isRunning: true } });
    tracker.report("parent", ["done", "active"]);

    expect(await tracker.status("parent")).toEqual({
      sessionId: "parent",
      state: "idle",
      trackedWorkers: [
        { id: "done", state: "idle", settled: true },
        { id: "active", state: "running", settled: false },
      ],
      pendingWakeups: 1,
      settled: false,
    });
  });

  it("evaluates tracked workers recursively", async () => {
    const { tracker } = fixture({ parent: {}, child: {}, grandchild: { isRunning: true } });
    tracker.report("parent", ["child"]);
    tracker.report("child", ["grandchild"]);

    expect(await tracker.status("parent")).toMatchObject({
      trackedWorkers: [{ id: "child", state: "idle", settled: false }],
      pendingWakeups: 0,
      settled: false,
    });
  });

  it("marks cyclic dependency evaluation unavailable instead of recursing", async () => {
    const { tracker, loadRuntime } = fixture({ a: {}, b: {} });
    tracker.report("a", ["b"]);
    tracker.report("b", ["a"]);

    expect(await tracker.status("a")).toMatchObject({
      state: "unavailable",
      trackedWorkers: [{ id: "b", state: "unavailable", settled: false }],
      settled: false,
    });
    expect(loadRuntime.mock.calls.length).toBeLessThan(20);
  });

  it("does not emit when a session is first observed settled", async () => {
    const { tracker, emitted } = fixture({ leaf: {} });

    expect((await tracker.status("leaf")).settled).toBe(true);
    await drain();
    expect(emitted).toEqual([]);
  });

  it("emits exactly once for a cached false-to-true runtime transition", async () => {
    const { tracker, runtimes, emitted } = fixture({ leaf: { isRunning: true } });
    await tracker.status("leaf");

    runtimes.set("leaf", { sessionId: "leaf", isRunning: false, pendingMessageCount: 0 });
    tracker.noteRuntimeChanged("leaf");
    tracker.noteRuntimeChanged("leaf");
    await drain();

    expect(emitted).toEqual([{
      type: "session-settled",
      sessionId: "leaf",
      status: {
        sessionId: "leaf",
        state: "idle",
        trackedWorkers: [],
        pendingWakeups: 0,
        settled: true,
      },
    }]);
  });

  it("propagates child runtime invalidation to transitive ancestors", async () => {
    const { tracker, runtimes, emitted } = fixture({ parent: {}, child: { isRunning: true } });
    tracker.report("parent", ["child"]);
    await tracker.status("parent");
    emitted.length = 0;

    runtimes.set("child", { sessionId: "child", isRunning: false, pendingMessageCount: 0 });
    tracker.noteRuntimeChanged("child");
    await drain();

    expect(emitted.map((event) => event.sessionId)).toEqual(["child"]);
    expect(await tracker.status("parent")).toMatchObject({ pendingWakeups: 1, settled: false });
  });

  it("emits for the parent after its final dependency is replaced away", async () => {
    const { tracker, emitted } = fixture({ parent: {}, child: { isRunning: true } });
    tracker.report("parent", ["child"]);
    await tracker.status("parent");
    emitted.length = 0;

    tracker.report("parent", []);
    await drain();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "session-settled",
      sessionId: "parent",
      status: { settled: true, trackedWorkers: [] },
    });
  });

  it("clear removes outbound dependencies but preserves incoming obligations", async () => {
    const { tracker } = fixture({ parent: {}, child: {}, grandchild: { isRunning: true } });
    tracker.report("parent", ["child"]);
    tracker.report("child", ["grandchild"]);
    await tracker.status("parent");

    tracker.clear("child");
    expect(await tracker.status("child")).toMatchObject({ trackedWorkers: [] });
    expect(await tracker.status("parent")).toMatchObject({
      trackedWorkers: [{ id: "child", state: "idle", settled: true }],
      pendingWakeups: 1,
      settled: false,
    });
  });

  it("emits again after a later true-to-false-to-true cycle", async () => {
    const { tracker, runtimes, emitted } = fixture({ leaf: { isRunning: true } });
    await tracker.status("leaf");
    runtimes.set("leaf", { sessionId: "leaf", isRunning: false, pendingMessageCount: 0 });
    tracker.noteRuntimeChanged("leaf");
    await drain();

    runtimes.set("leaf", { sessionId: "leaf", isRunning: true, pendingMessageCount: 0 });
    tracker.noteRuntimeChanged("leaf");
    await drain();
    runtimes.set("leaf", { sessionId: "leaf", isRunning: false, pendingMessageCount: 0 });
    tracker.noteRuntimeChanged("leaf");
    await drain();

    expect(emitted.map((event) => event.sessionId)).toEqual(["leaf", "leaf"]);
  });
});
