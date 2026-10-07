import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolveWebHomePath } from "./shared/webHome.js";

type BundledExtensionPathOptions = {
  piCwd: string;
  appDir: string;
  bundledExtensionsDir: string;
};

function isExtensionFile(name: string) {
  return name.endsWith(".ts") || name.endsWith(".js");
}

function dedupePaths(paths: string[]) {
  const seen = new Set<string>();
  return paths.filter((path) => {
    const key = resolve(path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readManifestExtensionEntries(dir: string, seenDirs: Set<string>) {
  const packageJsonPath = join(dir, "package.json");
  if (!existsSync(packageJsonPath)) return [];

  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { pi?: { extensions?: unknown } };
    if (!Array.isArray(pkg.pi?.extensions)) return [];

    return pkg.pi.extensions.flatMap((entry) => {
      if (typeof entry !== "string") return [];
      const entryPath = resolve(dir, entry);
      if (!existsSync(entryPath)) return [];

      try {
        const stats = statSync(entryPath);
        if (stats.isFile()) return [entryPath];
        if (stats.isDirectory()) return discoverExtensionEntryPaths(entryPath, seenDirs);
      } catch {
        // Ignore invalid manifest entries.
      }
      return [];
    });
  } catch {
    return [];
  }
}

function resolveExtensionEntries(dir: string, seenDirs: Set<string>) {
  const manifestEntries = readManifestExtensionEntries(dir, seenDirs);
  if (manifestEntries.length > 0) return manifestEntries;

  const indexTs = join(dir, "index.ts");
  if (existsSync(indexTs)) return [indexTs];

  const indexJs = join(dir, "index.js");
  if (existsSync(indexJs)) return [indexJs];

  return null;
}

export function discoverExtensionEntryPaths(dir: string, seenDirs = new Set<string>()): string[] {
  if (!existsSync(dir)) return [];

  const dirKey = resolve(dir);
  if (seenDirs.has(dirKey)) return [];
  seenDirs.add(dirKey);

  const rootEntries = resolveExtensionEntries(dir, seenDirs);
  if (rootEntries) return dedupePaths(rootEntries);

  const discovered: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

      const entryPath = join(dir, entry.name);
      let isFile = entry.isFile();
      let isDirectory = entry.isDirectory();

      if (entry.isSymbolicLink()) {
        try {
          const stats = statSync(entryPath);
          isFile = stats.isFile();
          isDirectory = stats.isDirectory();
        } catch {
          continue;
        }
      }

      if (isFile && isExtensionFile(entry.name)) {
        discovered.push(entryPath);
        continue;
      }

      if (isDirectory) {
        const nestedEntries = resolveExtensionEntries(entryPath, seenDirs);
        if (nestedEntries) discovered.push(...nestedEntries);
      }
    }
  } catch {
    return [];
  }

  return dedupePaths(discovered);
}

export function resolvePiWebExtensionPaths(cwd: string) {
  return dedupePaths([
    ...discoverExtensionEntryPaths(join(cwd, ".pi", "web", "extensions")),
    ...discoverExtensionEntryPaths(resolveWebHomePath("extensions", join(homedir(), ".pi", "web", "extensions"))),
  ]);
}

export function resolveBundledExtensionPaths(options: BundledExtensionPathOptions) {
  // When developing pi-web from this repo, the same directory is already loaded
  // by pi as the project-local .pi/extensions path. For other PI_WEB_CWD values
  // and packaged installs, add pi-web's bundled extensions explicitly.
  if (resolve(options.piCwd) === resolve(options.appDir) || !existsSync(options.bundledExtensionsDir)) return [];

  // DefaultResourceLoader resolves additionalExtensionPaths as package sources.
  // Passing the extensions directory itself can produce the directory as a single
  // extension path, so expand it to concrete entry files before handing it to pi.
  return discoverExtensionEntryPaths(options.bundledExtensionsDir);
}
