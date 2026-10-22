import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
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

/**
 * Returns true when `child` is `root` or a descendant of `root`. Both paths
 * are compared after being resolved; neither has to exist. The check is
 * applied against the logical (lexical) layout: callers performing symlink
 * containment should resolve `child` through `realpathSync` first and pass
 * the realpath of `root` as `root` here.
 */
function isPathContained(child: string, root: string) {
  const rel = relative(root, child);
  if (rel === "") return true;
  return !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Resolve a possibly-symlinked path to its realpath while still succeeding
 * for paths that do not exist on disk. Returns `null` only when an existing
 * path cannot be resolved (treat as untrusted).
 */
function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Enforce that `candidate` stays within `root` both lexically (so manifest
 * entries like `"../../etc"` are rejected) and after following any symlinks
 * (so a symlink inside the extensions root that points outside is rejected).
 * `root` is the resolved extensions root; it is expected to exist.
 */
function isEntryContainedInRoot(candidate: string, root: string): boolean {
  const resolvedCandidate = resolve(candidate);
  if (!isPathContained(resolvedCandidate, root)) return false;

  const realRoot = safeRealpath(root) ?? root;
  const realCandidate = safeRealpath(resolvedCandidate);
  // If the candidate does not exist yet, fall back to the lexical check above.
  if (realCandidate === null) return true;
  return isPathContained(realCandidate, realRoot);
}

function readManifestExtensionEntries(dir: string, seenDirs: Set<string>, root: string) {
  const packageJsonPath = join(dir, "package.json");
  if (!existsSync(packageJsonPath)) return [];

  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { pi?: { extensions?: unknown } };
    if (!Array.isArray(pkg.pi?.extensions)) return [];

    return pkg.pi.extensions.flatMap((entry) => {
      if (typeof entry !== "string") return [];
      // Reject absolute paths outright: a manifest must not name arbitrary
      // host files as code to execute.
      if (isAbsolute(entry)) return [];
      const entryPath = resolve(dir, entry);
      // Reject entries that escape the containing extension directory, or
      // that resolve (through symlinks) outside the extensions root.
      if (!isPathContained(entryPath, resolve(dir))) return [];
      if (!isEntryContainedInRoot(entryPath, root)) return [];
      if (!existsSync(entryPath)) return [];

      try {
        const stats = statSync(entryPath);
        if (stats.isFile()) return [entryPath];
        if (stats.isDirectory()) return discoverExtensionEntryPaths(entryPath, seenDirs, root);
      } catch {
        // Ignore invalid manifest entries.
      }
      return [];
    });
  } catch {
    return [];
  }
}

function resolveExtensionEntries(dir: string, seenDirs: Set<string>, root: string) {
  const manifestEntries = readManifestExtensionEntries(dir, seenDirs, root);
  if (manifestEntries.length > 0) return manifestEntries;

  const indexTs = join(dir, "index.ts");
  if (existsSync(indexTs) && isEntryContainedInRoot(indexTs, root)) return [indexTs];

  const indexJs = join(dir, "index.js");
  if (existsSync(indexJs) && isEntryContainedInRoot(indexJs, root)) return [indexJs];

  return null;
}

export function discoverExtensionEntryPaths(
  dir: string,
  seenDirs = new Set<string>(),
  root?: string,
): string[] {
  if (!existsSync(dir)) return [];

  const dirKey = resolve(dir);
  if (seenDirs.has(dirKey)) return [];
  seenDirs.add(dirKey);

  // The first (top-level) directory is the extensions root used for
  // containment checks on nested entries and symlink targets. Nested calls
  // thread the same root through, so a symlink inside `<root>/foo` cannot
  // escape via a package manifest that resolves outside `<root>`.
  const effectiveRoot = root ?? safeRealpath(dirKey) ?? dirKey;

  const rootEntries = resolveExtensionEntries(dir, seenDirs, effectiveRoot);
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
        // Follow the symlink only when its realpath stays inside the
        // extensions root; otherwise skip it entirely so a dropped link
        // cannot pull in code from outside the workspace.
        if (!isEntryContainedInRoot(entryPath, effectiveRoot)) continue;
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
        const nestedEntries = resolveExtensionEntries(entryPath, seenDirs, effectiveRoot);
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
