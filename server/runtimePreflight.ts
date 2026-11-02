import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const manualRuntimeRestartMessage = "Full application restart required; nothing has been stopped. Wait for all active turns to finish, then stop and start pi-web using its original terminal or service manager. A child restart cannot load updated supervisor code.";

/** Conservative deployment identity, not a hot-path request check. Include the
 * supervisor's local dependency tree and launcher/dependency manifests. */
export async function runtimeFingerprint(root: string): Promise<string> {
  const files = ["supervisor.ts", "bin/pi-web.js", "package.json"];
  async function collect(relative: string): Promise<void> {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) await collect(path);
      else if (entry.isFile() && /\.(ts|js|json)$/.test(entry.name)) files.push(path);
    }
  }
  // Auth and shared proxy code are supervisor dependencies. Including all server
  // modules deliberately errs on the side of a manual restart after an update.
  await collect("server");
  const hash = createHash("sha256");
  // npm excludes package-lock.json from published packages. Its presence or
  // absence is still part of the identity, but absence is a valid deployment.
  try {
    hash.update("package-lock.json\0").update(await readFile(join(root, "package-lock.json"))).update("\0");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    hash.update("package-lock.json:absent\0");
  }
  for (const file of files.sort()) {
    hash.update(file).update("\0").update(await readFile(join(root, file))).update("\0");
  }
  return hash.digest("hex");
}

export async function runtimePreflight(root: string, loadedFingerprint: string | undefined) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const current = await Promise.race([
      runtimeFingerprint(root),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Runtime preflight timed out")), 5_000);
      }),
    ]);
    if (loadedFingerprint && current === loadedFingerprint) return { ok: true as const };
  } catch {
    // Unreadable or partially installed updates must never stop the working child.
  } finally {
    clearTimeout(timeout);
  }
  return { ok: false as const, code: "FULL_RUNTIME_RESTART_REQUIRED", error: manualRuntimeRestartMessage };
}
