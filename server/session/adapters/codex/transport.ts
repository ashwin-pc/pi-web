import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { nativeChildEnvironment } from "../nativeEnvironment.js";

export type RpcId = string | number;
export type NativeObject = Record<string, unknown>;
export type NativeNotification = { method: string; params?: unknown };
export type NativeRequest = NativeNotification & { id: RpcId };

export function object(value: unknown): NativeObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as NativeObject : undefined;
}

function rpcId(value: unknown): value is RpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}

/** Credential filtering is separate from diagnostic shortening/URL elision. */
export function redactCredentials(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[^\s,;"'}\]]+/gi, "$1 [redacted]")
    .replace(/\b(?:sk-[\w-]{8,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/g, "[redacted]")
    .replace(/((?:["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|token|(?:aws_)?secret_access_key|(?:aws_)?session_token)["']?)\s*[=:]\s*)(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s,;&]+)/gi, "$1[redacted]");
}

/** Native diagnostics are not trusted log or UI content. Never retain stderr. */
export function diagnostic(value: unknown): string {
  if (typeof value !== "string") return "Codex request failed";
  return redactCredentials(value.slice(0, 2_048)).replace(/https?:\/\/[^\s]+/gi, "[url]").slice(0, 2_048);
}

export class CodexRpcError extends Error {
  constructor(message: string, readonly code: number | "timeout" | "closed" | "protocol", readonly ambiguous = false) {
    super(diagnostic(message));
    this.name = "CodexRpcError";
  }
}

export interface CodexLaunchOptions {
  cwd: string;
  /** Trusted server/test configuration, never browser input. Default preserves the PATH wrapper. */
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  maxFrameBytes?: number;
}

export interface CodexTransportCallbacks {
  notification(message: NativeNotification): void;
  request(message: NativeRequest): void;
  closed(error: CodexRpcError): void;
  observation(kind: "orphan-response" | "invalid-frame", bytes?: number): void;
}

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

/** One owned native stdio connection. All semantic state belongs to the adapter. */
export class CodexTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<RpcId, Pending>();
  private readonly decoder = new StringDecoder("utf8");
  private readonly maxFrameBytes: number;
  private readonly requestTimeoutMs: number;
  private nextId = 0;
  private buffer = "";
  private ended = false;
  private disposing?: Promise<void>;
  private readonly exited: Promise<void>;

  constructor(options: CodexLaunchOptions, private readonly callbacks: CodexTransportCallbacks) {
    this.maxFrameBytes = options.maxFrameBytes ?? 8 * 1024 * 1024;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 45_000;
    this.child = spawn(options.command ?? "codex", options.args ?? ["app-server", "--listen", "stdio://"], {
      cwd: options.cwd,
      // Preserve native auth/config and explicit-env semantics, not the host control token.
      env: nativeChildEnvironment(options.env ?? process.env),
      stdio: ["pipe", "pipe", "pipe"],
      // Own a process group so a wrapper's children cannot outlive explicit disposal.
      detached: process.platform !== "win32",
    });
    this.exited = new Promise((resolve) => this.child.once("close", () => resolve()));
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(this.decoder.write(chunk)));
    this.child.stderr.resume(); // Native stderr may contain private diagnostics; do not forward it.
    this.child.stdin.on("error", () => this.fail(new CodexRpcError("Codex input closed", "closed", true)));
    this.child.once("error", () => this.fail(new CodexRpcError("Could not launch Codex app-server; check the configured executable and native setup", "closed")));
    this.child.once("close", (code, signal) => {
      this.finish(new CodexRpcError(`Codex app-server exited (${signal ?? code ?? "unknown"})`, "closed", true));
    });
  }

  get closed(): boolean { return this.ended; }

  request(method: string, params: unknown = {}): Promise<unknown> {
    if (this.ended) return Promise.reject(new CodexRpcError("Codex app-server is closed", "closed"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Dispatch may have succeeded. The adapter must not automatically retry a prompt.
        reject(new CodexRpcError(`Codex ${method} response timed out`, "timeout", true));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method: string, params: unknown = {}): void { this.send({ method, params }); }
  respond(id: RpcId, result: unknown): void { this.send({ id, result }); }
  reject(id: RpcId, message = "This client does not support the required Codex request", code = -32601): void {
    this.send({ id, error: { code, message: diagnostic(message) } });
  }

  private send(message: unknown): void {
    if (this.ended) throw new CodexRpcError("Codex app-server is closed", "closed");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(text: string): void {
    if (this.ended) return;
    this.buffer += text;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > this.maxFrameBytes) return this.invalidFrame(Buffer.byteLength(line));
      let message: NativeObject | undefined;
      try { message = object(JSON.parse(line)); }
      catch { return this.invalidFrame(Buffer.byteLength(line)); }
      if (!message) return this.invalidFrame(Buffer.byteLength(line));
      if (typeof message.method === "string") {
        if (Object.hasOwn(message, "id")) {
          if (!rpcId(message.id)) return this.invalidFrame(Buffer.byteLength(line));
          const request = { method: message.method, id: message.id, params: message.params };
          if (!this.deliver(() => this.callbacks.request(request))) return;
        } else {
          const notification = { method: message.method, params: message.params };
          if (!this.deliver(() => this.callbacks.notification(notification))) return;
        }
        continue;
      }
      if (!rpcId(message.id) || (!Object.hasOwn(message, "result") && !object(message.error))) {
        return this.invalidFrame(Buffer.byteLength(line));
      }
      const pending = this.pending.get(message.id);
      if (!pending) {
        if (!this.deliver(() => this.callbacks.observation("orphan-response"))) return;
        continue;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      const error = object(message.error);
      if (error) pending.reject(new CodexRpcError(diagnostic(error.message), typeof error.code === "number" ? error.code : -32603));
      else pending.resolve(message.result);
    }
    if (Buffer.byteLength(this.buffer) > this.maxFrameBytes) this.invalidFrame(Buffer.byteLength(this.buffer));
  }

  private deliver(callback: () => void): boolean {
    try { callback(); }
    catch { this.fail(new CodexRpcError("Codex protocol handler failed; its connection was closed", "protocol", true)); }
    return !this.ended;
  }

  private invalidFrame(bytes: number): void {
    if (!this.deliver(() => this.callbacks.observation("invalid-frame", bytes))) return;
    this.fail(new CodexRpcError("Invalid or oversized Codex protocol message", "protocol", true));
  }

  private fail(error: CodexRpcError): void {
    this.finish(error);
    void this.dispose();
  }

  private finish(error: CodexRpcError): void {
    if (this.ended) return;
    this.ended = true;
    this.buffer = "";
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    try { this.callbacks.closed(error); }
    catch { /* A failed consumer must not crash the host or prevent owned-child cleanup. */ }
  }

  dispose(): Promise<void> {
    if (!this.disposing) {
      // Publish the promise before stop() invokes the closed callback; a consumer may
      // synchronously dispose in that callback. Cleanup must still run only once.
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      this.disposing = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
      void this.stop().then(resolve, reject);
    }
    return this.disposing;
  }

  private async stop(): Promise<void> {
    this.finish(new CodexRpcError("Codex connection disposed", "closed"));
    this.child.stdin.end();
    const terminate = setTimeout(() => this.signal("SIGTERM"), 1_000);
    const kill = setTimeout(() => this.signal("SIGKILL"), 2_000);
    terminate.unref?.();
    kill.unref?.();
    await this.exited;
    clearTimeout(terminate);
    clearTimeout(kill);
  }

  private signal(signal: NodeJS.Signals): void {
    if (!this.child.pid) return;
    try {
      if (process.platform === "win32") this.child.kill(signal);
      else process.kill(-this.child.pid, signal);
    } catch { /* Already exited. Only this connection's process group is targeted. */ }
  }
}
