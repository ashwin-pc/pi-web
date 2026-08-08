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

export type PiWebEffect =
  | { type: "open-panel"; key: string };

export type PiWebContributionEvent = {
  action?: string;
  payload?: unknown;
  fields?: Record<string, string | string[]>;
  context?: Record<string, unknown>;
};

export type PiWebContributionView = {
  title?: string;
  html?: string;
  markdown?: string;
  message?: string;
  composerContext?: PiWebComposerContext;
  download?: { filename?: string };
  effects?: PiWebEffect[];
};

export type PiWebContribution =
  | { slot: "footer"; kind: "static"; view: PiWebFooter }
  | { slot: "fab"; kind: "static"; title: string; label?: string; icon?: string; opens: string }
  | {
      slot: "header-action" | "artifact-action" | "git-tab" | "panel";
      kind: "rendered";
      title: string;
      label?: string;
      icon?: string;
      match?: { kinds?: PiWebArtifactContext["kind"][]; extensions?: string[] };
      render: (event?: PiWebContributionEvent) => PiWebContributionView | Promise<PiWebContributionView>;
    };

export type PiWebHeaderActionResult = {
  /** Markdown rendered in the shared dismissible popover. */
  markdown?: string;
  /** Typed host side effects, applied after a successful invocation. */
  effects?: PiWebEffect[];
};

export type PiWebHeaderAction = {
  icon?: string;
  title: string;
  label?: string;
  invoke: () => Promise<PiWebHeaderActionResult> | PiWebHeaderActionResult;
};

export type PiWebArtifactContext = {
  name: string;
  path: string;
  kind: "markdown" | "html" | "video";
};

export type PiWebArtifactAction = {
  title: string;
  label?: string;
  /** Limit the action to these preview kinds. Omit to match every kind. */
  kinds?: PiWebArtifactContext["kind"][];
  /** Limit the action to filenames ending in one of these extensions (for example, ".html"). */
  extensions?: string[];
  invoke: (artifact: PiWebArtifactContext) => Promise<PiWebArtifactActionResult> | PiWebArtifactActionResult;
};

export type PiWebArtifactActionResult = {
  markdown?: string;
  message?: string;
  /** Download the current artifact in the browser, optionally with a different filename. */
  download?: { filename?: string };
};

export type PiWebGitTabEvent = {
  action?: string;
  payload?: unknown;
  repo?: {
    path?: string;
    root?: string;
    branch?: string;
  };
};

export type PiWebComposerContext = {
  type: "reference";
  /** Stable identity used to avoid adding the same reference more than once. */
  id: string;
  /** Short source label shown in the composer attachment pill. */
  label: string;
  /** Optional detail shown alongside the label, such as an issue title. */
  title?: string;
  /** Structured pointer included in the transcript; content is resolved by agent tools. */
  reference: {
    provider: "github";
    repository: string;
    resource: "issue" | "pull-request";
    number: number;
    url: string;
  };
};

export type PiWebGitTabView = {
  title?: string;
  /** Omit HTML for actions that only add composer context and keep the current tab view. */
  html?: string;
  composerContext?: PiWebComposerContext;
};

export type PiWebGitTab = {
  title: string;
  label?: string;
  render: (event?: PiWebGitTabEvent) => Promise<PiWebGitTabView> | PiWebGitTabView;
};

export type PiWebPanelEvent = {
  /** Action declared by data-web-action on a form or interactive element. */
  action?: string;
  /** Optional JSON declared by data-web-payload. */
  payload?: unknown;
  /** Successful form controls, grouped by name. */
  fields?: Record<string, string | string[]>;
};

export type PiWebPanelView = {
  title?: string;
  /** Trusted extension-provided HTML rendered in the shared right panel. */
  html: string;
};

export type PiWebPanel = {
  title: string;
  label?: string;
  /** lucide icon name; unsupported names fall back to square-pen. */
  icon?: string;
  render: (event?: PiWebPanelEvent) => Promise<PiWebPanelView> | PiWebPanelView;
};

export type PiWebFabAction = {
  /** lucide icon name; unsupported names fall back to square-pen. */
  icon?: string;
  title: string;
  label?: string;
  /** Key of the panel surface (setPanel) this launcher opens. */
  opens: string;
};

// --- Extension-contributed settings (generic platform) ---

export type PiWebFieldType = "toggle" | "text" | "textarea" | "number" | "select" | "list";

export type PiWebSelectOption = { value: string; label?: string };

export type PiWebFieldDescriptor = {
  key: string;
  type: PiWebFieldType;
  label: string;
  description?: string;
  default?: unknown;
  required?: boolean;
  /** number */
  min?: number;
  max?: number;
  /** text / textarea */
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  /** select */
  options?: PiWebSelectOption[];
  optionsSource?: "models";
  optionsFromField?: string; // "<listKey>.<itemKey>"
  /** list (repeater) */
  itemFields?: PiWebFieldDescriptor[];
  minItems?: number;
  maxItems?: number;
  uniqueCaseInsensitive?: boolean;
};

export type PiWebSettingsSchema = {
  id: string; // namespaced owner id: <extension>.<schema>
  title: string;
  schemaVersion: number;
  fields: PiWebFieldDescriptor[];
};

export type PiWebStoredSettings = { schemaVersion: number; values: Record<string, unknown> };

export type PiWebSettingsRegistration = PiWebSettingsSchema & {
  /** Run when stored.schemaVersion < schemaVersion. Return migrated values. */
  migrate?: (
    oldValues: Record<string, unknown>,
    oldVersion: number,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Called after a persisted change (this owner only), with the new values. */
  /**
   * Called after a persisted change to this owner's values. Every live
   * registrant is notified with its own callback; `info.sessionId` identifies
   * which session's registration is being notified.
   */
  onChange?: (values: Record<string, unknown>, info: { sessionId: string }) => void;
};

export type PiWebRegisterSettingsResult = {
  registered: boolean;
  migrated: boolean;
  usedBackup: boolean;
  error?: string;
};

export type PiWebCapabilities = Readonly<{
  apiVersion: 1;
  slots: readonly string[];
  kinds: readonly string[];
  effects: readonly string[];
}>;

export type PiWebUi = {
  /** Runtime feature discovery for independently distributed extensions. */
  readonly capabilities: PiWebCapabilities;

  /** Register or clear a normalized browser contribution. */
  contribute(key: string, contribution: PiWebContribution | undefined): void;

  /** Notify the active host that a rendered contribution should be pulled again. */
  update(key: string): void;

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

  /** Set or clear an action shown on matching inline artifact preview cards. */
  setArtifactAction(key: string, action: PiWebArtifactAction | undefined): void;

  /** Set or clear a provider-specific tab in the built-in Git panel. */
  setGitTab(key: string, tab: PiWebGitTab | undefined): void;

  /**
   * Set or clear an extension panel surface (shared right panel). Panels have
   * NO implicit entry point: register a FAB launcher with setFabAction, open
   * from a header action via an `open-panel` effect, or any future affordance.
   */
  setPanel(key: string, panel: PiWebPanel | undefined): void;

  /** Set or clear a mascot-FAB launcher entry that opens a registered panel. */
  setFabAction(key: string, action: PiWebFabAction | undefined): void;

  /**
   * Register a settings schema contributed by this extension. Idempotent per
   * session (re-registering the same canonical schema just refreshes callbacks).
   * Awaits any schema-version migration. Values persist globally and outlive the
   * session; the live registration is torn down on session shutdown.
   */
  registerSettings(schema: PiWebSettingsRegistration): Promise<PiWebRegisterSettingsResult>;

  /** Read this owner's persisted settings (defaults if unset). */
  getSettings(id: string): Promise<PiWebStoredSettings>;
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
