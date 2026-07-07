import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type RuntimeKind = "local" | "container" | "ssh";

export type RuntimeRef = {
  id: string;
  kind: RuntimeKind;
  label: string;
};

export type SessionRuntimeBinding = {
  sessionId: string;
  runtimeId: string;
  cwd: string;
  sessionFile?: string;
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
      const next: SessionRuntimeBinding = { ...binding, updatedAt: binding.updatedAt || new Date().toISOString() };
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

  async ensureLocal(sessionId: string, cwd: string): Promise<SessionRuntimeBinding> {
    const existing = await this.get(sessionId);
    if (existing) return existing;
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
  return typeof item.sessionId === "string" && typeof item.runtimeId === "string" && typeof item.cwd === "string" && typeof item.updatedAt === "string";
}
