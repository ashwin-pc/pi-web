import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeQuery } from "../server/session/adapters/claude/native.js";

it("drives the executable scratch peer through the real SDK, including independent interrupt/settlement", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-claude-cli-"));
  const nativeSessionId = "11111111-1111-4111-8111-111111111111";
  const promptId = "22222222-2222-4222-8222-222222222222";
  let end!: () => void;
  const done = new Promise<void>((resolve) => { end = resolve; });
  const canUseTool = vi.fn(async () => ({ behavior: "deny" as const, message: "Synthetic user declined", interrupt: false }));
  const query = createClaudeQuery({
    prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
      yield { type: "user", uuid: promptId, message: { role: "user", content: "Synthetic browser prompt 📖" }, parent_tool_use_id: null };
      await done;
    })(),
    options: {
      cwd: root,
      sessionId: nativeSessionId,
      pathToClaudeCodeExecutable: fileURLToPath(new URL("./fixtures/claude-native-cli.mjs", import.meta.url)),
      env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: root, PI_WEB_CLAUDE_PEER_DIR: root, DISABLE_TELEMETRY: "1" },
      canUseTool,
    },
  });
  const messages: SDKMessage[] = [];
  const consumed = (async () => { try { for await (const message of query) messages.push(message); } catch (error) { return error; } })();
  try {
    await query.initializationResult();
    const manifest = await vi.waitFor(async () => {
      const pids = await readdir(join(root, "peers"));
      expect(pids).toHaveLength(1);
      return JSON.parse(await readFile(join(root, "peers", pids[0]!, "ready.json"), "utf8")) as { pid: number; directory: string; nativeSessionId: string };
    }, { timeout: 5000 });
    expect(manifest.nativeSessionId).toBe(nativeSessionId);
    expect(manifest.pid).not.toBe(process.pid);
    let commandNumber = 0;
    const control = async (command: unknown) => {
      const path = join(manifest.directory, "commands", `${String(++commandNumber).padStart(6, "0")}.json`);
      await writeFile(`${path}.tmp`, JSON.stringify(command));
      await rename(`${path}.tmp`, path);
    };
    const observed = async () => (await readFile(join(manifest.directory, "observed.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    await vi.waitFor(() => expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "user", uuid: promptId, isReplay: true, session_id: nativeSessionId }),
      expect.objectContaining({ type: "system", subtype: "session_state_changed", state: "running" }),
    ])), { timeout: 5000 });
    expect(await observed()).toContainEqual(expect.objectContaining({ direction: "client", message: expect.objectContaining({ type: "user", message: { role: "user", content: "Synthetic browser prompt 📖" } }) }));
    expect(await query.interrupt()).toEqual({ still_queued: [] });
    expect(messages.some((message) => message.type === "system" && message.subtype === "session_state_changed" && message.state === "idle")).toBe(false);

    await control({ action: "emit", message: { type: "control_request", request_id: "scratch-approval", request: {
      subtype: "can_use_tool", tool_name: "Write", input: { file_path: "/synthetic-file", content: "fixture" }, tool_use_id: "scratch-tool",
    } } });
    await vi.waitFor(async () => expect(await observed()).toContainEqual(expect.objectContaining({ direction: "client", message: {
      type: "control_response", response: { subtype: "success", request_id: "scratch-approval", response: {
        behavior: "deny", message: "Synthetic user declined", interrupt: false, toolUseID: "scratch-tool",
      } },
    } })), { timeout: 5000 });
    expect(canUseTool).toHaveBeenCalledTimes(1);

    await control({ action: "emit", message: { type: "assistant", parent_tool_use_id: null, message: {
      id: "synthetic-api-message", role: "assistant", model: "claude-fixture", content: [{ type: "text", text: "Visible fixture response" }],
      stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 2 },
    } } });
    await control({ action: "emit", message: {
      type: "result", subtype: "success", is_error: false, result: "Visible fixture response", num_turns: 1, stop_reason: "end_turn",
      duration_ms: 1, duration_api_ms: 0, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], user_message_uuid: promptId,
    } });
    await vi.waitFor(() => expect(messages.some((message) => message.type === "result")).toBe(true), { timeout: 5000 });
    expect(messages.some((message) => message.type === "system" && message.subtype === "session_state_changed" && message.state === "idle")).toBe(false);
    await control({ action: "emit", message: { type: "system", subtype: "session_state_changed", state: "idle" } });
    await vi.waitFor(() => expect(messages.some((message) => message.type === "system" && message.subtype === "session_state_changed" && message.state === "idle")).toBe(true), { timeout: 5000 });
    await control({ action: "exit", code: 42 });
    expect(await consumed).toBeInstanceOf(Error);
    expect(JSON.parse(await readFile(join(manifest.directory, "exit.json"), "utf8"))).toEqual({ code: 42, signal: null });
  } finally {
    end();
    query.close();
    await consumed;
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
