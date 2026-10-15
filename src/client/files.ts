// files.tree(root): a recursive file tree for a workspace root, walked through
// the existing one-level /api/files/tree endpoint (scoped by a session whose
// cwd contains the root). Bounded by depth and entry budgets so a huge
// repository cannot stall a view.
import type { FileTreeDir, FileTreeOptions } from "./types.js";

type Listing = { entries?: Array<{ name?: unknown; path?: unknown; kind?: unknown; size?: unknown }> };

export async function walkFileTree(options: {
  root: string;
  /** The session whose cwd scopes the API, and that cwd. */
  sessionId: string;
  cwd: string;
  list: (sessionId: string, relativePath: string, signal?: AbortSignal) => Promise<Listing>;
} & FileTreeOptions): Promise<FileTreeDir | null> {
  const maxDepth = options.maxDepth ?? 8;
  const maxEntries = options.maxEntries ?? 4000;
  const cwd = options.cwd.replace(/\/+$/, "");
  const root = options.root.replace(/\/+$/, "") || "/";
  if (root !== cwd && !root.startsWith(`${cwd}/`)) return null;
  const rootRelative = root === cwd ? "" : root.slice(cwd.length + 1);
  const name = root.split("/").filter(Boolean).pop() || root;
  const tree: FileTreeDir = { name, path: root, files: [], dirs: [] };
  let budget = maxEntries;
  // Breadth-first with a small concurrency, so shallow structure arrives before deep leaves.
  let frontier: Array<{ dir: FileTreeDir; relative: string; depth: number }> = [{ dir: tree, relative: rootRelative, depth: 0 }];
  const concurrency = 6;
  while (frontier.length && budget > 0) {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const next: typeof frontier = [];
    for (let index = 0; index < frontier.length; index += concurrency) {
      const slice = frontier.slice(index, index + concurrency);
      const listings = await Promise.all(slice.map((item) => options.list(options.sessionId, item.relative, options.signal).catch(() => ({ entries: [] } as Listing))));
      slice.forEach((item, position) => {
        for (const entry of listings[position].entries || []) {
          if (budget <= 0) { item.dir.truncated = true; break; }
          const entryName = typeof entry.name === "string" ? entry.name : "";
          if (!entryName) continue;
          budget--;
          const path = `${item.dir.path}/${entryName}`;
          if (entry.kind === "directory") {
            const child: FileTreeDir = { name: entryName, path, files: [], dirs: [] };
            item.dir.dirs.push(child);
            const relative = typeof entry.path === "string" ? entry.path : item.relative ? `${item.relative}/${entryName}` : entryName;
            if (item.depth + 1 < maxDepth) next.push({ dir: child, relative, depth: item.depth + 1 });
            else child.truncated = true;
          } else {
            item.dir.files.push({ name: entryName, path, ...(typeof entry.size === "number" ? { bytes: entry.size } : {}) });
          }
        }
      });
    }
    frontier = next;
  }
  for (const item of frontier) item.dir.truncated = true;
  return tree;
}
