import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createPiAdapter } from "../server/session/adapters/pi/index.js";
import { createKiroAdapter } from "../server/session/adapters/kiro/index.js";
import { LocalSessionService } from "../server/session/service.js";
import { createHostSessionEventHandler } from "../server/session/hostEvents.js";
import { SessionActivity } from "../server/session/activity.js";
import { controlPeer, peerForSession, readObserved, waitObserved } from "./fixtures/kiro-peer-control.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "kiro-service-")); const services: LocalSessionService[] = [];
  cleanups.push(async () => { await Promise.all(services.map((s) => s.disposeAll())); await rm(root, { recursive: true, force: true }); });
  vi.stubEnv("PI_WEB_SETTINGS_FILE", join(root, "settings.json"));
  const piFallback = vi.fn(async () => { throw Error("Unexpected Pi fallback"); });
  const native = createKiroAdapter({ command: resolve("tests/fixtures/kiro-acp-peer.mjs"), env: { ...process.env, PI_WEB_KIRO_PEER_DIR: root } });
  const make = () => {
    const pi = createPiAdapter({ modelRuntime: { getAvailableSnapshot: () => [] } as unknown as ModelRuntime,
      peer: { create: piFallback, list: async () => [] }, additionalExtensionPaths: () => [], defaultsFor: async () => ({}), globalCwd: () => root, clientCount: () => 2 });
    const service = new LocalSessionService({ pi, adapters: [native], nativeBindingsFile: join(root, "bindings.json"), multiHarnessEnabled: true,
      globalCwd: () => root, finalizeCreatedSession: async () => undefined }); services.push(service); return service;
  };
  return { root, native, make, service: make(), piFallback };
}
it("uses production service and host relay for create, prompt, approval, interrupt, process loss and explicit load", async () => {
  const { root, service, make, native, piFallback } = await fixture();
  const state = await service.create(undefined, root, "kiro"); const id = state.sessionId; const nativeId = state.nativeSession!.sessionId!;
  expect(id).not.toBe(nativeId); expect(service.catalog().defaultHarnessId).toBe("pi");
  const peer = await peerForSession(root, nativeId);
  const wire: Array<Record<string, any>> = [];
  service.subscribe(createHostSessionEventHandler({ sessionForId: (id) => service.sessionForId(id), projectState: (h) => service.projectState(h),
    webUiEntries: (h) => service.webUiEntries(h), sessionActivity: new SessionActivity((id) => service.sessionForPath(id)?.state()),
    broadcast: (e) => wire.push(e as Record<string, any>), markSessionUnreadCompleted: () => undefined }));
  const receipt = await service.prompt(id, { mode: "prompt", message: "Service input", attachments: [], clientMessageId: "browser-message" });
  expect(receipt.acknowledgement).toBe("not-exposed"); expect(receipt.nativeExecutionId).toBeUndefined();
  await controlPeer(peer, { action: "text", delta: "Retained service output" });
  await controlPeer(peer, { action: "approval", requestId: 0 });
  const pending = (await service.state(id)).pendingInteractions![0];
  expect(wire.some((e) => e.type === "message_delta" && e.delta === "Retained service output")).toBe(true);
  expect(wire.some((e) => e.type === "interaction_request" && e.id === pending.id)).toBe(true);
  expect(service.respondInteraction({ id: pending.id, sessionId: id, choiceID: "option-1" })).toBe(true);
  expect((await waitObserved(peer, (r) => r.direction === "client" && r.message.id === 0 && !!r.message.result)).message.result).toEqual({ outcome: { outcome: "selected", optionId: "native-deny" } });
  await expect(service.prompt(id, { mode: "prompt", message: "Concurrent", attachments: [] })).rejects.toMatchObject({ status: 409 });
  await expect(service.abort(id, "stale")).rejects.toMatchObject({ status: 409 });
  for (const call of [() => service.tree(id), () => service.models(id), () => service.executeShell(id, "pwd", false)]) await expect(call()).rejects.toMatchObject({ status: 400 });
  await controlPeer(peer, { action: "configure", interrupt: "defer" });
  expect(await service.abort(id, receipt.executionId)).toMatchObject({ acknowledged: true });
  expect((await service.state(id)).phase).toBe("settling");
  await controlPeer(peer, { action: "complete", reason: "cancelled" }); await expect.poll(async () => (await service.state(id)).phase).toBe("idle");
  await service.rename(id, "Web label");
  await controlPeer(peer, { action: "exit" }); await expect.poll(async () => (await service.state(id)).phase).toBe("unavailable");
  await service.state(id); await service.messages(id);
  const reopened = await service.open(id); expect(reopened).toMatchObject({ sessionId: id, sessionName: "Web label", nativeSession: { sessionId: nativeId }, phase: "idle" });
  const next = await peerForSession(root, nativeId); expect(next.pid).not.toBe(peer.pid);
  expect((await readObserved(next)).some((r) => r.message.method === "session/prompt")).toBe(false);
  expect((await service.messages(id)).some((m) => m.text === "Retained service output")).toBe(true);
  await service.disposeAll();
  const cold = make(); expect((await cold.open(id)).nativeSession?.sessionId).toBe(nativeId);
  expect((await cold.list())[0]).toMatchObject({ id, harnessId: "kiro", name: "Web label" });
  expect(await cold.delete(id)).toEqual({ id, disposition: "deleted" }); expect(await cold.list()).toEqual([]);
  expect((await native.list(root))[0].nativeSession.sessionId).toBe(nativeId);
  await expect(cold.open(id)).rejects.toMatchObject({ status: 410 });
  expect(piFallback).not.toHaveBeenCalled(); expect(wire.filter((e) => e.type === "agent_event")).toEqual([]);
  expect(JSON.parse(await readFile(join(root, "bindings.json"), "utf8")).sessions[0]).not.toHaveProperty("messages");
});
it("keeps unknown creation time absent across native binding reload and list ordering", async () => {
  const { root, service, make } = await fixture(); await service.disposeAll();
  const nativeSession = { harnessId: "kiro", sessionId: "public-native-id", persistence: "persistent", status: "resumable" };
  await writeFile(join(root, "bindings.json"), JSON.stringify({ version: 1, sessions: [
    { id: "older", cwd: root, nativeSession, modified: "2025-01-01T00:00:00Z" },
    { id: "newer", cwd: root, nativeSession: { ...nativeSession, sessionId: "public-other-id" }, modified: "2025-02-01T00:00:00Z" },
  ] }));
  const cold = make(); const list = await cold.list(); expect(list.map((r) => r.id)).toEqual(["newer", "older"]);
  expect(list.every((r) => !Object.hasOwn(r, "created"))).toBe(true);
});
