import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { PiWebSession } from "../types.js";

export interface CompletionMessage {
  customType: string;
  content: string;
  display: boolean;
  details?: Record<string, unknown>;
}
export interface CompletionInput { deliveryId: string; message: CompletionMessage; branchAnchorEntryId?: string }
export interface CompletionReceipt {
  sessionId: string;
  deliveryId: string;
  state: "pending" | "saved";
  entryId?: string;
}

/** Explicit proof that the host did not invoke the SDK (e.g. navigation owns it). */
export class CompletionDeferredError extends Error {}

export class CompletionOutboxError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

// These belong to the host/raw runtime, not an extension instance. In particular,
// reloading extensions must not inject a second copy of a still-queued message.
const submitted = new WeakMap<PiWebSession, Set<string>>();
const mutations = new Map<string, Promise<unknown>>();

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function validateCompletionInput(input: CompletionInput): CompletionInput {
  if (!input || !/^[A-Za-z0-9._:-]{1,160}$/.test(input.deliveryId || "")) throw new CompletionOutboxError("Invalid deliveryId");
  if (input.branchAnchorEntryId !== undefined && (typeof input.branchAnchorEntryId !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(input.branchAnchorEntryId))) throw new CompletionOutboxError("Invalid branchAnchorEntryId");
  const message = input.message;
  if (!message || typeof message.customType !== "string" || !/^[A-Za-z0-9._:-]{1,100}$/.test(message.customType) || typeof message.content !== "string" || !message.content || typeof message.display !== "boolean") throw new CompletionOutboxError("Invalid completion message");
  if (message.details !== undefined && (!message.details || typeof message.details !== "object" || Array.isArray(message.details))) throw new CompletionOutboxError("Completion details must be an object");
  if (message.details?.deliveryId !== undefined && message.details.deliveryId !== input.deliveryId) throw new CompletionOutboxError("Completion details.deliveryId conflicts with deliveryId");
  const normalized = JSON.parse(JSON.stringify({ deliveryId: input.deliveryId, message: { customType: message.customType, content: message.content, display: message.display, ...(message.details ? { details: message.details } : {}) }, ...(input.branchAnchorEntryId !== undefined ? { branchAnchorEntryId: input.branchAnchorEntryId } : {}) })) as CompletionInput;
  if (Buffer.byteLength(JSON.stringify(normalized)) > 64 * 1024) throw new CompletionOutboxError("Completion payload exceeds 64 KiB", 413);
  return normalized;
}

function directory(value: PiWebSession) {
  if (!value.sessionFile) throw new CompletionOutboxError("Completion delivery requires a persistent session", 409);
  return `${value.sessionFile}.completions`;
}
function filename(value: PiWebSession, id: string) {
  return join(directory(value), `${createHash("sha256").update(id).digest("hex")}.json`);
}
async function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutations.get(key) || Promise.resolve();
  const pending = previous.catch(() => {}).then(operation);
  mutations.set(key, pending);
  try { return await pending; }
  finally { if (mutations.get(key) === pending) mutations.delete(key); }
}

/** Windows does not consistently support opening/fsyncing directory handles.
 * File write/fsync/rename failures are never covered by this compatibility case.
 */
export async function syncCompletionDirectory(path: string, platform = process.platform, openDirectory: (path: string) => Promise<{ sync(): Promise<void>; close(): Promise<void> }> = path => open(path, "r")): Promise<void> {
  try {
    const handle = await openDirectory(path);
    try { await handle.sync(); }
    finally { await handle.close(); }
  } catch (error) {
    if (platform === "win32" && ["EPERM", "EISDIR", "EINVAL", "ENOTSUP", "EBADF"].includes((error as NodeJS.ErrnoException).code || "")) return;
    throw error;
  }
}

function messageId(message: unknown): string | undefined {
  const value = message as { role?: string; details?: { deliveryId?: unknown } } | undefined;
  return value?.role === "custom" && typeof value.details?.deliveryId === "string" ? value.details.deliveryId : undefined;
}
function entryId(entry: unknown, deliveryId: string): string | undefined {
  const value = entry as { id?: string; type?: string; details?: { deliveryId?: string }; message?: unknown };
  return typeof value?.id === "string" && ((value.type === "custom_message" && value.details?.deliveryId === deliveryId) || (value.type === "message" && messageId(value.message) === deliveryId)) ? value.id : undefined;
}

/** Disk, not getBranch/getEntries, is the delivery acknowledgement. Entries before
 * the first assistant may exist only in the SDK's memory, including appendEntry.
 */
async function savedEntry(value: PiWebSession, deliveryId: string): Promise<string | undefined> {
  let text: string;
  try { text = await readFile(value.sessionFile, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); }
    catch { throw new CompletionOutboxError("Cannot verify completion: malformed session JSONL", 503); }
    const id = entryId(entry, deliveryId);
    if (id) return id;
  }
}
function presentInMemory(value: PiWebSession, id: string) {
  // All entries, not just the active branch: a partially saved or branched-away
  // message must not be blindly injected again after an asynchronous failure.
  return value.sessionManager.getEntries?.().some(entry => entryId(entry, id)) || value.agent.state.messages.some(message => messageId(message) === id);
}

/** Durable payload + runtime-scoped ownership. Repeating deliver is also a receipt
 * lookup. Restart/replacement gets a new raw runtime, so disk is reconciled before
 * replay; extension reload retains ownership of any surviving SDK memory queue.
 */
export class CompletionOutbox {
  constructor(private readonly send: (value: PiWebSession, message: CompletionMessage) => Promise<void>, private readonly onError: (value: PiWebSession, error: unknown) => void) {}

  async deliver(value: PiWebSession, raw: CompletionInput): Promise<CompletionReceipt> {
    const input = validateCompletionInput(raw);
    const path = filename(value, input.deliveryId);
    return serialized(path, async () => {
      await mkdir(directory(value), { recursive: true, mode: 0o700 });
      let existing: CompletionInput | undefined;
      try { existing = JSON.parse(await readFile(path, "utf8")) as CompletionInput; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (existing && canonical(existing) !== canonical(input)) throw new CompletionOutboxError("deliveryId already belongs to a different payload", 409);
      if (!existing) await this.persist(path, input, directory(value));
      const saved = await savedEntry(value, input.deliveryId);
      if (saved) {
        submitted.get(value)?.delete(input.deliveryId);
        return { sessionId: value.sessionId, deliveryId: input.deliveryId, state: "saved", entryId: saved };
      }
      let ownership = submitted.get(value);
      if (!ownership) { ownership = new Set(); submitted.set(value, ownership); }
      if (!ownership.has(input.deliveryId)) {
        // Mark before invoking SDK code, which may synchronously emit events.
        ownership.add(input.deliveryId);
        const message = { ...input.message, details: { ...input.message.details, deliveryId: input.deliveryId } };
        void Promise.resolve().then(() => {
          // No await between this branch check and invoking the SDK. A pending
          // batch from a different branch must never steer this conversation.
          if (input.branchAnchorEntryId && !value.sessionManager.getBranch?.().some(entry => (entry as { id?: string }).id === input.branchAnchorEntryId)) {
            ownership!.delete(input.deliveryId); // No submission took place.
            return;
          }
          return this.send(value, message);
        }).catch(async error => {
          if (error instanceof CompletionDeferredError) { ownership!.delete(input.deliveryId); return; }
          // A rejection can follow enqueue, append, or an on-disk write. Absence
          // from history/state cannot prove absence from the SDK's custom queue.
          // Keep ownership even on failure; a replacement runtime can replay after
          // disk reconciliation. Never clear queues containing human steering.
          try { await savedEntry(value, input.deliveryId); presentInMemory(value, input.deliveryId); }
          catch (verificationError) { this.onError(value, verificationError); }
          this.onError(value, error);
        });
      }
      return { sessionId: value.sessionId, deliveryId: input.deliveryId, state: "pending" };
    });
  }

  /** Called with the host navigation lease already held, preventing a new
   * submission during this asynchronous disk check. SDK queue acceptance can
   * release its work lease before the queued custom message is actually saved.
   */
  async assertNavigationSafe(value: PiWebSession): Promise<void> {
    const ownership = submitted.get(value);
    for (const id of ownership || []) {
      if (!await savedEntry(value, id)) throw new CompletionOutboxError("Wait for pending completion delivery before navigating the tree", 409);
      ownership!.delete(id);
    }
  }

  async resume(value: PiWebSession): Promise<void> {
    let names: string[];
    try { names = await readdir(directory(value)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const input = JSON.parse(await readFile(join(directory(value), name), "utf8")) as CompletionInput;
      await this.deliver(value, input);
    }
  }

  private async persist(path: string, input: CompletionInput, parent: string) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(input)); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, path);
      // Make the rename durable too, before acknowledging the payload.
      await syncCompletionDirectory(parent);
    } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
  }
}
