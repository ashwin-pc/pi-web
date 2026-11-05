import { spawn } from "node:child_process";
import type { PiWebExtensionAPI } from "@ashwin-pc/pi-web/extensions";

/** Bounded standalone equivalent of pi.exec, with owned POSIX process-group cleanup. */
export const execLocal: PiWebExtensionAPI["exec"] = async (command, args, options = {}) => {
  if (options.signal?.aborted) throw new Error("Execution cancelled before launch.");
  if (process.platform === "win32") throw new Error("Standalone execution requires POSIX process groups.");
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, detached: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", code: number | null = null, spawnError: Error | undefined;
    let stopped = false, killed = false, reason = "";
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => { if (child.pid) try { process.kill(-child.pid, signal); } catch (error: any) { if (error.code !== "ESRCH") spawnError = error; } };
    const finish = () => {
      clearTimeout(timer); if (escalation) clearTimeout(escalation);
      options.signal?.removeEventListener("abort", cancel);
      child.stdout.destroy(); child.stderr.destroy();
      if (reason) reject(new Error(reason));
      else if (spawnError) reject(spawnError);
      else resolve({ stdout, stderr, code: code ?? 1, killed });
    };
    const cleanup = () => {
      if (stopped) return;
      stopped = true; clearTimeout(timer); kill("SIGTERM");
      escalation = setTimeout(() => { kill("SIGKILL"); finish(); }, 250);
    };
    const cancel = () => { killed = true; reason = "Execution cancelled."; cleanup(); };
    const timer = setTimeout(() => { killed = true; reason = "Execution timed out."; cleanup(); }, options.timeout ?? 180_000);
    options.signal?.addEventListener("abort", cancel, { once: true });
    child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-65536); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-65536); });
    child.once("error", error => { spawnError = error; cleanup(); });
    child.once("exit", value => { code = value; cleanup(); });
    if (options.signal?.aborted) cancel();
  });
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
