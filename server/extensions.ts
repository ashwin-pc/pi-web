import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveWebHomePath } from "./shared/webHome.js";

type BundledExtensionPathOptions = {
  piCwd: string;
  appDir: string;
  bundledExtensionsDir: string;
};

type DiscoveryPolicy = "trusted" | "workspace-contained";

type DiscoveryContext = {
  root: string;
  seenDirs: Set<string>;
  policy: DiscoveryPolicy;
};

function isExtensionFile(name: string) {
  return name.endsWith(".ts") || name.endsWith(".js");
}

function isContained(root: string, path: string) {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

function realpathForDiscovery(path: string, context: DiscoveryContext) {
  try {
    const realPath = realpathSync(path);
    if (context.policy === "trusted" || isContained(context.root, realPath)) return realPath;
    console.warn(`pi-web: skipped workspace extension "${path}" because it resolves outside root "${context.root}"`);
    return undefined;
  } catch {
    return undefined;
  }
}

function dedupePaths(paths: string[]) {
  const seen = new Set<string>();
  return paths.filter((path) => {
    let key: string;
    try { key = realpathSync(path); } catch { key = resolve(path); }
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function existingPath(path: string, context: DiscoveryContext) {
  if (!existsSync(path)) return undefined;
  return realpathForDiscovery(path, context);
}

function readManifestExtensionEntries(dir: string, context: DiscoveryContext) {
  const packageJsonPath = join(dir, "package.json");
  if (!existingPath(packageJsonPath, context)) return [];

  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { pi?: { extensions?: unknown } };
    if (!Array.isArray(pkg.pi?.extensions)) return [];

    const entries: string[] = [];
    for (const entry of pkg.pi.extensions) {
      if (typeof entry !== "string") continue;
      const entryPath = resolve(dir, entry);
      if (!existingPath(entryPath, context)) continue;

      try {
        const stats = statSync(entryPath);
        if (stats.isFile()) entries.push(entryPath);
        else if (stats.isDirectory()) entries.push(...discoverExtensionEntryPathsInternal(entryPath, context));
      } catch {
        // Ignore invalid manifest entries.
      }
    }
    return entries;
  } catch {
    return [];
  }
}

function resolveExtensionEntries(dir: string, context: DiscoveryContext) {
  const manifestEntries = readManifestExtensionEntries(dir, context);
  if (manifestEntries.length > 0) return manifestEntries;

  for (const indexName of ["index.ts", "index.js"]) {
    const indexPath = join(dir, indexName);
    if (existingPath(indexPath, context)) return [indexPath];
  }
  return null;
}

function discoverExtensionEntryPathsInternal(dir: string, context: DiscoveryContext): string[] {
  const realDir = realpathForDiscovery(dir, context);
  if (!realDir || context.seenDirs.has(realDir)) return [];
  context.seenDirs.add(realDir);

  const rootEntries = resolveExtensionEntries(dir, context);
  if (rootEntries) return dedupePaths(rootEntries);

  const discovered: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

      const entryPath = join(dir, entry.name);
      if (!realpathForDiscovery(entryPath, context)) continue;
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
        const nestedEntries = resolveExtensionEntries(entryPath, context);
        if (nestedEntries) discovered.push(...nestedEntries);
      }
    }
  } catch {
    return [];
  }

  return dedupePaths(discovered);
}

function discoverExtensionEntryPathsWithPolicy(
  dir: string,
  seenDirs = new Set<string>(),
  policy: DiscoveryPolicy = "trusted",
): string[] {
  if (!existsSync(dir)) return [];
  let root: string;
  try { root = realpathSync(dir); } catch { return []; }
  for (const seenDir of [...seenDirs]) {
    try { seenDirs.add(realpathSync(seenDir)); } catch { seenDirs.add(resolve(seenDir)); }
  }
  return discoverExtensionEntryPathsInternal(dir, {
    root,
    seenDirs,
    policy,
  });
}

export function discoverExtensionEntryPaths(dir: string, seenDirs = new Set<string>()): string[] {
  return discoverExtensionEntryPathsWithPolicy(dir, seenDirs);
}

export function resolvePiWebExtensionPaths(cwd: string) {
  return dedupePaths([
    ...discoverExtensionEntryPathsWithPolicy(join(cwd, ".pi", "web", "extensions"), new Set(), "workspace-contained"),
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
