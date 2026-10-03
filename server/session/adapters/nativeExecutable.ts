import { accessSync, constants, statSync } from "node:fs";
import { posix, win32 } from "node:path";

/** Host-only discovery, shared by catalog and launch. Never starts a process. */
export function findNativeExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  accessible: (path: string) => boolean = (path) => {
    try { accessSync(path, platform === "win32" ? constants.F_OK : constants.X_OK); return statSync(path).isFile(); }
    catch { return false; }
  },
): string | undefined {
  const windows = platform === "win32";
  const paths = windows ? win32 : posix;
  const value = (key: string) => windows ? Object.entries(env).find(([name]) => name.toUpperCase() === key)?.[1] : env[key];
  const extensions = windows ? (value("PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";").filter((extension) => /^\.[a-z0-9]+$/i.test(extension)) : [];
  const suffixes = extensions.some((extension) => extension.toLowerCase() === paths.extname(command).toLowerCase()) ? [""] : ["", ...extensions];
  const explicit = paths.isAbsolute(command) || command.includes("/") || windows && command.includes("\\");
  const searchPath = value("PATH");
  const directories = searchPath === undefined ? [] : searchPath.split(windows ? ";" : ":");
  const candidates = explicit ? [command] : directories.map((directory) => paths.join(directory.replace(/^"(.*)"$/, "$1") || ".", command));
  for (const candidate of candidates) for (const suffix of suffixes) {
    const path = candidate + suffix;
    if (accessible(path)) return paths.resolve(path);
  }
}
