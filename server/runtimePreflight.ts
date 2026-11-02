import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

export const manualRuntimeRestartMessage = "Full application restart required; nothing has been stopped. Wait for all active turns to finish, then stop and start pi-web using its original terminal or service manager. A child restart cannot load updated supervisor code.";

/** Loaded supervisor dependencies only; child-only updates remain restartable.
 * Keep this list aligned with supervisor.ts and its transitive runtime imports. */
export const supervisorDependencyFiles = [
  "supervisor.ts", "server/runtimePreflight.ts", "src/webHome.ts",
  "server/shared/httpProxy.ts", "server/shared/upgradeProxy.ts", "server/shared/webHome.ts",
  "server/tunnelSocket.ts",
  ...["kernel", "config", "admission", "origin", "proxy", "supervisorPeer", "ip", "passwordWork", "storeLock"]
    .map(name => `server/auth/${name}.ts`),
];

export async function runtimeFingerprint(root: string): Promise<string> {
  const files = supervisorDependencyFiles;
  const hash = createHash("sha256");
  const require = createRequire(join(root, "package.json"));
  // Installed versions, not the application version, dev dependencies, or an
  // optional lockfile (which npm does not ship).
  for (const name of ["@earendil-works/pi-coding-agent", "tsx"]) {
    let version: string | undefined;
    // Read the installed manifest via Node's search paths: ESM-only packages
    // need not export either a require entry point or their package.json.
    for (const directory of require.resolve.paths(name) || []) {
      try {
        const manifest = JSON.parse(await readFile(join(directory, name, "package.json"), "utf8")) as { version: string };
        if (typeof manifest.version !== "string") throw new Error(`Invalid dependency identity: ${name}`);
        version = manifest.version;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (!version) throw new Error(`Missing dependency identity: ${name}`);
    hash.update(name).update("\0").update(version).update("\0");
  }
  for (const file of [...files].sort()) {
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
