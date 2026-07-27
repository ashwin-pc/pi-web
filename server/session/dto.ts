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
  model?: ModelDto;
  thinkingLevel: string;
  thinkingLevels: string[];
  stats: SessionStatsDto;
}

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

export type NavigationResult = Record<string, unknown> & { finish(): void };

export interface SessionService {
  defaultSessionId(): string;
  state(sessionId?: string): Promise<Record<string, unknown>>;
  stats(sessionId?: string): Promise<{ sessionId: string; stats: SessionStatsDto }>;
  tree(sessionId?: string): Promise<ConversationTreeDto>;
  messages(sessionId?: string): Promise<unknown[]>;
  commands(sessionId?: string): Promise<SlashCommandDto[]>;
  models(sessionId?: string): Promise<Record<string, unknown>>;
  setModel(sessionId: string | undefined, provider: string, id: string, thinkingLevel?: string): Promise<Record<string, unknown>>;
  executeShell(sessionId: string | undefined, command: string, excludeFromContext: boolean): Promise<Record<string, unknown>>;
  executeCommand(sessionId: string | undefined, command: string): Promise<Record<string, unknown>>;
  prompt(sessionId: string | undefined, input: { message: string; mode: string; images: Array<{ data: string; mimeType: string; name?: string }>; clientMessageId?: string; sourceClientId?: string }): Promise<{ sessionId: string }>;
  retry(sessionId?: string): Promise<{ sessionId: string }>;
  abort(sessionId?: string): Promise<{ sessionId: string }>;
  abortCompaction(sessionId?: string): Promise<{ sessionId: string }>;
  abortBranchSummary(sessionId?: string): Promise<{ sessionId: string }>;
  rename(sessionId: string | undefined, name: string): Promise<Record<string, unknown>>;
  navigate(sessionId: string | undefined, targetId: string, options: Record<string, unknown>): Promise<NavigationResult>;
  invokeHeaderAction(sessionId: string | undefined, key: unknown): Promise<Record<string, unknown>>;
  invokeGitTab(sessionId: string | undefined, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  list(extraCwds?: string[]): Promise<Array<{ id: string } & Record<string, unknown>>>;
  create(sessionId?: string, cwd?: string): Promise<Record<string, unknown>>;
  open(sessionId: string, cwd?: string): Promise<Record<string, unknown>>;
  delete(sessionId: string, cwd?: string): Promise<unknown>;
  switchCwd(sessionId: string | undefined, cwd: string): Promise<Record<string, unknown>>;
}

export function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
