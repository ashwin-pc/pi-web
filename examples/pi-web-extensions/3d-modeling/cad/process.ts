import { spawn } from "node:child_process";
import type { PiWebExtensionAPI } from "@ashwin-pc/pi-web/extensions";

export interface OwnedProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeout?: number;
  outputLimit?: number;
  retention?: "head" | "tail";
}
export interface OwnedProcessResult {
  stdout: string; stderr: string; output: string; truncated: boolean;
  code: number | null; reason?: "cancelled" | "timed-out"; error?: Error;
}

/** Own only the freshly detached child's group, including descendants after leader exit.
 * Deliberately re-sessioned descendants and abrupt host exit without awaited
 * cancellation are outside this ownership boundary. */
export async function runOwnedProcess(command: string, args: string[], options: OwnedProcessOptions = {}): Promise<OwnedProcessResult> {
  if (options.signal?.aborted) throw new Error("Execution cancelled before launch.");
  if (process.platform === "win32") throw new Error("Execution requires POSIX process groups.");
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const result: OwnedProcessResult = { stdout: "", stderr: "", output: "", truncated: false, code: null };
    let stopping = false, finished = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const limit = options.outputLimit ?? 65536;
    const signalGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); } catch (error: any) { if (error.code !== "ESRCH") result.error ??= error; }
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearTimeout(escalation);
      options.signal?.removeEventListener("abort", cancel);
      child.stdout.destroy(); child.stderr.destroy();
      resolve(result);
    };
    const cleanup = () => {
      if (stopping) return;
      stopping = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
      signalGroup("SIGTERM");
      escalation = setTimeout(() => { signalGroup("SIGKILL"); finish(); }, 250);
    };
    const cancel = () => { if (!stopping) { result.reason = "cancelled"; cleanup(); } };
    const timer = setTimeout(() => { if (!stopping) { result.reason = "timed-out"; cleanup(); } }, options.timeout ?? 180_000);
    const append = (existing: string, text: string) => options.retention === "tail" ? (existing + text).slice(-limit) : existing + text.slice(0, Math.max(0, limit - existing.length));
    const collect = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString();
      if (result.output.length + text.length > limit) result.truncated = true;
      result[stream] = append(result[stream], text);
      result.output = append(result.output, text);
    };
    child.stdout.on("data", chunk => collect("stdout", chunk));
    child.stderr.on("data", chunk => collect("stderr", chunk));
    child.once("error", error => { result.error = error; cleanup(); });
    child.once("exit", code => { result.code = code; cleanup(); });
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
  });
}

/** Standalone pi.exec adapter preserves its rejection and bounded-tail contract. */
export const execLocal: PiWebExtensionAPI["exec"] = async (command, args, options = {}) => {
  const result = await runOwnedProcess(command, args, { ...options, retention: "tail" });
  if (result.reason) throw new Error(result.reason === "cancelled" ? "Execution cancelled." : "Execution timed out.");
  if (result.error) throw result.error;
  return { stdout: result.stdout, stderr: result.stderr, code: result.code ?? 1, killed: false };
};

export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)]));
  return value;
}

export function redact(value: string) {
  for (const [name, secret] of Object.entries(process.env)) if (/token|secret|password|credential|api.?key/i.test(name) && secret && secret.length >= 4) value = value.split(secret).join("[REDACTED]");
  return value.replace(/(bearer\s+)[\w.\-]+/gi, "$1[REDACTED]").replace(/((?:token|password|secret|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}
