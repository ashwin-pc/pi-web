import { access, lstat, mkdtemp, rm } from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PiWebExtensionAPI } from "@ashwin-pc/pi-web/extensions";
import { DEFAULT_DICTATION_BACKEND, DICTATION_BACKENDS } from "./adapters/config.js";

const CONTRIBUTION_KEY = "dictation.record";
const SETTINGS_ID = "dictation.settings";
const DEFAULT_BACKEND = DEFAULT_DICTATION_BACKEND.value;
const DEFAULT_MODEL = DEFAULT_DICTATION_BACKEND.defaultModel;
const MAX_BACKEND_CHARS = 32;
const MAX_MODEL_CHARS = 256;
const MAX_CAPTURE_BYTES = 25_000_000;
const MAX_PENDING = 3;
const MAX_PROTOCOL_BUFFER_CHARS = 1_000_000;
// Core owns the outer invoke deadline and currently caps it at three minutes.
const DEFAULT_TIMEOUT_SECONDS = 180;
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PYTHON = join(EXTENSION_DIR, ".venv", "bin", "python");
const WORKER_SCRIPT = join(EXTENSION_DIR, "worker.py");

type WorkerResult = {
  text: string;
  model: string;
  durationMs: number;
  decodeMs: number;
  inferenceMs: number;
};

type Pending = {
  resolve: (value: WorkerResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanupAbort: () => void;
};

type ProtocolMessage = Partial<WorkerResult> & { id?: string; ok?: boolean; error?: string };

async function waitForExit(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    timer.unref?.();
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export class DictationWorker {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private pending = new Map<string, Pending>();
  private pythonPath = DEFAULT_PYTHON;
  private generation = 0;
  private reservations = 0;

  constructor(private readonly options: { workerScript?: string; tempRoot?: string } = {}) {}

  async transcribe(path: string, options: { mimeType: string; backend?: string; model?: string; pythonPath?: string; timeoutMs: number; signal?: AbortSignal }): Promise<WorkerResult> {
    // Reserve synchronously, before any await, so simultaneous cold-start calls
    // cannot all pass a stale pending.size check.
    if (this.reservations >= MAX_PENDING) throw new Error("Dictation is busy; wait for the current transcription to finish.");
    this.reservations += 1;
    let workDir: string | undefined;
    let requestChild: ChildProcessWithoutNullStreams | undefined;
    try {
      // Allocate invocation-owned state first. Cancellation during this await is
      // observed below, and finally always removes the directory.
      workDir = await mkdtemp(join(this.options.tempRoot ?? tmpdir(), "pi-dictation-"));
      if (options.signal?.aborted) throw new Error("Dictation cancelled.");
      const pythonPath = options.pythonPath?.trim() || DEFAULT_PYTHON;
      if (this.child && pythonPath !== this.pythonPath) this.stop(new Error("Dictation Python setting changed."));
      this.pythonPath = pythonPath;
      await this.ensureStarted();

      // This is the final await before listener + pending registration. JS runs
      // the following block synchronously, so abort cannot slip between this
      // check and addEventListener. Another request may have stopped the shared
      // generation while startup awaited, so validate the child explicitly.
      if (options.signal?.aborted) throw new Error("Dictation cancelled.");
      const child = this.child;
      if (!child || child.killed) throw new Error("Dictation worker stopped during setup.");
      const id = randomUUID();
      requestChild = child;
      const generation = this.generation;
      return await new Promise<WorkerResult>((resolve, reject) => {
        const abort = () => this.stop(new Error("Dictation cancelled."), true, child, generation);
        options.signal?.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(
          () => this.stop(new Error(`Dictation timed out after ${Math.round(options.timeoutMs / 1000)} seconds.`), true, child, generation),
          options.timeoutMs,
        );
        this.pending.set(id, {
          resolve,
          reject,
          timer,
          cleanupAbort: () => options.signal?.removeEventListener("abort", abort),
        });
        child.stdin.write(`${JSON.stringify({ id, op: "transcribe", path, mimeType: options.mimeType, workDir, backend: options.backend ?? DEFAULT_BACKEND, model: options.model ?? DEFAULT_MODEL })}\n`, (error) => {
          if (error && this.child === child && this.generation === generation) {
            this.stop(new Error(`Could not send audio to the dictation worker: ${error.message}`), true, child, generation);
          }
        });
      });
    } finally {
      this.reservations -= 1;
      // If cancellation/timeout replaced this generation, wait for Node to reap
      // its process-group leader before unlinking ffmpeg's output directory.
      if (requestChild && this.child !== requestChild) await waitForExit(requestChild);
      if (workDir) await rm(workDir, { recursive: true, force: true });
    }
  }

  private async ensureStarted() {
    if (this.child && !this.child.killed) return;
    const workerScript = this.options.workerScript ?? WORKER_SCRIPT;
    await Promise.all([access(this.pythonPath), access(workerScript)]);
    if (this.child && !this.child.killed) return;
    const child = spawn(this.pythonPath, ["-u", workerScript], {
      cwd: EXTENSION_DIR,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    const generation = ++this.generation;
    this.child = child;
    this.buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (this.child === child && this.generation === generation) this.consume(chunk, child, generation);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (this.child === child && this.generation === generation) process.stderr.write(`[dictation] ${chunk}`);
    });
    child.once("error", (error) => {
      if (this.child === child && this.generation === generation) {
        this.stop(new Error(`Dictation worker failed to start: ${error.message}`), false, child, generation);
      }
    });
    child.once("exit", (code, signal) => {
      if (this.child === child && this.generation === generation) {
        this.stop(new Error(`Dictation worker exited (${signal || code || "unknown"}).`), false, child, generation);
      }
    });
  }

  private consume(chunk: string, child: ChildProcessWithoutNullStreams, generation: number) {
    if (this.child !== child || this.generation !== generation) return;
    if (this.buffer.length + chunk.length > MAX_PROTOCOL_BUFFER_CHARS) {
      return this.stop(new Error("Dictation worker exceeded the protocol buffer limit."), true, child, generation);
    }
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: ProtocolMessage;
      try { message = JSON.parse(line) as ProtocolMessage; }
      catch { return this.stop(new Error("Dictation worker returned invalid JSON."), true, child, generation); }
      if (!message.id) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.cleanupAbort();
      if (!message.ok) pending.reject(new Error(message.error || "Dictation failed."));
      else if (typeof message.text !== "string") pending.reject(new Error("Dictation worker returned no transcript."));
      else pending.resolve(message as WorkerResult);
    }
  }

  stop(error = new Error("Dictation worker stopped."), kill = true, expectedChild = this.child, expectedGeneration = this.generation) {
    if (!expectedChild || this.child !== expectedChild || this.generation !== expectedGeneration) return;
    this.child = undefined;
    this.buffer = "";
    if (kill && !expectedChild.killed) {
      // detached:true gives the worker and ffmpeg descendants one process group.
      // Kill the whole group so cancellation cannot orphan a decoder.
      try { if (expectedChild.pid) process.kill(-expectedChild.pid, "SIGKILL"); }
      catch { try { expectedChild.kill("SIGKILL"); } catch { /* already gone */ } }
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.cleanupAbort();
      pending.reject(error);
    }
    this.pending.clear();
  }
}

// jiti can instantiate the extension once per live session. A process-global
// singleton keeps one model-bearing Python worker shared by all those instances.
const workerSymbol = Symbol.for("pi-web.dictation.worker.v1");
const processGlobals = globalThis as typeof globalThis & { [workerSymbol]?: DictationWorker };
const worker = processGlobals[workerSymbol] ??= new DictationWorker();

function numberSetting(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

async function validateCapture(path: unknown) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("Core did not provide a valid private capture path.");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Capture must be a regular, non-symlink file.");
  if (info.size <= 0 || info.size > MAX_CAPTURE_BYTES) throw new Error("Capture is empty or exceeds the 25 MB limit.");
  return path;
}

function stringSetting(value: unknown, fallback: string, maxLength: number) {
  return typeof value === "string" && value.trim() && value.trim().length <= maxLength ? value.trim() : fallback;
}

export default function dictation(pi: PiWebExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const web = ctx.ui.web;
    const capabilities = web?.capabilities;
    if (!capabilities?.slots.includes("composer-input") || !capabilities.kinds.includes("capture")) {
      ctx.ui.notify("Dictation requires pi-web audio capture support.", "warning");
      return;
    }

    const registerContribution = (rawMaxSeconds: unknown) => {
      const maxSeconds = numberSetting(rawMaxSeconds, 120, 1, 120);
      web.contribute(CONTRIBUTION_KEY, {
        slot: "composer-input",
        kind: "capture",
        title: "Dictate",
        label: "Dictate",
        icon: "mic",
        capture: {
          media: "audio",
          maxSeconds,
          maxBytes: MAX_CAPTURE_BYTES,
          mimeTypes: ["audio/webm", "audio/mp4", "audio/ogg", "audio/wav"],
        },
        invoke: async (event) => {
          const path = await validateCapture(event.capture.path);
          const { values } = await web.getSettings(SETTINGS_ID);
          const timeoutSeconds = numberSetting(values?.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS, 30, 180);
          const backend = stringSetting(values?.backend, DEFAULT_BACKEND, MAX_BACKEND_CHARS);
          const model = stringSetting(values?.model, DEFAULT_MODEL, MAX_MODEL_CHARS);
          const result = await worker.transcribe(path, {
            mimeType: event.capture.mimeType,
            backend,
            model,
            pythonPath: typeof values?.pythonPath === "string" ? values.pythonPath : undefined,
            timeoutMs: timeoutSeconds * 1000,
            signal: event.signal,
          });
          return { effects: [{ type: "insert-composer-text", text: result.text, placement: "selection" }] };
        },
      });
    };

    await web.registerSettings({
      id: SETTINGS_ID,
      title: "Dictation",
      schemaVersion: 1,
      fields: [
        { key: "backend", type: "select", label: "Backend", default: DEFAULT_BACKEND, options: DICTATION_BACKENDS.map(({ value, label }) => ({ value, label })) },
        { key: "model", type: "text", label: "Model ID or local model path", description: "Weights stay outside the extension. Hugging Face IDs use its external cache.", default: DEFAULT_MODEL, required: true, maxLength: MAX_MODEL_CHARS },
        { key: "maxSeconds", type: "number", label: "Maximum recording length (seconds)", default: 120, min: 1, max: 120 },
        { key: "timeoutSeconds", type: "number", label: "Transcription timeout (seconds)", description: "Core enforces an outer three-minute limit.", default: DEFAULT_TIMEOUT_SECONDS, min: 30, max: 180 },
        { key: "pythonPath", type: "text", label: "Python executable", description: "Leave blank to use this extension's .venv/bin/python.", default: "" },
      ],
      onChange: (values) => registerContribution(values.maxSeconds),
    });
    const initial = await web.getSettings(SETTINGS_ID);
    registerContribution(initial.values?.maxSeconds);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    // Do not stop the shared worker: other sessions may be using it, and keeping
    // the process alive avoids reloading 2.5 GB of weights after extension reloads.
    ctx.ui.web.contribute(CONTRIBUTION_KEY, undefined);
  });
}
