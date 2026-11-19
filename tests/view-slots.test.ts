import { describe, expect, it, vi } from "vitest";
import { createSlotRegistry, SlotError } from "../src/views/slots.js";
import { viewIdFromPath, viewHref } from "../src/views/rootView.js";

describe("slot registry", () => {
  it("lets one host claim a slot, and rejects a second declaration until the first is disposed", () => {
    const slots = createSlotRegistry();
    const host = slots.declare<string, "single">("root-view", "single");
    expect(slots.isDeclared("root-view")).toBe(true);
    expect(slots.kindOf("root-view")).toBe("single");
    expect(() => slots.declare("root-view", "single")).toThrow(SlotError);
    expect(() => slots.declare("root-view", "list")).toThrow(/already declared/);
    host.dispose();
    expect(slots.isDeclared("root-view")).toBe(false);
    expect(() => slots.declare("root-view", "single").dispose()).not.toThrow();
  });

  it("single: the latest registration renders, and disposing it reveals the previous one", () => {
    const slots = createSlotRegistry();
    const early = slots.register("root-view", "early"); // before the host declares
    const host = slots.declare<string, "single">("root-view", "single");
    expect(host.getSnapshot()).toBe("early");
    const listener = vi.fn();
    const unsubscribe = host.subscribe(listener);
    const late = slots.register("root-view", "late");
    expect(host.getSnapshot()).toBe("late");
    late();
    late(); // idempotent
    expect(host.getSnapshot()).toBe("early");
    early();
    expect(host.getSnapshot()).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
    slots.register("root-view", "after");
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("list and chain keep registration order; keyed keeps the latest per key and needs a key", () => {
    const slots = createSlotRegistry();
    const list = slots.declare<number, "list">("footer", "list");
    const chain = slots.declare<number, "chain">("prompt-middleware", "chain");
    const keyed = slots.declare<string, "keyed">("panels", "keyed");
    slots.register("footer", 1); const two = slots.register("footer", 2); slots.register("footer", 3);
    two();
    expect(list.getSnapshot()).toEqual([1, 3]);
    slots.register("prompt-middleware", 10); slots.register("prompt-middleware", 20);
    expect(chain.getSnapshot()).toEqual([10, 20]);
    slots.register("panels", "git v1", { key: "git" });
    const v2 = slots.register("panels", "git v2", { key: "git" });
    slots.register("panels", "files", { key: "files" });
    expect([...keyed.getSnapshot()]).toEqual([["git", "git v2"], ["files", "files"]]);
    v2();
    expect(keyed.getSnapshot().get("git")).toBe("git v1");
    expect(() => slots.register("panels", "no key")).toThrow(/keyed/);
  });

  it("keeps registrations when a host goes away, for the next host", () => {
    const slots = createSlotRegistry();
    slots.register("root-view", "view");
    slots.declare("root-view", "single").dispose();
    expect(slots.declare<string, "single">("root-view", "single").getSnapshot()).toBe("view");
  });
});

describe("root view routes", () => {
  it("parses /view/<id> and builds its href", () => {
    expect(viewIdFromPath("/view/vr")).toBe("vr");
    expect(viewIdFromPath("/view/VR/")).toBe("vr");
    expect(viewIdFromPath("/view/")).toBeUndefined();
    expect(viewIdFromPath("/view/vr/extra")).toBeUndefined();
    expect(viewIdFromPath("/")).toBeUndefined();
    expect(viewHref("vr", "?sessionId=a")).toBe("/view/vr?sessionId=a");
  });
});
