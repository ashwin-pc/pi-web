import { AsyncLocalStorage } from "node:async_hooks";
import {
  DefaultResourceLoader,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

type LoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];
type LoaderFactory = (options: LoaderOptions) => ResourceLoader;

export type ExtensionLoadError = {
  path: string;
  error: string;
};

export type ExtensionLoadStatus = {
  state: "loading" | "ready" | "degraded";
  cwd: string;
  attempt: number;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  timeoutMs: number;
  fetchTimeoutMs: number;
  extensionCount: number;
  errors: ExtensionLoadError[];
  message: string;
};

export type ResilientResourceLoaderOptions = {
  loaderOptions: LoaderOptions;
  loadTimeoutMs?: number;
  fetchTimeoutMs?: number;
  createLoader?: LoaderFactory;
  log?: Pick<Console, "info" | "warn" | "error">;
};

type ExtensionFetchContext = {
  timeoutMs: number;
  log: Pick<Console, "warn">;
};

const extensionFetchContext = new AsyncLocalStorage<ExtensionFetchContext>();
const nativeFetch = globalThis.fetch.bind(globalThis);
const fetchWrapperKey = Symbol.for("pi-web.extension-fetch-wrapper");

function displayFetchTarget(input: string | URL | Request): string {
  try {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "<invalid URL>";
  }
}

function installExtensionFetchTimeout() {
  const markedGlobal = globalThis as typeof globalThis & Record<symbol, boolean | undefined>;
  if (markedGlobal[fetchWrapperKey]) return;
  markedGlobal[fetchWrapperKey] = true;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const context = extensionFetchContext.getStore();
    if (!context || context.timeoutMs <= 0) return nativeFetch(input, init);

    const controller = new AbortController();
    const inputSignal = init?.signal || (input instanceof Request ? input.signal : undefined);
    const relayAbort = () => controller.abort(inputSignal?.reason);
    if (inputSignal?.aborted) relayAbort();
    else inputSignal?.addEventListener("abort", relayAbort, { once: true });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`Extension fetch timed out after ${context.timeoutMs}ms`));
    }, context.timeoutMs);
    timer.unref?.();

    try {
      return await nativeFetch(input, { ...init, signal: controller.signal });
    } catch (error) {
      if (!timedOut) throw error;
      const target = displayFetchTarget(input);
      const message = `Extension fetch timed out after ${context.timeoutMs}ms: ${target}`;
      context.log.warn(`[extensions] ${message}`);
      throw new Error(message, { cause: error });
    } finally {
      clearTimeout(timer);
      inputSignal?.removeEventListener("abort", relayAbort);
    }
  };
}

installExtensionFetchTimeout();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveMs(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class ResilientResourceLoader implements ResourceLoader {
  private active: ResourceLoader;
  private readonly createLoader: LoaderFactory;
  private readonly log: Pick<Console, "info" | "warn" | "error">;
  private readonly loadTimeoutMs: number;
  private readonly fetchTimeoutMs: number;
  private readonly primaryOptions: LoaderOptions;
  private readonly fallbackOptions: LoaderOptions;
  private readonly extendedResources: Array<Parameters<ResourceLoader["extendResources"]>[0]> = [];
  private attempt = 0;
  private reloadPromise?: Promise<void>;
  private status: ExtensionLoadStatus;

  constructor(options: ResilientResourceLoaderOptions) {
    this.createLoader = options.createLoader || ((loaderOptions) => new DefaultResourceLoader(loaderOptions));
    this.log = options.log || console;
    this.loadTimeoutMs = positiveMs(options.loadTimeoutMs, 8_000);
    this.fetchTimeoutMs = positiveMs(options.fetchTimeoutMs, 3_000);
    this.primaryOptions = options.loaderOptions;
    this.fallbackOptions = {
      ...options.loaderOptions,
      additionalExtensionPaths: [],
      extensionFactories: [],
      noExtensions: true,
    };
    this.active = this.createLoader(this.fallbackOptions);
    this.status = {
      state: "loading",
      cwd: options.loaderOptions.cwd,
      attempt: 0,
      timeoutMs: this.loadTimeoutMs,
      fetchTimeoutMs: this.fetchTimeoutMs,
      extensionCount: 0,
      errors: [],
      message: "Extensions have not loaded yet.",
    };
  }

  getStatus(): ExtensionLoadStatus {
    return {
      ...this.status,
      errors: this.status.errors.map((error) => ({ ...error })),
    };
  }

  getExtensions() {
    return this.active.getExtensions();
  }

  getSkills() {
    return this.active.getSkills();
  }

  getPrompts() {
    return this.active.getPrompts();
  }

  getThemes() {
    return this.active.getThemes();
  }

  getAgentsFiles() {
    return this.active.getAgentsFiles();
  }

  getSystemPrompt() {
    return this.active.getSystemPrompt();
  }

  getAppendSystemPrompt() {
    return this.active.getAppendSystemPrompt();
  }

  extendResources(paths: Parameters<ResourceLoader["extendResources"]>[0]) {
    this.extendedResources.push(paths);
    this.active.extendResources(paths);
  }

  reload(options?: Parameters<ResourceLoader["reload"]>[0]): Promise<void> {
    if (this.reloadPromise) return this.reloadPromise;
    this.reloadPromise = this.performReload(options).finally(() => {
      this.reloadPromise = undefined;
    });
    return this.reloadPromise;
  }

  private async performReload(options?: Parameters<ResourceLoader["reload"]>[0]): Promise<void> {
    const attempt = ++this.attempt;
    const started = Date.now();
    this.status = {
      state: "loading",
      cwd: this.primaryOptions.cwd,
      attempt,
      startedAt: new Date(started).toISOString(),
      timeoutMs: this.loadTimeoutMs,
      fetchTimeoutMs: this.fetchTimeoutMs,
      extensionCount: this.active.getExtensions().extensions.length,
      errors: [],
      message: attempt === 1 ? "Loading extensions…" : "Retrying extensions…",
    };
    this.log.info(`[extensions] load started cwd=${this.primaryOptions.cwd} attempt=${attempt} timeoutMs=${this.loadTimeoutMs} fetchTimeoutMs=${this.fetchTimeoutMs}`);

    const candidate = this.createLoader(this.primaryOptions);
    for (const paths of this.extendedResources) candidate.extendResources(paths);
    try {
      await withTimeout(
        extensionFetchContext.run(
          { timeoutMs: this.fetchTimeoutMs, log: this.log },
          () => candidate.reload(options),
        ),
        this.loadTimeoutMs,
        `Extension loading timed out after ${this.loadTimeoutMs}ms`,
      );
      const result = candidate.getExtensions();
      this.active = candidate;
      const durationMs = Date.now() - started;
      this.status = {
        state: result.errors.length > 0 ? "degraded" : "ready",
        cwd: this.primaryOptions.cwd,
        attempt,
        startedAt: new Date(started).toISOString(),
        completedAt: new Date().toISOString(),
        durationMs,
        timeoutMs: this.loadTimeoutMs,
        fetchTimeoutMs: this.fetchTimeoutMs,
        extensionCount: result.extensions.length,
        errors: result.errors,
        message: result.errors.length > 0
          ? `Loaded ${result.extensions.length} extensions with ${result.errors.length} error${result.errors.length === 1 ? "" : "s"}.`
          : `Loaded ${result.extensions.length} extension${result.extensions.length === 1 ? "" : "s"}.`,
      };
      this.log.info(`[extensions] load ${this.status.state} cwd=${this.primaryOptions.cwd} attempt=${attempt} durationMs=${durationMs} extensions=${result.extensions.length} errors=${result.errors.length}`);
      for (const error of result.errors) this.log.error(`[extensions] failed path=${error.path}: ${error.error}`);
      return;
    } catch (error) {
      const loadError = errorMessage(error);
      this.log.error(`[extensions] load failed cwd=${this.primaryOptions.cwd} attempt=${attempt}: ${loadError}`);
      const fallback = this.createLoader(this.fallbackOptions);
      for (const paths of this.extendedResources) fallback.extendResources(paths);
      try {
        await fallback.reload(options);
        this.active = fallback;
      } catch (fallbackError) {
        this.log.error(`[extensions] extension-free fallback failed cwd=${this.primaryOptions.cwd}: ${errorMessage(fallbackError)}`);
        throw fallbackError;
      }
      const durationMs = Date.now() - started;
      this.status = {
        state: "degraded",
        cwd: this.primaryOptions.cwd,
        attempt,
        startedAt: new Date(started).toISOString(),
        completedAt: new Date().toISOString(),
        durationMs,
        timeoutMs: this.loadTimeoutMs,
        fetchTimeoutMs: this.fetchTimeoutMs,
        extensionCount: 0,
        errors: [{ path: "<extension loader>", error: loadError }],
        message: "Extensions were disabled after loading failed. Core pi-web is still available.",
      };
      this.log.warn(`[extensions] continuing without extensions cwd=${this.primaryOptions.cwd} attempt=${attempt} durationMs=${durationMs}`);
    }
  }
}
