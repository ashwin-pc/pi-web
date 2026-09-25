import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { Options, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeQuery } from "../server/session/adapters/claude/native.js";
import { ClaudeNativePeer } from "./fixtures/claude-native-peer.js";

const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => sdk);
afterEach(() => { sdk.query.mockReset(); vi.unstubAllEnvs(); });

it("filters the final SDK callback environment without mutating SDK/parent/caller inputs", () => {
  // Callback-boundary unit test, not real-SDK/process evidence. The companion
  // native-environment suite exercises actual SDK assembly and OS child peers.
  const hostToken = randomUUID();
  vi.stubEnv("PI_WEB_TOKEN", hostToken);
  const callerEnv = Object.freeze({ ANTHROPIC_API_KEY: randomUUID(), CLAUDE_CONFIG_DIR: "/synthetic-config" });
  const sdkEnv = Object.freeze({ ...callerEnv, PI_WEB_TOKEN: randomUUID(), Pi_WeB_ToKeN: randomUUID(), SDK_ADDED_NATIVE_CONFIG: "retained" });
  const args = ["--permission-mode", "default", "--setting-sources=user,project,local"];
  Object.freeze(args);
  const sdkInput: SpawnOptions = Object.freeze({ command: "synthetic", args, env: sdkEnv, signal: new AbortController().signal });
  const peer = new ClaudeNativePeer();
  const spawn = vi.fn((_options: SpawnOptions) => peer);
  sdk.query.mockImplementation(({ options }: { options: Options }) => {
    // Simulate a later SDK assembly/update adding a token even though the caller
    // supplied none. Filtering only the early Options.env would miss this.
    options.spawnClaudeCodeProcess!(sdkInput);
  });
  try {
    createClaudeQuery({ prompt: (async function* () {})(), options: { env: callerEnv, spawnClaudeCodeProcess: spawn } });
    expect(spawn).toHaveBeenCalledOnce();
    const forwarded = spawn.mock.calls[0]![0];
    expect(forwarded.env === sdkEnv).toBe(false);
    expect(Object.keys(forwarded.env).some((key) => key.toUpperCase() === "PI_WEB_TOKEN")).toBe(false);
    expect(forwarded.env.ANTHROPIC_API_KEY === callerEnv.ANTHROPIC_API_KEY).toBe(true);
    expect(forwarded.env.CLAUDE_CONFIG_DIR).toBe(callerEnv.CLAUDE_CONFIG_DIR);
    expect(forwarded.env.SDK_ADDED_NATIVE_CONFIG).toBe("retained");
    expect(forwarded.signal).toBe(sdkInput.signal);
    expect(forwarded.args).toEqual(["--setting-sources=user,project,local"]);
    expect(sdkInput.args).toEqual(["--permission-mode", "default", "--setting-sources=user,project,local"]);
    expect(Object.keys(sdkEnv).filter((key) => key.toUpperCase() === "PI_WEB_TOKEN")).toHaveLength(2);
    expect(Object.keys(callerEnv)).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"]);
    expect(process.env.PI_WEB_TOKEN === hostToken).toBe(true); // No credential values in failure output.
  } finally { peer.exit(); }
});
