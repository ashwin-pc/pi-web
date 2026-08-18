export interface PiWebModel {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

export interface PiWebSession {
  sessionId: string;
  sessionFile: string;
  isStreaming: boolean;
  isRetrying?: boolean;
  isCompacting?: boolean;
  pendingMessageCount?: number;
  model: PiWebModel;
  thinkingLevel: string;
  readonly systemPrompt: string;
  messages: unknown[];
  agent: { state: { messages: unknown[] } };
  sessionName?: string;
  sessionManager: {
    newSession(): void;
    setSessionFile?(path: string): void;
    buildSessionContext(): { messages: unknown[] };
    getSessionName?(): string | undefined;
    getSessionDir?(): string;
    getLeafId?(): string | null;
    getEntry?(id: string): unknown;
    getBranch?(fromId?: string): unknown[];
    getTree?(): unknown[];
    getLabel?(id: string): string | undefined;
    branch?(entryId: string): void;
    resetLeaf?(): void;
    appendLabelChange?(targetId: string, label: string | undefined): string;
  };
  modelRuntime: {
    getAvailableSnapshot(): readonly PiWebModel[];
    getModel(provider: string, id: string): PiWebModel | undefined;
  };
  extensionRunner?: {
    getRegisteredCommands?(): unknown[];
  };
  promptTemplates?: unknown[];
  resourceLoader?: {
    getPrompts?(): { prompts: unknown[]; diagnostics?: unknown[] };
    getSkills?(): { skills: unknown[]; diagnostics?: unknown[] };
    getExtensions?(): { extensions: unknown[]; errors: unknown[] };
    getAgentsFiles?(): { agentsFiles: Array<{ path: string; content: string }> };
    getSystemPrompt?(): string | undefined;
    getSystemPromptSource?(): { path: string } | undefined;
    getAppendSystemPrompt?(): string[];
    getAppendSystemPromptSources?(): Array<{ path: string }>;
    getStatus?(): { errors?: unknown[] };
  };
  getActiveToolNames?(): string[];
  getAllTools?(): Array<{ name?: string; description?: string; promptGuidelines?: string[]; sourceInfo?: unknown; definition?: { name?: string; description?: string; promptGuidelines?: string[] } }>;
  bindExtensions?(bindings: unknown): Promise<void>;
  getAvailableThinkingLevels(): string[];
  getSessionName?(): string | undefined;
  getContextUsage?(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  setSessionName?(name: string): void;
  setModel(model: unknown): Promise<void>;
  setThinkingLevel(level: string): void;
  reload?(): Promise<void>;
  navigateTree?(targetId: string, options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string }): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: unknown }>;
  abortBranchSummary?(): void;
  compact?(customInstructions?: string): Promise<unknown>;
  abortCompaction?(): void;
  executeBash?(command: string, onChunk?: (chunk: string) => void, options?: { excludeFromContext?: boolean; operations?: unknown }): Promise<{ output: string; exitCode: number | undefined; cancelled: boolean; truncated: boolean; fullOutputPath?: string }>;
  prompt(message: string, options?: { images?: unknown[]; streamingBehavior?: string }): Promise<void>;
  retryFromFailure?(): Promise<void>;
  abort(): Promise<void>;
  clearQueue?(): void;
  getSteeringMessages?(): readonly string[];
  getFollowUpMessages?(): readonly string[];
  subscribe?(listener: (event: unknown) => void): (() => void) | undefined;
}

export interface PiWebSessionInfo {
  id: string;
  path: string;
  name: string;
  firstMessage: string;
  created: Date;
  modified: Date;
  messageCount: number;
  allMessagesText: string;
  cwd: string;
}
