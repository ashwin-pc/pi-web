import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { NativeSessionRefDto } from "./dto.js";

export interface NativeBinding {
  id: string;
  nativeSession: NativeSessionRefDto;
  cwd: string;
  name?: string;
  firstMessage?: string;
  created?: string;
  modified: string;
  /** Native removal forgets the web binding, not the native transcript. Keep a tombstone. */
  deleted?: boolean;
}
export interface NativeBindingDiscovery {
  ref: NativeSessionRefDto;
  preferredId?: string;
  change(id: string, current: NativeBinding | undefined): NativeBinding;
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const nativeKey = (ref: NativeSessionRefDto) => ref.sessionId ? JSON.stringify([ref.harnessId, ref.sessionId]) : undefined;
function validate(row: NativeBinding, rows: ReadonlyMap<string, NativeBinding>, identities: ReadonlyMap<string, string>) {
  const ref = row?.nativeSession;
  if (!row || typeof row.id !== "string" || !row.id || typeof row.cwd !== "string" || !row.cwd
    || (row.created !== undefined && typeof row.created !== "string") || typeof row.modified !== "string"
    || !ref || typeof ref.harnessId !== "string" || !ref.harnessId || ref.harnessId.length > 128
    || !["persistent", "ephemeral"].includes(ref.persistence)
    || !["unmaterialized", "resumable", "live-only", "unavailable"].includes(ref.status)
    || (ref.sessionId !== undefined && (typeof ref.sessionId !== "string" || !ref.sessionId))) throw new Error("Invalid native session binding");
  const existing = rows.get(row.id);
  if (existing && existing.nativeSession.harnessId !== ref.harnessId) throw new Error("Cannot change a session's harness");
  const key = nativeKey(ref);
  if (key && identities.has(key) && identities.get(key) !== row.id) throw new Error("Conflicting native session identity");
}
function install(row: NativeBinding, rows: Map<string, NativeBinding>, identities: Map<string, string>) {
  const previous = rows.get(row.id);
  const oldKey = previous && nativeKey(previous.nativeSession);
  if (oldKey) identities.delete(oldKey);
  rows.set(row.id, row);
  const key = nativeKey(row.nativeSession);
  if (key) identities.set(key, row.id);
}

/** Web-owned identity metadata only. Never read a native private store or save a transcript. */
export class NativeBindings {
  private rows = new Map<string, NativeBinding>();
  private identities = new Map<string, string>();
  private tail: Promise<unknown> = Promise.resolve();
  readonly ready: Promise<void>;
  constructor(private readonly file: string) { this.ready = this.load(); }
  private async load() {
    let text: string;
    try { text = await readFile(this.file, "utf8"); }
    catch (error: any) { if (error?.code === "ENOENT") return; throw error; }
    const data = JSON.parse(text);
    if (data?.version !== 1 || !Array.isArray(data.sessions)) throw new Error("Invalid native session bindings");
    const candidate = new Map<string, NativeBinding>(), identities = new Map<string, string>();
    for (const row of data.sessions as NativeBinding[]) {
      validate(row, candidate, identities);
      if (candidate.has(row.id)) throw new Error("Conflicting native web identity");
      if (row.nativeSession.persistence === "ephemeral") row.nativeSession.status = "unavailable";
      install(row, candidate, identities);
    }
    this.rows = candidate; this.identities = identities;
  }
  get(id: string) { const row = this.rows.get(id); return row ? copy(row) : undefined; }
  list() { return copy([...this.rows.values()]); }
  byNative(ref: NativeSessionRefDto) {
    const key = nativeKey(ref), id = key && this.identities.get(key);
    return id ? this.get(id) : undefined;
  }
  put(row: NativeBinding): Promise<void> {
    const input = copy(row);
    return this.update(input.id, () => input).then(() => undefined);
  }
  getOrCreateNative(ref: NativeSessionRefDto, change: NativeBindingDiscovery["change"], preferredId?: string): Promise<NativeBinding | undefined> {
    return this.getOrCreateMany([{ ref, change, preferredId }]).then((rows) => rows[0]);
  }
  /** Lookup/allocation/merge share one queued draft and at most one atomic write. */
  getOrCreateMany(entries: NativeBindingDiscovery[]): Promise<Array<NativeBinding | undefined>> {
    const inputs = entries.map((entry) => ({ ...entry, ref: copy(entry.ref) }));
    return this.enqueue(async () => {
      const rows = new Map(this.rows), identities = new Map(this.identities);
      const result = inputs.map(({ ref, change, preferredId }) => {
        const key = nativeKey(ref), existingId = key && identities.get(key);
        const existing = existingId ? rows.get(existingId) : undefined;
        if (existing?.deleted) return undefined;
        const id = existing?.id || preferredId || randomUUID();
        const changed = copy(change(id, existing ? copy(existing) : undefined));
        if (changed.id !== id) throw new Error("Cannot change a native binding's web identity");
        validate(changed, rows, identities);
        install(changed, rows, identities);
        return copy(changed);
      });
      await this.commit(rows, identities);
      return result;
    });
  }
  /** Read, merge and commit in the same queue; callers never merge a stale get(). */
  update(id: string, change: (current: NativeBinding | undefined) => NativeBinding | undefined): Promise<NativeBinding | undefined> {
    return this.enqueue(async () => {
      const changed = change(this.get(id));
      if (!changed) return;
      if (changed.id !== id) throw new Error("Cannot change a native binding's web identity");
      const input = copy(changed), rows = new Map(this.rows), identities = new Map(this.identities);
      validate(input, rows, identities); install(input, rows, identities);
      await this.commit(rows, identities);
      return copy(input);
    });
  }
  private async commit(candidate: Map<string, NativeBinding>, identities: Map<string, string>): Promise<void> {
    if (isDeepStrictEqual(candidate, this.rows)) return;
    const snapshot = `${JSON.stringify({ version: 1, sessions: [...candidate.values()] }, null, 2)}\n`;
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, snapshot, { mode: 0o600, flag: "wx" }); await rename(temporary, this.file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    this.rows = candidate; this.identities = identities;
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const commit = async () => { await this.ready; return operation(); };
    const pending = this.tail.then(commit, commit); this.tail = pending; return pending;
  }
  async flush() { await this.ready; await this.tail; }
}
