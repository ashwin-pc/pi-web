import { afterEach, describe, expect, it, vi } from "vitest";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("completion alerts", () => {
  it("persists device preferences and vibrates by default", async () => {
    const vibrate = vi.fn();
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("navigator", { vibrate });
    vi.stubGlobal("window", {});
    const alerts = await import("../src/app/completionAlerts.js");

    expect(alerts.completionSoundEnabled()).toBe(false);
    expect(alerts.completionVibrationEnabled()).toBe(true);
    alerts.playCompletionAlerts();
    expect(vibrate).toHaveBeenCalledWith([180, 90, 240]);

    alerts.setCompletionVibrationEnabled(false);
    expect(alerts.completionVibrationEnabled()).toBe(false);
    alerts.playCompletionAlerts();
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  it("unlocks audio on opt-in and plays a two-note completion chime", async () => {
    const start = vi.fn();
    const stop = vi.fn();
    const connect = vi.fn();
    const resume = vi.fn(async () => undefined);
    const createOscillator = vi.fn(() => ({ type: "sine", frequency: { value: 0 }, connect, start, stop }));
    class MockAudioContext {
      state = "running";
      currentTime = 1;
      resume = resume;
      destination = {};
      createGain = () => ({ gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect });
      createOscillator = createOscillator;
    }
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("navigator", { vibrate: vi.fn() });
    vi.stubGlobal("window", { AudioContext: MockAudioContext });
    const alerts = await import("../src/app/completionAlerts.js");

    await alerts.setCompletionSoundEnabled(true);
    alerts.playCompletionAlerts();

    expect(resume).toHaveBeenCalledOnce();
    expect(createOscillator).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledTimes(2);
  });
});
