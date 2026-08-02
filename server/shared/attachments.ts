import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

export const attachmentFence = "~~~json pi-web-attachments-v1";
export const attachmentPathParts = [".pi", "web", "attachments"] as const;
const attachmentIdPattern = /^[a-f0-9-]{36}$/;
const safeStoredNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;

export type MessageAttachment = {
  id: string;
  name: string;
  mediaType: string;
  bytes: number;
  path: string;
  contentUrl: string;
};

type StoredMessageAttachment = Omit<MessageAttachment, "contentUrl">;

function safeStoredName(value: string) {
  const cleaned = basename(value).normalize("NFKC").replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 120);
  return cleaned && /^[a-zA-Z0-9]/.test(cleaned) ? cleaned : "attachment";
}

export function attachmentRootForCwd(cwd: string) {
  return join(cwd, ...attachmentPathParts);
}

export async function storeAttachment(cwd: string, input: { name: string; mediaType: string; data: string }): Promise<MessageAttachment> {
  if (!/^[a-zA-Z0-9+/]*={0,2}$/.test(input.data) || input.data.length % 4 !== 0) throw new Error("Attachment data is not valid Base64");
  const buffer = Buffer.from(input.data, "base64");
  if (!buffer.length) throw new Error("Attachment is empty");
  if (buffer.length > 30_000_000) throw new Error("Attachment is too large");
  const id = randomUUID();
  const name = safeStoredName(input.name || "attachment");
  const dir = join(attachmentRootForCwd(cwd), id);
  const path = join(dir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path, buffer, { flag: "wx" });
  return { id, name, mediaType: input.mediaType || "application/octet-stream", bytes: buffer.length, path, contentUrl: attachmentContentUrl(id, name) };
}

export function attachmentContentUrl(id: string, name: string) {
  return `/api/attachments/${encodeURIComponent(id)}/${encodeURIComponent(name)}`;
}

export function serializeAttachmentMarkup(text: string, attachments: Array<Omit<MessageAttachment, "contentUrl"> | MessageAttachment> = []) {
  if (!attachments.length) return text;
  const stored = attachments.map(({ id, name, mediaType, bytes, path }) => ({ id, name, mediaType, bytes, path }));
  return `${text}\n\n${attachmentFence}\n${JSON.stringify({ version: 1, attachments: stored })}\n~~~`;
}

function validStoredAttachment(value: unknown, cwd?: string): StoredMessageAttachment | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (!attachmentIdPattern.test(String(item.id || "")) || !safeStoredNamePattern.test(String(item.name || ""))) return undefined;
  if (typeof item.mediaType !== "string" || !item.mediaType || item.mediaType.length > 160) return undefined;
  if (!Number.isSafeInteger(item.bytes) || Number(item.bytes) < 0) return undefined;
  if (typeof item.path !== "string" || !item.path) return undefined;
  const suffix = `${sep}.pi${sep}web${sep}attachments${sep}${String(item.id)}${sep}${String(item.name)}`;
  if (!resolve(item.path).endsWith(suffix)) return undefined;
  if (cwd) {
    const expected = resolve(attachmentRootForCwd(cwd), String(item.id), String(item.name));
    if (resolve(item.path) !== expected) return undefined;
  }
  return { id: String(item.id), name: String(item.name), mediaType: item.mediaType, bytes: Number(item.bytes), path: item.path };
}

export function normalizeSubmittedAttachments(cwd: string, value: unknown): MessageAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const stored = validStoredAttachment(item, cwd);
    return stored ? [{ ...stored, contentUrl: attachmentContentUrl(stored.id, stored.name) }] : [];
  });
}

export function parseAttachmentMarkup(rawText: string, cwd?: string): { text: string; attachments: MessageAttachment[] } {
  const marker = `\n\n${attachmentFence}\n`;
  const start = rawText.lastIndexOf(marker);
  if (start < 0 || !rawText.endsWith("\n~~~")) return { text: rawText, attachments: [] };
  const jsonStart = start + marker.length;
  const jsonText = rawText.slice(jsonStart, -4);
  try {
    const parsed = JSON.parse(jsonText) as { version?: unknown; attachments?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.attachments) || !parsed.attachments.length) return { text: rawText, attachments: [] };
    const stored = parsed.attachments.map((item) => validStoredAttachment(item, cwd));
    if (stored.some((item) => !item)) return { text: rawText, attachments: [] };
    return {
      text: rawText.slice(0, start),
      attachments: (stored as StoredMessageAttachment[]).map((item) => ({ ...item, contentUrl: attachmentContentUrl(item.id, item.name) })),
    };
  } catch {
    return { text: rawText, attachments: [] };
  }
}

export function resolveAttachmentFile(cwds: Iterable<string>, id: string, name: string): string | undefined {
  if (!attachmentIdPattern.test(id) || !safeStoredNamePattern.test(name)) return undefined;
  for (const cwd of cwds) {
    const root = attachmentRootForCwd(cwd);
    const file = resolve(root, id, name);
    if (!existsSync(file) || !statSync(file).isFile()) continue;
    const realRoot = realpathSync(root);
    const realFile = realpathSync(file);
    const fromRoot = relative(realRoot, realFile);
    if (fromRoot && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`)) return file;
  }
  return undefined;
}
