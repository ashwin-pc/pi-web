import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

export const attachmentFence = "~~~json pi-web-attachments-v2";
export const legacyAttachmentFence = "~~~json pi-web-attachments-v1";
export const attachmentPathParts = [".pi", "web", "attachments"] as const;
const attachmentIdPattern = /^[a-f0-9-]{36}$/;
const safeStoredNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;
const githubRepositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export type FileMessageAttachment = {
  type: "file";
  id: string;
  name: string;
  mediaType: string;
  bytes: number;
  path: string;
  contentUrl: string;
};

export type ReferenceMessageAttachment = {
  type: "reference";
  id: string;
  label: string;
  title?: string;
  reference: {
    provider: "github";
    repository: string;
    resource: "issue" | "pull-request";
    number: number;
    url: string;
  };
};

export type QuoteReplyMessageAttachment = {
  type: "quote-reply";
  id: string;
  label: string;
  quote: string;
  question: string;
  source: {
    messageId?: string;
    startOffset: number;
    endOffset: number;
  };
};

export type MessageAttachment = FileMessageAttachment | ReferenceMessageAttachment | QuoteReplyMessageAttachment;
type StoredFileAttachment = Omit<FileMessageAttachment, "contentUrl">;

function safeStoredName(value: string) {
  const cleaned = basename(value).normalize("NFKC").replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 120);
  return cleaned && /^[a-zA-Z0-9]/.test(cleaned) ? cleaned : "attachment";
}

export function attachmentRootForCwd(cwd: string) {
  return join(cwd, ...attachmentPathParts);
}

export async function storeAttachment(cwd: string, input: { name: string; mediaType: string; data: string } | { name: string; mediaType: string; bytes: Uint8Array }): Promise<FileMessageAttachment> {
  let buffer: Buffer;
  if ("bytes" in input) buffer = Buffer.from(input.bytes);
  else {
    if (!/^[a-zA-Z0-9+/]*={0,2}$/.test(input.data) || input.data.length % 4 !== 0) throw new Error("Attachment data is not valid Base64");
    buffer = Buffer.from(input.data, "base64");
  }
  if (!buffer.length) throw new Error("Attachment is empty");
  if (buffer.length > 30_000_000) throw new Error("Attachment is too large");
  const id = randomUUID();
  const name = safeStoredName(input.name || "attachment");
  const dir = join(attachmentRootForCwd(cwd), id);
  const path = join(dir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path, buffer, { flag: "wx" });
  return { type: "file", id, name, mediaType: input.mediaType || "application/octet-stream", bytes: buffer.length, path, contentUrl: attachmentContentUrl(id, name) };
}

export function attachmentContentUrl(id: string, name: string) {
  return `/api/attachments/${encodeURIComponent(id)}/${encodeURIComponent(name)}`;
}

export function serializeAttachmentMarkup(text: string, attachments: MessageAttachment[] = []) {
  if (!attachments.length) return text;
  const stored = attachments.map((attachment) => attachment.type !== "file"
    ? attachment
    : (({ type, id, name, mediaType, bytes, path }) => ({ type, id, name, mediaType, bytes, path }))(attachment));
  return `${text}\n\n${attachmentFence}\n${JSON.stringify({ version: 2, attachments: stored })}\n~~~`;
}

function validStoredAttachment(value: unknown, cwd?: string): StoredFileAttachment | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (item.type !== undefined && item.type !== "file") return undefined;
  if (!attachmentIdPattern.test(String(item.id || "")) || !safeStoredNamePattern.test(String(item.name || ""))) return undefined;
  if (typeof item.mediaType !== "string" || !item.mediaType || item.mediaType.length > 160) return undefined;
  if (!Number.isSafeInteger(item.bytes) || Number(item.bytes) < 0) return undefined;
  if (typeof item.path !== "string" || !item.path) return undefined;
  const suffix = `${sep}.pi${sep}web${sep}attachments${sep}${String(item.id)}${sep}${String(item.name)}`;
  if (!resolve(item.path).endsWith(suffix)) return undefined;
  if (cwd && resolve(item.path) !== resolve(attachmentRootForCwd(cwd), String(item.id), String(item.name))) return undefined;
  return { type: "file", id: String(item.id), name: String(item.name), mediaType: item.mediaType, bytes: Number(item.bytes), path: item.path };
}

function validReferenceAttachment(value: unknown): ReferenceMessageAttachment | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const reference = item.reference && typeof item.reference === "object" ? item.reference as Record<string, unknown> : undefined;
  if (item.type !== "reference" || typeof item.id !== "string" || !item.id || item.id.length > 500) return undefined;
  if (typeof item.label !== "string" || !item.label || item.label.length > 200) return undefined;
  if (item.title !== undefined && (typeof item.title !== "string" || item.title.length > 500)) return undefined;
  if (!reference || reference.provider !== "github" || !githubRepositoryPattern.test(String(reference.repository || ""))) return undefined;
  if (reference.resource !== "issue" && reference.resource !== "pull-request") return undefined;
  if (!Number.isSafeInteger(reference.number) || Number(reference.number) <= 0) return undefined;
  const expectedUrl = `https://github.com/${reference.repository}/${reference.resource === "issue" ? "issues" : "pull"}/${reference.number}`;
  if (reference.url !== expectedUrl) return undefined;
  return {
    type: "reference", id: item.id, label: item.label,
    ...(typeof item.title === "string" ? { title: item.title } : {}),
    reference: { provider: "github", repository: String(reference.repository), resource: reference.resource, number: Number(reference.number), url: expectedUrl },
  };
}

function validQuoteReplyAttachment(value: unknown): QuoteReplyMessageAttachment | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const source = item.source && typeof item.source === "object" ? item.source as Record<string, unknown> : undefined;
  if (item.type !== "quote-reply" || typeof item.id !== "string" || !item.id || item.id.length > 500) return undefined;
  if (typeof item.label !== "string" || !item.label || item.label.length > 200) return undefined;
  if (typeof item.quote !== "string" || !item.quote.trim() || item.quote.length > 20_000) return undefined;
  if (typeof item.question !== "string" || !item.question.trim() || item.question.length > 10_000) return undefined;
  if (!source || !Number.isSafeInteger(source.startOffset) || Number(source.startOffset) < 0) return undefined;
  if (!Number.isSafeInteger(source.endOffset) || Number(source.endOffset) <= Number(source.startOffset)) return undefined;
  if (source.messageId !== undefined && (typeof source.messageId !== "string" || !source.messageId || source.messageId.length > 500)) return undefined;
  return {
    type: "quote-reply",
    id: item.id,
    label: item.label,
    quote: item.quote,
    question: item.question,
    source: {
      ...(typeof source.messageId === "string" ? { messageId: source.messageId } : {}),
      startOffset: Number(source.startOffset),
      endOffset: Number(source.endOffset),
    },
  };
}

function normalizeAttachment(cwd: string | undefined, item: unknown): MessageAttachment | undefined {
  const quoteReply = validQuoteReplyAttachment(item);
  if (quoteReply) return quoteReply;
  const reference = validReferenceAttachment(item);
  if (reference) return reference;
  const stored = validStoredAttachment(item, cwd);
  return stored ? { ...stored, contentUrl: attachmentContentUrl(stored.id, stored.name) } : undefined;
}

export function normalizeSubmittedAttachments(cwd: string, value: unknown): MessageAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const normalized = normalizeAttachment(cwd, item);
    return normalized ? [normalized] : [];
  });
}

export function parseAttachmentMarkup(rawText: string, cwd?: string): { text: string; attachments: MessageAttachment[] } {
  const candidates = [{ fence: attachmentFence, version: 2 }, { fence: legacyAttachmentFence, version: 1 }];
  for (const candidate of candidates) {
    const marker = `\n\n${candidate.fence}\n`;
    const start = rawText.lastIndexOf(marker);
    if (start < 0 || !rawText.endsWith("\n~~~")) continue;
    try {
      const parsed = JSON.parse(rawText.slice(start + marker.length, -4)) as { version?: unknown; attachments?: unknown };
      if (parsed.version !== candidate.version || !Array.isArray(parsed.attachments) || !parsed.attachments.length) return { text: rawText, attachments: [] };
      const attachments = parsed.attachments.map((item) => normalizeAttachment(cwd, item));
      if (attachments.some((item) => !item)) return { text: rawText, attachments: [] };
      return { text: rawText.slice(0, start), attachments: attachments as MessageAttachment[] };
    } catch { return { text: rawText, attachments: [] }; }
  }
  return { text: rawText, attachments: [] };
}

export function resolveAttachmentFile(cwds: Iterable<string>, id: string, name: string): string | undefined {
  if (!attachmentIdPattern.test(id) || !safeStoredNamePattern.test(name)) return undefined;
  for (const cwd of cwds) {
    const root = attachmentRootForCwd(cwd);
    const file = resolve(root, id, name);
    if (!existsSync(file) || !statSync(file).isFile()) continue;
    const fromRoot = relative(realpathSync(root), realpathSync(file));
    if (fromRoot && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`)) return file;
  }
  return undefined;
}
