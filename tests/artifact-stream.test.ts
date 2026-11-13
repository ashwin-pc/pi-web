import { afterEach, describe, expect, it, vi } from "vitest";
import { mountArtifactStream, selectedArtifactUrl } from "../src/extensions/artifactStream.js";
import { configureArtifactPreviews, mountArtifactPreview, setArtifactPreviews } from "../src/extensions/artifactPreviews.js";

class Element {
  children: Element[] = []; textContent = ""; hidden = false; style = {}; onclick?: () => void; onload?: () => void; isConnected = true;
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
  const content = host.children[0].children[1].children[0];
  const [icon, title, status, meta, warning, progress, actions] = content.children;
  return { title, status, meta, warning, progress, load: actions.children[0], stop: actions.children[1], download: actions.children[2] };
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
  it.each([20 * 1024 * 1024, 20 * 1024 * 1024 + 1])("auto-initializes at or below 20 MiB and asks consent only above it (bytes=%s)", async size => {
    const {host,frame}=dom();const fetch=vi.fn(async()=>({ok:true,headers:new Headers({'content-range':`bytes 0-0/${size}`}),body:{cancel:async()=>{}}}));vi.stubGlobal('fetch',fetch);
    mountArtifactStream(host as any,frame as any,'/selected',()=>({}),()=>true);
    await vi.waitFor(()=>expect(controls(host).meta.textContent).toContain('20.0 MiB'));
    expect(host.contains(frame)).toBe(size <= 20 * 1024 * 1024);
    expect(controls(host).load.hidden).toBe(size <= 20 * 1024 * 1024);
    expect(fetch).toHaveBeenCalledTimes(1); // Full fetch waits for renderer readiness, never races consent.
    controls(host).stop.onclick!();expect(host.contains(frame)).toBe(false);
    controls(host).load.onclick!();
    await vi.waitFor(()=>expect(controls(host).meta.textContent).toContain('20.0 MiB'));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(controls(host).load.hidden).toBe(size <= 20 * 1024 * 1024); // Retry keeps the same size policy.
    controls(host).stop.onclick!();
  });
  it("only probes one byte before confirmation and Cancel never loads the file", async () => {
    const { host, frame } = dom();
    const cancel = vi.fn();
    const fetch = vi.fn(async (_url: string, _options: any) => ({ ok: true, headers: new Headers({ "content-range": "bytes 0-0/207486284" }), body: { cancel } }));
    vi.stubGlobal("fetch", fetch);
    mountArtifactStream(host as any, frame as any, "/selected", () => ({ Authorization: "host-only" }), () => true);
    await vi.waitFor(() => expect(controls(host).load.hidden).toBe(false));
    const { title, status, meta, warning, load, stop, download } = controls(host);
    expect(meta.textContent).toContain("197.9 MiB");
    expect(warning.textContent).toContain("crash");
    expect(load.textContent).toBe("Load full model");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].headers.Range).toBe("bytes=0-0");
    expect(host.contains(frame)).toBe(false);
    stop.onclick!();
    expect(title.textContent).toBe("Loading stopped");
    expect(meta.textContent).toBe("Source: 197.9 MiB");
    expect(status.textContent).toContain("restart loading");
    expect(load.textContent).toBe("Open again");
    expect(download.hidden).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it("starts only after consent, keeps one chunk in flight and aborts on mid-load Cancel", async () => {
    const { host, frame } = dom();
    let remote: MessagePort | undefined;
    const sent: any[] = [];
    (frame as any).contentWindow = { postMessage: (message: any, _origin: string, ports: MessagePort[]) => {
      sent.push(message); remote = ports[0];
      remote.onmessage = event => { sent.push(event.data); }; // Deliberately withhold ack.
      remote.postMessage({ type: "ready" });
    } };
    const read = vi.fn(async () => ({ value: new Uint8Array(1024 * 1024), done: false }));
    const cancelReader = vi.fn(async () => {});
    let calls = 0;
    const fetch = vi.fn(async (_url: string, _options: any) => ++calls === 1
      ? { ok: true, headers: new Headers({ "content-range": "bytes 0-0/207486284" }), body: { cancel: async () => {} } }
      : { ok: true, headers: new Headers({ "content-length": "207486284" }), body: { getReader: () => ({ read, cancel: cancelReader }) } });
    vi.stubGlobal("fetch", fetch);
    mountArtifactStream(host as any, frame as any, "/selected", () => ({ Authorization: "host-only" }), () => true);
    await vi.waitFor(() => expect(controls(host).load.hidden).toBe(false));
    controls(host).load.onclick!(); frame.onload!();
    await vi.waitFor(() => expect(sent.some(m => m.type === "chunk")).toBe(true));
    expect(read).toHaveBeenCalledTimes(1);
    expect(sent[0]).toEqual({ type: "pi-artifact-stream", size: 207486284, streamVersion: 2 });
    expect(JSON.stringify(sent)).not.toContain("host-only");
    controls(host).stop.onclick!();
    await vi.waitFor(() => expect(cancelReader).toHaveBeenCalled());
    expect(fetch.mock.calls[1][1].signal.aborted).toBe(true);
    expect(host.contains(frame)).toBe(false);
    remote?.close();
  });
  it.each([true, false])("completes only a whole stream and offers recovery after close or truncation (whole=%s)", async whole => {
    const {host,frame}=dom();let remote: MessagePort|undefined,reads=0,calls=0;
    (frame as any).contentWindow={postMessage: (_m:any,_o:string,ports:MessagePort[])=>{remote=ports[0];remote.onmessage=e=>{if(e.data.type==='chunk')remote!.postMessage({type:'ack',triangles:1});if(e.data.type==='end')remote!.postMessage({type:'complete'});};remote.postMessage({type:'ready'});}};
    const fetch=vi.fn(async()=>++calls===1?{ok:true,headers:new Headers({'content-range':'bytes 0-0/3'}),body:{cancel:async()=>{}}}:{ok:true,headers:new Headers({'content-length':'3'}),body:{getReader:()=>({read:async()=>++reads===1?{done:false,value:new Uint8Array(whole?3:2)}:{done:true},cancel:async()=>{}})}});
    const onFrameReady = vi.fn();
    vi.stubGlobal('fetch',fetch);mountArtifactStream(host as any,frame as any,'/selected',()=>({}),()=>true,onFrameReady);
    await vi.waitFor(()=>expect(frame.onload).toBeTypeOf('function'));
    expect(onFrameReady).not.toHaveBeenCalled();
    frame.onload!();
    if(whole){await vi.waitFor(()=>expect(onFrameReady).toHaveBeenCalledOnce());
      expect(onFrameReady).toHaveBeenCalledWith(frame, frame.parent);
      expect(frame.parent).not.toBe(host.children[0]); // Shield cannot cover consent or Close.
      expect(frame.parent!.contains(host.children[0].children[1])).toBe(false);
      // Ready is moved after the iframe so it is the last child.
      const panel=host.children[0],ready=panel.children.at(-1)!;ready.children[1].onclick!();expect(controls(host).title.textContent).toBe('Model closed');expect(host.contains(frame)).toBe(false);expect(controls(host).meta.textContent).toBe('Source: 0.0 MiB');
    }else{await vi.waitFor(()=>expect(controls(host).title.textContent).toContain('could not'));expect(controls(host).status.textContent).toContain('ended before');expect(host.contains(frame)).toBe(false);expect(onFrameReady).not.toHaveBeenCalled();}
    expect(controls(host).load.textContent).toBe('Open again');expect(controls(host).download.hidden).toBe(false);remote?.close();
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
    await vi.waitFor(() => expect(controls(host).title.textContent).toBe("Open full-detail 3D preview"));
    expect(fetch.mock.calls.filter(([url]) => url !== "/api/web-contributions/invoke").map(([, options]) => options.headers["x-pi-artifact-selection"])).toEqual(["selection-1", "selection-2"]);
    controls(host).stop.onclick!(); setArtifactPreviews([]);
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
    mountArtifactStream(host as any, frame as any, "/selected", () => ({ "content-type": "application/json" }), () => true, ready, "inline", { selection: "private-selection", key: "stl", sessionId: "one" });
    await vi.waitFor(() => expect(frame.onload).toBeTypeOf("function")); frame.onload!();
    await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
    expect(calls).toBe(2); expect(fetch.mock.calls[0][1].headers["x-pi-artifact-selection"]).toBe("private-selection");
    original!.postMessage({ type: "derive" }); await vi.waitFor(() => expect(calls).toBe(3));
    expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({ selection: "private-selection", key: "stl", sessionId: "one" });
    original!.postMessage({ type: "derive-cancel" }); await vi.waitFor(() => expect(derivedSignal?.aborted).toBe(true));
    expect(host.contains(frame)).toBe(true); original!.close();
    const panel = host.children[0]; panel.children.at(-1)!.children[1].onclick!();
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
    mountArtifactStream(host as any, frame as any, '/selected', () => ({}), () => true, ready, 'inline', { selection: 'selected', key: 'stl', sessionId: 'one' });
    await vi.waitFor(() => expect(frame.onload).toBeTypeOf('function')); frame.onload!();
    await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
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
    original!.close(); host.children[0].children.at(-1)!.children[1].onclick!();
  });
  it("aborts a pending size probe when the preview is removed or session changes", () => {
    const { host, frame } = dom();
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", (_: string, options: any) => { signal = options.signal; return new Promise(() => {}); });
    let current = true;
    mountArtifactStream(host as any, frame as any, "/selected", () => ({}), () => current);
    current = false; mutation();
    expect(signal?.aborted).toBe(true);
  });
});
