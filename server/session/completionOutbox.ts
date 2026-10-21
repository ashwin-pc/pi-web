import { open, stat } from "node:fs/promises";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import type { PiWebSession } from "../types.js";

export interface CompletionMessage {
  customType: string;
  content: string;
  display: boolean;
  details?: Record<string, unknown>;
}
export interface CompletionInput { deliveryId: string; message: CompletionMessage }
export interface CompletionReceipt {
  sessionId: string;
  deliveryId: string;
  state: "pending" | "saved";
  entryId?: string;
}

/** Proof that the host refused before invoking SDK code. */
export class CompletionDeferredError extends Error {}
/** Only the audited Pi adapter may classify a rejected immediate SDK call. */
export class CompletionNotAdmittedError extends Error {
  constructor(readonly cause: unknown) { super("Immediate SDK completion send rejected without admission"); }
}
export class CompletionOutboxError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function validateCompletionInput(input: CompletionInput): CompletionInput {
  if (!input || typeof input.deliveryId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(input.deliveryId)) throw new CompletionOutboxError("Invalid deliveryId");
  const message = input.message;
  if (!message || typeof message.customType !== "string" || !/^[A-Za-z0-9._:-]{1,100}$/.test(message.customType) || typeof message.content !== "string" || !message.content || typeof message.display !== "boolean") throw new CompletionOutboxError("Invalid completion message");
  if (message.details !== undefined && (!message.details || typeof message.details !== "object" || Array.isArray(message.details))) throw new CompletionOutboxError("Completion details must be an object");
  if (message.details?.deliveryId !== undefined && message.details.deliveryId !== input.deliveryId) throw new CompletionOutboxError("Completion details.deliveryId conflicts with deliveryId");
  const normalized = JSON.parse(JSON.stringify({ deliveryId: input.deliveryId, message: { customType: message.customType, content: message.content, display: message.display, ...(message.details ? { details: message.details } : {}) } })) as CompletionInput;
  if (Buffer.byteLength(JSON.stringify(normalized)) > 64 * 1024) throw new CompletionOutboxError("Completion payload exceeds 64 KiB", 413);
  return normalized;
}
function fingerprint(input: CompletionInput) {
  return canonical({ ...input.message, details: { ...input.message.details, deliveryId: input.deliveryId } });
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
    if (canonical(payload) !== fingerprint(input)) throw new CompletionOutboxError("deliveryId already belongs to a different payload", 409);
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
/** Memory is only a negative fast path, NEVER persistence proof. A new claim
 * starts at the pre-send EOF; an existing SDK candidate reconciles from zero
 * once. Thereafter each claim decodes only complete, newly appended records.
 * Never open a SessionManager here: it can repair/initialize the live file.
 */
async function savedEntry(value: PiWebSession, input: CompletionInput, claim: Claim, verifyIdentity = false) {
  if (!verifyIdentity && !presentInMemory(value, input)) return;
  const cursor = claim.cursor ??= await snapshot(value, true);
  if (!cursor) return;
  const file = await open(value.sessionFile, "r");
  try {
    const before = await file.stat();
    if (before.dev !== cursor.dev || before.ino !== cursor.ino || before.size < cursor.offset) uncertain();
    if (!cursor.verified) {
      // Read just the header, not the parent transcript. Decode via the public SDK.
      const chunks: Buffer[] = [];
      let position = 0;
      while (position < before.size) {
        const chunk = Buffer.alloc(Math.min(4096, before.size - position));
        const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
        if (!bytesRead) uncertain();
        const end = chunk.subarray(0, bytesRead).indexOf(10);
        chunks.push(chunk.subarray(0, end < 0 ? bytesRead : end + 1));
        position += bytesRead;
        if (end >= 0) break;
      }
      const header = parseSessionEntries(Buffer.concat(chunks).toString("utf8"))[0];
      if (!chunks.length || chunks.at(-1)!.at(-1) !== 10 || header?.type !== "session" || header.id !== value.sessionId) uncertain();
    }
    let offset = cursor.offset;
    let partial = cursor.partial;
    let saved = cursor.saved;
    let boundary = cursor.boundary;
    if (boundary === undefined && offset < before.size) {
      // A failed SDK append may leave EOF inside a JSONL record. Its next
      // append is NOT a standalone record, even if that suffix parses alone.
      const byte = Buffer.alloc(1);
      if ((await file.read(byte, 0, 1, offset - 1)).bytesRead !== 1) uncertain();
      boundary = byte[0] === 10;
    }
    while (offset < before.size) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, before.size - offset));
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
        saved = matchingEntry(parseSessionEntries(complete.toString("utf8")), input) ?? saved;
        partial = end < content.length ? [content.subarray(end)] : [];
      } else partial = [...partial, content];
    }
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

type Claim = { fingerprint: string; lookup: Promise<CompletionReceipt>; cursor?: DiskCursor };
// Runtime ownership survives extension reload, including invisible SDK queues.
// The caller's journal is the sole durable payload/replay owner.
const claims = new WeakMap<PiWebSession, Map<string, Claim>>();
export class CompletionOutbox {
  constructor(private readonly send: (value: PiWebSession, message: CompletionMessage) => Promise<void>, private readonly onError: (value: PiWebSession, error: unknown) => void) {}

  async deliver(value: PiWebSession, raw: CompletionInput): Promise<CompletionReceipt> {
    const input = validateCompletionInput(raw);
    if (!value.sessionFile) throw new CompletionOutboxError("Completion delivery requires a persistent session", 409);
    let ownership = claims.get(value);
    if (!ownership) { ownership = new Map(); claims.set(value, ownership); }
    const prior = ownership.get(input.deliveryId);
    const payload = fingerprint(input);
    if (prior && prior.fingerprint !== payload) throw new CompletionOutboxError("deliveryId already belongs to a different payload", 409);
    const receipt = (id?: string): CompletionReceipt => ({ sessionId: value.sessionId, deliveryId: input.deliveryId, state: id ? "saved" : "pending", ...(id ? { entryId: id } : {}) });
    if (prior) {
      // Serialize cursor updates as well as submission; a failed read may retry.
      prior.lookup = prior.lookup.catch(() => receipt()).then(async () => receipt(await savedEntry(value, input, prior)));
      return prior.lookup;
    }
    // Register BEFORE any asynchronous disk lookup or SDK invocation.
    const claim: Claim = { fingerprint: payload, lookup: Promise.resolve(receipt()) };
    ownership.set(input.deliveryId, claim);
    claim.lookup = (async () => {
      let saved: string | undefined;
      try {
        claim.cursor = await snapshot(value, presentInMemory(value, input));
        saved = await savedEntry(value, input, claim, true);
      }
      catch (error) { ownership.delete(input.deliveryId); throw error; } // No SDK invocation.
      if (saved) return receipt(saved);
      if (!presentInMemory(value, input)) {
        void Promise.resolve().then(() => this.send(value, { ...input.message, details: { ...input.message.details, deliveryId: input.deliveryId } })).catch(async error => {
          try {
            if (error instanceof CompletionDeferredError) ownership.delete(input.deliveryId);
            else if (error instanceof CompletionNotAdmittedError) {
              claim.lookup = claim.lookup.then(async () => {
                const saved = await savedEntry(value, input, claim, true);
                if (!saved && !presentInMemory(value, input) && value.isIdle === true) ownership.delete(input.deliveryId);
                return receipt(saved);
              });
              await claim.lookup;
            }
          } catch (verificationError) { this.onError(value, verificationError); }
          // Unknown rejection may have queued invisibly. User pending count is
          // deliberately irrelevant; never clear queues or release that claim.
          this.onError(value, error);
        });
      }
      return receipt();
    })();
    return claim.lookup;
  }
}
