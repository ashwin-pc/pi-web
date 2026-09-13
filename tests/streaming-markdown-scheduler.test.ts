import { describe, expect, it, vi } from "vitest";
import { createStreamingBatch } from "../src/markdown/streamingScheduler.js";

describe("streaming markdown scheduler", () => {
  it("coalesces queued prefixes and renders the newest value after the delay", () => {
    vi.useFakeTimers();
    const rendered: string[] = [];
    const batch = createStreamingBatch(75, (value: string) => rendered.push(value));

    batch.queue("first");
    batch.queue("second");
    vi.advanceTimersByTime(74);
    expect(rendered).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(rendered).toEqual(["second"]);
    vi.useRealTimers();
  });

  it("cancels pending work", () => {
    vi.useFakeTimers();
    const render = vi.fn();
    const batch = createStreamingBatch(75, render);
    batch.queue("discarded");
    batch.cancel();
    vi.runAllTimers();
    expect(render).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("flushes immediately with authoritative final content and cancels the timer", () => {
    vi.useFakeTimers();
    const rendered: string[] = [];
    const batch = createStreamingBatch(75, (value: string) => rendered.push(value));
    batch.queue("partial");
    batch.flush("final");
    expect(rendered).toEqual(["final"]);
    vi.runAllTimers();
    expect(rendered).toEqual(["final"]);
    vi.useRealTimers();
  });
});
