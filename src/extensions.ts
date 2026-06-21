import type {
  AgentEndEvent,
  AgentStartEvent,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  BeforeProviderRequestEvent,
  BeforeProviderRequestEventResult,
  ContextEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
  InputEvent,
  InputEventResult,
  RegisteredCommand,
  SessionBeforeCompactEvent,
  SessionBeforeForkEvent,
  SessionBeforeSwitchEvent,
  SessionBeforeTreeEvent,
  SessionCompactEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  SessionTreeEvent,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
  TurnEndEvent,
  TurnStartEvent,
  UserBashEvent,
  UserBashEventResult,
} from "@earendil-works/pi-coding-agent";

export type PiWebFooter =
  | string
  | string[]
  | { kind: "text"; lines: string[] }
  | { kind: "html"; html: string };

export type PiWebHeaderAction = {
  icon?: string;
  title: string;
  label?: string;
  invoke: () => Promise<{ markdown: string }> | { markdown: string };
};

export type PiWebUi = {
  /**
   * Set or clear a pi-web footer region.
   *
   * - string/string[] and { kind: "text" } render as plain text.
   * - { kind: "html" } renders as trusted extension-provided HTML.
   *
   * pi-web extensions run with full local trust, like regular pi extensions.
   * Only install pi-web extensions from sources you trust.
   */
  setFooter(key: string, footer: PiWebFooter | undefined): void;

  /** Set or clear a status-bar icon button contributed by a pi-web extension. */
  setHeaderAction(key: string, action: PiWebHeaderAction | undefined): void;
};

export type PiWebExtensionUIContext = ExtensionUIContext & {
  web: PiWebUi;
};

export interface PiWebExtensionContext extends ExtensionContext {
  ui: PiWebExtensionUIContext;
}

export interface PiWebExtensionCommandContext extends ExtensionCommandContext {
  ui: PiWebExtensionUIContext;
}

type PiWebExtensionHandler<E, R = undefined> = (event: E, ctx: PiWebExtensionContext) => Promise<R | void> | R | void;

type ContextEventResult = { messages?: unknown[] };
type MessageEndEventResult = { message?: unknown };
type ToolResultEventResult = { content?: unknown; details?: unknown; isError?: boolean };
type SessionBeforeSwitchResult = { cancel?: boolean };
type SessionBeforeForkResult = { cancel?: boolean; skipConversationRestore?: boolean };
type SessionBeforeCompactResult = { cancel?: boolean; compaction?: unknown };
type SessionBeforeTreeResult = { cancel?: boolean; summary?: unknown; customInstructions?: string; replaceInstructions?: boolean; label?: string };
type ResourcesDiscoverResult = { skillPaths?: string[]; promptPaths?: string[]; themePaths?: string[] };

type PiWebEventMap = {
  resources_discover: [any, ResourcesDiscoverResult];
  session_start: [SessionStartEvent, undefined];
  session_before_switch: [SessionBeforeSwitchEvent, SessionBeforeSwitchResult];
  session_before_fork: [SessionBeforeForkEvent, SessionBeforeForkResult];
  session_before_compact: [SessionBeforeCompactEvent, SessionBeforeCompactResult];
  session_compact: [SessionCompactEvent, undefined];
  session_shutdown: [SessionShutdownEvent, undefined];
  session_before_tree: [SessionBeforeTreeEvent, SessionBeforeTreeResult];
  session_tree: [SessionTreeEvent, undefined];
  context: [ContextEvent, ContextEventResult];
  before_provider_request: [BeforeProviderRequestEvent, BeforeProviderRequestEventResult];
  after_provider_response: [any, undefined];
  before_agent_start: [BeforeAgentStartEvent, BeforeAgentStartEventResult];
  agent_start: [AgentStartEvent, undefined];
  agent_end: [AgentEndEvent, undefined];
  turn_start: [TurnStartEvent, undefined];
  turn_end: [TurnEndEvent, undefined];
  message_start: [any, undefined];
  message_update: [any, undefined];
  message_end: [any, MessageEndEventResult];
  tool_execution_start: [any, undefined];
  tool_execution_update: [any, undefined];
  tool_execution_end: [any, undefined];
  model_select: [any, undefined];
  thinking_level_select: [any, undefined];
  tool_call: [ToolCallEvent, ToolCallEventResult];
  tool_result: [ToolResultEvent, ToolResultEventResult];
  user_bash: [UserBashEvent, UserBashEventResult];
  input: [InputEvent, InputEventResult];
};

type PiWebCommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo" | "handler"> & {
  handler: (args: string, ctx: PiWebExtensionCommandContext) => Promise<void> | void;
};

export type PiWebExtensionAPI = Omit<ExtensionAPI, "on" | "registerCommand"> & {
  on<K extends keyof PiWebEventMap>(event: K, handler: PiWebExtensionHandler<PiWebEventMap[K][0], PiWebEventMap[K][1]>): void;
  registerCommand(name: string, options: PiWebCommandOptions): void;
};
