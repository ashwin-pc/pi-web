import type {
  HarnessDescriptorDto,
  HarnessId,
  InteractionResponseDto,
  InterruptReceiptDto,
  MessageDto,
  NativeSessionRefDto,
  PromptInputDto,
  PromptReceiptDto,
  SessionServiceEvent,
  SessionSnapshotDto,
} from "./dto.js";

/** The host supplies a guard, not a native turn ID. For supported steering it must
 * preserve the validated expectedExecutionId, never substitute the current execution. */
export interface AdapterPromptInput extends PromptInputDto {
  executionId: string;
}

/** One owned live native session. No native SDK/session-manager object escapes this handle. */
export interface SessionHandle {
  readonly sessionId: string;
  readonly harnessId: HarnessId;
  /** Cached authoritative state, including all still-pending interactions. */
  state(): SessionSnapshotDto;
  messages(): Promise<MessageDto[]>;
  /** Dispatch/acknowledge without waiting for execution settlement. Never auto-resubmit. */
  prompt(input: AdapterPromptInput): Promise<PromptReceiptDto>;
  /** Validate the host guard, then target the actual live native execution/query. */
  interrupt(expectedExecutionId: string): Promise<InterruptReceiptDto>;
  respondInteraction(response: InteractionResponseDto): boolean;
  cancelInteractions(reason: "timeout" | "disconnect" | "disposed"): void;
  subscribe(listener: (event: SessionServiceEvent) => void): () => void;
  dispose(): Promise<void>;
}

export interface AdapterCreateInput {
  cwd: string;
  /** Native adapters receive an independent web UUID; Pi returns its existing Pi UUID. */
  sessionId?: string;
  persistence?: "persistent" | "ephemeral";
  /** Pi-only new-session extension context, never native routing. */
  previousSessionFile?: string;
}

export interface AdapterOpenInput {
  sessionId: string;
  cwd: string;
  nativeSession: NativeSessionRefDto;
  /** Pi-only compatibility path. Codex/Claude resume by nativeSession.sessionId. */
  sessionFile?: string;
}

/** Discovery is native; the host owns the durable web-ID-to-native-ref association. */
export interface AdapterSessionInfo {
  nativeSession: NativeSessionRefDto;
  cwd: string;
  sessionFile?: string;
  name?: string;
  firstMessage?: string;
  created?: string;
  modified: string;
  messageCount?: number;
}

/** Small operational seam used by the local service, not an SDK-shaped universal API. */
export interface SessionAdapter {
  readonly harness: HarnessDescriptorDto;
  create(input: AdapterCreateInput): Promise<SessionHandle>;
  /** The service reuses an existing live handle, especially for ephemeral sessions. */
  open(input: AdapterOpenInput): Promise<SessionHandle>;
  list(cwd: string): Promise<AdapterSessionInfo[]>;
}
