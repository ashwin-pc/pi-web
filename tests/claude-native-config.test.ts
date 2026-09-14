import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Options, Query, SDKResultMessage, SDKSystemMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_CODE_VERSION, createClaudeQuery } from "../server/session/adapters/claude/native.js";

function bounded<T>(promise: Promise<T>, stage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Native configuration canary timed out: ${stage}`)), 8000); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Opt-in, real pinned CLI, NO MODEL REQUESTS. A fresh-session /compact is a
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
          if (message.type === "result") completed(message);
          if (message.type === "system" && message.subtype === "init") started(message);
        } })().catch((error) => error));
        const initialization = await bounded(query.initializationResult(), "initialize");
        expect(initialization.commands.some((command) => command.name === "native-canary-skill")).toBe(true);
        expect(await bounded(nativeMode, "native mode in system/init")).toMatchObject({
          permissionMode: explicitMode ?? "dontAsk", claude_code_version: CLAUDE_CODE_VERSION,
        });
        const result = await bounded(commandResult, "local command");
        expect(result).toMatchObject({ subtype: "success", is_error: false, num_turns: 0, total_cost_usd: 0, local_command: "compact" });
        expect(result.modelUsage).toEqual({});
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
});
