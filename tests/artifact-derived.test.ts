import { afterEach, describe, expect, it, vi } from "vitest";
import { statSync } from "node:fs";
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});
import { mkdtemp, writeFile, rm, symlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactDerivations } from "../server/extensions/artifactDerived.js";
import { createWebUiBridge } from "../server/extensions/webUi.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function setup(timeout = 1000, maxBytes = 100) {
  const root = await mkdtemp(join(tmpdir(), "derived-test-")); directories.push(root);
  const source = join(root, "model.stl"); await writeFile(source, "original");
  const store = new ArtifactDerivations(timeout, maxBytes);
  const token = store.select({ sessionId: "one", key: "stl", registration: "revision", artifact: { name: "model.stl", path: "/api/artifacts/model.stl", kind: "file" }, url: "/api/session-artifacts/one/model.stl" });
  const bind = () => store.bind(token, "one", "/api/session-artifacts/one/model.stl", source);
  const derive = (invoke: Parameters<ArtifactDerivations["derive"]>[4], signal = new AbortController().signal, session = "one", key = "stl") => store.derive(token, session, key, signal, invoke);
  return { store, token, source, bind, derive };
}
describe("derived preview registrations", () => {
  it("requires opt-in and rejects replaced registrations or mismatched contexts", async () => {
    let ui: any; let calls = 0;
    const bridge = createWebUiBridge({ emit: () => {}, clientCount: () => 1,
      withWorkLease: (_session: any, _label: string, operation: () => Promise<any>) => operation(),
      createNewSession: async () => ({}), sessionCwd: () => process.cwd(), state: () => ({}) });
    const session = { sessionId: "one", sessionFile: "/tmp/one.jsonl", agent: { waitForIdle: async () => {} }, bindExtensions: async (options: any) => { ui = options.uiContext; } };
    await bridge.bind(session);
    const artifact = { name: "model.stl", path: "/api/session-artifacts/one/model.stl", kind: "file" };
    const preview = { title: "STL", extensions: [".stl"], render: () => ({ html: "<p>model</p>", artifactBytes: true, artifactDerived: true }), derive: async () => { calls++; } };
    ui.web.setArtifactPreview("stl", preview);
    const result = await bridge.invokeContribution(session, { slot: "artifact-preview", key: "stl", event: { context: artifact } }) as any;
    expect(result.artifactDerived).toBe(true); expect(result.registration).toBeTypeOf("string");
    const options = { destination: "/private/output", signal: new AbortController().signal };
    await bridge.deriveArtifactPreview(session, { key: "stl", registration: result.registration, artifact }, options);
    expect(calls).toBe(1);
    await expect(bridge.deriveArtifactPreview(session, { key: "stl", registration: result.registration, artifact: { ...artifact, path: "/api/session-artifacts/two/model.stl" } }, options)).rejects.toThrow("Invalid artifact context");
    ui.web.setArtifactPreview("stl", preview);
    await expect(bridge.deriveArtifactPreview(session, { key: "stl", registration: result.registration, artifact }, options)).rejects.toThrow("registration changed");
    ui.web.setArtifactPreview("stl", { ...preview, derive: undefined });
    const disabled = await bridge.invokeContribution(session, { slot: "artifact-preview", key: "stl", event: { context: artifact } }) as any;
    expect(disabled.artifactDerived).toBeUndefined(); expect(calls).toBe(1);
  });
});

describe("selected artifact derivations", () => {
  it("requires original selection, same session, renderer and exact selected path", async () => {
    const s = await setup(); const invoke = async () => {};
    await expect(s.derive(invoke)).rejects.toThrow("Unselected");
    expect(() => s.store.bind(s.token, "two", "/api/session-artifacts/one/model.stl", s.source)).toThrow("unavailable");
    expect(() => s.store.bind(s.token, "one", "/api/session-artifacts/one/other.stl", s.source)).toThrow("Unselected");
    s.bind();
    await expect(s.derive(invoke, undefined, "two")).rejects.toThrow("unavailable");
    await expect(s.derive(invoke, undefined, "one", "other")).rejects.toThrow("Unselected");
  });
  it("owns the private destination and cleans successful output", async () => {
    const s = await setup(); s.bind(); let destination = "";
    const output = await s.derive(async (_selection, options) => { destination = options.destination; await writeFile(destination, "edges"); });
    expect(await output.file.readFile("utf8")).toBe("edges"); expect(output.size).toBe(5);
    expect(destination).not.toContain(".pi/web/artifacts");
    await output.cleanup(); await expect(readFile(destination)).rejects.toThrow();
  });
  it("accepts an empty derived output for an all-smooth mesh", async () => {
    const s = await setup(); s.bind();
    const output = await s.derive(async (_selection, options) => { await writeFile(options.destination, ""); });
    expect(output.size).toBe(0); await output.cleanup();
  });
  it.each(["symlink", "oversize", "missing", "throw"])("rejects and cleans %s output", async mode => {
    const s = await setup(); s.bind(); let destination = "";
    await expect(s.derive(async (_selection, options) => {
      destination = options.destination;
      if (mode === "symlink") await symlink(s.source, destination);
      else if (mode === "oversize") await writeFile(destination, Buffer.alloc(101));
      else if (mode === "throw") { await writeFile(destination, "partial"); throw new Error("failure"); }
    })).rejects.toThrow();
    await expect(readFile(destination)).rejects.toThrow();
  });
  it("evicts inactive least-recently-used selections instead of blocking preview 129", async () => {
    const s = await setup(); s.bind();
    const other = () => s.store.select({ sessionId: "one", key: "stl", registration: "revision", artifact: { name: "model.stl", path: "/api/artifacts/model.stl", kind: "file" }, url: "/api/session-artifacts/one/model.stl" });
    const second = other();
    // Refresh the original selection, making the second one least recent.
    s.bind();
    let latest = "";
    for (let i = 0; i < 127; i++) latest = other();
    expect(() => s.store.bind(second, "one", "/api/session-artifacts/one/model.stl", s.source)).toThrow("unavailable");
    expect(s.bind).not.toThrow();
    expect(() => s.store.bind(latest, "one", "/api/session-artifacts/one/model.stl", s.source)).not.toThrow();
  });
  it.each(["deleted", "permission"])("sanitizes %s source errors before invoking the handler", async mode => {
    const s = await setup(); s.bind();
    if (mode === "deleted") await rm(s.source);
    else vi.mocked(statSync).mockImplementationOnce(() => { throw new Error(`EACCES: permission denied, stat '${s.source}'`); });
    let invoked = false;
    const error = await s.derive(async () => { invoked = true; }).catch(error => error);
    expect(invoked).toBe(false); expect(error.status).toBe(409);
    expect(error.message).toBe("Source unavailable or changed; reopen the model");
    expect(error.message).not.toContain(s.source);
    expect(error.message).not.toMatch(/ENOENT|EACCES/);
  });
  it("rejects same-size mutation between probe, stream, and derive", async () => {
    const s = await setup(); const check = s.bind(); await writeFile(s.source, "modified");
    expect(check).toThrow("Source changed"); expect(s.bind).toThrow("Source changed");
    await expect(s.derive(async () => {})).rejects.toThrow("Source changed");
  });
  it("rejects mutation during generation and cleans output", async () => {
    const s = await setup(); s.bind(); let destination = "";
    await expect(s.derive(async (_selection, options) => {
      destination = options.destination; await writeFile(destination, "edges"); await writeFile(s.source, "modified");
    })).rejects.toThrow("Source changed");
    await expect(readFile(destination)).rejects.toThrow();
  });
  it.each(["abort", "timeout", "session"])("cancels generation on %s with cleanup", async mode => {
    const s = await setup(30); s.bind(); const controller = new AbortController(); let destination = "";
    const work = s.derive(async (_selection, options) => {
      destination = options.destination; await writeFile(destination, "partial");
      if (mode === "abort") controller.abort(new Error("cancelled"));
      if (mode === "session") s.store.releaseSession("one");
      await new Promise<void>((resolve) => { options.signal.addEventListener("abort", () => resolve(), { once: true }); if (options.signal.aborted) resolve(); });
      options.signal.throwIfAborted();
    }, controller.signal);
    await expect(work).rejects.toThrow(); await expect(readFile(destination)).rejects.toThrow();
  });
  it("rejects duplicate generation without invoking a second handler", async () => {
    const s = await setup(); s.bind(); let finish!: () => void;
    const running = s.derive(async (_selection, options) => { await new Promise<void>(resolve => { finish = resolve; }); await writeFile(options.destination, "edges"); });
    await expect(s.derive(async () => { throw new Error("should not run"); })).rejects.toThrow("busy");
    while (!finish) await new Promise(resolve => setTimeout(resolve, 1));
    finish(); await (await running).cleanup();
  });
});
