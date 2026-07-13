import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CommandRunnerConfig } from "./commandProvider.js";

export type RuntimeStoreFile = { version: 1; commandRuntimes: CommandRunnerConfig[] };

export class RuntimeStore {
  private writeQueue = Promise.resolve();

  constructor(private readonly file: string) {}

  async read(): Promise<RuntimeStoreFile> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf-8")) as Partial<RuntimeStoreFile>;
      return { version: 1, commandRuntimes: Array.isArray(parsed.commandRuntimes) ? parsed.commandRuntimes.filter(isCommandRuntimeConfig) : [] };
    } catch (error: any) {
      if (error?.code === "ENOENT") return { version: 1, commandRuntimes: [] };
      throw error;
    }
  }

  async upsert(config: CommandRunnerConfig): Promise<RuntimeStoreFile> {
    return this.enqueueWrite(async () => {
      const current = await this.read();
      const commandRuntimes = current.commandRuntimes.filter((item) => item.id !== config.id);
      commandRuntimes.push(config);
      const next = { version: 1 as const, commandRuntimes };
      await writeJsonAtomic(this.file, next);
      return next;
    });
  }

  async remove(id: string): Promise<RuntimeStoreFile> {
    return this.enqueueWrite(async () => {
      const current = await this.read();
      const next = { version: 1 as const, commandRuntimes: current.commandRuntimes.filter((item) => item.id !== id) };
      await writeJsonAtomic(this.file, next);
      return next;
    });
  }

  private enqueueWrite<T>(run: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(run, run);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

async function writeJsonAtomic(file: string, value: unknown) {
  await mkdir(dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tempFile, JSON.stringify(value, null, 2), "utf-8");
  await rename(tempFile, file);
}

function isCommandRuntimeConfig(value: unknown): value is CommandRunnerConfig {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string" && item.id.trim().length > 0
    && typeof item.label === "string" && item.label.trim().length > 0
    && typeof item.command === "string" && item.command.trim().length > 0
    && Array.isArray(item.args) && item.args.every((arg) => typeof arg === "string")
    && typeof item.cwd === "string" && item.cwd.trim().length > 0
    && (item.processCwd === undefined || typeof item.processCwd === "string")
    && (item.agentDir === undefined || typeof item.agentDir === "string")
    && (item.modelBroker === undefined || typeof item.modelBroker === "boolean")
    && (item.network === undefined || typeof item.network === "string")
    && (item.networkPolicy === undefined || item.networkPolicy === "none" || item.networkPolicy === "provider-only" || item.networkPolicy === "unrestricted" || item.networkPolicy === "unverified")
    && (item.kind === undefined || item.kind === "local" || item.kind === "container" || item.kind === "ssh");
}
