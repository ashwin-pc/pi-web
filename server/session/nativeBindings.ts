import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { NativeSessionRefDto } from "./dto.js";

export interface NativeBinding {
  id: string;
  nativeSession: NativeSessionRefDto;
  cwd: string;
  name?: string;
  firstMessage?: string;
  created: string;
  modified: string;
  /** Native removal forgets the web binding, not the native transcript. Keep a tombstone. */
  deleted?: boolean;
}

/** Web-owned identity metadata only. Never read a native private store or save a transcript. */
export class NativeBindings {
  private readonly rows = new Map<string, NativeBinding>();
  private tail: Promise<void> = Promise.resolve();
  readonly ready: Promise<void>;
  constructor(private readonly file: string) { this.ready = this.load(); }
  private async load() {
    let text: string;
    try { text = await readFile(this.file, "utf8"); }
    catch (error: any) { if (error?.code === "ENOENT") return; throw error; }
    const data = JSON.parse(text);
    if (data?.version !== 1 || !Array.isArray(data.sessions)) throw new Error("Invalid native session bindings");
    const nativeKeys = new Set<string>();
    for (const row of data.sessions) {
      const ref = row?.nativeSession;
      if (!row || typeof row.id !== "string" || !row.id || typeof row.cwd !== "string" || !row.cwd
        || typeof row.created !== "string" || typeof row.modified !== "string"
        || !ref || !["codex", "claude"].includes(ref.harnessId)
        || !["persistent", "ephemeral"].includes(ref.persistence)
        || !["unmaterialized", "resumable", "live-only", "unavailable"].includes(ref.status)
        || (ref.sessionId !== undefined && (typeof ref.sessionId !== "string" || !ref.sessionId))
        || this.rows.has(row.id)) throw new Error("Invalid or conflicting native session binding");
      const key = ref.sessionId ? `${ref.harnessId}:${ref.sessionId}` : undefined;
      if (key && nativeKeys.has(key)) throw new Error("Conflicting native session identity");
      if (key) nativeKeys.add(key);
      // A new host process has no surviving ephemeral Query/thread handle.
      if (ref.persistence === "ephemeral") ref.status = "unavailable";
      this.rows.set(row.id, row as NativeBinding);
    }
  }
  get(id: string) { return this.rows.get(id); }
  list() { return [...this.rows.values()]; }
  byNative(ref: NativeSessionRefDto) {
    return ref.sessionId ? this.list().find((row) => row.nativeSession.harnessId === ref.harnessId && row.nativeSession.sessionId === ref.sessionId) : undefined;
  }
  async put(row: NativeBinding) {
    await this.ready;
    const existing = this.rows.get(row.id);
    if (existing && existing.nativeSession.harnessId !== row.nativeSession.harnessId) throw new Error("Cannot change a session's harness");
    const other = this.byNative(row.nativeSession);
    if (other && other.id !== row.id) throw new Error("Native session already has a web identity");
    this.rows.set(row.id, JSON.parse(JSON.stringify(row)) as NativeBinding);
    const write = async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ version: 1, sessions: this.list() }, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.file);
    };
    const pending = this.tail.then(write, write);
    this.tail = pending;
    await pending;
  }
  async flush() { await this.ready; await this.tail; }
}
