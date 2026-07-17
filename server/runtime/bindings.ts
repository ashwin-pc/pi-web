import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RuntimeCapabilities } from "./protocol.js";

export type RuntimeKind = "local" | "container" | "ssh";

export type RuntimeRef = {
  id: string;
  kind: RuntimeKind;
  label: string;
  capabilities?: RuntimeCapabilities;
};

export type SessionRuntimeBinding = {
  sessionId: string;
  runtimeId: string;
  cwd: string;
  sessionFile?: string;
  name?: string;
  firstMessage?: string;
  createdAt?: string;
  runtimeModifiedAt?: string;
  messageCount?: number;
  updatedAt: string;
};

type BindingFile = {
  version: 1;
  bindings: SessionRuntimeBinding[];
};

export class RuntimeBindingStore {
  private writeQueue = Promise.resolve();
  private cache?: BindingFile;

  constructor(private readonly file: string) {}

  async read(): Promise<BindingFile> {
    if (this.cache) return { version: 1, bindings: [...this.cache.bindings] };
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf-8")) as Partial<BindingFile>;
      this.cache = { version: 1, bindings: Array.isArray(parsed.bindings) ? parsed.bindings.filter(isBinding) : [] };
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      this.cache = { version: 1, bindings: [] };
    }
    return { version: 1, bindings: [...this.cache.bindings] };
  }

  async get(sessionId: string): Promise<SessionRuntimeBinding | undefined> {
    const data = await this.read();
    return data.bindings.find((binding) => binding.sessionId === sessionId);
  }

  async set(binding: Omit<SessionRuntimeBinding, "updatedAt"> & { updatedAt?: string }): Promise<SessionRuntimeBinding> {
    const run = async () => {
      const data = await this.read();
      const existing = data.bindings.find((item) => item.sessionId === binding.sessionId);
      if (existing && existing.runtimeId !== binding.runtimeId) {
        throw new Error(`Session ${binding.sessionId} is already bound to runtime ${existing.runtimeId}; refusing to rebind it to ${binding.runtimeId}`);
      }
      const next: SessionRuntimeBinding = { ...existing, ...binding, updatedAt: binding.updatedAt || new Date().toISOString() };
      if (existing) {
        const keys = new Set([...Object.keys(existing), ...Object.keys(next)] as Array<keyof SessionRuntimeBinding>);
        if (Array.from(keys).every((key) => existing[key] === next[key])) return existing;
      }
      const bindings = data.bindings.filter((item) => item.sessionId !== next.sessionId);
      bindings.unshift(next);
      const nextData: BindingFile = { version: 1, bindings };
      await writeJsonAtomic(this.file, nextData);
      this.cache = nextData;
      return next;
    };
    const result = this.writeQueue.then(run, run);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async remove(sessionId: string): Promise<void> {
    const run = async () => {
      const data = await this.read();
      const bindings = data.bindings.filter((item) => item.sessionId !== sessionId);
      if (bindings.length === data.bindings.length) return;
      const nextData: BindingFile = { version: 1, bindings };
      await writeJsonAtomic(this.file, nextData);
      this.cache = nextData;
    };
    const result = this.writeQueue.then(run, run);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async removeMissingForRuntime(runtimeId: string, authoritativeSessionIds: ReadonlySet<string>): Promise<SessionRuntimeBinding[]> {
    let removed: SessionRuntimeBinding[] = [];
    const run = async () => {
      const data = await this.read();
      removed = data.bindings.filter((item) => item.runtimeId === runtimeId && !authoritativeSessionIds.has(item.sessionId));
      if (removed.length === 0) return;
      const removedIds = new Set(removed.map((item) => item.sessionId));
      const nextData: BindingFile = { version: 1, bindings: data.bindings.filter((item) => !removedIds.has(item.sessionId)) };
      await writeJsonAtomic(this.file, nextData);
      this.cache = nextData;
    };
    const result = this.writeQueue.then(run, run);
    this.writeQueue = result.then(() => undefined, () => undefined);
    await result;
    return removed;
  }

  async removeRuntime(runtimeId: string): Promise<number> {
    let removed = 0;
    const run = async () => {
      const data = await this.read();
      const bindings = data.bindings.filter((item) => item.runtimeId !== runtimeId);
      removed = data.bindings.length - bindings.length;
      if (removed === 0) return;
      const nextData: BindingFile = { version: 1, bindings };
      await writeJsonAtomic(this.file, nextData);
      this.cache = nextData;
    };
    const result = this.writeQueue.then(run, run);
    this.writeQueue = result.then(() => undefined, () => undefined);
    await result;
    return removed;
  }

  async ensureLocal(sessionId: string, cwd: string): Promise<SessionRuntimeBinding> {
    return { sessionId, runtimeId: "local", cwd, updatedAt: new Date().toISOString() };
  }
}

async function writeJsonAtomic(file: string, value: unknown) {
  await mkdir(dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tempFile, JSON.stringify(value, null, 2), "utf-8");
  await rename(tempFile, file);
}

function isBinding(value: unknown): value is SessionRuntimeBinding {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.sessionId === "string" && typeof item.runtimeId === "string" && typeof item.cwd === "string" && typeof item.updatedAt === "string"
    && (item.sessionFile === undefined || typeof item.sessionFile === "string")
    && (item.name === undefined || typeof item.name === "string")
    && (item.firstMessage === undefined || typeof item.firstMessage === "string")
    && (item.createdAt === undefined || typeof item.createdAt === "string")
    && (item.runtimeModifiedAt === undefined || typeof item.runtimeModifiedAt === "string")
    && (item.messageCount === undefined || typeof item.messageCount === "number");
}
