import type { HarnessEventDto } from "./piEventMap.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ModelDto {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

export interface SessionStatsDto {
  userMessages: number;
  assistantMessages: number;
  toolResults: number;
  totalMessages: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  /** Omitted when the harness does not expose monetary usage; zero is a known zero. */
  cost?: number;
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
}

export type HarnessId = "pi" | "codex" | "claude";

/** Native identity is not a web ID, execution ID, item ID, or storage path. */
export interface NativeSessionRefDto {
  harnessId: HarnessId;
  sessionId?: string;
  persistence: "persistent" | "ephemeral";
  /** Persistent sessions can be unmaterialized; ephemeral sessions never become resumable. */
  status: "unmaterialized" | "resumable" | "live-only" | "unavailable";
}

export type SessionPhaseDto = "idle" | "starting" | "running" | "settling" | "error" | "unavailable";
export type SessionActivityDto = "idle" | "working" | "waiting-approval" | "waiting-input" | "retrying" | "compacting";

export interface ActiveExecutionDto {
  /** Host-owned stale-command guard, never presented as a native turn ID. */
  id: string;
  owner: "host";
  /** Only when exposed by the native harness (e.g. Codex turn.id, not Pi/Claude). */
  nativeExecutionId?: string;
}

export interface NativeSettingsDto {
  /** Observed native settings, not Pi model/default-setting overrides. */
  model?: string;
  reasoningEffort?: string;
  permissionMode?: string;
  sandboxMode?: string;
}

export interface HarnessCapabilitiesDto {
  harness: string;
  queue: boolean;
  steering: boolean;
  followUp: boolean;
  thinkingLevel: boolean;
  tree: boolean;
  compaction: boolean;
  retry: boolean;
  bash: boolean;
  extensions: boolean;
  interactions: boolean;
  /** Absent on legacy Pi snapshots; native adapters set these explicitly. */
  models?: boolean;
  context?: boolean;
  attachments?: boolean;
  historyFork?: boolean;
}

export interface HarnessDescriptorDto {
  id: HarnessId;
  name: string;
  enabled: boolean;
  available: boolean;
  unavailableReason?: string;
  capabilities: HarnessCapabilitiesDto;
}

/** GET /api/harnesses returns { ok: true, ...catalog }. */
export interface HarnessCatalogDto {
  multiHarnessEnabled: boolean;
  defaultHarnessId: "pi";
  harnesses: HarnessDescriptorDto[];
}

export interface BaseSessionStateDto {
  cwd: string;
  /** Pi-only compatibility metadata. Never route native sessions through this field. */
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  sessionTitle: string;
  harnessId?: HarnessId;
  nativeSession?: NativeSessionRefDto;
  phase?: SessionPhaseDto;
  activity?: SessionActivityDto;
  activeExecution?: ActiveExecutionDto;
  pendingInteractions?: InteractionRequestDto[];
  nativeSettings?: NativeSettingsDto;
  error?: string;
  capabilities: HarnessCapabilitiesDto;
  isStreaming: boolean;
  isRetrying: boolean;
  isCompacting: boolean;
  queue?: { steering: string[]; followUp: string[] };
  model?: ModelDto;
  thinkingLevel?: string;
  thinkingLevels?: string[];
  stats: SessionStatsDto;
}

/** Complete adapter snapshot; optional base fields only support the legacy Pi transition. */
export interface SessionSnapshotDto extends BaseSessionStateDto {
  harnessId: HarnessId;
  nativeSession: NativeSessionRefDto;
  phase: SessionPhaseDto;
  activity: SessionActivityDto;
  pendingInteractions: InteractionRequestDto[];
}

/** Serializable, role-discriminated projection consumed by every transcript path. */
export type AttachmentDto = {
  type: "file";
  id: string;
  name: string;
  mediaType: string;
  bytes: number;
  path: string;
  contentUrl: string;
} | {
  type: "reference";
  id: string;
  label: string;
  title?: string;
  reference: {
    provider: "github";
    repository: string;
    resource: "issue" | "pull-request";
    number: number;
    url: string;
  };
} | {
  type: "quote-reply";
  id: string;
  label: string;
  quote: string;
  question: string;
  source: {
    messageId?: string;
    startOffset: number;
    endOffset: number;
  };
};

interface MessagePartBaseDto {
  id: string;
  nativeItemId?: string;
  nativeExecutionId?: string;
}

export interface TextPartDto extends MessagePartBaseDto { type: "text"; text: string }
export interface ThinkingPartDto extends MessagePartBaseDto { type: "thinking"; text: string }
export interface ImagePartDto extends MessagePartBaseDto {
  type: "image";
  mediaType: string;
  data?: string;
  url?: string;
  alt?: string;
}
export interface ToolCallPartDto extends MessagePartBaseDto {
  type: "toolCall";
  toolCallId: string;
  toolName: string;
  args: JsonValue;
  status: "running" | "completed" | "error" | "cancelled";
  startedAt?: string;
  result?: { parts: Array<TextPartDto | ImagePartDto>; isError: boolean; details?: JsonValue };
}
export type MessagePartDto = TextPartDto | ThinkingPartDto | ImagePartDto | ToolCallPartDto;

/** Ordered parts are authoritative when present; raw is a Pi-only fidelity fallback. */
type MessageDtoBase = {
  id?: string;
  parts?: MessagePartDto[];
  executionId?: string;
  nativeExecutionId?: string;
  nativeItemId?: string;
  status?: "streaming" | "completed" | "error" | "interrupted";
  errorMessage?: string;
  stopReason?: string;
  details?: JsonValue;
  entryId?: string;
  parentEntryId?: string;
  text?: string;
  timestamp?: string;
  attachments?: AttachmentDto[];
  raw?: JsonValue;
};

export type MessageDto = MessageDtoBase & (
  | { role: "user"; isError?: boolean }
  | { role: "assistant"; toolCalls?: Array<{ id?: string; toolName: string; args: JsonValue; startedAt?: string }>; isError: boolean }
  | { role: "system"; isError?: boolean }
  | { role: "toolResult"; toolCallId?: string; toolName?: string; toolArgs?: JsonValue; isError: boolean }
  | { role: "bashExecution"; command?: JsonValue; output?: JsonValue; exitCode?: JsonValue; cancelled: boolean; truncated: boolean; fullOutputPath?: JsonValue; excludeFromContext: boolean }
  | { role: "compactionSummary"; isError?: boolean }
  | { role: "branchSummary"; isError?: boolean }
  | { role: "unknown"; originalRole: string; isError?: boolean }
  | { role: "custom"; customType: string; details?: JsonValue; display: true }
);

/** New adapter transcript events require stable message and ordered-part identities. */
export type TranscriptMessageDto = MessageDto & { id: string; parts: MessagePartDto[] };

type TranscriptEventBaseDto = {
  sessionId: string;
  executionId?: string;
  nativeExecutionId?: string;
  nativeItemId?: string;
  clientMessageId?: string;
  sourceClientId?: string;
};

/** Events relay unchanged to the browser. No final item/message event implies session idle. */
export type TranscriptEventDto = TranscriptEventBaseDto & (
  | { type: "message_start"; message: TranscriptMessageDto }
  /** Upsert by part.id at index; use this for tool progress/results and non-text changes. */
  | { type: "message_part"; messageId: string; index: number; part: MessagePartDto }
  /** Append only to an existing text/thinking part, addressed by both stable keys. */
  | { type: "message_delta"; messageId: string; partId: string; delta: string }
  /** Authoritative replacement, not an append. final ends this message, not the execution. */
  | { type: "message_replace"; message: TranscriptMessageDto; final: boolean }
);

export interface TreeNodeDto {
  id: string;
  parentId: string | null;
  type: string;
  role: string;
  preview: string;
  timestamp: string;
  label?: string;
  labelTimestamp?: string;
  childCount: number;
  isOnActivePath: boolean;
  isCurrentLeaf: boolean;
  children: never[];
}

export interface ConversationTreeDto {
  ok: true;
  sessionId: string;
  leafId: string | null;
  activePathIds: string[];
  entryCount: number;
  branchPointCount: number;
  nodes: TreeNodeDto[];
}

export interface SlashCommandDto {
  name: string;
  description?: string;
  source: "web" | "extension" | "prompt" | "skill";
  sourceInfo?: JsonValue;
}

export interface SessionInfoDto {
  id: string;
  /** Pi-only history path; omitted for native sessions. */
  path?: string;
  harnessId?: HarnessId;
  nativeSession?: NativeSessionRefDto;
  name?: string;
  firstMessage?: string;
  created: string;
  modified: string;
  /** Exact for live sessions; omitted for cold sessions because deriving it requires a transcript parse. */
  messageCount?: number;
  cwd: string;
  isCurrent: false;
}

export type PromptProvenanceSourceKind = "system-prompt" | "context-file" | "skill" | "tool" | "append-prompt" | "pi-web" | "unknown";
export type PromptProvenanceConfidence = "exact" | "derived" | "unknown";

export interface PromptProvenanceSpanDto {
  /** UTF-16 code-unit offsets, matching JavaScript String#slice and browser selections. */
  start: number;
  end: number;
  source: { kind: PromptProvenanceSourceKind; label: string; path?: string };
  confidence: PromptProvenanceConfidence;
}

export interface PromptProvenanceDto {
  encoding: "utf-16";
  spans: PromptProvenanceSpanDto[];
  coverage: { exact: number; derived: number; unknown: number; total: number };
}

export interface SessionContextDto {
  sessionId: string;
  systemPrompt: string;
  provenance: PromptProvenanceDto;
  capturedAt: string;
  tools: {
    activeNames: string[];
    configured: Array<{ name: string; description?: string; sourceInfo?: JsonValue; callCount: number }>;
    callsByName: Record<string, number>;
  };
  resources: {
    skills: Array<{ name: string; description?: string; filePath?: string; disableModelInvocation?: boolean; sourceInfo?: JsonValue }>;
    extensions: Array<{ path: string; resolvedPath?: string; hidden?: boolean; sourceInfo?: JsonValue; contributions: { tools: number; commands: number; handlers: number; renderers: number; flags: number; shortcuts: number } }>;
    contextFiles: string[];
    systemPromptSource?: string;
    appendSystemPromptSources: string[];
    diagnostics: JsonValue[];
  };
}

export interface ModelsResultDto {
  cwd: string;
  current?: ModelDto;
  thinkingLevel: string;
  thinkingLevels: string[];
  models: ModelDto[];
}

export interface InteractionChoiceDto {
  id: string;
  label: string;
  /** Display semantics only. The adapter maps the opaque ID to an exact native response. */
  meaning: "accept" | "decline" | "cancel" | "submit";
  scope?: string;
}

export interface InteractionQuestionDto {
  id: string;
  label: string;
  description?: string;
  options?: Array<{ id: string; label: string }>;
  multiple?: boolean;
  required?: boolean;
  allowFreeText?: boolean;
}

export interface InteractionRequestDto {
  id: string;
  source: "extension" | "approval" | "clarify" | "sudo" | "secret";
  kind: string;
  payload: { [key: string]: JsonValue };
  sessionId: string;
  sessionFile?: string;
  timeout: number;
  title?: string;
  body?: string;
  choices?: InteractionChoiceDto[];
  questions?: InteractionQuestionDto[];
  expiresAt?: string;
}

export interface InteractionResponseDto {
  id: string;
  /** Required by native adapters; optional only for legacy Pi extension responses. */
  sessionId?: string;
  choiceID?: string;
  answers?: Record<string, string | string[]>;
  cancelled?: boolean;
  [key: string]: JsonValue | undefined;
}

export interface PromptInputDto {
  message: string;
  mode: string;
  /** Required for native steering when supported; the browser targets the observed host guard. */
  expectedExecutionId?: string;
  attachments: AttachmentDto[];
  clientMessageId?: string;
  sourceClientId?: string;
}

export interface PromptReceiptDto {
  sessionId: string;
  executionId: string;
  /** A receipt records dispatch; only a native acknowledgement can say accepted. */
  acknowledgement: "pending" | "accepted" | "not-exposed";
  nativeExecutionId?: string;
}

export interface InterruptReceiptDto {
  sessionId: string;
  executionId: string;
  nativeExecutionId?: string;
  /** Command acknowledgement is not settlement or idle. */
  acknowledged: true;
  stillQueued?: boolean;
}

export interface DeleteSessionResultDto {
  id: string;
  disposition: "trashed" | "deleted";
}

export type SessionServiceEvent =
  | TranscriptEventDto
  | { type: "interaction_resolved"; sessionId: string; id: string; reason: "responded" | "expired" | "cancelled" | "native" | "disposed" }
  /** Legacy Pi events are retained for Pi-only presentation and extension fidelity. */
  | { type: "agent"; sessionId: string; sessionFile: string; event: HarnessEventDto; clientMessageId?: string; sourceClientId?: string }
  | { type: "interaction"; request: InteractionRequestDto }
  | { type: "settlement_dependencies"; sessionId: string; childIds: string[] }
  | { type: "entry"; sessionId: string; sessionFile: string; entryId: string; parentId?: string; entryKind: string }
  | { type: "state"; state: BaseSessionStateDto; includeThinkingLevels?: boolean }
  | { type: "committed"; sessionId: string; sessionFile: string; message: MessageDto }
  | { type: "stats"; sessionId: string; sessionFile: string; stats: SessionStatsDto }
  | { type: "models"; sessionId: string; models: ModelDto[] }
  | { type: "error"; sessionId?: string; sessionFile?: string; error: string; clientMessageId?: string }
  | { type: "shutdown"; sessionId: string; sessionFile: string; sessionKey: string }
  | { type: "runtime"; sessionId: string; sessionFile: string; activitySessionFile?: string; action: "ensure" | "clear" | "changed" | "completed"; aborted?: boolean }
  | { type: "wire"; value: JsonValue };

export type NavigationResult = {
  state: BaseSessionStateDto;
  [key: string]: unknown;
};

export interface SessionService {
  state(sessionId: string): Promise<BaseSessionStateDto>;
  context(sessionId: string): Promise<SessionContextDto>;
  stats(sessionId: string): Promise<{ sessionId: string; stats: SessionStatsDto }>;
  tree(sessionId: string): Promise<ConversationTreeDto>;
  messages(sessionId: string): Promise<MessageDto[]>;
  /** Read bounded saved text without opening or mutating a session runtime. */
  readSession(reference: import("../shared/sessionReference.js").SessionReference, tail: number): Promise<import("./referenceTools.js").SessionReadResult>;
  commands(sessionId: string): Promise<SlashCommandDto[]>;
  models(sessionId: string): Promise<ModelsResultDto>;
  setModel(sessionId: string, provider: string, id: string, thinkingLevel?: string): Promise<BaseSessionStateDto>;
  executeShell(sessionId: string, command: string, excludeFromContext: boolean): Promise<Record<string, JsonValue | undefined>>;
  executeCommand(sessionId: string, command: string): Promise<{ message: string; state: BaseSessionStateDto }>;
  prompt(sessionId: string, input: PromptInputDto): Promise<{ sessionId: string } & Partial<PromptReceiptDto>>;
  retry(sessionId: string): Promise<{ sessionId: string }>;
  abort(sessionId: string, expectedExecutionId?: string): Promise<{ sessionId: string } & Partial<InterruptReceiptDto>>;
  abortCompaction(sessionId: string): Promise<{ sessionId: string }>;
  abortBranchSummary(sessionId: string): Promise<{ sessionId: string }>;
  rename(sessionId: string, name: string): Promise<BaseSessionStateDto>;
  navigate(sessionId: string, targetId: string, options: Record<string, unknown>): Promise<NavigationResult>;
  respondInteraction(response: InteractionResponseDto): boolean;
  cancelInteractions(): void;
  invokeContribution(sessionId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  invokeHeaderAction(sessionId: string, key: unknown): Promise<Record<string, unknown>>;
  invokeArtifactAction(sessionId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  invokeGitTab(sessionId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  invokePanel(sessionId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  list(extraCwds?: string[]): Promise<SessionInfoDto[]>;
  create(previousSessionId: string | undefined, cwd?: string, harnessId?: HarnessId): Promise<BaseSessionStateDto>;
  open(sessionId: string, cwd?: string): Promise<BaseSessionStateDto>;
  delete(sessionId: string, cwd?: string): Promise<DeleteSessionResultDto>;
  switchCwd(sessionId: string, cwd: string): Promise<BaseSessionStateDto>;
  subscribe(listener: (event: SessionServiceEvent) => void): () => void;
}

export function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
