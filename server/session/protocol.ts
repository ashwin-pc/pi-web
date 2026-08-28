import type { SessionService, SessionServiceEvent } from "./dto.js";

export const SESSION_PROTOCOL_VERSION = 1;
export type SessionApiMethod = Exclude<keyof SessionService, "subscribe">;
const sessionApiMethods = {
  state: true,
  context: true,
  stats: true,
  tree: true,
  messages: true,
  commands: true,
  models: true,
  setModel: true,
  executeShell: true,
  executeCommand: true,
  prompt: true,
  retry: true,
  abort: true,
  abortCompaction: true,
  abortBranchSummary: true,
  rename: true,
  navigate: true,
  respondInteraction: true,
  cancelInteractions: true,
  invokeContribution: true,
  invokeHeaderAction: true,
  invokeArtifactAction: true,
  invokeGitTab: true,
  invokePanel: true,
  list: true,
  create: true,
  open: true,
  delete: true,
  switchCwd: true,
} satisfies Record<SessionApiMethod, true>;
/** Exhaustive by type: adding a SessionService method fails until it is exposed or explicitly excluded. */
export const SESSION_API_METHODS: ReadonlySet<string> = new Set(Object.keys(sessionApiMethods));
export type SessionRequest = { type: "health"; id: string; protocolVersion: number; build: string } | { type: "request"; id: string; method: SessionApiMethod; args: unknown[] };
export type SerializedError = { name: string; message: string; stack?: string; status?: number; code?: string };
export type SessionResponse =
  | { type: "health"; id: string; protocolVersion: number; build: string }
  | { type: "response"; id: string; result: unknown }
  | { type: "error"; id: string; error: SerializedError }
  | { type: "event"; event: SessionServiceEvent };

export function isSessionResponse(value: unknown): value is SessionResponse {
  if (!value || typeof value !== "object") return false;
  const frame = value as Record<string, unknown>;
  if (frame.type === "event") return typeof frame.event === "object" && frame.event !== null;
  if (typeof frame.id !== "string") return false;
  if (frame.type === "health") return typeof frame.protocolVersion === "number" && typeof frame.build === "string";
  if (frame.type === "response") return Object.hasOwn(frame, "result");
  if (frame.type === "error") { const error = frame.error as Record<string, unknown> | undefined; return !!error && typeof error.name === "string" && typeof error.message === "string"; }
  return false;
}

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
