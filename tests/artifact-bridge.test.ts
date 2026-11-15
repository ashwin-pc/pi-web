import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { ArtifactBridges, bridgeJson } from "../server/extensions/artifactBridge.js";
import { ArtifactDerivations } from "../server/extensions/artifactDerived.js";
import { RealtimeHub } from "../server/realtime.js";
import { createWebUiBridge } from "../server/extensions/webUi.js";
import { artifactBridgePreview } from "./fixtures/artifact-bridge-preview.js";
import type { PiWebArtifactConnect, PiWebArtifactConnection, PiWebJson } from "../src/extensions.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(connect: PiWebArtifactConnect = () => ({ request: request => request.payload ?? null })) {
  const dir = await mkdtemp(join(tmpdir(), "preview-bridge-")); cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, "fixture.notes"); await writeFile(source, "selected source");
  const selections = new ArtifactDerivations();
  const selection = selections.select({ sessionId: "session", key: "notes", registration: "registration", bridge: true, derived: false,
    artifact: { name: "fixture.notes", path: "/api/artifacts/fixture.notes", kind: "file" }, url: "/selected" });
  selections.bind(selection, "session", "/selected", source);
  const events: Record<string, unknown>[] = [];
  let socketClose = () => {};
  const socketCloses: (() => void)[] = [];
  const registry = new ArtifactBridges(selections, (socket, owner) => socket === "socket" && owner === "owner" ? {
    send: event => { events.push(event as Record<string, unknown>); return true; },
    onClose: close => { socketClose = close; socketCloses.push(close); return () => { socketClose = () => {}; }; },
  } : undefined, (_session, selected, options) => connect(selected.artifact as Parameters<PiWebArtifactConnect>[0], options));
  cleanup.push(() => registry.releaseSession("session"));
  const signal = new AbortController().signal;
  const invoke = (input: Record<string, unknown>, owner = "owner", session = "session", key = "notes", requestSignal = signal) => registry.invoke(owner, session, key, input, requestSignal);
  const open = () => invoke({ operation: "open", socket: "socket", selection });
  return { source, selections, selection, events, registry, invoke, open, socketCloses, disconnect: () => socketClose() };
}

describe("preview-scoped command/event bridge", () => {
  for (const outcome of ["resolve", "reject"] as const) for (const abortOldOpen of [false, true]) {
    it(`protects reused preview IDs from old connect ${outcome}${abortOldOpen ? " and opening-request abort" : ""}`, async () => {
      let resolve!: (handler: PiWebArtifactConnection) => void;
      let reject!: (error: Error) => void;
      const gate = new Promise<PiWebArtifactConnection>((yes, no) => { resolve = yes; reject = no; });
      const options: Parameters<PiWebArtifactConnect>[1][] = [];
      const replacementHandler = { request: () => ({ replacement: true }) };
      const s = await fixture((_artifact, connection) => {
        options.push(connection);
        return options.length === 1 ? gate : replacementHandler;
      });
      const preview = "11111111-1111-4111-8111-111111111111";
      const opening = new AbortController();
      const open = { operation: "open", preview, socket: "socket", selection: s.selection };
      const timers = vi.spyOn(globalThis, "setTimeout");
      const oldResult = s.invoke(open, "owner", "session", "notes", opening.signal).then(() => null, error => error);
      const oldTimers = timers.mock.calls.map(([callback]) => callback);
      await s.invoke({ operation: "close", preview });
      expect(options[0].signal.aborted).toBe(true);
      await expect(s.invoke(open)).resolves.toEqual({ preview });
      const oldSocketClose = s.socketCloses[0];
      try {
        if (abortOldOpen) opening.abort();
        oldSocketClose(); // A queued callback can still run after its listener was detached.
        for (const callback of oldTimers) callback(); // Likewise for already-queued expiry callbacks.
        expect(options[0].emit({ stale: true })).toBe(false);
        expect(options[1].signal.aborted).toBe(false);
        if (outcome === "resolve") resolve({ request: () => ({ stale: true }) });
        else reject(new Error("old connect failed"));
        expect(await oldResult).toMatchObject({ status: 422 });
        opening.abort(); // Also harmless after old opening cleanup has completed.
        expect(options[1].signal.aborted).toBe(false);
        await expect(s.invoke({ operation: "request", preview, id: "replacement", command: "echo" })).resolves.toEqual({ result: { replacement: true } });
        expect(options[1].emit({ live: true })).toBe(true);
        expect(s.events.filter(event => event.closed)).toHaveLength(1);
        s.registry.releaseSession("session");
        expect(options[1].signal.aborted).toBe(true);
        expect(options[0].emit(null)).toBe(false);
        expect(options[1].emit(null)).toBe(false);
        expect(s.registry).toMatchObject({ connecting: 0, pending: 0 });
        expect((s.registry as unknown as { connections: Map<string, unknown> }).connections.size).toBe(0);
      } finally { timers.mockRestore(); resolve(replacementHandler); await oldResult; }
    });
  }
  it("keeps asynchronous events alive after a request completes without tool/chat callbacks", async () => {
    let emit!: (event: PiWebJson) => boolean;
    const s = await fixture((_artifact, options) => { emit = options.emit; return { request: request => request.payload ?? null }; });
    const { preview } = await s.open();
    await expect(s.invoke({ operation: "request", preview, id: "request-1", command: "echo", payload: { text: "hello" } })).resolves.toEqual({ result: { text: "hello" } });
    await new Promise(resolve => setTimeout(resolve, 1));
    expect(emit({ changed: true })).toBe(true);
    expect(s.events).toEqual([{ type: "artifact_bridge_event", preview, event: { changed: true } }]);
    await s.invoke({ operation: "close", preview });
    expect(emit({ changed: false })).toBe(false);
  });
  it("binds owner, exact socket, session, key and selected-source capability", async () => {
    const s = await fixture();
    await expect(s.invoke({ operation: "open", socket: "other-tab", selection: s.selection })).rejects.toMatchObject({ status: 403 });
    await expect(s.invoke({ operation: "open", socket: "socket", selection: s.selection }, "intruder")).rejects.toMatchObject({ status: 403 });
    const { preview } = await s.open();
    const request = { operation: "request", preview, id: "a", command: "read" };
    await expect(s.invoke(request, "intruder")).rejects.toMatchObject({ status: 403 });
    await expect(s.invoke(request, "owner", "other-session")).rejects.toMatchObject({ status: 403 });
    await expect(s.invoke(request, "owner", "session", "other-key")).rejects.toMatchObject({ status: 403 });
    await expect(s.invoke({ ...request, preview: "invented" })).rejects.toMatchObject({ status: 403 });
    await writeFile(s.source, "changed source");
    await expect(s.invoke(request)).rejects.toMatchObject({ status: 409 });
  });
  it("does not enable derivation merely because a bridge selection exists", async () => {
    const s = await fixture();
    await expect(s.selections.derive(s.selection, "session", "notes", new AbortController().signal, async () => {})).rejects.toMatchObject({ status: 403 });
  });
  it("propagates command cancellation, HTTP disconnect and preview/socket closure", async () => {
    const signals: AbortSignal[] = [];
    const s = await fixture((_artifact, options) => { signals.push(options.signal); return { request: (_request, command) => {
      signals.push(command.signal);
      return new Promise((_resolve, reject) => command.signal.addEventListener("abort", () => reject(Error("private path /secret")), { once: true }));
    } }; });
    const { preview } = await s.open();
    const first = s.invoke({ operation: "request", preview, id: "first", command: "wait" });
    const firstResult = expect(first).rejects.toMatchObject({ message: "Preview request cancelled" });
    await s.invoke({ operation: "cancel", preview, id: "first" }); await firstResult;
    const disconnect = new AbortController();
    const second = s.invoke({ operation: "request", preview, id: "second", command: "wait" }, "owner", "session", "notes", disconnect.signal);
    const secondResult = expect(second).rejects.toMatchObject({ message: "Preview request cancelled" });
    disconnect.abort(); await secondResult;
    const third = s.invoke({ operation: "request", preview, id: "third", command: "wait" });
    const thirdResult = expect(third).rejects.toMatchObject({ message: "Preview request cancelled" });
    s.disconnect(); await thirdResult;
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });
  it("retains admission for noncooperative requests until they settle and suppresses late replies", async () => {
    let finish!: (value: PiWebJson) => void;
    const gate = new Promise<PiWebJson>(resolve => { finish = resolve; });
    const s = await fixture(() => ({ request: () => gate }));
    const { preview } = await s.open();
    const pending = Array.from({ length: 16 }, (_, i) => s.invoke({ operation: "request", preview, id: `r${i}`, command: "wait" }));
    const settled = Promise.allSettled(pending);
    await s.invoke({ operation: "cancel", preview, id: "r0" });
    await expect(s.invoke({ operation: "request", preview, id: "extra", command: "wait" })).rejects.toMatchObject({ status: 429 });
    await s.invoke({ operation: "close", preview });
    finish(null);
    expect((await settled).every(result => result.status === "rejected")).toBe(true);
  });
  it("retains the global 256-request budget across closed noncooperating previews", async () => {
    let finish!: (value: PiWebJson) => void;
    const gate = new Promise<PiWebJson>(resolve => { finish = resolve; });
    const s = await fixture(() => ({ request: () => gate }));
    const pending: Promise<unknown>[] = [];
    for (let connection = 0; connection < 16; connection++) {
      const { preview } = await s.open();
      for (let request = 0; request < 16; request++) {
        pending.push(s.invoke({ operation: "request", preview, id: `r${request}`, command: "wait" }));
      }
      await s.invoke({ operation: "close", preview });
    }
    const settled = Promise.allSettled(pending);
    const { preview } = await s.open();
    try {
      await expect(s.invoke({ operation: "request", preview, id: "extra", command: "wait" })).rejects.toMatchObject({ status: 429 });
    } finally { finish(null); }
    expect((await settled).every(result => result.status === "rejected")).toBe(true);
    await expect(s.invoke({ operation: "request", preview, id: "released", command: "wait" })).resolves.toEqual({ result: null });
    expect(s.registry).toMatchObject({ pending: 0 });
  });
  it("bounds JSON, sanitizes errors, and closes event floods", async () => {
    let emit!: (event: PiWebJson) => boolean;
    const s = await fixture((_artifact, options) => { emit = options.emit; return { request: () => { throw Error("private /home/secret"); } }; });
    const { preview } = await s.open();
    await expect(s.invoke({ operation: "request", preview, id: "a", command: "read" })).rejects.toMatchObject({ message: "Preview request failed" });
    await expect(s.invoke({ operation: "request", preview, id: "b", command: "read", payload: "x".repeat(65536) })).rejects.toMatchObject({ status: 400 });
    for (let i = 0; i < 32; i++) expect(emit(i)).toBe(true);
    expect(emit(33)).toBe(false);
    expect(emit(34)).toBe(false);
    for (const invalid of [NaN, Infinity, undefined, new Date(), { nested: undefined }]) expect(() => bridgeJson(invalid)).toThrow();
    expect(() => bridgeJson("x".repeat(65536))).toThrow();
  });
  it("registration invalidation closes only the matching key", async () => {
    const s = await fixture();
    const secondSelection = s.selections.select({ sessionId: "session", key: "second", registration: "second-registration", bridge: true,
      artifact: { name: "fixture.notes", path: "/api/artifacts/fixture.notes", kind: "file" }, url: "/selected" });
    s.selections.bind(secondSelection, "session", "/selected", s.source);
    const first = await s.open();
    const second = await s.invoke({ operation: "open", socket: "socket", selection: secondSelection }, "owner", "session", "second");
    s.registry.releaseSession("session", "notes");
    await expect(s.invoke({ operation: "request", preview: first.preview, id: "a", command: "echo" })).rejects.toMatchObject({ status: 403 });
    await expect(s.invoke({ operation: "request", preview: second.preview, id: "a", command: "echo" }, "owner", "session", "second")).resolves.toEqual({ result: null });
  });
  it("caps preview lifetime at the selected capability expiry", async () => {
    const s = await fixture();
    const selected = s.selections.selected(s.selection, "session", "notes");
    selected.expires = Date.now() + 10;
    const { preview } = await s.open();
    await new Promise(resolve => setTimeout(resolve, 20));
    await expect(s.invoke({ operation: "request", preview, id: "expired", command: "echo" })).rejects.toMatchObject({ status: 403 });
  });
  it("expiry/session invalidation disables retained event emitters", async () => {
    let emit!: (event: PiWebJson) => boolean;
    const s = await fixture((_artifact, options) => { emit = options.emit; return { request: () => null }; });
    await s.open(); s.selections.releaseSession("session");
    expect(emit(null)).toBe(false);
  });
});

it("connect registration requires rendered opt-in, checks session context, and proactively invalidates replacements/unload", async () => {
  let ui: any;
  const emit = vi.fn();
  const invalidateArtifactPreview = vi.fn();
  const bridge = createWebUiBridge({ emit, invalidateArtifactPreview, clientCount: () => 1,
    withWorkLease: (_session: unknown, _label: string, operation: () => Promise<unknown>) => operation(),
    createNewSession: async () => ({}), sessionCwd: () => process.cwd(), state: () => ({}) } as never);
  const session = { sessionId: "one", sessionFile: "/tmp/one.jsonl", agent: { waitForIdle: async () => {} }, bindExtensions: async (options: any) => { ui = options.uiContext; } };
  await bridge.bind(session);
  const artifact = { name: "notes.gcode", path: "/api/session-artifacts/one/notes.gcode", kind: "file" };
  ui.web.contribute("notes", artifactBridgePreview);
  const result = await bridge.invokeContribution(session, { slot: "artifact-preview", key: "notes", event: { context: artifact } }) as Record<string, unknown>;
  expect(result.artifactBridge).toBe(true); expect(result.artifactBytes).toBeUndefined();
  const input = { key: "notes", registration: String(result.registration), artifact };
  const options = { source: "/core/selected/source", signal: new AbortController().signal, emit: () => true };
  const connected = await bridge.connectArtifactPreview(session, input, options);
  expect(connected.request).toBeTypeOf("function");
  expect(() => bridge.connectArtifactPreview(session, { ...input, artifact: { ...artifact, path: "/api/session-artifacts/two/notes.gcode" } }, options)).toThrow("Invalid artifact context");
  emit.mockClear(); ui.web.contribute("notes", artifactBridgePreview);
  expect(invalidateArtifactPreview).toHaveBeenCalledWith("one", "notes");
  expect(emit.mock.calls.some(([event]) => event.type === "artifact_preview_invalidated")).toBe(false);
  expect(() => bridge.connectArtifactPreview(session, input, options)).toThrow("registration changed");
  ui.web.contribute("notes", { ...artifactBridgePreview, connect: undefined });
  const disabled = await bridge.invokeContribution(session, { slot: "artifact-preview", key: "notes", event: { context: artifact } }) as Record<string, unknown>;
  expect(disabled.artifactBridge).toBeUndefined();
  emit.mockClear(); bridge.releaseSessionSettings(session);
  expect(invalidateArtifactPreview).toHaveBeenCalledWith("one");
  expect(emit.mock.calls.some(([event]) => event.type === "artifact_preview_invalidated")).toBe(false);
});

it("live-targeted websocket delivery is exact-socket, bounded and never recorded/replayed/onBroadcast", () => {
  class Socket extends EventEmitter {
    OPEN = 1; readyState = 1; bufferedAmount = 0; sent: string[] = [];
    send(value: string) { this.sent.push(value); }
  }
  const broadcast = vi.fn();
  const hub = new RealtimeHub(0, 1, broadcast);
  const one = new Socket(), two = new Socket();
  hub.attach(one as never, 0); hub.attach(two as never, 0);
  const id = hub.bindTarget(one as never, "owner");
  const target = hub.target(id, "owner")!;
  expect(hub.target(id, "other-owner")).toBeUndefined();
  expect(target.send({ type: "artifact_bridge_event", event: "private" })).toBe(true);
  expect(one.sent).toHaveLength(1); expect(two.sent).toHaveLength(0);
  expect(hub.latestSeq).toBe(0); expect(broadcast).not.toHaveBeenCalled();
  hub.broadcast({ type: "normal" });
  const reconnect = new Socket(); hub.attach(reconnect as never, 1);
  expect(reconnect.sent).toEqual([]);
  expect(broadcast).toHaveBeenCalledTimes(1);
  one.bufferedAmount = 256 * 1024 + 1;
  expect(target.send({ event: "slow" })).toBe(false);
  one.emit("close"); expect(hub.target(id, "owner")).toBeUndefined();
});
