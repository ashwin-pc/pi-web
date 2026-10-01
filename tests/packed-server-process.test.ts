import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { stopPackedServer } from "../scripts/packed-server-process.mjs";

describe("packed server process cleanup", () => {
  it("waits for pre-attached close even when exitCode was already set", async () => {
    const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null, kill: vi.fn() });
    // Like the smoke script, register immediately after spawn, before exit.
    const closed = new Promise(resolve => child.once("close", resolve));
    child.exitCode = 0;
    let finished = false;
    const cleanup = stopPackedServer(child, closed).then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
    child.emit("close", 0);
    await cleanup;
    expect(finished).toBe(true);
  });

  it("terminates a running child and still awaits close", async () => {
    const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: vi.fn() });
    const closed = new Promise(resolve => child.once("close", resolve));
    let finished = false;
    const cleanup = stopPackedServer(child, closed).then(() => { finished = true; });
    expect(child.kill).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(finished).toBe(false);
    child.emit("close", 0);
    await cleanup;
    expect(finished).toBe(true);
  });
});
