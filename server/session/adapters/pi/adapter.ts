import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, getAgentDir, SessionManager, type SessionStartEvent } from "@earendil-works/pi-coding-agent";
import type { PiWebSession } from "../../../types.js";
import { createWebUiBridge } from "../../../extensions/webUi.js";
import { ResilientResourceLoader } from "../../../extensions/resilientLoader.js";
import { createSettingsStore } from "../../../settings.js";
import { assertDirectory } from "../../../shared/fsList.js";
import { createShallowLister, shallowSessionCwd } from "../../shallowList.js";
import { SessionServiceError } from "../../errors.js";
import { createSessionsReadTools } from "../../referenceTools.js";
import { simplifyMessage } from "../../projection.js";
import type { SessionAdapter, AdapterCreateInput, AdapterOpenInput, AdapterSessionInfo } from "../../adapter.js";
import type { HarnessDescriptorDto, SessionInfoDto } from "../../dto.js";
import { PiSessionHandle, type PiAdapterDependencies, type PiAdapterHost } from "./index.js";

const execFileAsync = promisify(execFile);
const envMs = (key: string, fallback: number) => {
  const value = Number(process.env[key] || fallback);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

/** Pi resource creation and extension binding, with no parallel live-session manager. */
export class PiAdapter implements SessionAdapter {
  readonly harness: HarnessDescriptorDto = {
    id: "pi", name: "Pi", enabled: true, available: true,
    capabilities: { harness: "pi", queue: true, steering: true, followUp: true, thinkingLevel: true,
      tree: true, compaction: true, retry: true, bash: true, extensions: true, interactions: true,
      models: true, context: true, attachments: true, historyFork: false },
  };
  readonly settingsStore = createSettingsStore(process.env.PI_WEB_SETTINGS_FILE || join(getAgentDir(), "pi-web-settings.json"));
  readonly blockedModelIds = new Set<string>();
  readonly webUiBridge;
  private readonly handles = new WeakMap<object, PiSessionHandle>();
  private readonly shallowLister = createShallowLister();
  host!: PiAdapterHost;
  constructor(readonly deps: PiAdapterDependencies) {
    const handleFor = (raw: object) => {
      const handle = this.handles.get(raw);
      if (!handle) throw new Error("Pi session has not been bound");
      return handle;
    };
    this.webUiBridge = createWebUiBridge({
      extensionHttp: deps.extensionHttp,
      captureStore: {
        consume: (...args) => this.host.captureStore.consume(...args),
        releasePath: (path) => this.host.captureStore.releasePath(path),
        releaseOwner: (id) => this.host.captureStore.releaseOwner(id),
      },
      emit: (input) => {
        const value = input as Record<string, unknown>;
        // Bridge emissions all include their originating session; binding installs
        // its event sink on that raw session before extensions receive session_start.
        const emit = this.bridgeSinks.get(String(value.sessionId || ""));
        if (emit) emit(value);
        else if (value.type === "web_settings_schemas_changed") this.bridgeSinks.values().next().value?.(value);
      },
      clientCount: deps.clientCount,
      withWorkLease: (raw, label, operation) => this.host.withWorkLease(handleFor(raw), label, "general", operation),
      createNewSession: (cwd, previous) => this.host.create(cwd, previous),
      sessionCwd: (raw) => handleFor(raw).state().cwd,
      state: (raw) => handleFor(raw).state() as unknown as Record<string, unknown>,
      settingsStore: this.settingsStore,
      modelOptions: () => this.modelOptionTokens(),
    });
  }
  /** Sinks are only for Pi extension-originated events, removed with the handle. */
  private readonly bridgeSinks = new Map<string, (event: Record<string, unknown>) => void>();
  releaseBridge(sessionId: string) { this.bridgeSinks.delete(sessionId); }
  bindHost(host: PiAdapterHost) { this.host = host; }
  modelOptionTokens() {
    return new Set(this.deps.modelRuntime.getAvailableSnapshot().flatMap((model) => model?.provider && model?.id ? [`${model.provider}:${model.id}`] : []));
  }
  private cwd(raw: PiWebSession) { return String((raw.sessionManager as any)?.getCwd?.() || this.deps.globalCwd()); }
  private async ensureStorage(cwd: string) {
    const directory = join(cwd, ".pi", "web");
    await mkdir(directory, { recursive: true });
    if (!existsSync(join(directory, ".gitignore"))) await writeFile(join(directory, ".gitignore"), "*\n");
  }
  private async make(input: AdapterCreateInput, path?: string, sessionStartEvent?: SessionStartEvent): Promise<PiSessionHandle> {
    const cwd = await assertDirectory(input.cwd, this.deps.globalCwd());
    let raw: PiWebSession;
    let loader: ResilientResourceLoader | undefined;
    let fallback: string | undefined;
    if (this.deps.peer) {
      const result = await this.deps.peer.create({ cwd, path, sessionStartEvent });
      raw = result.session;
      fallback = result.modelFallbackMessage;
      if (!path && sessionStartEvent?.reason === "new" && this.deps.peer.newSessionAfterCreate) {
        raw.sessionManager.newSession();
        raw.agent.state.messages = raw.sessionManager.buildSessionContext().messages;
      }
    } else {
      const ephemeral = process.env.PI_WEB_NO_SESSION === "1" || input.persistence === "ephemeral";
      const manager = ephemeral ? SessionManager.inMemory(cwd) : path ? SessionManager.open(path) : SessionManager.create(cwd);
      if (!path && !ephemeral && sessionStartEvent?.reason === "new") manager.newSession();
      const resolvedCwd = manager.getCwd();
      await this.ensureStorage(resolvedCwd);
      const contextPath = fileURLToPath(new URL("../../../../contexts/web-ui.md", import.meta.url));
      const appDir = dirname(dirname(contextPath));
      const webUiContext = [existsSync(contextPath) ? readFileSync(contextPath, "utf8") : "", [
        "pi-web extension documentation (read when asked to build pi-web extensions or browser UI):",
        `- API + slots: ${join(appDir, "docs/pi-web-extensions.md")}`,
        `- Examples: ${join(appDir, "examples/pi-web-extensions")} (notepad.ts shows the current contribute() API)`,
      ].join("\n")].filter(Boolean).join("\n\n");
      loader = new ResilientResourceLoader({
        loadTimeoutMs: envMs("PI_WEB_EXTENSION_LOAD_TIMEOUT_MS", 8_000), fetchTimeoutMs: envMs("PI_WEB_EXTENSION_FETCH_TIMEOUT_MS", 3_000),
        loaderOptions: { cwd: resolvedCwd, agentDir: getAgentDir(), additionalExtensionPaths: this.deps.additionalExtensionPaths(resolvedCwd),
          appendSystemPromptOverride: (base) => [...base, webUiContext].filter(Boolean) },
      });
      await loader.reload();
      const result = await createAgentSession({ cwd: resolvedCwd, sessionManager: manager, modelRuntime: this.deps.modelRuntime, resourceLoader: loader, customTools: createSessionsReadTools((reference, tail) => this.host.readSession(reference, tail)), sessionStartEvent });
      raw = result.session as unknown as PiWebSession;
      fallback = result.modelFallbackMessage;
    }
    if (fallback) console.warn(fallback);
    if (path && input.sessionId && raw.sessionId !== input.sessionId) {
      (raw as any).dispose?.();
      throw new SessionServiceError("Session location did not match requested ID", 409);
    }
    const handle = new PiSessionHandle(raw, this, loader);
    this.handles.set(raw, handle);
    this.bridgeSinks.set(handle.sessionId, (event) => handle.bridgeEvent(event));
    this.host.register(handle, sessionStartEvent?.reason === "new");
    try {
      await this.webUiBridge.bind(raw);
      if (sessionStartEvent?.reason === "new") {
        const defaults = await this.deps.defaultsFor(this.cwd(raw));
        if (defaults.model) {
          const model = raw.modelRuntime.getModel(defaults.model.provider, defaults.model.id);
          if (model) await raw.setModel(model);
        }
        if (defaults.thinkingLevel && raw.getAvailableThinkingLevels().includes(defaults.thinkingLevel)) raw.setThinkingLevel(defaults.thinkingLevel);
      }
      return handle;
    } catch (error) { await handle.dispose(); this.host.failed(handle); throw error; }
  }
  initialize(path?: string) { return this.make({ cwd: this.deps.globalCwd() }, path); }
  create(input: AdapterCreateInput) { return this.make(input, undefined, { type: "session_start", reason: "new", previousSessionFile: input.previousSessionFile }); }
  async open(input: AdapterOpenInput) {
    if (!input.sessionFile) throw new SessionServiceError("Pi session path is missing", 404);
    if (!this.deps.peer && dirname(resolve(input.sessionFile)) !== this.defaultSessionDir(input.cwd)) throw new SessionServiceError("Invalid Pi session location", 400);
    const handle = await this.make(input, input.sessionFile);
    if (handle.sessionId !== input.sessionId) { await handle.dispose(); this.host.failed(handle); throw new SessionServiceError("Session location did not match requested ID", 409); }
    return handle;
  }
  async readHistory(input: AdapterOpenInput) {
    if (!input.sessionFile) throw new SessionServiceError("Pi session path is missing", 404);
    try {
      const records: unknown[] = (await readFile(input.sessionFile, "utf8")).split("\n").flatMap((line) => {
        try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; }
      });
      const header = records[0] as Record<string, unknown> | undefined;
      if (header?.type !== "session" || header.id !== input.sessionId) throw new Error("Session identity mismatch");
      return records.slice(1).flatMap((value) => {
        const entry = value as Record<string, unknown>;
        if (entry?.type !== "message" || typeof entry.id !== "string") return [];
        const message = simplifyMessage(entry.message, { entryId: entry.id });
        return message ? [message] : [];
      });
    } catch { throw new SessionServiceError("Session not found", 404); }
  }
  private info(row: SessionInfoDto): AdapterSessionInfo {
    return { nativeSession: { harnessId: "pi", sessionId: row.id, persistence: "persistent", status: "resumable" },
      cwd: row.cwd, sessionFile: row.path, name: row.name, firstMessage: row.firstMessage, created: row.created, modified: row.modified, messageCount: row.messageCount };
  }
  async list(cwd: string): Promise<AdapterSessionInfo[]> {
    if (process.env.PI_WEB_NO_SESSION === "1") return [];
    if (this.deps.peer?.list) return (await this.deps.peer.list(cwd)).map((row) => this.info({ ...row, created: row.created.toISOString(), modified: row.modified.toISOString(), isCurrent: false }));
    return (await this.shallowLister.list(cwd, this.defaultSessionDir(cwd))).map((row) => this.info(row));
  }
  private defaultSessionDir(cwd: string) {
    return join(getAgentDir(), "sessions", `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
  }
  async find(id: string, cwds: string[]): Promise<AdapterSessionInfo | undefined> {
    if (!id || process.env.PI_WEB_NO_SESSION === "1") return;
    if (this.deps.peer?.list) {
      for (const cwd of cwds) { const row = (await this.list(cwd)).find((item) => item.nativeSession.sessionId === id); if (row) return row; }
      return;
    }
    const suffix = `_${id}.jsonl`;
    const checked = new Set<string>();
    const locate = async (directory: string, cwd?: string) => {
      let names: string[];
      try { names = await readdir(directory); } catch { return; }
      const name = names.find((item) => item.endsWith(suffix));
      if (!name) return;
      const path = join(directory, name);
      const resolvedCwd = cwd || await shallowSessionCwd(path);
      if (!resolvedCwd || this.defaultSessionDir(resolvedCwd) !== directory) return;
      return { nativeSession: { harnessId: "pi" as const, sessionId: id, persistence: "persistent" as const, status: "resumable" as const },
        cwd: resolve(resolvedCwd), sessionFile: path, created: "", modified: "" };
    };
    for (const cwd of cwds) {
      const directory = this.defaultSessionDir(cwd); checked.add(directory);
      const row = await locate(directory, cwd); if (row) return row;
    }
    const root = join(getAgentDir(), "sessions");
    let directories: string[];
    try { directories = await readdir(root); } catch { return; }
    for (const directory of directories) {
      const path = join(root, directory); if (checked.has(path)) continue;
      const row = await locate(path); if (row) return row;
    }
  }
  async remove(input: AdapterOpenInput): Promise<"trashed" | "deleted"> {
    if (!input.sessionFile) throw new SessionServiceError("Pi session path is missing", 404);
    if (this.deps.peer?.remove) return this.deps.peer.remove(input.sessionId, input.sessionFile);
    try { await execFileAsync("trash", [input.sessionFile], { timeout: 15_000 }); return "trashed"; }
    catch (error: any) { if (error?.code !== "ENOENT") throw error; await rm(input.sessionFile, { force: true }); return "deleted"; }
  }
}

export function createPiAdapter(deps: PiAdapterDependencies) { return new PiAdapter(deps); }
