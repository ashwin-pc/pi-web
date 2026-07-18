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

export interface MessageDto {
  entryId?: string;
  role?: string;
  text?: string;
  toolCalls?: Array<{ id?: string; toolName: string; args: JsonValue; startedAt?: string }>;
  toolCallId?: string;
  toolName?: string;
  toolArgs?: JsonValue;
  isError?: boolean;
  timestamp?: string;
  raw?: JsonValue;
  [key: string]: JsonValue | undefined;
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

export interface SessionInfoDto {
  id: string;
  name?: string;
  firstMessage?: string;
  created: string;
  modified: string;
  messageCount: number;
  cwd: string;
}

export interface SessionRefDto { sessionId: string; sessionFile: string; cwd: string }
export interface CreateSessionResultDto extends SessionRefDto { state: BaseSessionStateDto; previousSessionFile?: string }
export interface DeleteSessionResultDto { id: string; disposition: "trashed" | "deleted" }
export interface NavigateTreeResultDto { cancelled: boolean; aborted?: boolean; editorText?: string; summaryEntry?: JsonValue; leafId: string | null; state: BaseSessionStateDto }
export interface ShellResultDto { output: string; exitCode?: number; cancelled: boolean; truncated: boolean; fullOutputPath?: string }
export interface ArtifactDto { name: string; base64: string }
export interface GitImageDto { path: string; base64: string }
export interface DirectoryListingDto { path: string; parent: string; dirs: Array<{ name: string; path: string }> }

export type SessionServiceEvent =
  | { type: "pi"; sessionId: string; sessionFile: string; event: JsonValue }
  | { type: "state"; state: BaseSessionStateDto }
  | { type: "stats"; sessionId: string; sessionFile: string; stats: SessionStatsDto }
  | { type: "models"; sessionId: string; models: ModelDto[] }
  | { type: "error"; sessionId?: string; sessionFile?: string; error: string }
  | { type: "shutdown"; sessionId: string; sessionFile: string }
  | { type: "extension-ui"; request: JsonValue }
  | { type: "footers"; sessionId: string; sessionFile: string; footers: JsonValue[] }
  | { type: "header-actions"; sessionId: string; sessionFile: string; actions: JsonValue[] }
  | { type: "git-tabs"; sessionId: string; sessionFile: string; tabs: JsonValue[] };

export interface SessionService {
  create(cwd?: string, previousSessionFile?: string): Promise<CreateSessionResultDto>;
  open(sessionId: string, cwd?: string): Promise<BaseSessionStateDto>;
  delete(sessionId: string, cwd?: string): Promise<DeleteSessionResultDto>;
  list(extraCwds?: string[]): Promise<SessionInfoDto[]>;
  switchCwd(sessionId: string, cwd: string): Promise<CreateSessionResultDto>;
  state(sessionId: string): Promise<BaseSessionStateDto>;
  messages(sessionId: string): Promise<MessageDto[]>;
  stats(sessionId: string): Promise<SessionStatsDto>;
  tree(sessionId: string): Promise<ConversationTreeDto>;
  commands(sessionId: string): Promise<SlashCommandDto[]>;
  models(sessionId: string): Promise<{ cwd: string; current?: ModelDto; thinkingLevel: string; thinkingLevels: string[]; models: ModelDto[] }>;
  prompt(sessionId: string, text: string, images: Array<{ data: string; mimeType: string; name?: string }>, mode: "followUp" | "steer"): Promise<void>;
  abort(sessionId: string): Promise<void>;
  abortCompaction(sessionId: string): Promise<void>;
  retry(sessionId: string): Promise<void>;
  rename(sessionId: string, name: string): Promise<BaseSessionStateDto>;
  setModel(sessionId: string, provider: string, id: string, thinkingLevel?: string): Promise<BaseSessionStateDto>;
  executeCommand(sessionId: string, command: string): Promise<{ message?: string; state: BaseSessionStateDto }>;
  executeShell(sessionId: string, command: string, excludeFromContext: boolean): Promise<ShellResultDto>;
  navigateTree(sessionId: string, targetId: string, options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string }): Promise<NavigateTreeResultDto>;
  abortBranchSummary(sessionId: string): Promise<void>;
  respondExtensionUi(id: string, response: JsonValue): void;
  invokeHeaderAction(sessionId: string, key: string): Promise<{ label: string; markdown: string }>;
  invokeGitTab(sessionId: string, key: string, action: string, payload?: JsonValue): Promise<JsonValue>;
  acquireViewer(sessionId: string, clientId: string): void;
  releaseViewer(clientId: string): void;
  fs: {
    list(path: string): Promise<DirectoryListingDto>;
    mkdir(parent: string, name: string): Promise<DirectoryListingDto>;
  };
  git: {
    repos(cwd: string): Promise<JsonValue>;
    status(cwd: string, fetchRemote?: boolean): Promise<JsonValue>;
    log(cwd: string): Promise<JsonValue>;
    commit(cwd: string, hash: string): Promise<JsonValue>;
    diff(cwd: string, path: string, staged: boolean): Promise<JsonValue>;
    imageBase64(cwd: string, path: string, oldPath: string | undefined, version: string, staged: boolean): Promise<GitImageDto>;
    sync(cwd: string): Promise<JsonValue>;
  };
  artifacts: {
    read(cwd: string, name: string): Promise<ArtifactDto>;
    readBase64(cwd: string, name: string, maxBytes?: number): Promise<ArtifactDto>;
    write(cwd: string, name: string, base64: string): Promise<ArtifactDto>;
  };
  subscribe(listener: (event: SessionServiceEvent) => void): () => void;
}

export function jsonRoundTrip<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
