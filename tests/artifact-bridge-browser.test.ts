import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountArtifactBridge, receiveArtifactBridgeEvent, setArtifactBridgeSocket } from "../src/extensions/artifactBridge.js";
import { mountArtifactStream } from "../src/extensions/artifactStream.js";

class Element extends EventTarget {
  children: Element[] = []; textContent = ""; hidden = false; style = {}; dataset = {}; isConnected = true;
  parent?: Element;
  onload: (() => void) | null = null;
  contentWindow = { postMessage: vi.fn() };
  setAttribute() {}
  append(...children: Element[]) { for (const child of children) { this.children.push(child); child.parent = this; } }
  replaceChildren(...children: Element[]) { this.children = []; this.append(...children); }
  contains(child: Element): boolean { return this.children.includes(child) || this.children.some(item => item.contains(child)); }
  remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
}
class Port {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  postMessage = vi.fn(); start = vi.fn(); close = vi.fn();
  receive(data: unknown) { this.onmessage?.({ data }); }
}
let mutate: () => void;
let observed: number, disconnected: number;
let ports: Port[], operations: Record<string, unknown>[];
const disposers: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers(); observed = 0; disconnected = 0; ports = []; operations = [];
  vi.stubGlobal("document", { documentElement: new Element(), createElement: () => new Element() });
  vi.stubGlobal("location", { origin: "https://preview.test" });
  vi.stubGlobal("MutationObserver", class {
    constructor(callback: () => void) { mutate = callback; observed++; }
    observe() {}
    disconnect() { disconnected++; }
  });
  vi.stubGlobal("MessageChannel", class { port1 = new Port(); port2 = new Port(); constructor() { ports.push(this.port1); } });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url === "/api/web-contributions/invoke") {
      const body = JSON.parse(String(init.body)); operations.push(body.preview);
      return { ok: true, json: async () => ({ ok: true, preview: body.preview.preview }) };
    }
    return { ok: true, status: 206, headers: new Headers({ "content-range": "bytes 0-0/5" }), body: { cancel: async () => {} } };
  }));
  setArtifactBridgeSocket("socket");
});
afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  setArtifactBridgeSocket(undefined);
  await vi.advanceTimersByTimeAsync(0);
  vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
});
function bridge(connected = true) {
  const frame = new Element(); frame.isConnected = connected;
  let current = true;
  const reopen = vi.fn();
  const states: string[] = [];
  const close = mountArtifactBridge({ onReopen: reopen, onState: state => states.push(state), frame: frame as unknown as HTMLIFrameElement, sessionId: "session", key: "notes", selection: "selection", url: "/selected",
    headers: () => ({}), current: () => current });
  disposers.push(close);
  return { frame, close, reopen, states, switchSession: () => { current = false; } };
}
async function load(frame: Element) { frame.dispatchEvent(new Event("load")); await vi.advanceTimersByTimeAsync(0); }
function handshake(port: Port) { port.receive({ type: "ready" }); port.receive({ type: "ack" }); port.receive({ type: "ack" }); }
function openId() { return String(operations.find(operation => operation.operation === "open")!.preview); }

describe("shared artifact preview lifecycle", () => {
  it("waits for the initial hello and keeps one iframe and private port across reconnects", async () => {
    setArtifactBridgeSocket(undefined);
    const preview = bridge(); await load(preview.frame); handshake(ports[0]);
    expect(operations.filter(operation => operation.operation === "open")).toHaveLength(0);
    expect(preview.states).toContain("disconnected");
    setArtifactBridgeSocket("first-hello"); await vi.advanceTimersByTimeAsync(0); handshake(ports[0]);
    const first = openId();
    setArtifactBridgeSocket(undefined); handshake(ports[0]);
    expect(ports[0].close).not.toHaveBeenCalled();
    setArtifactBridgeSocket("new-hello"); await vi.advanceTimersByTimeAsync(0); handshake(ports[0]);
    const opens = operations.filter(operation => operation.operation === "open");
    expect(opens).toHaveLength(2); expect(opens[1].preview).not.toBe(first);
    expect(preview.frame.contentWindow.postMessage).toHaveBeenCalledOnce(); expect(ports).toHaveLength(1);
    receiveArtifactBridgeEvent({ preview: first, event: "stale" });
    expect(ports[0].postMessage.mock.calls.some(([data]) => data.event === "stale")).toBe(false);
    expect(operations.filter(operation => operation.operation === "request")).toHaveLength(0);
  });
  it("never replays commands, aborts uncertain work, and guards old request finalizers after reconnect", async () => {
    const preview = bridge(); await load(preview.frame); handshake(ports[0]);
    const original = vi.mocked(fetch).getMockImplementation()!;
    const waiting: { resolve: (value: unknown) => void; signal: AbortSignal }[] = [];
    vi.mocked(fetch).mockImplementation((url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (body?.preview.operation === "request") {
        operations.push(body.preview);
        return new Promise(resolve => waiting.push({ resolve: resolve as (value: unknown) => void, signal: init!.signal! }));
      }
      return original(url, init);
    });
    ports[0].receive({ type: "request", id: "same", command: "mutate" });
    setArtifactBridgeSocket(undefined); expect(waiting[0].signal.aborted).toBe(true);
    handshake(ports[0]);
    setArtifactBridgeSocket("replacement"); await vi.advanceTimersByTimeAsync(0); handshake(ports[0]);
    expect(operations.filter(operation => operation.operation === "request")).toHaveLength(1);
    ports[0].receive({ type: "request", id: "same", command: "new" });
    waiting[0].resolve({ ok: true, json: async () => ({ ok: true, result: "stale" }) });
    await vi.advanceTimersByTimeAsync(0);
    ports[0].receive({ type: "cancel", id: "same" });
    expect(waiting[1].signal.aborted).toBe(true);
    waiting[1].resolve({ ok: true, json: async () => ({ ok: true, result: "also-stale" }) });
    await vi.advanceTimersByTimeAsync(0); handshake(ports[0]);
    expect(ports[0].postMessage.mock.calls.some(([data]) => data.result === "stale" || data.result === "also-stale")).toBe(false);
    expect(preview.states.at(-1)).toBe("ready");
    preview.close();
  });
  it("preserves exactly one outcome per request across two reconnects without granting ACK credit", async () => {
    const preview = bridge(); await load(preview.frame); handshake(ports[0]);
    const before = ports[0].postMessage.mock.calls.length;
    for (const id of ["a", "b", "c"]) ports[0].receive({ type: "request", id, command: "mutate" });
    for (const socket of ["replacement", "replacement2"]) {
      setArtifactBridgeSocket(undefined); setArtifactBridgeSocket(socket);
      await vi.advanceTimersByTimeAsync(0);
      // Only a's outcome may be posted until the iframe supplies its first ACK.
      expect(ports[0].postMessage.mock.calls).toHaveLength(before + 1);
    }
    for (let i = 0; i < 8; i++) {
      const count = ports[0].postMessage.mock.calls.length;
      ports[0].receive({ type: "ack" });
      expect(ports[0].postMessage.mock.calls.length - count).toBeLessThanOrEqual(1);
    }
    const outcomes = ports[0].postMessage.mock.calls.map(([data]) => data).filter(data => data.type === "error" || data.type === "response");
    expect(outcomes.map(data => [data.id, data.error?.code])).toEqual([["a", "OUTCOME_UNKNOWN"], ["b", "OUTCOME_UNKNOWN"], ["c", "OUTCOME_UNKNOWN"]]);
    expect(operations.filter(operation => operation.operation === "request")).toHaveLength(3);
    expect(preview.states.at(-1)).toBe("ready");
  });
  it("retains a completed queued response behind an unACKed event across reconnect", async () => {
    const preview = bridge(); await load(preview.frame); handshake(ports[0]);
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (body?.preview.operation === "request") {
        operations.push(body.preview);
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, result: "completed" }) } as Response);
      }
      return original(url, init);
    });
    receiveArtifactBridgeEvent({ preview: openId(), event: "held" });
    const before = ports[0].postMessage.mock.calls.length;
    ports[0].receive({ type: "request", id: "complete", command: "mutate" });
    await vi.advanceTimersByTimeAsync(0); // The command has settled and left the pending map.
    expect(ports[0].postMessage.mock.calls).toHaveLength(before);
    setArtifactBridgeSocket(undefined); setArtifactBridgeSocket("replacement");
    await vi.advanceTimersByTimeAsync(0);
    expect(ports[0].postMessage.mock.calls).toHaveLength(before);
    ports[0].receive({ type: "ack" });
    expect(ports[0].postMessage.mock.calls.at(-1)![0]).toEqual({ type: "response", id: "complete", result: "completed" });
    expect(ports[0].postMessage.mock.calls).toHaveLength(before + 1);
    for (let i = 0; i < 8; i++) {
      const count = ports[0].postMessage.mock.calls.length;
      ports[0].receive({ type: "ack" });
      expect(ports[0].postMessage.mock.calls.length - count).toBeLessThanOrEqual(1);
    }
    const outcomes = ports[0].postMessage.mock.calls.map(([data]) => data).filter(data => data.id === "complete");
    expect(outcomes).toEqual([{ type: "response", id: "complete", result: "completed" }]);
    expect(operations.filter(operation => operation.operation === "request")).toHaveLength(1);
  });
  it("bounds the extracted delivery queue by messages and UTF-8 bytes", async () => {
    const preview = bridge(); await load(preview.frame); handshake(ports[0]);
    const id = openId();
    for (let i = 0; i < 6; i++) receiveArtifactBridgeEvent({ preview: id, event: "x".repeat(65_500) });
    expect(ports[0].close).toHaveBeenCalledOnce();
    expect(disconnected).toBe(1);
  });
  it("requires explicit reopen when the retained registration is rejected on a new hello", async () => {
    const preview = bridge(); await load(preview.frame); handshake(ports[0]);
    setArtifactBridgeSocket(undefined); handshake(ports[0]);
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (body?.preview.operation === "open") {
        expect(body.preview.selection).toBe("selection");
        return Promise.resolve({ ok: false, status: 422, json: async () => ({ ok: false }) } as Response);
      }
      return original(url, init);
    });
    setArtifactBridgeSocket("replacement"); await vi.advanceTimersByTimeAsync(0); handshake(ports[0]);
    expect(preview.states.at(-1)).toBe("reopen-required"); expect(preview.reopen).not.toHaveBeenCalled();
    ports[0].receive({ type: "reopen" }); expect(preview.reopen).toHaveBeenCalledOnce();
  });
  it("requires explicit full reopen after failed source validation without retry loops", async () => {
    const preview = bridge(); await load(preview.frame); handshake(ports[0]);
    setArtifactBridgeSocket(undefined); handshake(ports[0]);
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((url, init) => url === "/selected" ? Promise.resolve({ status: 409, body: { cancel: async () => {} } } as Response) : original(url, init));
    setArtifactBridgeSocket("replacement"); await vi.advanceTimersByTimeAsync(0); handshake(ports[0]);
    expect(preview.states.at(-1)).toBe("reopen-required");
    const calls = vi.mocked(fetch).mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(calls); expect(ports[0].close).not.toHaveBeenCalled();
    ports[0].receive({ type: "reopen" });
    expect(preview.reopen).toHaveBeenCalledOnce(); expect(ports[0].close).toHaveBeenCalledOnce();
  });
  it("two bridges and a mounted byte stream share one observer and clean it up after the final preview", async () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    const first = bridge(), second = bridge();
    // Keep the actual stream in its probe phase so teardown also exercises aborting its fetch.
    vi.mocked(fetch).mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("stream closed")), { once: true });
    }));
    const host = new Element(), frame = new Element();
    mountArtifactStream({ host: host as unknown as HTMLElement, frame: frame as unknown as HTMLIFrameElement, url: "/api/artifacts/model.stl", headers: () => ({}), isCurrent: () => true });
    expect(observed).toBe(1);
    first.close(); expect(disconnected).toBe(0);
    second.frame.isConnected = false; mutate(); expect(disconnected).toBe(0);
    host.isConnected = false; mutate(); await vi.advanceTimersByTimeAsync(0);
    expect(disconnected).toBe(1);
    expect(interval).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("allows delayed frame attachment, then closes on session change through the shared watcher", async () => {
    const preview = bridge(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(disconnected).toBe(0);
    preview.frame.isConnected = true; mutate(); await load(preview.frame);
    expect(operations.filter(operation => operation.operation === "open")).toHaveLength(1);
    handshake(ports[0]);
    expect(vi.getTimerCount()).toBe(0); // Idle ready previews have no poller or deadline.
    preview.switchSession(); mutate(); await vi.advanceTimersByTimeAsync(0);
    expect(ports[0].close).toHaveBeenCalledOnce(); expect(disconnected).toBe(1);
    expect(operations.filter(operation => operation.operation === "close")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds initial attachment and ready handshakes with one-shot deadlines", async () => {
    const unattached = bridge(false);
    await vi.advanceTimersByTimeAsync(29_999); expect(disconnected).toBe(0);
    await vi.advanceTimersByTimeAsync(1); expect(disconnected).toBe(1);
    await load(unattached.frame); expect(operations).toHaveLength(0);
    const preview = bridge(); await load(preview.frame);
    ports[0].receive({ type: "ack" }); // A spurious ACK cannot cancel the ready deadline.
    await vi.advanceTimersByTimeAsync(9_999); expect(ports[0].close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(ports[0].close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0); expect(disconnected).toBe(2);
  });
  it("bounds each delivery ACK and ignores duplicate ready without extending its deadline", async () => {
    const preview = bridge(); await load(preview.frame);
    handshake(ports[0]);
    receiveArtifactBridgeEvent({ preview: openId(), event: { tick: 1 } });
    await vi.advanceTimersByTimeAsync(5_000);
    const posted = ports[0].postMessage.mock.calls.length;
    setArtifactBridgeSocket(undefined); setArtifactBridgeSocket("replacement");
    await vi.advanceTimersByTimeAsync(0);
    expect(ports[0].postMessage.mock.calls).toHaveLength(posted);
    ports[0].receive({ type: "ready" });
    await vi.advanceTimersByTimeAsync(4_999); expect(ports[0].close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(ports[0].close).toHaveBeenCalledOnce();
    expect(disconnected).toBe(1); expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels acknowledged delivery deadlines and arms a fresh deadline for the next queued event", async () => {
    const preview = bridge(); await load(preview.frame); handshake(ports[0]);
    receiveArtifactBridgeEvent({ preview: openId(), event: 1 });
    receiveArtifactBridgeEvent({ preview: openId(), event: 2 });
    await vi.advanceTimersByTimeAsync(9_000); ports[0].receive({ type: "ack" });
    await vi.advanceTimersByTimeAsync(1_001); expect(ports[0].close).not.toHaveBeenCalled();
    ports[0].receive({ type: "ack" });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000); expect(ports[0].close).not.toHaveBeenCalled();
    preview.close(); await vi.advanceTimersByTimeAsync(0);
    expect(disconnected).toBe(1); expect(vi.getTimerCount()).toBe(0);
  });
});
