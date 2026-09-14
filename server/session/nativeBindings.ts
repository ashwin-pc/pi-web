import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function validate(row: NativeBinding, rows: ReadonlyMap<string, NativeBinding>) {
  const ref = row?.nativeSession;
  if (!row || typeof row.id !== "string" || !row.id || typeof row.cwd !== "string" || !row.cwd
    || typeof row.created !== "string" || typeof row.modified !== "string"
    || !ref || !["codex", "claude"].includes(ref.harnessId)
    || !["persistent", "ephemeral"].includes(ref.persistence)
    || !["unmaterialized", "resumable", "live-only", "unavailable"].includes(ref.status)
    || (ref.sessionId !== undefined && (typeof ref.sessionId !== "string" || !ref.sessionId))) {
    throw new Error("Invalid native session binding");
  }
  const existing = rows.get(row.id);
  if (existing && existing.nativeSession.harnessId !== ref.harnessId) throw new Error("Cannot change a session's harness");
  if (ref.sessionId && [...rows.values()].some((other) => other.id !== row.id
    && other.nativeSession.harnessId === ref.harnessId && other.nativeSession.sessionId === ref.sessionId)) {
    throw new Error("Conflicting native session identity");
  }
}

/** Web-owned identity metadata only. Never read a native private store or save a transcript. */
export class NativeBindings {
  private rows = new Map<string, NativeBinding>();
  private tail: Promise<void> = Promise.resolve();
  readonly ready: Promise<void>;
  constructor(private readonly file: string) { this.ready = this.load(); }
  private async load() {
    let text: string;
    try { text = await readFile(this.file, "utf8"); }
    catch (error: any) { if (error?.code === "ENOENT") return; throw error; }
    const data = JSON.parse(text);
    if (data?.version !== 1 || !Array.isArray(data.sessions)) throw new Error("Invalid native session bindings");
    const candidate = new Map<string, NativeBinding>();
    for (const row of data.sessions as NativeBinding[]) {
      validate(row, candidate);
      if (candidate.has(row.id)) throw new Error("Conflicting native web identity");
      // A new host process has no surviving ephemeral Query/thread handle.
      if (row.nativeSession.persistence === "ephemeral") row.nativeSession.status = "unavailable";
      candidate.set(row.id, row);
    }
    this.rows = candidate;
  }
  get(id: string) { const row = this.rows.get(id); return row ? copy(row) : undefined; }
  list() { return copy([...this.rows.values()]); }
  byNative(ref: NativeSessionRefDto) {
    return ref.sessionId ? this.list().find((row) => row.nativeSession.harnessId === ref.harnessId && row.nativeSession.sessionId === ref.sessionId) : undefined;
  }
  put(row: NativeBinding): Promise<void> {
    // Capture caller input now, but validate against committed rows only when this
    // job reaches the head of the queue. Pending candidates never become visible.
    const input = copy(row);
    const commit = async () => {
      await this.ready;
      validate(input, this.rows);
      const candidate = new Map(this.rows);
      candidate.set(input.id, input);
      const snapshot = `${JSON.stringify({ version: 1, sessions: [...candidate.values()] }, null, 2)}\n`;
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, snapshot, { mode: 0o600, flag: "wx" });
        await rename(temporary, this.file);
      } catch (error) {
        // EEXIST means the exclusive create never owned this pathname.
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
      this.rows = candidate;
    };
    const pending = this.tail.then(commit, commit);
    this.tail = pending;
    return pending;
  }
  async flush() { await this.ready; await this.tail; }
}
