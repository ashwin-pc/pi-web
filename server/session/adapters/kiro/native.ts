import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { nativeChildEnvironment } from "../nativeEnvironment.js";
import { KiroRpcError, type KiroLaunchOptions } from "./transport.js";

export const KIRO_VERSION = "2.24.0";
export const ACP_VERSION = 1;
export function installed(options: Omit<KiroLaunchOptions, "cwd">): boolean {
  const command = options.command ?? "kiro-cli";
  const paths = isAbsolute(command) || command.includes("/") ? [command]
    : ((options.env ?? process.env).PATH ?? "").split(delimiter).map((path) => join(path, command));
  return paths.some((path) => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } });
}

/** Bounded public CLI metadata command; stderr is never retained. Every launch
 * uses the same native environment policy, including rejected-version children. */
export function metadata(options: KiroLaunchOptions, args: string[], maxBytes = 8 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command ?? "kiro-cli", args, {
      cwd: options.cwd, env: nativeChildEnvironment(options.env ?? process.env),
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    let bytes = 0;
    const chunks: Buffer[] = [];
    let failure: Error | undefined;
    const signal = () => {
      if (!child.pid) return;
      try { if (process.platform === "win32") child.kill("SIGKILL"); else process.kill(-child.pid, "SIGKILL"); } catch { /* owned group already exited */ }
    };
    const fail = (message: string) => { failure ??= new KiroRpcError(message, "closed"); signal(); };
    const timer = setTimeout(() => fail("Kiro metadata command timed out; check native setup"), options.requestTimeoutMs ?? 30_000);
    timer.unref();
    child.stdin.end();
    child.stdin.on("error", () => fail("Kiro metadata input closed"));
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) fail("Kiro metadata output exceeds limit");
      else chunks.push(chunk);
    });
    child.once("error", () => fail("Could not launch Kiro; check the configured executable"));
    child.once("close", (code) => {
      clearTimeout(timer); signal();
      if (failure || code !== 0) reject(failure ?? new KiroRpcError("Kiro metadata command failed; check native authentication and setup", "closed"));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}
export async function preflight(options: KiroLaunchOptions): Promise<void> {
  const version = await metadata(options, ["--version"], 16 * 1024);
  if (version.trim() !== `kiro-cli ${KIRO_VERSION}`) throw new KiroRpcError(`Unsupported Kiro CLI version; expected ${KIRO_VERSION}`, "protocol");
}
