import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { nativeChildEnvironment } from "../server/session/adapters/nativeEnvironment.js";
import { createCodexAdapter } from "../server/session/adapters/codex/index.js";
import { createClaudeAdapter } from "../server/session/adapters/claude/index.js";
import { CLAUDE_SDK_VERSION, createClaudeQuery } from "../server/session/adapters/claude/native.js";
import { controlPeer, peerForThread } from "./fixtures/codex-peer-control.js";

type Observation = {
  pid: number;
  stage: "version" | "runtime";
  hostTokenPresent: boolean;
  nativeMatches: Record<string, boolean>;
  parentOnlyPresent: boolean;
  idleOptIn: boolean;
};
type EnvironmentMode = "inherited" | "overrides" | "token-overrides";
const hostKeys = ["PI_WEB_TOKEN", "pi_web_token", "Pi_WeB_ToKeN"];
const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
  finally {
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  }
});

// Compare without ever putting credential values in an assertion/log on failure.
const sameEnvironment = (left: NodeJS.ProcessEnv, right: NodeJS.ProcessEnv) =>
  Object.keys(left).length === Object.keys(right).length && Object.keys(left).every((key) => left[key] === right[key]);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function fixture(harness: "codex" | "claude", mode: EnvironmentMode) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-native-env-")); roots.push(root);
  const native = {
    HOME: join(root, "home"), PATH: process.env.PATH ?? "",
    CODEX_HOME: join(root, "codex-home"), CLAUDE_CONFIG_DIR: join(root, "claude-home"),
    OPENAI_API_KEY: randomUUID(), ANTHROPIC_API_KEY: randomUUID(),
    AWS_PROFILE: "synthetic-native-profile", AWS_SESSION_TOKEN: randomUUID(),
    PI_WEB_CODEX_PEER_DIR: join(root, "codex-peer"), PI_WEB_CLAUDE_PEER_DIR: join(root, "claude-peer"),
    PI_WEB_TOKEN_SUFFIX: "keep-unrelated-keys", NATIVE_CONFIG_SENTINEL: "keep-native-configuration",
  };
  for (const dir of [native.HOME, native.CODEX_HOME, native.CLAUDE_CONFIG_DIR]) await mkdir(dir);
  for (const [key, value] of Object.entries(native)) vi.stubEnv(key, value);
  for (const key of hostKeys) vi.stubEnv(key, randomUUID());
  vi.stubEnv("PI_WEB_PARENT_ONLY_SENTINEL", "parent-only");
  // query() sets its own version marker. Seed that documented pin before the
  // unchanged-parent assertion, rather than attributing an SDK write to filtering.
  vi.stubEnv("CLAUDE_AGENT_SDK_VERSION", CLAUDE_SDK_VERSION);
  const environment: NodeJS.ProcessEnv | undefined = mode === "inherited" ? undefined : Object.freeze({
    ...native, AWS_PROFILE: "synthetic-native-override", OPENAI_API_KEY: randomUUID(),
    ...(mode === "token-overrides" ? Object.fromEntries(hostKeys.map((key) => [key, randomUUID()])) : {}),
  });
  const parentBefore = { ...process.env };
  const inputBefore = environment ? { ...environment } : undefined;
  const expectedNative = Object.fromEntries(Object.keys(native).map((key) => [key, environment?.[key] ?? native[key as keyof typeof native]]));
  const hashes = Object.fromEntries(Object.entries(expectedNative).map(([key, value]) => [key, createHash("sha256").update(value).digest("hex")]));
  const log = join(root, "environment.jsonl");
  const wrapper = join(root, `${harness}-environment.mjs`);
  const peer = new URL(`./fixtures/${harness === "codex" ? "codex-app-server-peer.mjs" : "claude-native-cli.mjs"}`, import.meta.url).href;
  // Only hashes of fresh synthetic native credentials are embedded. Host token
  // values are never read by the wrapper, serialized, or included in assertions.
  await writeFile(wrapper, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
const expected = ${JSON.stringify(hashes)};
appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  pid: process.pid, stage: process.argv.includes("--version") ? "version" : "runtime",
  hostTokenPresent: Object.keys(process.env).some(key => key.toUpperCase() === "PI_WEB_TOKEN"),
  nativeMatches: Object.fromEntries(Object.entries(expected).map(([key, hash]) => [key,
    typeof process.env[key] === "string" && createHash("sha256").update(process.env[key]).digest("hex") === hash])),
  parentOnlyPresent: process.env.PI_WEB_PARENT_ONLY_SENTINEL === "parent-only",
  idleOptIn: process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS === "1"
}) + "\\n");
await import(${JSON.stringify(peer)});
`);
  await chmod(wrapper, 0o700);
  const observations = async (): Promise<Observation[]> => (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Observation);
  const checkInputs = () => {
    expect(sameEnvironment(process.env, parentBefore)).toBe(true);
    if (environment && inputBefore) expect(sameEnvironment(environment, inputBefore)).toBe(true);
  };
  const checkChildren = (rows: Observation[], expected: number, parentOnly: boolean) => {
    expect(rows.filter((row) => row.stage === "runtime")).toHaveLength(expected);
    expect(rows.every((row) => !row.hostTokenPresent)).toBe(true);
    expect(rows.every((row) => Object.values(row.nativeMatches).every(Boolean))).toBe(true);
    expect(rows.every((row) => row.parentOnlyPresent === parentOnly)).toBe(true);
  };
  return { root, wrapper, environment, observations, checkInputs, checkChildren };
}

describe("native child credential boundary (controlled OS processes, no actual models)", () => {
  it("copies without case-variant host tokens or input mutation, including inherited environment keys", () => {
    const prototype = Object.freeze({ pi_web_token: randomUUID(), INHERITED_NATIVE_CONFIG: "retained" });
    const input: NodeJS.ProcessEnv = Object.freeze(Object.assign(Object.create(prototype), {
      PI_WEB_TOKEN: randomUUID(), Pi_WeB_ToKeN: randomUUID(),
      OPENAI_API_KEY: randomUUID(), AWS_SESSION_TOKEN: randomUUID(), PI_WEB_TOKEN_SUFFIX: "retained", UNSET: undefined,
    }));
    const before = { ...input };
    const filtered = nativeChildEnvironment(input);
    expect(Object.getPrototypeOf(filtered)).toBeNull();
    expect(filtered === input).toBe(false);
    expect(Object.keys(filtered).some((key) => key.toUpperCase() === "PI_WEB_TOKEN")).toBe(false);
    expect(filtered.INHERITED_NATIVE_CONFIG).toBe("retained");
    expect(filtered.OPENAI_API_KEY === input.OPENAI_API_KEY && filtered.AWS_SESSION_TOKEN === input.AWS_SESSION_TOKEN).toBe(true);
    expect(filtered.PI_WEB_TOKEN_SUFFIX).toBe("retained");
    expect(Object.hasOwn(filtered, "UNSET")).toBe(true);
    expect(sameEnvironment(input, before)).toBe(true);
    expect(Object.keys(prototype)).toEqual(["pi_web_token", "INHERITED_NATIVE_CONFIG"]);
  });

  it("does not backfill a deliberately empty native environment from the host", () => {
    vi.stubEnv("PI_WEB_TOKEN", randomUUID());
    vi.stubEnv("NATIVE_CONFIG_SENTINEL", "not-requested");
    expect(Object.keys(nativeChildEnvironment(Object.freeze({})))).toEqual([]);
  });

  it.each(["inherited", "token-overrides"] as const)("filters Codex create/list/resume processes with %s env", async (mode) => {
    const run = await fixture("codex", mode);
    const adapter = createCodexAdapter({ command: process.execPath, args: [run.wrapper], env: run.environment });
    const handle = await adapter.create({ sessionId: randomUUID(), cwd: run.root });
    cleanups.push(() => handle.dispose());
    // A synthetic peer turn materializes its scratch history for real adapter
    // list/resume calls. No native CLI or provider is reachable through this peer.
    await handle.prompt({ message: "Synthetic peer input", mode: "prompt", attachments: [], executionId: randomUUID() });
    const nativeSession = handle.state().nativeSession;
    const peer = await peerForThread(join(run.root, "codex-peer"), nativeSession.sessionId!);
    await controlPeer(peer, { action: "complete" });
    await handle.dispose();
    const listed = await adapter.list(run.root);
    expect(listed.some((entry) => entry.nativeSession.sessionId === nativeSession.sessionId)).toBe(true);
    const reopened = await adapter.open({ sessionId: handle.sessionId, cwd: run.root, nativeSession });
    cleanups.push(() => reopened.dispose());
    await reopened.dispose();
    const rows = await run.observations();
    await vi.waitFor(() => expect(rows.every((row) => !alive(row.pid))).toBe(true));
    run.checkInputs();
    run.checkChildren(rows, 3, mode === "inherited");
  }, 15_000);

  it.each(["inherited", "token-overrides"] as const)("filters BOTH Claude version preflight and runtime children with %s env", async (mode) => {
    const run = await fixture("claude", mode);
    const adapter = createClaudeAdapter({ pathToClaudeCodeExecutable: run.wrapper, env: run.environment });
    const handle = await adapter.create({ sessionId: randomUUID(), cwd: run.root });
    cleanups.push(() => handle.dispose());
    // Unlike the direct Query tests below, this production handle first runs
    // --version. The matching-version executable then starts the real SDK peer;
    // synthetic input cannot reach an actual CLI or model.
    await handle.prompt({ message: "Synthetic peer input only", mode: "prompt", attachments: [], executionId: randomUUID() });
    await handle.dispose();
    const rows = await run.observations();
    expect(rows.map((row) => row.stage)).toEqual(["version", "runtime"]);
    expect(new Set(rows.map((row) => row.pid)).size).toBe(2);
    await vi.waitFor(() => expect(rows.every((row) => !alive(row.pid))).toBe(true), { timeout: 5000 });
    run.checkInputs();
    run.checkChildren(rows, 1, mode === "inherited"); // Checks exclusion/preservation in every row, not runtime alone.
    expect(rows[1]!.idleOptIn).toBe(true);
  }, 15_000);

  it.each([
    { mode: "inherited", customSpawn: false },
    { mode: "overrides", customSpawn: false },
    { mode: "token-overrides", customSpawn: false },
    { mode: "token-overrides", customSpawn: true },
  ] as const)("filters Claude's final SDK merge with $mode env (custom spawn: $customSpawn)", async ({ mode, customSpawn }) => {
    const run = await fixture("claude", mode);
    let end!: () => void;
    const done = new Promise<void>((resolve) => { end = resolve; });
    let customCalls = 0;
    const spawnClaudeCodeProcess: Options["spawnClaudeCodeProcess"] = customSpawn ? (options) => {
      customCalls++;
      // Do not sanitize here: the production callback must supply the already
      // filtered final SDK environment to this supported custom spawn seam too.
      expect(Object.keys(options.env).some((key) => key.toUpperCase() === "PI_WEB_TOKEN")).toBe(false);
      const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env,
        signal: options.signal, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      child.stderr.resume();
      return child;
    } : undefined;
    const query = createClaudeQuery({
      prompt: (async function* (): AsyncGenerator<SDKUserMessage> { await done; })(),
      options: { cwd: run.root, pathToClaudeCodeExecutable: run.wrapper, env: run.environment, spawnClaudeCodeProcess },
    });
    cleanups.push(async () => { end(); query.close(); });
    // Metadata only: input never yields a user message and the executable is the
    // controlled peer. An explicit env replaces, rather than extends, inheritance.
    await query.supportedModels();
    end(); query.close();
    const rows = await run.observations();
    await vi.waitFor(() => expect(rows.every((row) => !alive(row.pid))).toBe(true), { timeout: 5000 });
    run.checkInputs();
    run.checkChildren(rows, 1, mode === "inherited");
    expect(rows.every((row) => row.idleOptIn)).toBe(true);
    expect(customCalls).toBe(customSpawn ? 1 : 0);
  }, 15_000);
});
