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
  cost: number;
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
}

export interface BaseSessionStateDto {
  cwd: string;
  sessionFile: string;
  sessionId: string;
  sessionName?: string;
  sessionTitle: string;
  isStreaming: boolean;
  isRetrying: boolean;
  isCompacting: boolean;
  queue: { steering: string[]; followUp: string[] };
  model?: ModelDto;
  thinkingLevel: string;
  thinkingLevels: string[];
  stats: SessionStatsDto;
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
};

type MessageDtoBase = {
  entryId?: string;
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
  path: string;
  name?: string;
  firstMessage?: string;
  created: string;
  modified: string;
  /** Exact for live sessions; omitted for cold sessions because deriving it requires a transcript parse. */
  messageCount?: number;
  cwd: string;
  isCurrent: false;
}

export interface ModelsResultDto {
  cwd: string;
  current?: ModelDto;
  thinkingLevel: string;
  thinkingLevels: string[];
  models: ModelDto[];
}

export interface DeleteSessionResultDto {
  id: string;
  disposition: "trashed" | "deleted";
}

export type SessionServiceEvent =
  | { type: "pi"; sessionId: string; sessionFile: string; event: JsonValue; clientMessageId?: string; sourceClientId?: string }
  | { type: "state"; state: BaseSessionStateDto; includeThinkingLevels?: boolean }
  | { type: "committed"; sessionId: string; sessionFile: string; message: MessageDto }
  | { type: "stats"; sessionId: string; sessionFile: string; stats: SessionStatsDto }
  | { type: "models"; sessionId: string; models: ModelDto[] }
  | { type: "error"; sessionId?: string; sessionFile?: string; error: string; clientMessageId?: string }
  | { type: "shutdown"; sessionId: string; sessionFile: string; sessionKey: string }
  | { type: "runtime"; sessionId: string; sessionFile: string; activitySessionFile?: string; action: "ensure" | "clear" | "changed" | "completed" }
  | { type: "wire"; value: JsonValue };

/**
 * Navigation has one serving-side finalizer. `finish` is intentionally not
 * serializable: a remote runner returns the data first and its serving adapter
 * finalizes only after writing that data to its own transport.
 */
export type NavigationResult = {
  state: BaseSessionStateDto;
  finish(): void;
  [key: string]: unknown;
};

export interface SessionService {
  state(sessionId: string): Promise<BaseSessionStateDto>;
  stats(sessionId: string): Promise<{ sessionId: string; stats: SessionStatsDto }>;
  tree(sessionId: string): Promise<ConversationTreeDto>;
  messages(sessionId: string): Promise<MessageDto[]>;
  commands(sessionId: string): Promise<SlashCommandDto[]>;
  models(sessionId: string): Promise<ModelsResultDto>;
  setModel(sessionId: string, provider: string, id: string, thinkingLevel?: string): Promise<BaseSessionStateDto>;
  executeShell(sessionId: string, command: string, excludeFromContext: boolean): Promise<Record<string, JsonValue | undefined>>;
  executeCommand(sessionId: string, command: string): Promise<{ message: string; state: BaseSessionStateDto }>;
  prompt(sessionId: string, input: { message: string; mode: string; attachments: AttachmentDto[]; clientMessageId?: string; sourceClientId?: string }): Promise<{ sessionId: string }>;
  retry(sessionId: string): Promise<{ sessionId: string }>;
  abort(sessionId: string): Promise<{ sessionId: string }>;
  abortCompaction(sessionId: string): Promise<{ sessionId: string }>;
  abortBranchSummary(sessionId: string): Promise<{ sessionId: string }>;
  rename(sessionId: string, name: string): Promise<BaseSessionStateDto>;
  navigate(sessionId: string, targetId: string, options: Record<string, unknown>): Promise<NavigationResult>;
  invokeContribution(sessionId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  invokeHeaderAction(sessionId: string, key: unknown): Promise<Record<string, unknown>>;
  invokeArtifactAction(sessionId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  invokeGitTab(sessionId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  invokePanel(sessionId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  list(extraCwds?: string[]): Promise<SessionInfoDto[]>;
  create(previousSessionId: string | undefined, cwd?: string): Promise<BaseSessionStateDto>;
  open(sessionId: string, cwd?: string): Promise<BaseSessionStateDto>;
  delete(sessionId: string, cwd?: string): Promise<DeleteSessionResultDto>;
  switchCwd(sessionId: string, cwd: string): Promise<BaseSessionStateDto>;
  subscribe(listener: (event: SessionServiceEvent) => void): () => void;
}

export function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
