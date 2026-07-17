import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { encodeRuntimeMessage, parseRuntimeLine, type RuntimeEvent, type RuntimeRequest, type RuntimeRequestHandler, type RuntimeResponse } from "./protocol.js";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

export class StdioRuntimeClient {
  readonly child: ChildProcess;
  private pending = new Map<string, Pending>();
  private eventListeners = new Set<(event: RuntimeEvent) => void>();
  private closeListeners = new Set<(error: Error) => void>();
  private closed = false;
  private closeNotified = false;
  private readonly runtimeRequestHandler?: RuntimeRequestHandler;

  get isClosed(): boolean {
    return this.closed || this.child.exitCode !== null || this.child.signalCode !== null;
  }

  constructor(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; runtimeRequestHandler?: RuntimeRequestHandler } = {}) {
    this.runtimeRequestHandler = options.runtimeRequestHandler;
    this.child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rl = createInterface({ input: this.child.stdout! });
    rl.on("line", (line) => this.handleLine(line));
    this.child.stderr?.on("data", (chunk) => process.stderr.write(`[runtime] ${chunk}`));
    this.child.on("exit", (code, signal) => {
      this.notifyClosed(new Error(`runtime exited code=${code ?? ""} signal=${signal ?? ""}`));
    });
    this.child.on("error", (error) => {
      this.notifyClosed(error);
    });
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.isClosed) return Promise.reject(new Error("runtime client is closed"));
    const id = randomUUID();
    const payload = encodeRuntimeMessage({ id, method, params });
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`runtime request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeout });
      this.child.stdin!.write(payload, (error) => {
        if (!error) return;
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onClose(listener: (error: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    this.notifyClosed(new Error("runtime client closed"));
    this.child.kill("SIGTERM");
  }

  private handleLine(line: string): void {
    let message: RuntimeRequest | RuntimeResponse | RuntimeEvent | undefined;
    try {
      message = parseRuntimeLine(line);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const level = line.trimStart().startsWith("{\"id\":") ? "malformed protocol response" : "ignored non-protocol stdout line";
      process.stderr.write(`[runtime] ${level}: ${line.slice(0, 500)}${line.length > 500 ? "…" : ""} (${detail})\n`);
      return;
    }
    if (!message) return;
    if ("method" in message) {
      void this.handleRuntimeRequest(message);
      return;
    }
    if ("event" in message) {
      for (const listener of this.eventListeners) listener(message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error));
  }

  private async handleRuntimeRequest(request: RuntimeRequest): Promise<void> {
    try {
      if (!this.runtimeRequestHandler) throw new Error(`Runtime-initiated requests are disabled: ${request.method}`);
      const result = await this.runtimeRequestHandler(request, {
        sendEvent: (event, data) => this.writeToRuntime({ event, data }),
      });
      this.writeToRuntime({ id: request.id, ok: true, result });
    } catch (error) {
      this.writeToRuntime({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private writeToRuntime(value: RuntimeResponse | RuntimeEvent): void {
    if (this.isClosed || !this.child.stdin?.writable) return;
    this.child.stdin.write(encodeRuntimeMessage(value));
  }

  private notifyClosed(error: Error): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.closed = true;
    this.runtimeRequestHandler?.dispose?.();
    this.failAll(error);
    for (const listener of this.closeListeners) listener(error);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
