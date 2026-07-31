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

async function boundedContents(path: string, size: number) {
  const handle = await open(path, "r");
  try {
    const headSize = Math.min(size, HEAD_BYTES);
    const head = Buffer.allocUnsafe(headSize);
    const { bytesRead: headRead } = await handle.read(head, 0, headSize, 0);
    let text = head.subarray(0, headRead).toString("utf8");
    if (size > HEAD_BYTES) {
      const tailSize = Math.min(size - HEAD_BYTES, TAIL_BYTES);
      const tail = Buffer.allocUnsafe(tailSize);
      const position = size - tailSize;
      const { bytesRead: tailRead } = await handle.read(tail, 0, tailSize, position);
      // Discard the first possibly partial line.
      const tailText = tail.subarray(0, tailRead).toString("utf8");
      text += `\n${tailText.slice(Math.max(0, tailText.indexOf("\n") + 1))}`;
    }
    return text;
  } finally { await handle.close(); }
}

/** A bounded projection of pi's append-only JSONL. It never reads transcript bodies. */
export async function shallowListSessions(cwd: string, directory: string): Promise<SessionInfoDto[]> {
  let names: string[];
  try { names = await readdir(directory); } catch { return []; }
  return (await Promise.all(names.filter((name) => name.endsWith(".jsonl")).map(async (name) => {
    const metadata = filenameMetadata(name);
    if (!metadata) return undefined;
    const path = join(directory, name);
    try {
      const fileStat = await stat(path);
      if (!fileStat.isFile()) return undefined;
      const entries = parseLines(await boundedContents(path, fileStat.size));
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
      return result;
    } catch { return undefined; }
  }))).filter((value): value is SessionInfoDto => value !== undefined);
}
