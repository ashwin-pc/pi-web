import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { stopChildProcess } from "../server/supervisorLifecycle.js";

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kills: NodeJS.Signals[] = [];
  kill(signal: NodeJS.Signals): boolean {
    this.kills.push(signal);
    return true;
  }
  exit(): void {
    this.exitCode = 0;
    this.emit("exit", 0, null);
  }
}

describe("stopChildProcess", () => {
  it("waits for actual exit even after SIGKILL is requested", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      let settled = false;
      const stopping = stopChildProcess(child as never, 50).then(() => { settled = true; });
      expect(child.kills).toEqual(["SIGTERM"]);
      await vi.advanceTimersByTimeAsync(50);
      expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
      expect(settled).toBe(false);
      child.exit();
      await stopping;
      expect(settled).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles immediately for an already-exited child", async () => {
    const child = new FakeChild();
    child.exitCode = 0;
    await expect(stopChildProcess(child as never)).resolves.toBeUndefined();
    expect(child.kills).toEqual([]);
  });

  it("rechecks exit state after registering the listener", async () => {
    const child = new FakeChild();
    const once = child.once.bind(child);
    child.once = ((event: string, listener: (...args: unknown[]) => void) => {
      once(event, listener as never);
      child.exitCode = 0;
      return child;
    }) as typeof child.once;
    await expect(stopChildProcess(child as never)).resolves.toBeUndefined();
    expect(child.kills).toEqual([]);
  });

  it("cleans up and rejects when a kill request throws", async () => {
    const child = new FakeChild();
    child.kill = () => { throw new Error("kill failed"); };
    await expect(stopChildProcess(child as never, 50)).rejects.toThrow("kill failed");
    expect(child.listenerCount("exit")).toBe(0);
  });
});
