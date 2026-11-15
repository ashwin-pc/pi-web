import { afterEach, describe, expect, it, vi } from "vitest";
import { mountArtifactStream, selectedArtifactUrl, type ArtifactStreamOptions } from "../src/extensions/artifactStream.js";
import { openRendererPort, watchArtifactConnection } from "../src/extensions/artifactStreamLifecycle.js";
import { streamArtifactIntoRenderer } from "../src/extensions/artifactStreamSource.js";
import { configureArtifactPreviews, mountArtifactPreview, setArtifactPreviews } from "../src/extensions/artifactPreviews.js";

class Element {
  children: Element[] = []; textContent = ""; hidden = false; style = {}; dataset = {}; onclick?: () => void; onload?: () => void; isConnected = true;
  parent?: Element;
  setAttribute() {}
  cloneNode() { return new Element(); }
  append(...children: Element[]) { for (const c of children) { this.children.push(c); c.parent = this; } }
  replaceChildren(...children: Element[]) { this.children = []; this.append(...children); }
  contains(child: Element): boolean { return this.children.includes(child) || this.children.some(c => c.contains(child)); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); }
}
let mutation: () => void;
function controls(host: Element) {
  const status = host.children[0].children[0];
  return { title: status.children[0], status: status.children[1], load: status.children[2] };
}
function dom() {
  vi.stubGlobal("location", { origin: "https://preview.test" });
  vi.stubGlobal("document", { createElement: () => new Element(), documentElement: new Element() });
  vi.stubGlobal("MutationObserver", class { constructor(fn: () => void) { mutation = fn; } observe() {} disconnect() {} });
  return { host: new Element(), frame: new Element() };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("selected artifact stream host", () => {
  it("rejects external, cross-session, query and non-artifact targets", () => {
    dom();
    expect(selectedArtifactUrl("/api/artifacts/model.stl", "one")).toBe("/api/session-artifacts/one/model.stl");
    expect(selectedArtifactUrl("/api/session-artifacts/one/model.stl", "one")).toBe("/api/session-artifacts/one/model.stl");
    for (const path of ["https://evil.test/api/artifacts/a.stl", "/api/session-artifacts/two/a.stl", "/api/artifacts/a.stl?sessionId=two", "/api/state", "/api/artifacts/../../state"]) expect(() => selectedArtifactUrl(path, "one")).toThrow();
  });
  it.each([20 * 1024 * 1024, 207486284])("attaches the renderer before readiness and never fetches full bytes before renderer consent (%s)", async size => {
    const { host, frame } = dom();
    let remote: MessagePort | undefined;
    (frame as any).contentWindow = { postMessage: (_m: any, _o: string, ports: MessagePort[]) => {
      remote = ports[0]; remote.postMessage({ type: "connected" });
    } };
    const fetch = vi.fn(async (_url: string, options: any) => ({ ok: true, headers: new Headers({ "content-range": `bytes 0-0/${size}` }), body: { cancel: async () => {} } }));
    vi.stubGlobal("fetch", fetch);
    const attached = vi.fn();
    mountArtifactStream({ host: host as any, frame: frame as any, url: "/selected", headers: () => ({}), isCurrent: () => true, onFrameReady: attached });
    await vi.waitFor(() => expect(attached).toHaveBeenCalledOnce());
    expect(host.contains(frame)).toBe(true); frame.onload!();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].headers.Range).toBe("bytes=0-0");
    remote!.postMessage({ type: "release" });
    await vi.waitFor(() => expect(host.contains(frame)).toBe(false));
    expect(controls(host).load.textContent).toBe("Open again");
    remote!.close();
  });
  it("accepts release while the bounded credit window is occupied", async () => {
    const { host, frame } = dom(); let remote: MessagePort | undefined;
    const sent: any[] = [];
    (frame as any).contentWindow = { postMessage: (_m: any, _o: string, ports: MessagePort[]) => {
      remote = ports[0]; remote.onmessage = e => sent.push(e.data); remote.postMessage({ type: "ready", streamVersion: 2 });
    } };
    const cancel = vi.fn(async () => {});
    let reads = 0;
    const fetch = vi.fn(async (_url: string, options: any) => options.headers.Range
      ? { ok: true, headers: new Headers({ "content-range": "bytes 0-0/207486284" }), body: { cancel: async () => {} } }
      : { ok: true, headers: new Headers({ "content-length": "207486284" }), body: { getReader: () => ({ read: async () => (++reads, { done: false, value: new Uint8Array(1048576) }), cancel }) } });
    vi.stubGlobal("fetch", fetch);
    mountArtifactStream({ host: host as any, frame: frame as any, url: "/selected", headers: () => ({}), isCurrent: () => true });
    await vi.waitFor(() => expect(frame.onload).toBeTypeOf("function")); frame.onload!();
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    remote!.postMessage({ type: "release" });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
    expect(reads).toBe(2); expect(host.contains(frame)).toBe(false); remote!.close();
  });
  it("Open again re-renders and obtains fresh selection authority after a changed source", async () => {
    const { host } = dom(); let renders = 0;
    configureArtifactPreviews({ headers: () => ({ "content-type": "application/json" }), getSessionId: () => "one" });
    setArtifactPreviews([{ key: "stl", match: { extensions: [".stl"] } }]);
    const fetch = vi.fn(async (url: string, options: any) => {
      if (url === "/api/web-contributions/invoke") {
        renders++;
        return { ok: true, json: async () => ({ ok: true, html: "<p>mesh</p>", artifactBytes: true, artifactDerived: true, selection: `selection-${renders}` }) };
      }
      if (options.headers["x-pi-artifact-selection"] === "selection-1") return { ok: false, headers: new Headers(), body: { cancel: async () => {} } };
      return { ok: true, headers: new Headers({ "content-range": "bytes 0-0/30000000" }), body: { cancel: async () => {} } };
    });
    vi.stubGlobal("fetch", fetch);
    await mountArtifactPreview(host as any, { name: "mesh.stl", path: "/api/artifacts/mesh.stl", kind: "file" }, { title: "Mesh" });
    await vi.waitFor(() => expect(controls(host).title.textContent).toContain("could not"));
    controls(host).load.onclick!();
    await vi.waitFor(() => expect(renders).toBe(2));
    await vi.waitFor(() => expect(host.children[0].children[1].children).toHaveLength(1));
    expect(fetch.mock.calls.filter(([url]) => url !== "/api/web-contributions/invoke").map(([, options]) => options.headers["x-pi-artifact-selection"])).toEqual(["selection-1", "selection-2"]);
    host.isConnected = false; mutation(); setArtifactPreviews([]);
  });
  it("derives only on explicit post-load request and cancels without removing the original", async () => {
    const { host, frame } = dom(); let original: MessagePort | undefined; let calls = 0;
    let derivedSignal: AbortSignal | undefined;
    (frame as any).contentWindow = { postMessage: (_message: any, _origin: string, ports: MessagePort[]) => {
      original = ports[0]; original.onmessage = event => {
        if (event.data.type === "chunk") original!.postMessage({ type: "ack" });
        if (event.data.type === "end") original!.postMessage({ type: "complete" });
      }; original.postMessage({ type: "ready" });
    } };
    const fetch = vi.fn(async (_url: string, options: any) => {
      calls++;
      if (calls === 1) return { ok: true, headers: new Headers({ "content-range": "bytes 0-0/3" }), body: { cancel: async () => {} } };
      if (calls === 2) { let read = false; return { ok: true, headers: new Headers({ "content-length": "3" }), body: { getReader: () => ({ read: async () => read ? { done: true } : (read = true, { done: false, value: new Uint8Array(3) }), cancel: async () => {} }) } }; }
      derivedSignal = options.signal;
      return new Promise<never>((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    });
    vi.stubGlobal("fetch", fetch); const ready = vi.fn();
    mountArtifactStream({ host: host as any, frame: frame as any, url: "/selected", headers: () => ({ "content-type": "application/json" }), isCurrent: () => true, onFrameReady: ready, layout: "inline", derivation: { selection: "private-selection", key: "stl", sessionId: "one" } });
    await vi.waitFor(() => expect(frame.onload).toBeTypeOf("function")); frame.onload!();
    await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(calls).toBe(2); expect(fetch.mock.calls[0][1].headers["x-pi-artifact-selection"]).toBe("private-selection");
    original!.postMessage({ type: "derive" }); await vi.waitFor(() => expect(calls).toBe(3));
    expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({ selection: "private-selection", key: "stl", sessionId: "one" });
    original!.postMessage({ type: "derive-cancel" }); await vi.waitFor(() => expect(derivedSignal?.aborted).toBe(true));
    expect(host.contains(frame)).toBe(true); original!.close();
    host.isConnected = false; mutation();
  });
  it("replays the latest enabled intent after a cancelled derivation settles without overlapping jobs", async () => {
    const { host, frame } = dom(); let original: MessagePort | undefined; let reads = 0;
    const pending: { signal: AbortSignal; reject: (error: Error) => void }[] = [];
    (frame as any).contentWindow = { postMessage: (_m: any, _o: string, ports: MessagePort[]) => {
      original = ports[0]; original.onmessage = event => {
        if (event.data.type === 'chunk') original!.postMessage({ type: 'ack' });
        if (event.data.type === 'end') original!.postMessage({ type: 'complete' });
      }; original.postMessage({ type: 'ready' });
    } };
    const fetch = vi.fn(async (url: string, options: any) => {
      if (url.includes('artifact-derived')) return new Promise<never>((_resolve, reject) => pending.push({ signal: options.signal, reject }));
      if (options.headers.Range) return { ok: true, headers: new Headers({ 'content-range': 'bytes 0-0/3' }), body: { cancel: async () => {} } };
      return { ok: true, headers: new Headers({ 'content-length': '3' }), body: { getReader: () => ({ read: async () => ++reads === 1 ? { done: false, value: new Uint8Array(3) } : { done: true }, cancel: async () => {} }) } };
    });
    vi.stubGlobal('fetch', fetch); const ready = vi.fn();
    mountArtifactStream({ host: host as any, frame: frame as any, url: '/selected', headers: () => ({}), isCurrent: () => true, onFrameReady: ready, layout: 'inline', derivation: { selection: 'selected', key: 'stl', sessionId: 'one' } });
    await vi.waitFor(() => expect(frame.onload).toBeTypeOf('function')); frame.onload!();
    await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
    await new Promise(resolve => setTimeout(resolve, 30));
    original!.postMessage({ type: 'derive' }); await vi.waitFor(() => expect(pending).toHaveLength(1));
    original!.postMessage({ type: 'derive-cancel' });
    await vi.waitFor(() => expect(pending[0].signal.aborted).toBe(true));
    original!.postMessage({ type: 'derive' });
    // Let the intent reach the host while the cancelled fetch remains unsettled.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(pending).toHaveLength(1);
    pending[0].reject(new Error('cancelled job settled'));
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[1].signal.aborted).toBe(false);
    expect(host.contains(frame)).toBe(true); expect(fetch).toHaveBeenCalledTimes(4);
    // A final OFF supersedes an ON queued behind cancellation.
    original!.postMessage({ type: 'derive-cancel' });
    await vi.waitFor(() => expect(pending[1].signal.aborted).toBe(true));
    original!.postMessage({ type: 'derive' }); original!.postMessage({ type: 'derive-cancel' });
    await new Promise(resolve => setTimeout(resolve, 20)); pending[1].reject(new Error('cancelled'));
    await new Promise(resolve => setTimeout(resolve, 20)); expect(pending).toHaveLength(2);
    original!.close(); host.isConnected = false; mutation();
  });
  it("bounds renderer boot but permits consent beyond 15 seconds after connected", async () => {
    dom(); vi.useFakeTimers();
    try {
      const local = { onmessage: null as any, close: vi.fn() };
      vi.stubGlobal("MessageChannel", class { port1 = local; port2 = { close() {} }; });
      const frame = new Element();
      (frame as any).contentWindow = { postMessage() {} };
      const controller = new AbortController();
      let settled = false;
      const result = openRendererPort(frame as any, 207486284, controller.signal).then(value => { settled = true; return value; });
      frame.onload!();
      local.onmessage({ data: { type: "connected" } });
      await vi.advanceTimersByTimeAsync(60000);
      expect(settled).toBe(false);
      local.onmessage({ data: { type: "ready", streamVersion: 2 } });
      await expect(result).resolves.toEqual({ port: local, pipelined: true });
      const boot = openRendererPort(frame as any, 3, controller.signal);
      const rejected = expect(boot).rejects.toThrow("did not initialize");
      await vi.advanceTimersByTimeAsync(15001); await rejected;
    } finally { vi.useRealTimers(); }
  });
  it("shares connection observation and releases only the disposed owner", () => {
    dom();
    const disconnect = vi.fn();
    const observe = vi.fn();
    const constructor = vi.fn();
    vi.stubGlobal("MutationObserver", class {
      constructor(fn: () => void) { constructor(); mutation = fn; }
      observe = observe;
      disconnect = disconnect;
    });
    const first = vi.fn(), second = vi.fn();
    const disposeFirst = watchArtifactConnection(first);
    const disposeSecond = watchArtifactConnection(second);
    expect(constructor).toHaveBeenCalledOnce();
    mutation();
    expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledOnce();
    disposeFirst(); mutation();
    expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledTimes(2);
    expect(disconnect).not.toHaveBeenCalled();
    disposeSecond(); expect(disconnect).toHaveBeenCalledOnce();
  });
  it.each([false, true])("cleans up handshake listeners and owns its private port (abort=%s)", async abort => {
    const { frame } = dom();
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const close = vi.fn();
    const local = { onmessage: null as any, close };
    const remote = { close: vi.fn() };
    vi.stubGlobal("MessageChannel", class { port1 = local; port2 = remote; });
    const postMessage = vi.fn();
    (frame as any).contentWindow = { postMessage };
    const result = openRendererPort(frame as any, 123, controller.signal);
    frame.onload!();
    expect(postMessage).toHaveBeenCalledWith({ type: "pi-artifact-stream", size: 123, streamVersion: 2 }, "*", [remote]);
    if (abort) {
      controller.abort();
      await expect(result).rejects.toThrow("Cancelled");
      expect(close).toHaveBeenCalledOnce();
    } else {
      local.onmessage({ data: { type: "ready", streamVersion: 2 } });
      await expect(result).resolves.toEqual({ port: local, pipelined: true });
      controller.abort(); // ownership passed to the caller, not a lingering listener
      expect(close).not.toHaveBeenCalled();
    }
    expect(frame.onload).toBeNull(); expect(local.onmessage).toBeNull();
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });
  it.each([false, true])("owns completion before end, retains derive intents, and cleans up (abort=%s)", async abort => {
    const { frame } = dom();
    const controller = new AbortController();
    const close = vi.fn(), ready = vi.fn(), derive = vi.fn(), cancelDerivation = vi.fn();
    const error = vi.fn(), release = vi.fn(), reopen = vi.fn();
    const local = {
      onmessage: null as any, close,
      postMessage(message: any) {
        if (message.type === "chunk") local.onmessage({ data: { type: "ack" } });
        if (message.type === "end") {
          if (abort) controller.abort();
          else {
            local.onmessage({ data: { type: "complete", decodeMs: 12, uploadMs: 8 } });
            // Even synchronous intents immediately following completion stay live.
            local.onmessage({ data: { type: "derive" } });
            local.onmessage({ data: { type: "derive-cancel" } });
          }
        }
      },
    };
    vi.stubGlobal("MessageChannel", class { port1 = local; port2 = {}; });
    (frame as any).contentWindow = { postMessage: () => local.onmessage({ data: { type: "ready" } }) };
    const stream = streamArtifactIntoRenderer({
      frame: frame as any, signal: controller.signal, current: () => !controller.signal.aborted,
      source: {
        probe: async () => 3,
        open: async () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(3)); c.close(); } }).getReader(),
      },
      ready, derive, cancelDerivation, error, release, reopen,
    });
    const done = stream.run(3);
    frame.onload!();
    if (abort) {
      await expect(done).rejects.toThrow("Cancelled");
      expect(ready).not.toHaveBeenCalled();
    } else {
      await done;
      expect(ready).toHaveBeenCalledWith();
      local.onmessage({ data: { type: "derive" } });
      local.onmessage({ data: { type: "derive-cancel" } });
      expect(derive).toHaveBeenCalledTimes(2); expect(cancelDerivation).toHaveBeenCalledTimes(2);
      local.onmessage({ data: { type: "release" } });
      local.onmessage({ data: { type: "reopen" } });
      expect(release).toHaveBeenCalledOnce(); expect(reopen).toHaveBeenCalledOnce();
      expect(stream.getPort()).toBe(local);
      controller.abort(); // completed handshake has removed its abort listener
    }

    stream.dispose();
    expect(local.onmessage).toBeNull(); expect(close).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
  });
  it("uses typed options and aborts detach, but not a connected reparent", () => {
    const { host, frame } = dom();
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", (_: string, options: any) => { signal = options.signal; return new Promise(() => {}); });
    const options: ArtifactStreamOptions = { host: host as any, frame: frame as any, url: "/selected", headers: () => ({}), isCurrent: () => true, layout: "panel" };
    mountArtifactStream(options);
    mutation(); // A move within the document leaves the host connected.
    expect(signal?.aborted).toBe(false);
    host.isConnected = false; mutation();
    expect(signal?.aborted).toBe(true);
  });
  it("aborts a pending size probe when the preview is removed or session changes", () => {
    const { host, frame } = dom();
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", (_: string, options: any) => { signal = options.signal; return new Promise(() => {}); });
    let current = true;
    mountArtifactStream({ host: host as any, frame: frame as any, url: "/selected", headers: () => ({}), isCurrent: () => current });
    current = false; mutation();
    expect(signal?.aborted).toBe(true);
  });
});
