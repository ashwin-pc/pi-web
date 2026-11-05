import { afterEach, describe, expect, it, vi } from "vitest";
import { createStatusBar } from "../src/status/statusBar.js";
import type { Toast } from "../src/components/toasts.js";
import type { AppState } from "../src/app/types.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup() {
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  const state = { currentSessionId: "one", initialSyncComplete: true, wsDisconnected: false, wsHasOpened: true } as AppState;
  const notices = new Map<string, Toast>();
  const list = deferred();
  const snapshot = deferred();
  const refreshSessions = vi.fn(() => list.promise);
  const refreshState = vi.fn(() => snapshot.promise);
  const status = createStatusBar({ state, elements: {}, api: {}, sessionState: {}, addMessage() {},
    refreshSessions, refreshState,
    toasts: { show: toast => { notices.set(toast.id, toast); }, dismiss: id => { notices.delete(id); }, has: id => notices.has(id), clear: () => notices.clear() },
  } as Parameters<typeof createStatusBar>[0]);
  status.markSyncRequired();
  const sync = () => notices.get("connection")!.actions!.find(action => action.label === "Sync only")!.run();
  return { state, status, notices, list, snapshot, sync, refreshSessions, refreshState };
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("recovery sync ownership", () => {
  it.each(["missed updates", "disconnect", "session switch"])("does not clear a notice after %s supersedes an in-flight sync", async change => {
    vi.useFakeTimers();
    const t = setup();
    const pending = t.sync();
    if (change === "missed updates") t.status.markSyncRequired();
    else if (change === "disconnect") { t.status.markWebSocketClosed(); t.status.markWebSocketOpen(); }
    else t.state.currentSessionId = "two";
    t.list.resolve(); t.snapshot.resolve();
    await pending;
    expect(t.notices.get("connection")?.persistent).toBe(true);
  });

  it("shares in-flight sync and waits for all work after an early failure", async () => {
    const t = setup();
    const first = t.sync() as Promise<void>;
    const rejected = expect(first).rejects.toThrow("List unavailable");
    t.list.reject(new Error("List unavailable"));
    await Promise.resolve(); await Promise.resolve();
    const second = t.sync();
    const secondSettled = Promise.resolve(second).catch(() => {});
    const shared = second === first;
    t.snapshot.resolve();
    await rejected;
    await secondSettled;
    expect(shared).toBe(true);
    expect(t.refreshState).toHaveBeenCalledTimes(1);
    expect(t.notices.has("connection")).toBe(true);
  });

  it("clears recovery only after a successful current-session sync", async () => {
    const t = setup();
    const pending = t.sync();
    t.list.resolve(); t.snapshot.resolve();
    await pending;
    expect(t.notices.has("connection")).toBe(false);
  });
});
