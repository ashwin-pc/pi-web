import { lstat, opendir, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

const maxTraversalDepth = 128;
const maxTraversalEntries = 250_000;

function syncRefusal(reason: string) {
  return new Error(
    `Sync refused: ${reason}. Remove the nested Git state or directory link, ` +
    "or sync this checkout outside pi-web.",
  );
}

function errorCode(error: unknown) {
  return (error as NodeJS.ErrnoException).code;
}

async function assertNoCachedSubmoduleRepos(commonDir: string) {
  const modules = join(commonDir, "modules");
  let info;
  try {
    info = await lstat(modules);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw syncRefusal(`the cached submodule directory could not be verified (${modules})`);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw syncRefusal(`the cached submodule path is not a normal directory (${modules})`);
  }
  let entries;
  try {
    entries = await readdir(modules);
  } catch {
    throw syncRefusal(`the cached submodule directory could not be read (${modules})`);
  }
  if (entries.length > 0) {
    throw syncRefusal(`cached submodule repositories are present under ${modules}`);
  }
}

async function assertSafeLink(path: string) {
  try {
    const target = await realpath(path);
    if ((await stat(target)).isDirectory()) {
      throw syncRefusal(`a directory link is present at ${path}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Sync refused:")) throw error;
    throw syncRefusal(`a filesystem link could not be verified at ${path}`);
  }
}

/**
 * Pull may fetch a different commit from any one inspected beforehand. Refuse
 * pre-existing child repositories instead of trying to predict pull's target:
 * an incoming gitlink then has no child config available for Git to execute.
 */
export async function assertSyncFilesystemBoundary(root: string, commonDir: string) {
  let canonicalRoot: string;
  let canonicalCommonDir: string;
  try {
    [canonicalRoot, canonicalCommonDir] = await Promise.all([realpath(root), realpath(commonDir)]);
  } catch {
    throw syncRefusal("the repository root or common Git directory could not be resolved");
  }
  await assertNoCachedSubmoduleRepos(canonicalCommonDir);

  const pending: Array<{ path: string; depth: number }> = [{ path: canonicalRoot, depth: 0 }];
  let visitedEntries = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.path !== canonicalRoot) {
      const marker = join(current.path, ".git");
      try {
        await lstat(marker);
        throw syncRefusal(`a nested Git repository marker is present at ${marker}`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Sync refused:")) throw error;
        if (errorCode(error) !== "ENOENT") {
          throw syncRefusal(`a nested Git repository marker could not be verified at ${marker}`);
        }
      }
    }

    let directory;
    try {
      directory = await opendir(current.path);
    } catch {
      throw syncRefusal(`the checkout could not be completely inspected at ${current.path}`);
    }

    const children: Array<{ path: string; depth: number }> = [];
    let hasHead = false;
    let hasObjects = false;
    let hasRefs = false;
    let hasPackedRefs = false;
    try {
      for await (const entry of directory) {
        visitedEntries += 1;
        if (visitedEntries > maxTraversalEntries) {
          throw syncRefusal(`checkout inspection exceeded ${maxTraversalEntries} entries`);
        }
        const path = join(current.path, entry.name);
        const atRoot = current.path === canonicalRoot;
        if (entry.name.toLowerCase() === ".git") {
          if (atRoot) continue;
          throw syncRefusal(`a nested Git repository marker is present at ${path}`);
        }
        if (entry.isSymbolicLink()) {
          await assertSafeLink(path);
          continue;
        }
        if (entry.isDirectory()) {
          if (entry.name === "objects") hasObjects = true;
          if (entry.name === "refs") hasRefs = true;
          if (current.depth >= maxTraversalDepth) {
            throw syncRefusal(`checkout inspection exceeded ${maxTraversalDepth} directory levels at ${path}`);
          }
          children.push({ path, depth: current.depth + 1 });
          continue;
        }
        if (entry.isFile()) {
          if (entry.name === "HEAD") hasHead = true;
          if (entry.name === "packed-refs") hasPackedRefs = true;
          continue;
        }
        throw syncRefusal(`a filesystem entry could not be safely classified at ${path}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Sync refused:")) throw error;
      throw syncRefusal(`the checkout could not be completely inspected at ${current.path}`);
    }

    if (current.path !== canonicalRoot && hasHead && hasObjects && (hasRefs || hasPackedRefs)) {
      throw syncRefusal(`a nested bare Git repository is present at ${current.path}`);
    }
    pending.push(...children);
  }
}
