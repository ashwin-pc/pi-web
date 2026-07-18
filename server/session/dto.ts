export interface SimplifiedModelDTO {
  provider: unknown;
  id: unknown;
  name: unknown;
  reasoning: boolean;
  contextWindow: unknown;
  maxTokens: unknown;
}

export interface MessageEntryRefDTO {
  entryId?: string;
}

export interface SimplifiedToolCallDTO {
  id: unknown;
  toolName: unknown;
  args: unknown;
  startedAt: unknown;
}

export interface SimplifiedMessageDTO {
  entryId?: string;
  role: unknown;
  text?: string;
  toolCalls?: SimplifiedToolCallDTO[];
  isError?: boolean;
  timestamp?: unknown;
  raw: Record<string, unknown>;
  command?: unknown;
  output?: unknown;
  exitCode?: unknown;
  cancelled?: boolean;
  truncated?: boolean;
  fullOutputPath?: unknown;
  excludeFromContext?: boolean;
  toolCallId?: unknown;
  toolName?: unknown;
  toolArgs?: Record<string, unknown>;
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
  contextUsage: unknown;
}

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

export interface SessionStateDTO extends Omit<SessionStateProjectionInput, "model"> {
  model: SimplifiedModelDTO | undefined;
}
