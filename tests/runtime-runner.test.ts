import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { StdioRuntimeClient } from "../server/runtime/stdioClient.js";
import type { RuntimeRequestHandler } from "../server/runtime/protocol.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function tempRepo() {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-runtime-runner-"));
  tempDirs.push(dir);
  await mkdir(join(dir, "src"));
  await mkdir(join(dir, "docs"));
  await writeFile(join(dir, "README.md"), "runtime spike\n");
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: dir });
  await execFileAsync("git", ["add", "README.md"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

function createClient(cwd: string, env: Record<string, string> = {}, runtimeRequestHandler?: RuntimeRequestHandler) {
  return new StdioRuntimeClient(process.execPath, ["--import", "tsx", "server/runner.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, PI_RUNNER_CWD: cwd, PI_CODING_AGENT_DIR: join(cwd, ".pi", "agent"), ...env },
    runtimeRequestHandler,
  });
}

function waitForEvent(client: StdioRuntimeClient, predicate: (event: any) => boolean, timeoutMs = 15_000) {
  return new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for runtime event"));
    }, timeoutMs);
    const unsubscribe = client.onEvent((event) => {
      if (!predicate(event)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(event);
    });
  });
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("runtime runner spike", () => {
  it("serves health, filesystem, git, artifacts, and events over stdio", async () => {
    const cwd = await tempRepo();
    const client = createClient(cwd);
    const ready = new Promise((resolve) => client.onEvent((event) => event.event === "ready" && resolve(event)));
    try {
      await expect(ready).resolves.toMatchObject({ event: "ready" });
      await expect(client.request("health")).resolves.toMatchObject({
        ok: true,
        cwd,
        protocol: "pi-runner-v2",
        modelTransport: "runtime",
        capabilities: { messageBranching: true, sessionRename: false, slashCommands: false, shellCommands: false, sessionStats: false, gitPanel: false, gitSync: false, extensionUi: false, compactionCancel: false },
      });

      const listing = await client.request<any>("fs.list", { path: cwd });
      expect(listing.dirs.map((dir: any) => dir.name)).toEqual(expect.arrayContaining(["docs", "src"]));

      const status = await client.request<any>("git.status", { cwd });
      expect(status).toMatchObject({ ok: true, cwd, isRepo: true });

      await expect(client.request("artifacts.write", { cwd, name: "spike.txt", text: "hello from runner" })).resolves.toMatchObject({ ok: true, name: "spike.txt" });
      await expect(client.request("artifacts.read", { cwd, name: "spike.txt" })).resolves.toMatchObject({ ok: true, name: "spike.txt", text: "hello from runner" });

      const createdEvent = waitForEvent(client, (event) => event.event === "session.created");
      const created = await client.request<any>("sessions.create", { cwd });
      expect(created).toMatchObject({ ok: true, cwd, isStreaming: false, isCompacting: false });
      expect(created.sessionId).toBeTruthy();
      await expect(createdEvent).resolves.toMatchObject({ event: "session.created", data: { sessionId: created.sessionId } });
      await expect(client.request("sessions.subscribe", { sessionId: created.sessionId })).resolves.toMatchObject({ ok: true, sessionId: created.sessionId });
      await expect(client.request("sessions.state", { sessionId: created.sessionId })).resolves.toMatchObject({ ok: true, sessionId: created.sessionId, cwd });
      const second = await client.request<any>("sessions.create", { cwd });
      const listed = await client.request<any>("sessions.list", { limit: 1 });
      expect(listed).toMatchObject({ ok: true, total: 2, sessions: [{ cwd }], nextCursor: "1" });
      const secondPage = await client.request<any>("sessions.list", { limit: 1, cursor: listed.nextCursor });
      expect(secondPage).toMatchObject({ ok: true, total: 2, sessions: [{ cwd }] });
      expect(new Set([...listed.sessions, ...secondPage.sessions].map((item: any) => item.sessionId))).toEqual(new Set([created.sessionId, second.sessionId]));
      await expect(client.request("sessions.messages", { sessionId: created.sessionId })).resolves.toMatchObject({ ok: true, sessionId: created.sessionId });
      await expect(client.request("sessions.abort", { sessionId: created.sessionId })).resolves.toMatchObject({ ok: true, sessionId: created.sessionId });
      await expect(client.request("sessions.delete", { sessionId: created.sessionId, sessionFile: created.sessionFile })).resolves.toMatchObject({ ok: true, sessionId: created.sessionId });
      await expect(client.request("sessions.delete", { sessionId: second.sessionId, sessionFile: second.sessionFile })).resolves.toMatchObject({ ok: true, sessionId: second.sessionId });
      await expect(access(created.sessionFile)).rejects.toThrow();
    } finally {
      client.close();
    }
  }, 60_000);

  it("accepts image prompts and rejects empty prompts", async () => {
    const cwd = await tempRepo();
    const client = createClient(cwd);
    try {
      const created = await client.request<any>("sessions.create", { cwd });
      const promptEvent = waitForEvent(client, (event) => event.event === "session.prompt.start" || event.event === "session.prompt.error");
      await expect(client.request("sessions.prompt", {
        sessionId: created.sessionId,
        message: "",
        images: [{ type: "image", mimeType: "image/png", data: Buffer.from("png").toString("base64") }],
      })).resolves.toMatchObject({ ok: true, sessionId: created.sessionId });
      await expect(promptEvent).resolves.toMatchObject({ event: expect.stringMatching(/^session\.prompt\.(start|error)$/) });
      await expect(client.request("sessions.prompt", { sessionId: created.sessionId, message: "", images: [] })).rejects.toThrow(/message or image is required/);
    } finally {
      client.close();
    }
  }, 60_000);

  it("retries broker initialization after a transient host catalog failure", async () => {
    const cwd = await tempRepo();
    let attempts = 0;
    const runtimeRequestHandler: RuntimeRequestHandler = async (request) => {
      if (request.method !== "host.models.list") throw new Error("Unexpected host method");
      attempts += 1;
      if (attempts === 1) throw new Error("temporary catalog failure");
      return { ok: true, models: [] };
    };
    const client = createClient(cwd, { PI_RUNNER_MODEL_BROKER: "1" }, runtimeRequestHandler);
    try {
      await expect(client.request("health")).rejects.toThrow(/temporary catalog failure/);
      await expect(client.request("health")).resolves.toMatchObject({ modelTransport: "host-broker" });
      expect(attempts).toBe(2);
    } finally {
      client.close();
    }
  });

  it("streams an approved host model without runtime credentials", async () => {
    const cwd = await tempRepo();
    const brokerRequests: any[] = [];
    const model = {
      provider: "test-host",
      id: "broker-model",
      name: "Broker Model",
      reasoning: false,
      input: ["text"] as const,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_000,
      maxTokens: 4_000,
    };
    const runtimeRequestHandler: RuntimeRequestHandler = async (request, transport) => {
      if (request.method === "host.models.list") return { ok: true, models: [model] };
      if (request.method === "host.models.abort") return { ok: true };
      if (request.method !== "host.models.stream") throw new Error("Unexpected host method");
      brokerRequests.push(request.params);
      const message = {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "hello from host broker" }],
        api: "openai-responses",
        provider: model.provider,
        model: model.id,
        usage: { input: 1, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop" as const,
        timestamp: Date.now(),
      };
      transport.sendEvent("host.models.stream.event", { requestId: request.id, event: { type: "start", partial: { ...message, content: [] } } });
      transport.sendEvent("host.models.stream.event", { requestId: request.id, event: { type: "done", reason: "stop", message } });
      return { ok: true };
    };
    const client = createClient(cwd, {
      PI_RUNNER_MODEL_BROKER: "1",
      OPENAI_API_KEY: "must-not-be-used",
      AWS_PROFILE: "ambient-profile-must-not-be-visible",
      GOOGLE_CLOUD_PROJECT: "ambient-project-must-not-be-visible",
    }, runtimeRequestHandler);
    try {
      await expect(client.request("health")).resolves.toMatchObject({ modelTransport: "host-broker" });
      const created = await client.request<any>("sessions.create", { cwd });
      const listedModels = await client.request<any>("models.list", { sessionId: created.sessionId });
      expect(listedModels.models.map(({ provider, id }: any) => ({ provider, id }))).toEqual([{ provider: model.provider, id: model.id }]);
      const done = waitForEvent(client, (event) => event.event === "session.prompt.done");
      await client.request("sessions.prompt", { sessionId: created.sessionId, message: "hello", images: [] });
      await expect(done).resolves.toMatchObject({ event: "session.prompt.done" });
      const messages = await client.request<any>("sessions.messages", { sessionId: created.sessionId });
      expect(messages.messages.at(-1)).toMatchObject({ role: "assistant", content: [{ text: "hello from host broker" }] });
      expect(messages.entryIds).toHaveLength(messages.messages.length);
      expect(messages.entryIds).toEqual(messages.entryIds.map(() => expect.any(String)));
      expect(brokerRequests).toHaveLength(1);
      expect(brokerRequests[0]).toMatchObject({ provider: model.provider, id: model.id });
      expect(JSON.stringify(brokerRequests[0])).not.toContain("must-not-be-used");
    } finally {
      client.close();
    }
  }, 60_000);

  it("rejects artifacts over the configured base64 read cap", async () => {
    const cwd = await tempRepo();
    const client = createClient(cwd, { PI_RUNNER_MAX_ARTIFACT_BYTES: "4" });
    try {
      await client.request("artifacts.write", { cwd, name: "large.txt", text: "12345" });
      await expect(client.request("artifacts.readBase64", { cwd, name: "large.txt" })).rejects.toThrow(/Artifact is too large/);
    } finally {
      client.close();
    }
  }, 60_000);
});
