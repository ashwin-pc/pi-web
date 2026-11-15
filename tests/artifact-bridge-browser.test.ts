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
  const close = mountArtifactBridge({ frame: frame as unknown as HTMLIFrameElement, sessionId: "session", key: "notes", selection: "selection", url: "/selected",
    headers: () => ({}), current: () => current });
  disposers.push(close);
  return { frame, close, switchSession: () => { current = false; } };
}
async function load(frame: Element) { frame.dispatchEvent(new Event("load")); await vi.advanceTimersByTimeAsync(0); }
function openId() { return String(operations.find(operation => operation.operation === "open")!.preview); }

describe("shared artifact preview lifecycle", () => {
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
    ports[0].receive({ type: "ready" });
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
    ports[0].receive({ type: "ready" });
    receiveArtifactBridgeEvent({ preview: openId(), event: { tick: 1 } });
    await vi.advanceTimersByTimeAsync(5_000);
    ports[0].receive({ type: "ready" });
    await vi.advanceTimersByTimeAsync(4_999); expect(ports[0].close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(ports[0].close).toHaveBeenCalledOnce();
    expect(disconnected).toBe(1); expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels acknowledged delivery deadlines and arms a fresh deadline for the next queued event", async () => {
    const preview = bridge(); await load(preview.frame); ports[0].receive({ type: "ready" });
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
