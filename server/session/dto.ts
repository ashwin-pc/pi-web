/** Values that can cross a SessionService process boundary without adaptation. */
export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

/** Browser projection of a model already simplified from the pi runtime. */
export interface SimplifiedModelDTO {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

/** Lossless, box-local model fact carried by the transport protocol. */
export interface SessionModelDTO {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number | null;
  maxTokens: number | null;
  metadata: JsonObject;
}

export interface MessageEntryRefDTO {
  entryId?: string;
}

export interface SimplifiedToolCallDTO {
  id?: JsonValue;
  toolName?: JsonValue;
  args: JsonValue;
  startedAt?: JsonValue;
}

/** Existing browser message projection, including host-decorated tool timestamps. */
export interface SimplifiedMessageDTO {
  entryId?: string;
  role?: JsonValue;
  text?: string;
  toolCalls?: SimplifiedToolCallDTO[];
  isError?: boolean;
  timestamp?: JsonValue;
  raw: JsonObject;
  command?: JsonValue;
  output?: JsonValue;
  exitCode?: JsonValue;
  cancelled?: boolean;
  truncated?: boolean;
  fullOutputPath?: JsonValue;
  excludeFromContext?: boolean;
  toolCallId?: JsonValue;
  toolName?: JsonValue;
  toolArgs?: JsonObject;
}

/** Raw box-local message fact. The host derives activity decoration from pi events. */
export interface SessionMessageFactDTO {
  entryId: string | null;
  role: string;
  content: JsonValue;
  timestamp: string | null;
  attributes: JsonObject;
}

export interface ConversationTreeNodeDTO {
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

export interface ConversationTreeDTO {
  ok: true;
  sessionId: string;
  leafId: string | null;
  activePathIds: string[];
  entryCount: number;
  branchPointCount: number;
  nodes: ConversationTreeNodeDTO[];
}

export interface SessionStatsDTO {
  userMessages: number;
  assistantMessages: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  contextUsage?: JsonValue;
}

/** JSON-only stats fact carried by the transport protocol. */
export interface SessionStatsFactDTO {
  userMessages: number;
  assistantMessages: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  contextUsage: JsonValue | null;
}

/** Raw facts from the box. It deliberately has no activity timestamps. */
export interface SessionRuntimeFactDTO {
  loaded: boolean;
  isRunning: boolean;
  isStreaming: boolean;
  isRetrying: boolean;
  isCompacting: boolean;
  pendingMessageCount: number;
  model: SessionModelDTO | null;
}

/** Raw box-local session facts. The host decorates these into WebState. */
export interface SessionStateFactDTO {
  cwd: string;
  sessionFile: string;
  sessionId: string;
  sessionName: string | null;
  sessionTitle: string;
  isStreaming: boolean;
  isRetrying: boolean;
  isCompacting: boolean;
  runtime: SessionRuntimeFactDTO;
  model: SessionModelDTO | null;
  thinkingLevel: string;
  stats: SessionStatsFactDTO;
  webFooters: JsonValue;
  webHeaderActions: JsonValue;
  webGitTabs: JsonValue;
}

/** Browser-only runtime projection. The host adds timestamps from pi events. */
export interface WebSessionRuntimeDTO {
  loaded: boolean;
  isRunning: boolean;
  isStreaming: boolean;
  isRetrying: boolean;
  isCompacting: boolean;
  startedAt?: string;
  lastActivityAt?: string;
  pendingMessageCount: number;
  model?: SimplifiedModelDTO;
}

/** Internal projection input may be sourced from the pi runtime. */
export interface SessionStateProjectionInput {
  cwd: string;
  sessionFile: string;
  sessionId: string;
  sessionName: string | undefined;
  sessionTitle: string;
  isStreaming: unknown;
  isRetrying: boolean;
  isCompacting: boolean;
  runtimeStartedAt: string | undefined;
  runtimeLastActivityAt: string | undefined;
  runtime: unknown;
  model: unknown;
  thinkingLevel: unknown;
  stats: SessionStatsDTO;
  webFooters: unknown;
  webHeaderActions: unknown;
  webGitTabs: unknown;
}

/** Existing browser WebState projection; not the SessionService transport state. */
export interface WebSessionStateDTO {
  cwd: string;
  sessionFile: string;
  sessionId: string;
  sessionName?: string;
  sessionTitle: string;
  isStreaming: boolean;
  isRetrying: boolean;
  isCompacting: boolean;
  runtimeStartedAt?: string;
  runtimeLastActivityAt?: string;
  runtime: WebSessionRuntimeDTO;
  model?: SimplifiedModelDTO;
  thinkingLevel: string;
  stats: SessionStatsDTO;
  webFooters: JsonValue;
  webHeaderActions: JsonValue;
  webGitTabs: JsonValue;
}

/** Backwards-compatible name used by the current browser projection. */
export type SessionStateDTO = WebSessionStateDTO;
