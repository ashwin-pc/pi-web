import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, getAgentDir, SessionManager, type ModelRuntime, type SessionStartEvent } from "@earendil-works/pi-coding-agent";
import type { PiWebSession, PiWebSessionInfo } from "../types.js";
import { ResilientResourceLoader } from "../extensions/resilientLoader.js";
import { createShallowLister, shallowSessionCwd } from "./shallowList.js";
import { createSessionsReadTools } from "./referenceTools.js";

export interface LocalSessionFactoryInput {
  path?: string;
  cwd: string;
  sessionStartEvent?: SessionStartEvent;
}

/** Saved metadata; production discovery deliberately does not read full transcripts. */
export type LocalSessionInfo = Omit<PiWebSessionInfo, "name" | "firstMessage" | "messageCount" | "allMessagesText"> &
  Partial<Pick<PiWebSessionInfo, "name" | "firstMessage" | "messageCount" | "allMessagesText">>;

export interface LocalSessionFactory<Info extends LocalSessionInfo = PiWebSessionInfo> {
  create(input: LocalSessionFactoryInput): Promise<{ session: PiWebSession; modelFallbackMessage?: string }>;
  list?(cwd: string): Promise<Info[]>;
  remove?(id: string, path: string): Promise<"trashed" | "deleted">;
  readonly isMock?: boolean;
}

export function piSessionDirectory(cwd: string) {
  const safePath = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(getAgentDir(), "sessions", safePath);
}

function isMissingPath(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function envMs(name: string, fallback: number) {
  const raw = Number(process.env[name] || fallback);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}
const execFileAsync = promisify(execFile);

type ProductionFactoryOptions = {
  noSession: boolean;
  modelRuntime: ModelRuntime;
  additionalExtensionPaths(cwd: string): string[];
  sessionCwd(manager: SessionManager): string;
  rememberCwd(cwd: string): void;
  readSession: Parameters<typeof createSessionsReadTools>[0];
};

/** Pi resources and disk lifecycle only; the service owns binding and live sessions. */
export class PiSessionFactory implements LocalSessionFactory<LocalSessionInfo> {
  // Instance-owned cache: independent services never share or evict discovery state.
  private readonly shallowLister = createShallowLister();
  private readonly loaders = new WeakMap<object, ResilientResourceLoader>();
  constructor(private readonly options: ProductionFactoryOptions) {}

  loaderFor(session: PiWebSession) { return this.loaders.get(session); }

  async ensureStorage(cwd: string) {
    const webDir = join(cwd, ".pi", "web");
    await mkdir(webDir, { recursive: true });
    const ignoreFile = join(webDir, ".gitignore");
    if (!existsSync(ignoreFile)) await writeFile(ignoreFile, "*\n");
  }

  async create({ path, cwd: targetCwd, sessionStartEvent }: LocalSessionFactoryInput) {
    const manager = this.options.noSession
      ? SessionManager.inMemory(targetCwd)
      : path ? SessionManager.open(path) : SessionManager.create(targetCwd);
    if (!path && !this.options.noSession && sessionStartEvent?.reason === "new") manager.newSession();
    const resolvedCwd = this.options.sessionCwd(manager);
    this.options.rememberCwd(resolvedCwd);
    await this.ensureStorage(resolvedCwd);
    const contextPath = fileURLToPath(new URL("../../contexts/web-ui.md", import.meta.url));
    const appDir = dirname(dirname(contextPath));
    const extensionAuthoringContext = [
      "pi-web extension documentation (read when asked to build pi-web extensions or browser UI):",
      `- API + slots: ${join(appDir, "docs/pi-web-extensions.md")}`,
      `- Examples: ${join(appDir, "examples/pi-web-extensions")} (notepad.ts shows the current contribute() API)`,
    ].join("\n");
    const webUiContext = [
      existsSync(contextPath) ? readFileSync(contextPath, "utf8") : "",
      extensionAuthoringContext,
    ].filter(Boolean).join("\n\n");
    const loader = new ResilientResourceLoader({
      loadTimeoutMs: envMs("PI_WEB_EXTENSION_LOAD_TIMEOUT_MS", 8_000),
      fetchTimeoutMs: envMs("PI_WEB_EXTENSION_FETCH_TIMEOUT_MS", 3_000),
      loaderOptions: {
        cwd: resolvedCwd,
        agentDir: getAgentDir(),
        additionalExtensionPaths: this.options.additionalExtensionPaths(resolvedCwd),
        appendSystemPromptOverride: (base) => [...base, webUiContext].filter(Boolean),
      },
    });
    await loader.reload();
    const result = await createAgentSession({
      cwd: resolvedCwd,
      sessionManager: manager,
      modelRuntime: this.options.modelRuntime,
      resourceLoader: loader,
      customTools: createSessionsReadTools(this.options.readSession),
      sessionStartEvent,
    });
    this.loaders.set(result.session, loader);
    return { session: result.session as unknown as PiWebSession, modelFallbackMessage: result.modelFallbackMessage };
  }

  async list(cwd: string): Promise<LocalSessionInfo[]> {
    return (await this.shallowLister.list(cwd, piSessionDirectory(cwd))).map((info) => ({
      ...info, cwd: info.cwd || cwd, created: new Date(info.created), modified: new Date(info.modified),
    }));
  }

  async locate(id: string, cwd: string, knownCwds: Iterable<string>) {
    const suffix = `_${id}.jsonl`;
    const checkedDirectories = new Set<string>();
    for (const resolvedCwd of new Set([resolve(cwd), ...knownCwds])) {
      const directory = piSessionDirectory(resolvedCwd);
      checkedDirectories.add(directory);
      let names: string[];
      try { names = await readdir(directory); }
      catch (error) {
        if (isMissingPath(error)) continue;
        throw error;
      }
      const name = names.find((entry) => entry.endsWith(suffix));
      if (!name) continue;
      const location = { path: join(directory, name), cwd: resolvedCwd };
      return location;
    }

    // Bookmarked IDs may be opened before their cwd has been visited in this process.
    // Scan directory names and filenames only, then read the one matching header.
    const sessionsRoot = join(getAgentDir(), "sessions");
    let directories: string[];
    try { directories = await readdir(sessionsRoot); }
    catch (error) {
      if (isMissingPath(error)) return undefined;
      throw error;
    }
    for (const directoryName of directories) {
      const directory = join(sessionsRoot, directoryName);
      if (checkedDirectories.has(directory)) continue;
      let names: string[];
      try { names = await readdir(directory); }
      catch (error) {
        if (isMissingPath(error)) continue;
        throw error;
      }
      const name = names.find((entry) => entry.endsWith(suffix));
      if (!name) continue;
      const path = join(directory, name);
      const sessionCwd = await shallowSessionCwd(path, { strict: true });
      if (!sessionCwd) continue; // The matching file disappeared during lookup.
      if (piSessionDirectory(sessionCwd) !== directory) throw new Error("Session working directory does not match its location");
      const location = { path, cwd: resolve(sessionCwd) };
      return location;
    }
    return undefined;
  }

  async remove(_id: string, path: string) {
    try { await execFileAsync("trash", [path], { timeout: 15_000 }); return "trashed" as const; }
    catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      await rm(path, { force: true });
      return "deleted" as const;
    }
  }
}
