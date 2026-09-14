import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createPiAdapter } from "../server/session/adapters/pi/index.js";
import { createCodexAdapter } from "../server/session/adapters/codex/index.js";
import { LocalSessionService } from "../server/session/service.js";
import { createHostSessionEventHandler } from "../server/session/hostEvents.js";
import { SessionActivity } from "../server/session/activity.js";
import { controlPeer, peerForThread, readObserved, waitObserved } from "./fixtures/codex-peer-control.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-web-codex-service-"));
  const services: LocalSessionService[] = [];
  cleanups.push(async () => { await Promise.all(services.map((service) => service.disposeAll())); await rm(root, { recursive: true, force: true }); });
  vi.stubEnv("PI_WEB_SETTINGS_FILE", join(root, "pi-settings.json"));
  const piFallback = vi.fn(async () => { throw new Error("Unexpected Pi fallback"); });
  const native = createCodexAdapter({ command: process.execPath, args: [fileURLToPath(new URL("./fixtures/codex-app-server-peer.mjs", import.meta.url))],
    env: { ...process.env, PI_WEB_CODEX_PEER_DIR: root } });
  const makeService = () => {
    // Real Pi adapter remains registered, but no Pi session/model is needed for this native test.
    const pi = createPiAdapter({ modelRuntime: { getAvailableSnapshot: () => [] } as unknown as ModelRuntime,
      peer: { create: piFallback, list: async () => [] }, additionalExtensionPaths: () => [], defaultsFor: async () => ({}), globalCwd: () => root, clientCount: () => 2 });
    const service = new LocalSessionService({ pi, adapters: [native], nativeBindingsFile: join(root, "bindings.json"), multiHarnessEnabled: true,
      globalCwd: () => root, finalizeCreatedSession: async () => undefined });
    services.push(service);
    return service;
  };
  return { root, service: makeService(), makeService, native, piFallback };
}

describe("Codex production service, host relay and native process ingress", () => {
  it("uses the common handle lifecycle and host event path for stream, decisions and exact interrupt", async () => {
    const { root, service, piFallback } = await fixture();
    const state = await service.create(undefined, root, "codex");
    expect(state.sessionId).not.toBe(state.nativeSession?.sessionId);
    expect(state.sessionFile).toBeUndefined();
    const peer = await peerForThread(root, state.nativeSession!.sessionId!);
    const activity = new SessionActivity((id) => service.sessionForPath(id)?.state());
    const wire: Array<Record<string, any>> = [];
    service.subscribe(createHostSessionEventHandler({ sessionForId: (id) => service.sessionForId(id), projectState: (handle) => service.projectState(handle),
      webUiEntries: (handle) => service.webUiEntries(handle), sessionActivity: activity,
      broadcast: (event) => wire.push(event as Record<string, any>), markSessionUnreadCompleted: () => undefined }));
    const receipt = await service.prompt(state.sessionId, { message: "Real service input", mode: "prompt", attachments: [], clientMessageId: "browser-input" });
    expect(receipt.acknowledgement).toBe("accepted");
    expect(receipt.nativeExecutionId).toBeTruthy();
    await controlPeer(peer, { action: "thinking", delta: "Native reasoning" });
    await controlPeer(peer, { action: "text", delta: "Native text", done: true });
    await controlPeer(peer, { action: "approval", requestId: "native-approval", decisions: ["accept", "decline", "cancel"] });
    const pending = (await service.state(state.sessionId)).pendingInteractions![0]!;
    expect(wire.some((event) => event.type === "message_delta" && event.delta === "Native text")).toBe(true);
    expect(wire.some((event) => event.type === "interaction_request" && event.id === pending.id)).toBe(true);
    expect(service.respondInteraction({ id: pending.id, sessionId: "other-session", choiceID: "accept" })).toBe(false);
    expect(service.respondInteraction({ id: pending.id, sessionId: state.sessionId, choiceID: "decline" })).toBe(true);
    expect(service.respondInteraction({ id: pending.id, sessionId: state.sessionId, choiceID: "accept" })).toBe(false);
    await waitObserved(peer, (record) => record.direction === "client" && record.message.id === "native-approval" && record.message.result?.decision === "decline");
    expect(wire.some((event) => event.type === "interaction_resolved" && event.id === pending.id)).toBe(true);
    await expect(service.prompt(state.sessionId, { message: "Concurrent", mode: "prompt", attachments: [] })).rejects.toMatchObject({ status: 409 });
    await expect(service.prompt(state.sessionId, { message: "Steer", mode: "steer", attachments: [], expectedExecutionId: receipt.executionId })).rejects.toMatchObject({ status: 400 });
    await expect(service.abort(state.sessionId, "stale-host-guard")).rejects.toMatchObject({ status: 409 });
    for (const unsupported of [() => service.tree(state.sessionId), () => service.models(state.sessionId), () => service.executeShell(state.sessionId, "pwd", false),
      () => service.invokePanel(state.sessionId, { key: "pi-extension" })]) await expect(unsupported()).rejects.toMatchObject({ status: 400 });
    await controlPeer(peer, { action: "configure", interrupt: "defer" });
    const interrupt = service.abort(state.sessionId, receipt.executionId);
    const request = await waitObserved(peer, (record) => record.direction === "client" && record.message.method === "turn/interrupt");
    expect(request.message.params).toEqual({ threadId: state.nativeSession!.sessionId, turnId: receipt.nativeExecutionId });
    await controlPeer(peer, { action: "complete", status: "interrupted", idle: false });
    expect(await interrupt).toMatchObject({ acknowledged: true, nativeExecutionId: receipt.nativeExecutionId });
    expect((await service.state(state.sessionId)).phase).toBe("settling");
    await controlPeer(peer, { action: "activity", status: { type: "idle" } });
    expect((await service.state(state.sessionId)).phase).toBe("idle");
    expect((await service.messages(state.sessionId)).some((message) => message.parts?.some((part) => part.type === "text" && part.text === "Native text"))).toBe(true);
    expect(wire.filter((event) => event.type === "agent_event")).toEqual([]); // No Pi-shaped parallel broadcast.
    expect(piFallback).not.toHaveBeenCalled();
  });

  it("restarts from web-owned native identity metadata and removes only that metadata", async () => {
    const { root, service, makeService, native, piFallback } = await fixture();
    const state = await service.create(undefined, root, "codex");
    const nativeId = state.nativeSession!.sessionId!;
    const peer = await peerForThread(root, nativeId);
    await service.prompt(state.sessionId, { message: "Persist this input", mode: "prompt", attachments: [] });
    await controlPeer(peer, { action: "text", delta: "Persisted native response", done: true });
    await controlPeer(peer, { action: "complete" });
    await service.rename(state.sessionId, "Web-owned title");
    await service.disposeAll();
    const metadata = JSON.parse(await readFile(join(root, "bindings.json"), "utf8"));
    expect(metadata.sessions[0]).not.toHaveProperty("messages");
    expect(metadata.sessions[0]).not.toHaveProperty("sessionFile");
    const restarted = makeService();
    const opened = await restarted.open(state.sessionId);
    expect(opened).toMatchObject({ sessionId: state.sessionId, sessionName: "Web-owned title", phase: "idle", nativeSession: { sessionId: nativeId, status: "resumable" } });
    expect((await restarted.messages(state.sessionId)).at(-1)?.text).toBe("Persisted native response");
    const resumedPeer = await peerForThread(root, nativeId);
    const requests = (await readObserved(resumedPeer)).filter((record) => record.direction === "client");
    expect(requests.some((record) => record.message.method === "thread/resume" && record.message.params.threadId === nativeId)).toBe(true);
    expect(requests.some((record) => record.message.method === "turn/start")).toBe(false);
    expect((await restarted.list())[0]).toMatchObject({ id: state.sessionId, harnessId: "codex", nativeSession: { sessionId: nativeId } });
    expect(await restarted.delete(state.sessionId)).toEqual({ id: state.sessionId, disposition: "deleted" });
    expect(await restarted.list()).toEqual([]);
    expect((await native.list(root)).some((entry) => entry.nativeSession.sessionId === nativeId)).toBe(true);
    await expect(restarted.open(state.sessionId)).rejects.toMatchObject({ status: 410 });
    expect(piFallback).not.toHaveBeenCalled();
  });
});
