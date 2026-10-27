import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { resolveWebHomePath } from "./shared/webHome.js";

type BundledExtensionPathOptions = {
  piCwd: string;
  appDir: string;
  bundledExtensionsDir: string;
};

type DiscoveryContext = {
  root: string;
  seenDirs: Set<string>;
  visitedObjects: number;
  truncated: boolean;
};

const MAX_DISCOVERY_DEPTH = 32;
export const MAX_EXTENSION_DISCOVERY_OBJECTS = 1024;

function isExtensionFile(name: string) {
  return name.endsWith(".ts") || name.endsWith(".js");
}

function isContained(root: string, path: string) {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

function realpathWithinRoot(path: string, context: DiscoveryContext) {
  try {
    const realPath = realpathSync(path);
    return isContained(context.root, realPath) ? realPath : undefined;
  } catch {
    return undefined;
  }
}

function visitObject(context: DiscoveryContext) {
  if (context.visitedObjects >= MAX_EXTENSION_DISCOVERY_OBJECTS) {
    context.truncated = true;
    return false;
  }
  context.visitedObjects += 1;
  return true;
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

function containedExistingPath(path: string, context: DiscoveryContext) {
  if (!existsSync(path) || !visitObject(context)) return undefined;
  return realpathWithinRoot(path, context);
}

function readManifestExtensionEntries(dir: string, context: DiscoveryContext, depth: number) {
  const packageJsonPath = join(dir, "package.json");
  if (!containedExistingPath(packageJsonPath, context)) return [];

  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { pi?: { extensions?: unknown } };
    if (!Array.isArray(pkg.pi?.extensions)) return [];

    const entries: string[] = [];
    for (const entry of pkg.pi.extensions) {
      if (context.truncated) break;
      if (typeof entry !== "string" || isAbsolute(entry)) continue;
      const entryPath = resolve(dir, entry);
      if (!isContained(resolve(dir), entryPath) || !containedExistingPath(entryPath, context)) continue;

      try {
        const stats = statSync(entryPath);
        if (stats.isFile()) entries.push(entryPath);
        else if (stats.isDirectory()) entries.push(...discoverExtensionEntryPathsInternal(entryPath, context, depth + 1));
      } catch {
        // Ignore invalid manifest entries.
      }
    }
    return entries;
  } catch {
    return [];
  }
}

function resolveExtensionEntries(dir: string, context: DiscoveryContext, depth: number) {
  const manifestEntries = readManifestExtensionEntries(dir, context, depth);
  if (manifestEntries.length > 0) return manifestEntries;
  if (context.truncated) return [];

  for (const indexName of ["index.ts", "index.js"]) {
    const indexPath = join(dir, indexName);
    if (containedExistingPath(indexPath, context)) return [indexPath];
    if (context.truncated) return [];
  }
  return null;
}

function discoverExtensionEntryPathsInternal(dir: string, context: DiscoveryContext, depth: number): string[] {
  if (context.truncated || depth > MAX_DISCOVERY_DEPTH) return [];
  const realDir = realpathWithinRoot(dir, context);
  if (!realDir || context.seenDirs.has(realDir)) return [];
  context.seenDirs.add(realDir);

  const rootEntries = resolveExtensionEntries(dir, context, depth);
  if (rootEntries) return dedupePaths(rootEntries);

  const discovered: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!visitObject(context)) break;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

      const entryPath = join(dir, entry.name);
      if (!realpathWithinRoot(entryPath, context)) continue;
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
        const nestedEntries = resolveExtensionEntries(entryPath, context, depth + 1);
        if (nestedEntries) discovered.push(...nestedEntries);
      }
    }
  } catch {
    return [];
  }

  return dedupePaths(discovered);
}

export function discoverExtensionEntryPaths(dir: string, seenDirs = new Set<string>()): string[] {
  if (!existsSync(dir)) return [];
  let root: string;
  try { root = realpathSync(dir); } catch { return []; }
  for (const seenDir of [...seenDirs]) {
    try { seenDirs.add(realpathSync(seenDir)); } catch { seenDirs.add(resolve(seenDir)); }
  }
  return discoverExtensionEntryPathsInternal(dir, {
    root,
    seenDirs,
    visitedObjects: 1,
    truncated: false,
  }, 0);
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
