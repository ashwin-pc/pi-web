import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SessionInfoDto } from "./dto.js";

const HEAD_BYTES = 32 * 1024;
const TAIL_BYTES = 8 * 1024;

function parseLines(text: string) {
  const entries: any[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* a bounded read may end mid-entry */ }
  }
  return entries;
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part: any) => part?.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
}

function filenameMetadata(name: string) {
  const match = name.match(/^(.+)_([^_]+)\.jsonl$/);
  if (!match) return undefined;
  const encoded = match[1];
  const iso = encoded.replace(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    "$1T$2:$3:$4.$5Z",
  );
  const created = new Date(iso);
  if (Number.isNaN(created.getTime())) return undefined;
  return { id: match[2], created };
}

export interface ShallowListMetrics { files: number; bytesRead: number }

const SCAN_CONCURRENCY = 16;

/** Run `fn` over `items` with at most `limit` in-flight at once. */
async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = index++;
      if (i >= items.length) break;
      results[i] = await fn(items[i]);
    }
  }));
  return results;
}

async function boundedContents(path: string, size: number, metrics?: ShallowListMetrics) {
  const handle = await open(path, "r");
  try {
    const headSize = Math.min(size, HEAD_BYTES);
    const head = Buffer.allocUnsafe(headSize);
    const { bytesRead: headRead } = await handle.read(head, 0, headSize, 0);
    if (metrics) metrics.bytesRead += headRead;
    let text = head.subarray(0, headRead).toString("utf8");
    if (size > HEAD_BYTES) {
      const tailSize = Math.min(size - HEAD_BYTES, TAIL_BYTES);
      const tail = Buffer.allocUnsafe(tailSize);
      const position = size - tailSize;
      const { bytesRead: tailRead } = await handle.read(tail, 0, tailSize, position);
      if (metrics) metrics.bytesRead += tailRead;
      // Deliberately drop any entry straddling the head/tail boundary, including
      // contiguous 32–40 KiB reads; bounded metadata projection tolerates that loss.
      const tailText = tail.subarray(0, tailRead).toString("utf8");
      text += `\n${tailText.slice(Math.max(0, tailText.indexOf("\n") + 1))}`;
    }
    return text;
  } finally { await handle.close(); }
}

export async function shallowSessionCwd(path: string): Promise<string | undefined> {
  try {
    const fileStat = await stat(path);
    const header = parseLines(await boundedContents(path, fileStat.size)).find((entry) => entry?.type === "session");
    return typeof header?.cwd === "string" && header.cwd ? header.cwd : undefined;
  } catch { return undefined; }
}

// Stat-gated cache for the session-list scan (issue #112: message_end-driven
// refetches rescanned ~1,223 JSONLs / ~40MB on the main thread each time).
// Session files are append-only, so head+tail bytes are unchanged iff the file
// size is unchanged; `mtimeMs` adds redundancy against a same-size rewrite
// within git's "racily clean" mtime granularity.
//
// The cached DTO is a pure function of (filename, head+tail bytes, file stat), so
// it stays valid while size and mtime are unchanged. Entries whose path is no
// longer in the current readdir are evicted, bounding each directory's map to its
// live file set. `metrics.bytesRead` counts only actual boundedContents reads (0
// on hits).
//
// The cache is INSTANCE-OWNED, not module-global: each ShallowLister owns its own
// directory->map so concurrent scans of different cwds (service.list() runs one
// per known cwd via Promise.all) never touch each other's maps, and tests get
// fresh, isolated state with no reset hook. When the service is hosted per-runtime
// (PR #43 Stage 3), the cache lifecycle rides along for free.
interface CachedEntry { size: number; mtimeMs: number; dto: SessionInfoDto }

export interface ShallowLister {
  list(cwd: string, directory: string, metrics?: ShallowListMetrics): Promise<SessionInfoDto[]>;
}

export function createShallowLister(): ShallowLister {
  // directory -> (absolute file path -> entry). Owned by this instance.
  const cache = new Map<string, Map<string, CachedEntry>>();

  return {
    async list(cwd, directory, metrics) {
      let names: string[];
      try { names = await readdir(directory); } catch { return []; }
      const jsonlNames = names.filter((name) => name.endsWith(".jsonl"));

      // Eviction only ever touches THIS directory's entries.
      let dirCache = cache.get(directory);
      if (!dirCache) { dirCache = new Map(); cache.set(directory, dirCache); }
      const seen = new Set(jsonlNames.map((name) => join(directory, name)));
      for (const key of dirCache.keys()) if (!seen.has(key)) dirCache.delete(key);

      const results = await mapConcurrent(jsonlNames, SCAN_CONCURRENCY, async (name) => {
        const metadata = filenameMetadata(name);
        if (!metadata) return undefined;
        const path = join(directory, name);
        try {
          const fileStat = await stat(path);
          if (!fileStat.isFile()) return undefined;
          if (metrics) metrics.files += 1;
          const cached = dirCache.get(path);
          if (cached && cached.size === fileStat.size && cached.mtimeMs === fileStat.mtimeMs) {
            return cached.dto;
          }
          const entries = parseLines(await boundedContents(path, fileStat.size, metrics));
          const header = entries.find((entry) => entry?.type === "session");
          if (header?.id && header.id !== metadata.id) return undefined;
          let sessionName: string | undefined;
          let firstMessage: string | undefined;
          for (const entry of entries) {
            if (entry?.type === "session_info") sessionName = typeof entry.name === "string" && entry.name ? entry.name : undefined;
            if (!firstMessage && entry?.type === "message" && entry.message?.role === "user") {
              firstMessage = textContent(entry.message.content).replace(/\s+/g, " ").trim() || undefined;
            }
          }
          const result: SessionInfoDto = {
            id: metadata.id,
            path,
            name: sessionName,
            firstMessage,
            created: metadata.created.toISOString(),
            modified: fileStat.mtime.toISOString(),
            cwd: typeof header?.cwd === "string" && header.cwd ? header.cwd : cwd,
            isCurrent: false as const,
          };
          // Freeze cached DTOs: they are shared references across calls. Today every
          // consumer spreads copies, but a future in-place mutation would silently
          // corrupt the cache; freezing makes that a loud error in dev.
          dirCache.set(path, { size: fileStat.size, mtimeMs: fileStat.mtimeMs, dto: Object.freeze(result) });
          return result;
        } catch { return undefined; }
      });
      return results.filter((value): value is SessionInfoDto => value !== undefined);
    },
  };
}
