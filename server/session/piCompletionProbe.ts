import { open, stat, type FileHandle } from "node:fs/promises";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import type { PiWebSession } from "../types.js";

import { assertCompletionPayload, CompletionOutboxError, type CompletionFact, type CompletionInitialFact, type CompletionInput, type CompletionProbe } from "./completionOutbox.js";

/** Audit candidate only; the probe must still verify disk/history/idle absence. */
export class CompletionNotAdmittedError extends Error {
  constructor(readonly cause: unknown) { super("Immediate SDK completion send rejected without admission"); }
}
interface ReceiptMessage { role?: unknown; customType?: unknown; content?: unknown; display?: unknown; details?: Record<string, unknown> }
interface ReceiptEntry extends ReceiptMessage { type?: unknown; id?: unknown; message?: ReceiptMessage }
function custom(entry: ReceiptEntry): ReceiptMessage | undefined {
  return entry?.type === "custom_message" ? entry : entry?.type === "message" && entry.message?.role === "custom" ? entry.message : undefined;
}
function matchingEntry(entries: unknown[], input: CompletionInput): string | undefined {
  let found: string | undefined;
  for (const entry of entries as ReceiptEntry[]) {
    const message = custom(entry);
    if (message?.details?.deliveryId !== input.deliveryId) continue;
    const payload = { customType: message.customType, content: message.content, display: message.display, details: message.details };
    assertCompletionPayload(input, payload);
    if (typeof entry.id === "string") found = entry.id;
  }
  return found;
}

interface DiskCursor { dev: number; ino: number; offset: number; partial: Buffer[]; boundary?: boolean; verified: boolean; saved?: string }
function uncertain(): never { throw new CompletionOutboxError("Cannot verify completion: session identity is uncertain", 503); }
async function snapshot(value: PiWebSession, reconcile: boolean): Promise<DiskCursor | undefined> {
  try {
    const file = await stat(value.sessionFile);
    if (!file.isFile()) uncertain();
    return { dev: file.dev, ino: file.ino, offset: reconcile ? 0 : file.size, partial: [], boundary: reconcile || !file.size ? true : undefined, verified: false };
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
async function verifyHeader(file: FileHandle, size: number, sessionId: string) {
  // Read just the header, not the parent transcript. Decode via the public SDK.
  const chunks: Buffer[] = [];
  let position = 0;
  while (position < size) {
    const chunk = Buffer.alloc(Math.min(4096, size - position));
    const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
    if (!bytesRead) uncertain();
    const end = chunk.subarray(0, bytesRead).indexOf(10);
    chunks.push(chunk.subarray(0, end < 0 ? bytesRead : end + 1));
    position += bytesRead;
    if (end >= 0) break;
  }
  const header = parseSessionEntries(Buffer.concat(chunks).toString("utf8"))[0];
  if (!chunks.length || chunks.at(-1)!.at(-1) !== 10 || header?.type !== "session" || header.id !== sessionId) uncertain();
}
async function readAppendedRecords(file: FileHandle, cursor: DiskCursor, size: number, onRecords: (entries: unknown[]) => void) {
  let offset = cursor.offset;
  let partial = cursor.partial;
  let boundary = cursor.boundary;
  if (boundary === undefined && offset < size) {
    // A failed SDK append may leave EOF inside a JSONL record. Its next
    // append is NOT a standalone record, even if that suffix parses alone.
    const byte = Buffer.alloc(1);
    if ((await file.read(byte, 0, 1, offset - 1)).bytesRead !== 1) uncertain();
    boundary = byte[0] === 10;
  }
  while (offset < size) {
    const chunk = Buffer.alloc(Math.min(64 * 1024, size - offset));
    const { bytesRead } = await file.read(chunk, 0, chunk.length, offset);
    if (!bytesRead) uncertain();
    offset += bytesRead;
    let content = chunk.subarray(0, bytesRead);
    if (boundary === false) {
      const newline = content.indexOf(10);
      if (newline < 0) continue;
      content = content.subarray(newline + 1);
      boundary = true;
    }
    const end = content.lastIndexOf(10) + 1;
    if (end) {
      const complete = Buffer.concat([...partial, content.subarray(0, end)]);
      onRecords(parseSessionEntries(complete.toString("utf8")));
      partial = end < content.length ? [content.subarray(end)] : [];
    } else partial = [...partial, content];
  }
  return { offset, partial, boundary };
}
/** Memory is only a negative fast path, NEVER persistence proof. A new claim
 * starts at the pre-send EOF; an existing SDK candidate reconciles from zero
 * once. Thereafter each claim decodes only complete, newly appended records.
 * Never open a SessionManager here: it can repair/initialize the live file.
 */
async function savedEntry(value: PiWebSession, input: CompletionInput, claim: { cursor?: DiskCursor }, verifyIdentity = false) {
  if (!verifyIdentity && !presentInMemory(value, input)) return;
  const cursor = claim.cursor ??= await snapshot(value, true);
  if (!cursor) return;
  const file = await open(value.sessionFile, "r");
  try {
    const before = await file.stat();
    if (before.dev !== cursor.dev || before.ino !== cursor.ino || before.size < cursor.offset) uncertain();
    if (!cursor.verified) await verifyHeader(file, before.size, value.sessionId);
    let saved = cursor.saved;
    const { offset, partial, boundary } = await readAppendedRecords(file, cursor, before.size, entries => {
      saved = matchingEntry(entries, input) ?? saved;
    });
    // A replaced path or truncation during the read cannot acknowledge a receipt.
    const after = await stat(value.sessionFile);
    if (after.dev !== cursor.dev || after.ino !== cursor.ino || after.size < offset) uncertain();
    Object.assign(cursor, { offset, partial, boundary, saved, verified: true });
    return saved;
  } finally { await file.close(); }
}
function presentInMemory(value: PiWebSession, input: CompletionInput) {
  return Boolean(matchingEntry(value.sessionManager.getEntries?.() || [], input) || (value.agent.state.messages as ReceiptMessage[]).some(message => message?.role === "custom" && message.details?.deliveryId === input.deliveryId));
}

/** One probe belongs to one core claim. All calls are serialized by the outbox. */
export function piCompletionProbe(value: PiWebSession, input: CompletionInput): CompletionProbe {
  const claim: { cursor?: DiskCursor } = {};
  let auditedRejection = false;
  const fact = (entryId?: string): CompletionFact => entryId
    ? { state: "saved", entryId }
    : { state: "pending", admission: "unknown" };
  async function poll(): Promise<CompletionFact> {
    const saved = await savedEntry(value, input, claim, auditedRejection);
    if (saved) return fact(saved);
    // An audited immediate rejection may settle before the independent run does.
    // Recheck on later polls; idle/history absence alone never authorizes retry.
    if (auditedRejection && !presentInMemory(value, input) && value.isIdle === true) {
      return { state: "pending", admission: "proven-not-admitted" };
    }
    return fact();
  }
  return {
    async initialize(): Promise<CompletionInitialFact> {
      if (!value.sessionFile) throw new CompletionOutboxError("Completion delivery requires a persistent session", 409);
      claim.cursor = await snapshot(value, presentInMemory(value, input));
      const saved = await savedEntry(value, input, claim, true);
      return saved ? { state: "saved", entryId: saved }
        : { state: "pending", submission: presentInMemory(value, input) ? "observed" : "needed" };
    },
    poll,
    async rejected(error): Promise<CompletionFact> {
      if (!(error instanceof CompletionNotAdmittedError)) return fact();
      auditedRejection = true;
      return poll();
    },
  };
}
