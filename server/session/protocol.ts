import type { SessionService, SessionServiceEvent } from "./dto.js";

export const SESSION_PROTOCOL_VERSION = 1;
export type SessionApiMethod = Exclude<keyof SessionService, "subscribe">;
export type SessionRequest = { type: "health"; id: string; protocolVersion: number; build: string } | { type: "request"; id: string; method: SessionApiMethod; args: unknown[] };
export type SerializedError = { name: string; message: string; stack?: string; status?: number; code?: string };
export type SessionResponse =
  | { type: "health"; id: string; protocolVersion: number; build: string }
  | { type: "response"; id: string; result: unknown }
  | { type: "error"; id: string; error: SerializedError }
  | { type: "event"; event: SessionServiceEvent };

export function serializeError(value: unknown): SerializedError {
  if (!(value instanceof Error)) return { name: "Error", message: String(value) };
  const extra = value as Error & { status?: number; code?: string };
  return { name: value.name, message: value.message, ...(value.stack ? { stack: value.stack } : {}), ...(extra.status !== undefined ? { status: extra.status } : {}), ...(extra.code ? { code: extra.code } : {}) };
}

export class RemoteSessionError extends Error {
  status?: number;
  code?: string;
  constructor(error: SerializedError) {
    super(error.message); this.name = error.name; this.stack = error.stack; this.status = error.status; this.code = error.code;
  }
}
