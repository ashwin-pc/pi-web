import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createPiAdapter } from "../server/session/adapters/pi/index.js";
import { LocalSessionService } from "../server/session/service.js";
import type { SessionServiceEvent } from "../server/session/dto.js";

let root: string | undefined;
let service: LocalSessionService | undefined;
afterEach(async () => {
  await service?.disposeAll(); service = undefined;
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

it("uses the actual Pi SDK for startup, extension commands, identity and disposal without inference", async () => {
  root = await mkdtemp(join(tmpdir(), "pi-web-pi-adapter-sdk-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  await mkdir(agentDir); await mkdir(cwd);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("PI_WEB_SETTINGS_FILE", join(root, "settings.json"));
  const hostToken = randomUUID();
  vi.stubEnv("PI_WEB_TOKEN", hostToken);
  const extension = join(root, "sdk-fixture.ts");
  await writeFile(extension, `export default function (pi) {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.web.setFooter("sdk-fixture", "Actual SDK extension");
      ctx.ui.notify("SDK startup", "info");
      ctx.ui.notify("SDK identity: " + ctx.sessionManager.getSessionId(), "info");
    });
    pi.registerCommand("sdk-no-inference", {
      description: "Local fixture command",
      handler: async (_args, ctx) => {
        ctx.ui.notify("SDK host token available: " + Boolean(process.env.PI_WEB_TOKEN), "info");
        ctx.ui.notify("SDK command handled", "info");
      },
    });
    pi.on("session_shutdown", (_event, ctx) => { ctx.ui.notify("SDK shutdown", "info"); });
  }\n`);
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore() });
  const pi = createPiAdapter({ modelRuntime, additionalExtensionPaths: () => [extension], defaultsFor: async () => ({}), globalCwd: () => cwd, clientCount: () => 1 });
  service = new LocalSessionService({ pi, nativeBindingsFile: join(root, "native.json"), globalCwd: () => cwd, finalizeCreatedSession: async () => undefined });
  const events: SessionServiceEvent[] = [];
  service.subscribe((event) => events.push(event));
  const handle = await service.initialize();
  const state = handle.state();
  expect(state.harnessId).toBe("pi");
  expect(state.stats.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
  expect(state.nativeSession.sessionId).toBe(state.sessionId);
  expect(state.sessionId).toMatch(/^[a-f\d-]{36}$/i);
  expect(events).toContainEqual(expect.objectContaining({ type: "wire", value: expect.objectContaining({ payload: { message: `SDK identity: ${state.sessionId}`, notifyType: "info" } }) }));
  expect(service.webUiEntries(handle).webContributions).toContainEqual(expect.objectContaining({ key: "sdk-fixture", slot: "footer" }));
  expect(await service.commands(handle.sessionId)).toContainEqual(expect.objectContaining({ name: "sdk-no-inference", source: "extension" }));
  const receipt = await service.prompt(handle.sessionId, { message: "/sdk-no-inference", mode: "steer", attachments: [] });
  expect(receipt.acknowledgement).toBe("not-exposed");
  await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "wire", value: expect.objectContaining({ type: "interaction_effect", kind: "notify", payload: { message: "SDK command handled", notifyType: "info" } }) })));
  await vi.waitFor(() => expect(handle.state().phase).toBe("idle"));
  expect(events).toContainEqual(expect.objectContaining({ type: "wire", value: expect.objectContaining({ payload: { message: "SDK host token available: true", notifyType: "info" } }) }));
  expect(process.env.PI_WEB_TOKEN === hostToken).toBe(true); // Never log the value, even on failure.
  expect(events.some((event) => event.type === "agent" && event.event.type === "agent_start")).toBe(false);
  expect(handle.state().stats.tokens).toEqual(state.stats.tokens);
  expect(receipt).not.toHaveProperty("nativeExecutionId");
  await service.disposeAll();
  expect(events).toContainEqual(expect.objectContaining({ type: "wire", value: expect.objectContaining({ payload: { message: "SDK shutdown", notifyType: "info" } }) }));
  expect(events).toContainEqual(expect.objectContaining({ type: "shutdown", sessionId: handle.sessionId }));
}, 15_000);
