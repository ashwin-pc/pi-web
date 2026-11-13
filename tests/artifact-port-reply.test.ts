import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitPortReply } from "../src/extensions/artifactPortReply.js";
import { openRendererPort } from "../src/extensions/artifactStreamLifecycle.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("bounded port replies", () => {
  it.each(["preabort", "load-timeout", "send-throw"])("bounds iframe initialization: %s", async mode => {
    vi.useFakeTimers();
    const local = { onmessage: null, close: vi.fn() };
    const remote = { close: vi.fn() };
    vi.stubGlobal("MessageChannel", class { port1 = local; port2 = remote; });
    const frame = { onload: null as null | (() => void), contentWindow: { postMessage() { throw new Error("cannot transfer"); } } };
    const controller = new AbortController();
    if (mode === "preabort") controller.abort();
    const result = openRendererPort(frame as unknown as HTMLIFrameElement, 3, controller.signal);
    const assertion = expect(result).rejects.toThrow(mode === "preabort" ? "Cancelled" : mode === "send-throw" ? "cannot transfer" : "did not initialize");
    if (mode === "load-timeout") vi.advanceTimersByTime(15000);
    if (mode === "send-throw") frame.onload!();
    await assertion;
    expect(frame.onload).toBeNull();
    expect(local.onmessage).toBeNull();
    expect(local.close).toHaveBeenCalledOnce();
    expect(remote.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["success", "reject", "send", "abort", "preabort", "timeout"])("cleans up %s without closing the caller's port", async mode => {
    vi.useFakeTimers();
    const controller = new AbortController();
    if (mode === "preabort") controller.abort();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const port = { onmessage: null as any, close: vi.fn() };
    const cleanup = vi.fn();
    const start = vi.fn(() => {
      if (mode === "send") throw new Error("send failed");
      if (mode === "success" || mode === "reject") port.onmessage({ data: mode });
    });
    const result = awaitPortReply({
      port: port as unknown as MessagePort, signal: controller.signal,
      timeout: 10, timeoutMessage: "timed out", start, cleanup,
      accept: (data) => {
        if (data === "reject") throw new Error("bad reply");
        return { value: data };
      },
    });
    const assertion = mode === "success"
      ? expect(result).resolves.toBe("success")
      : expect(result).rejects.toThrow(mode === "send" ? "send failed" : mode === "reject" ? "bad reply" : mode === "timeout" ? "timed out" : "Cancelled");
    if (mode === "abort") controller.abort();
    if (mode === "timeout") vi.advanceTimersByTime(10);
    await assertion;
    expect(port.onmessage).toBeNull();
    expect(port.close).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    if (mode === "preabort") expect(start).not.toHaveBeenCalled();
  });
});
