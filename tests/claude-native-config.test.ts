import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Options, Query, SDKResultMessage, SDKSystemMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_CODE_VERSION, createClaudeQuery } from "../server/session/adapters/claude/native.js";
import { createClaudeAdapter } from "../server/session/adapters/claude/index.js";
import type { SessionHandle } from "../server/session/adapter.js";

function bounded<T>(promise: Promise<T>, stage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Native configuration canary timed out: ${stage}`)), 8000); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Opt-in, real pinned CLI, NO REAL MODEL REQUESTS. A fresh-session /compact is a
 * documented local no-op (nothing to summarize); it boots session hooks before
 * exercising initialization/readFile controls. The process has a disposable
 * HOME/config, no real credentials, and an unreachable local API endpoint, so
 * an accidental model call cannot spend or reach a provider.
 * This is policy/config evidence, NOT a generation/auth/browser canary.
 */
describe.skipIf(process.env.PI_WEB_CLAUDE_CONFIG_CANARY !== "1")("Claude native configuration canary (no LLM)", () => {
  it("inherits native restrictive mode, settings, hooks and skills while preserving explicit overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-claude-config-"));
    const cwd = join(root, "project");
    const home = join(root, "home");
    const config = join(root, "config");
    const marker = join(root, "native-hook-marker");
    const hook = join(root, "native-hook.mjs");
    const queries: Query[] = [];
    const endInputs: Array<() => void> = [];
    const reads: Array<Promise<unknown>> = [];
    try {
      await Promise.all([mkdir(home), mkdir(config), mkdir(join(cwd, ".claude", "skills", "native-canary-skill"), { recursive: true })]);
      await writeFile(join(cwd, "allowed.txt"), "synthetic allowed file");
      await writeFile(join(cwd, "blocked.txt"), "synthetic blocked file");
      await writeFile(join(cwd, ".claude", "skills", "native-canary-skill", "SKILL.md"), "---\nname: native-canary-skill\ndescription: Synthetic discovery canary; do not invoke\n---\nNo task.\n");
      await writeFile(hook, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'native hook ran');\n`);
      await writeFile(join(config, "settings.json"), JSON.stringify({
        permissions: { defaultMode: "dontAsk", deny: [`Read(/${join(cwd, "blocked.txt")})`] },
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(hook)}` }] }] },
      }));
      const env: NonNullable<Options["env"]> = {
        PATH: process.env.PATH,
        HOME: home,
        USERPROFILE: home,
        CLAUDE_CONFIG_DIR: config,
        ANTHROPIC_API_KEY: "synthetic-not-a-real-key",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
        DISABLE_TELEMETRY: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      };
      for (const explicitMode of [undefined, "plan"] as const) {
        let end!: () => void;
        const inputEnded = new Promise<void>((resolve) => { end = resolve; });
        endInputs.push(end);
        let started!: (init: SDKSystemMessage) => void;
        const nativeMode = new Promise<SDKSystemMessage>((resolve) => { started = resolve; });
        let completed!: (result: SDKResultMessage) => void;
        const commandResult = new Promise<SDKResultMessage>((resolve) => { completed = resolve; });
        let becameIdle!: () => void;
        const nativeIdle = new Promise<void>((resolve) => { becameIdle = resolve; });
        let resultSeen = false;
        const query = createClaudeQuery({
          prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
            yield { type: "user", message: { role: "user", content: "/compact" }, parent_tool_use_id: null };
            await inputEnded;
          })(),
          options: {
            cwd,
            env,
            ...(explicitMode ? { permissionMode: explicitMode } : {}),
          },
        });
        queries.push(query);
        reads.push((async () => { for await (const message of query) {
          if (message.type === "result") { resultSeen = true; completed(message); }
          if (message.type === "system" && message.subtype === "init") started(message);
          if (resultSeen && message.type === "system" && message.subtype === "session_state_changed" && message.state === "idle") becameIdle();
        } })().catch((error) => error));
        const initialization = await bounded(query.initializationResult(), "initialize");
        expect(initialization.commands.some((command) => command.name === "native-canary-skill")).toBe(true);
        expect(await bounded(nativeMode, "native mode in system/init")).toMatchObject({
          permissionMode: explicitMode ?? "dontAsk", claude_code_version: CLAUDE_CODE_VERSION,
        });
        const result = await bounded(commandResult, "local command");
        expect(result).toMatchObject({ subtype: "success", is_error: false, num_turns: 0, total_cost_usd: 0, local_command: "compact" });
        expect(result.modelUsage).toEqual({});
        // A real CLI regression guard: synthetic peers alone hid the missing
        // documented opt-in and left successful generations permanently busy.
        await bounded(nativeIdle, "authoritative idle after result");
        expect(await readFile(marker, "utf8")).toBe("native hook ran");
        expect(await bounded(query.readFile("allowed.txt"), "read allowed file")).toMatchObject({ contents: "synthetic allowed file" });
        expect(await bounded(query.readFile("blocked.txt"), "read denied file")).toBeNull();
        end();
        query.close();
      }
    } finally {
      for (const end of endInputs) end();
      for (const query of queries) query.close();
      await Promise.allSettled(reads);
      await rm(root, { recursive: true, force: true });
    }
  }, 25_000);

  it("handles a real CLI abort/error envelope with synthetic SSE, without treating an interrupt as a runtime fault", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-claude-abort-"));
    const home = join(root, "home");
    await mkdir(home);
    let calls = 0;
    // This peer is a fake MODEL, not a native process/SDK message producer. The
    // pinned CLI genuinely runs its cancellation path; no provider is contacted.
    const server = createServer((request, response) => {
      request.resume();
      if (request.url?.includes("count_tokens")) { response.setHeader("content-type", "application/json"); response.end('{"input_tokens":100}'); return; }
      if (!request.url?.startsWith("/v1/messages")) { response.writeHead(404); response.end(); return; }
      calls++;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const emit = (type: string, value: unknown) => response.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
      emit("message_start", { type: "message_start", message: { id: "msg_synthetic_abort", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } });
      emit("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      emit("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Synthetic stream awaiting interrupt" } });
    });
    let handle: SessionHandle | undefined;
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as { port: number }).port;
      const adapter = createClaudeAdapter({ env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, ".claude"),
        ANTHROPIC_API_KEY: "synthetic-not-a-credential", ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, DISABLE_TELEMETRY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
        sessionApi: { getSessionInfo: async () => undefined, getSessionMessages: async () => [], listSessions: async () => [] },
      });
      handle = await adapter.create({ sessionId: "native-abort-canary", cwd: root });
      await handle.prompt({ executionId: "abort-execution", message: "Synthetic test input", mode: "prompt", attachments: [] });
      await vi.waitFor(async () => expect((await handle!.messages()).some((message) => message.role === "assistant")).toBe(true), { timeout: 8000, interval: 10 });
      expect(await handle.interrupt("abort-execution")).toMatchObject({ acknowledged: true, executionId: "abort-execution" });
      await vi.waitFor(() => expect(handle!.state().isStreaming).toBe(false), { timeout: 8000, interval: 10 });
      expect(handle.state()).toMatchObject({ phase: "idle", activity: "idle" });
      expect(handle.state().error).toBeUndefined();
      expect((await handle.messages()).some((message) => message.role === "assistant" && message.status === "interrupted")).toBe(true);
      expect(calls).toBe(1);
    } finally {
      await handle?.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 25_000);
});
