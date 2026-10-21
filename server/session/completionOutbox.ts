import { readFile } from "node:fs/promises";
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

/** Read-only receipt: complete records only, decoded by the public SDK. Never
 * open a SessionManager here: opening can repair/initialize the live file.
 * Memory (even with an assistant) is not proof that an SDK write succeeded.
 */
async function savedEntry(value: PiWebSession, input: CompletionInput) {
  let content: string;
  try { content = await readFile(value.sessionFile, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const entries = parseSessionEntries(content.slice(0, content.lastIndexOf("\n") + 1));
  const header = entries[0];
  if (!header || header.type !== "session" || header.id !== value.sessionId) throw new CompletionOutboxError("Cannot verify completion: session identity is uncertain", 503);
  return matchingEntry(entries, input);
}
function presentInMemory(value: PiWebSession, input: CompletionInput) {
  return Boolean(matchingEntry(value.sessionManager.getEntries?.() || [], input) || (value.agent.state.messages as ReceiptMessage[]).some(message => message?.role === "custom" && message.details?.deliveryId === input.deliveryId));
}

type Claim = { fingerprint: string; lookup: Promise<CompletionReceipt> };
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
      await prior.lookup;
      return receipt(await savedEntry(value, input));
    }
    // Register BEFORE any asynchronous disk lookup or SDK invocation.
    const claim: Claim = { fingerprint: payload, lookup: Promise.resolve(receipt()) };
    ownership.set(input.deliveryId, claim);
    claim.lookup = (async () => {
      let saved: string | undefined;
      try { saved = await savedEntry(value, input); }
      catch (error) { ownership.delete(input.deliveryId); throw error; } // No SDK invocation.
      if (saved) return receipt(saved);
      if (!presentInMemory(value, input)) {
        void Promise.resolve().then(() => this.send(value, { ...input.message, details: { ...input.message.details, deliveryId: input.deliveryId } })).catch(async error => {
          try {
            if (error instanceof CompletionDeferredError || (error instanceof CompletionNotAdmittedError && !await savedEntry(value, input) && !presentInMemory(value, input) && value.isIdle === true)) ownership.delete(input.deliveryId);
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
