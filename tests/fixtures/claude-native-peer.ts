import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type {
  SDKControlInitializeResponse,
  SDKControlRequest,
  SDKControlResponse,
  SDKUserMessage,
  SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";

export type ClaudePeerInput = SDKControlRequest | SDKControlResponse | SDKUserMessage;

export const claudePeerInitialization: SDKControlInitializeResponse = {
  commands: [],
  agents: [],
  models: [{ value: "claude-fixture", displayName: "Claude fixture", description: "Synthetic test peer" }],
  output_style: "default",
  available_output_styles: ["default"],
  account: {},
};

/**
 * Synthetic native stream-json peer, not a fake adapter or Pi session. The real
 * pinned SDK consumes this process's stdout and writes controls to its stdin.
 * Application mock routes can hold a peer and call send()/exit()/fail() while
 * browser workflows continue through the normal service, HTTP, and WebSocket.
 */
export class ClaudeNativePeer extends EventEmitter implements SpawnedProcess {
  readonly stdout = new PassThrough();
  readonly stdin: Writable;
  readonly received: ClaudePeerInput[] = [];
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly initialization: SDKControlInitializeResponse | null;
  private ended = false;
  private input = "";
  private decoder = new StringDecoder("utf8");

  constructor(initialization: SDKControlInitializeResponse | null = claudePeerInitialization) {
    super();
    this.initialization = initialization;
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        try {
          this.input += this.decoder.write(chunk);
          let newline: number;
          while ((newline = this.input.indexOf("\n")) !== -1) {
            const line = this.input.slice(0, newline);
            this.input = this.input.slice(newline + 1);
            if (line.trim()) this.receive(JSON.parse(line) as ClaudePeerInput);
          }
          callback();
        } catch (error) {
          callback(error instanceof Error ? error : new Error("Invalid SDK fixture input"));
        }
      },
    });
    this.stdin.on("finish", () => queueMicrotask(() => this.exit(0)));
  }

  send(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  sendRaw(data: string | Buffer): void {
    this.stdout.write(data);
  }

  private receive(message: ClaudePeerInput): void {
    this.received.push(message);
    this.emit("input", message);
    if (this.initialization && message.type === "control_request" && message.request.subtype === "initialize") {
      queueMicrotask(() => this.send({
        type: "control_response",
        response: { subtype: "success", request_id: message.request_id, response: this.initialization },
      }));
    }
  }

  async nextInput(test: (message: ClaudePeerInput) => boolean, timeoutMs = 2000): Promise<ClaudePeerInput> {
    const received = this.received.find(test);
    if (received) return received;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.off("input", listener); reject(new Error("Claude peer input timed out")); }, timeoutMs);
      const listener = (message: ClaudePeerInput) => {
        if (test(message)) {
          clearTimeout(timer);
          this.off("input", listener);
          resolve(message);
        }
      };
      this.on("input", listener);
    });
  }

  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    if (this.ended) return;
    this.ended = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.emit("exit", code, signal);
  }

  fail(error: Error): void {
    this.emit("error", error);
    this.exit(1);
  }

  kill(signal: NodeJS.Signals): boolean {
    this.killed = true;
    this.exit(null, signal);
    return true;
  }
}
