import { afterEach, describe, expect, it, vi } from "vitest";
import { playToolCardEntry, playToolCardStateTransition } from "../src/messages/entryAnimation.js";

function classList() {
  const values = new Set<string>();
  return {
    values,
    add: (...names: string[]) => names.forEach((name) => values.add(name)),
    remove: (...names: string[]) => names.forEach((name) => values.delete(name)),
    contains: (name: string) => values.has(name),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("tool card entry animation", () => {
  it("waits for two painted frames before starting the folio flip", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: false }),
      requestAnimationFrame: (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; },
    });
    const classes = classList();
    let animationEnd: (() => void) | undefined;
    const card = {
      classList: classes,
      isConnected: true,
      addEventListener: (_name: string, callback: () => void) => { animationEnd = callback; },
    } as unknown as HTMLElement;

    playToolCardEntry(card);
    expect(classes.contains("toolCard--folioPending")).toBe(true);
    expect(classes.contains("toolCard--folioEnter")).toBe(false);

    frames.shift()!(0);
    expect(classes.contains("toolCard--folioEnter")).toBe(false);
    frames.shift()!(16);
    expect(classes.contains("toolCard--folioPending")).toBe(false);
    expect(classes.contains("toolCard--folioEnter")).toBe(true);

    animationEnd?.();
    expect(classes.contains("toolCard--folioEnter")).toBe(false);
  });

  it("restarts the state-settle animation and removes its marker afterward", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    const classes = classList();
    classes.add("toolCard--stateChanging");
    let animationEnd: (() => void) | undefined;
    const header = { addEventListener: (_name: string, callback: () => void) => { animationEnd = callback; } };
    const card = {
      classList: classes,
      offsetWidth: 100,
      querySelector: () => header,
    } as unknown as HTMLElement;

    playToolCardStateTransition(card);
    expect(classes.contains("toolCard--stateChanging")).toBe(true);
    animationEnd?.();
    expect(classes.contains("toolCard--stateChanging")).toBe(false);
  });

  it("does not animate when reduced motion is requested", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    const classes = classList();
    const card = { classList: classes } as unknown as HTMLElement;

    playToolCardEntry(card);
    playToolCardStateTransition(card);
    expect(classes.values.size).toBe(0);
  });
});
