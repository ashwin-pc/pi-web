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

import type { SessionService, BaseSessionStateDto, NavigationResult, SessionContextDto, ConversationTreeDto, ModelsResultDto, SlashCommandDto } from "./dto.js";
import type { AudioCapturePolicy } from "../extensions/captureStore.js";

/** Independently defined compatibility protocol, not a projection of an implementation. */
export interface PiOperations {
  context(): Promise<SessionContextDto>;
  tree(): Promise<ConversationTreeDto>;
  models(): Promise<ModelsResultDto>;
  commands(): Promise<SlashCommandDto[]>;
  setModel(provider: string, model: string, thinkingLevel?: string): Promise<BaseSessionStateDto>;
  executeShell(command: string, exclude: boolean): Promise<Record<string, import("./dto.js").JsonValue | undefined>>;
  executeCommand(command: string): Promise<{ message: string; state: BaseSessionStateDto }>;
  retry(): Promise<{ sessionId: string }>;
  abortCompaction(): Promise<{ sessionId: string }>;
  abortBranchSummary(): Promise<{ sessionId: string }>;
  navigate(target: string, options: Record<string, unknown>): Promise<NavigationResult>;
  rename(name: string): Promise<BaseSessionStateDto>;
  readHistoryEntry(entryId: string): MessageDto[];
  webUiEntries(): { webContributions: unknown[] };
  captureRegistration(key: unknown, registrationId: unknown): { key: string; policy: AudioCapturePolicy; registrationId: string } | undefined;
  invokeContribution(input: Record<string, unknown>, signal?: AbortSignal): ReturnType<SessionService["invokeContribution"]>;
  invokeHeaderAction(key: unknown): ReturnType<SessionService["invokeHeaderAction"]>;
  invokeArtifactAction(input: Record<string, unknown>): ReturnType<SessionService["invokeArtifactAction"]>;
  invokeGitTab(input: Record<string, unknown>): ReturnType<SessionService["invokeGitTab"]>;
  invokePanel(input: Record<string, unknown>): ReturnType<SessionService["invokePanel"]>;
  extensionStatus(): unknown;
  reloadExtensions(): Promise<unknown>;
}

/** Optional legacy file/history compatibility, separate from identity allocation policy. */
export interface PiCompatibility {
  initialize(path?: string): Promise<SessionHandle>;
  find(id: string, cwds: string[]): Promise<AdapterSessionInfo | undefined>;
  readHistory(input: AdapterOpenInput): Promise<MessageDto[]>;
  remove(input: AdapterOpenInput): Promise<"trashed" | "deleted">;
}

/** One owned live native session. No native SDK/session-manager object escapes this handle. */
export interface SessionHandle {
  readonly sessionId: string;
  readonly harnessId: HarnessId;
  readonly piOperations?: PiOperations;
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
  /** Pi preserves its legacy public UUID; native subprocess agents use host-owned UUIDs. */
  readonly webIdentity: "native" | "host";
  readonly piCompatibility?: PiCompatibility;
  create(input: AdapterCreateInput): Promise<SessionHandle>;
  /** The service reuses an existing live handle, especially for ephemeral sessions. */
  open(input: AdapterOpenInput): Promise<SessionHandle>;
  list(cwd: string): Promise<AdapterSessionInfo[]>;
}
