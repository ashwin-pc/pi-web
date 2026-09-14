import { spawn } from "node:child_process";
import { Transform } from "node:stream";
import {
  query,
  type Options,
  type Query,
  type SDKUserMessage,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";

export const CLAUDE_SDK_VERSION = "0.3.270";
export const CLAUDE_CODE_VERSION = "2.1.270";

/** Metadata only: native output can contain credentials, prompts, or tool contents. */
export interface ClaudeIngressObservation {
  kind: "message" | "invalid-json" | "oversized";
  bytes: number;
  type?: string;
  subtype?: string;
}

const MAX_OBSERVED_LINE_BYTES = 64 * 1024;

function discriminant(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/i.test(value) ? value : undefined;
}

/**
 * This exact SDK pin inserts --permission-mode default even when the caller did
 * not set a mode. Omit only that generated override so the CLI, not pi-web,
 * resolves native settings and managed policy. Explicit modes pass unchanged.
 * Never guess if an SDK upgrade changes the invocation.
 */
export function preserveNativePermissionMode(args: readonly string[], explicitMode: Options["permissionMode"]): string[] {
  if (explicitMode !== undefined) return [...args];
  const indices = args.flatMap((arg, index) => arg === "--permission-mode" ? [index] : []);
  if (indices.length !== 1 || args.some((arg) => arg.startsWith("--permission-mode=")) || args[indices[0]! + 1] !== "default") {
    throw new Error(`Unsupported Claude SDK ${CLAUDE_SDK_VERSION} invocation: cannot safely inherit native permission mode`);
  }
  const index = indices[0]!;
  return args.filter((_, position) => position !== index && position !== index + 1);
}

/** Observe before the SDK consumes control requests or silently skips bad JSON. */
function observeOutput(source: SpawnedProcess["stdout"], listener: (observation: ClaudeIngressObservation) => void): Transform {
  let chunks: Buffer[] = [];
  let bytes = 0;
  let oversized = false;
  const notify = (observation: ClaudeIngressObservation) => {
    try { listener(observation); } catch { /* Diagnostics cannot break native execution. */ }
  };
  const flushLine = () => {
    if (oversized) {
      notify({ kind: "oversized", bytes });
    } else if (bytes > 0) {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text) {
        try {
          const value: unknown = JSON.parse(text);
          const object = value && typeof value === "object" ? value as Record<string, unknown> : {};
          const request = object.request && typeof object.request === "object" ? object.request as Record<string, unknown> : undefined;
          notify({ kind: "message", bytes, type: discriminant(object.type), subtype: discriminant(object.subtype ?? request?.subtype) });
        } catch {
          notify({ kind: "invalid-json", bytes });
        }
      }
    }
    chunks = [];
    bytes = 0;
    oversized = false;
  };
  const output = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      let start = 0;
      for (let end = 0; end <= chunk.length; end++) {
        if (end !== chunk.length && chunk[end] !== 10) continue;
        const part = chunk.subarray(start, end);
        bytes += part.length;
        if (bytes > MAX_OBSERVED_LINE_BYTES) {
          oversized = true;
          chunks = [];
        } else if (!oversized && part.length > 0) {
          chunks.push(Buffer.from(part));
        }
        if (end !== chunk.length) flushLine();
        start = end + 1;
      }
      callback(null, chunk);
    },
    flush(callback) { flushLine(); callback(); },
  });
  source.once("error", (error) => output.destroy(error));
  source.pipe(output);
  return output;
}

function spawnLocal(options: SpawnOptions): SpawnedProcess {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  // The SDK's custom-spawn path does not drain stderr. Do so without retaining
  // auth URLs, credentials, prompts or arbitrary native debug output.
  child.stderr.resume();
  return child;
}

/**
 * The only Claude process entry point. Native SDK types stay inside the adapter.
 * The documented custom spawn seam also lets deterministic peers exercise the
 * same SDK ingress as production, without replacing the event mapper or service.
 */
export function createClaudeQuery(params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
  observe?: (observation: ClaudeIngressObservation) => void;
}): Query {
  const { options, observe } = params;
  if (Object.keys(options.extraArgs ?? {}).some((name) => name === "permission-mode" || name.startsWith("permission-mode="))) {
    throw new Error("Use the Claude permissionMode option, not an additional permission-mode argument");
  }
  const spawnProcess = options.spawnClaudeCodeProcess ?? spawnLocal;
  return query({
    prompt: params.prompt,
    options: {
      ...options,
      systemPrompt: options.systemPrompt ?? { type: "preset", preset: "claude_code" },
      settingSources: options.settingSources ?? ["user", "project", "local"],
      includePartialMessages: true,
      extraArgs: { ...options.extraArgs, "replay-user-messages": null },
      spawnClaudeCodeProcess(spawnOptions) {
        const child = spawnProcess({ ...spawnOptions, args: preserveNativePermissionMode(spawnOptions.args, options.permissionMode) });
        if (!observe) return child;
        return {
          stdin: child.stdin,
          stdout: observeOutput(child.stdout, observe),
          get killed() { return child.killed; },
          get exitCode() { return child.exitCode; },
          get signalCode() { return child.signalCode; },
          kill: child.kill.bind(child),
          on: child.on.bind(child),
          once: child.once.bind(child),
          off: child.off.bind(child),
        };
      },
    },
  });
}
