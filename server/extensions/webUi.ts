import type { ExtensionUIDialogOptions, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { PiWebFooter, PiWebGitTab, PiWebGitTabEvent, PiWebHeaderAction, PiWebUi } from "../../src/extensions.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue | undefined };

export type ExtensionUiMethod = "select" | "confirm" | "input" | "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text" | "editor";

/** Serializable request emitted for browser adapters or future service transports. */
export interface ExtensionUiServiceEvent {
  type: "extension_ui_request";
  id: string;
  method: ExtensionUiMethod;
  sessionId: string;
  sessionFile: string;
  timeout?: number;
  [key: string]: JsonValue | undefined;
}

export interface ExtensionUiResponse {
  id: string;
  cancelled?: boolean;
  confirmed?: boolean;
  value?: JsonValue;
  [key: string]: JsonValue | undefined;
}

export interface WebUiSession {
  sessionId: string;
  sessionFile: string;
  agent: { waitForIdle(): Promise<unknown> };
  bindExtensions?(bindings: unknown): Promise<void>;
  navigateTree(targetId: string, options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string }): Promise<{ cancelled: boolean }>;
  reload?(): Promise<void>;
}

export interface WebUiHost {
  broadcast(value: unknown): void;
  emitExtensionUiEvent(event: ExtensionUiServiceEvent): void;
  clientCount(): number;
  acquireWorkLease(session: WebUiSession): () => void;
  sessionCwd(session: WebUiSession): string;
  createNewSession(cwd: string, previousSessionFile: string): Promise<WebUiSession>;
  currentStateWithThinkingLevels(session: WebUiSession): Record<string, unknown>;
}

export interface WebFooterProjection {
  key: string;
  footer: Exclude<PiWebFooter, string | string[]>;
}

export interface WebHeaderActionProjection {
  key: string;
  icon?: string;
  title: string;
  label?: string;
}

export interface WebGitTabProjection {
  key: string;
  title: string;
  label?: string;
}

type PendingExtensionUiRequest = {
  resolve: (response: ExtensionUiResponse) => void;
  cleanup: () => void;
};

type FooterState = { footers: Map<string, Exclude<PiWebFooter, string | string[]>> };
type HeaderActionState = { actions: Map<string, PiWebHeaderAction> };
type GitTabState = { tabs: Map<string, PiWebGitTab> };

const plainExtensionTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  inverse: (text: string) => text,
  strikethrough: (text: string) => text,
  getFgAnsi: () => "",
  getBgAnsi: () => "",
  getColorMode: () => "truecolor",
  getThinkingBorderColor: () => (text: string) => text,
  getBashModeBorderColor: () => (text: string) => text,
};

function cleanKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim().slice(0, 80).replace(/[^a-zA-Z0-9_.:-]/g, "-");
  return cleaned || undefined;
}

function cleanText(value: unknown, maxLength = 200): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001F\u007F]/g, "").trim();
  return cleaned ? cleaned.slice(0, maxLength) : undefined;
}

function cleanFooterText(value: unknown, maxLength = 2_000): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trimEnd();
  return cleaned ? cleaned.slice(0, maxLength) : undefined;
}

function normalizeTextLines(value: unknown): Exclude<PiWebFooter, string | string[]> | undefined {
  const rawLines = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const lines = rawLines.slice(0, 8).map((line) => cleanFooterText(line)).filter((line): line is string => Boolean(line));
  return lines.length ? { kind: "text", lines } : undefined;
}

function normalizeFooter(value: unknown): Exclude<PiWebFooter, string | string[]> | undefined {
  if (typeof value === "string" || Array.isArray(value)) return normalizeTextLines(value);
  if (!value || typeof value !== "object") return undefined;
  const footer = value as Record<string, unknown>;
  if (footer.kind === "text") return normalizeTextLines(footer.lines);
  if (footer.kind === "html") {
    const html = cleanFooterText(footer.html, 20_000);
    return html ? { kind: "html", html } : undefined;
  }
  return undefined;
}

function asResponse(value: unknown): ExtensionUiResponse | undefined {
  if (!value || typeof value !== "object") return undefined;
  const response = value as Record<string, JsonValue | undefined>;
  return typeof response.id === "string" && response.id.trim() ? response as ExtensionUiResponse : undefined;
}

export class WebUiExtensionService {
  private readonly pendingRequests = new Map<string, PendingExtensionUiRequest>();
  private readonly footerStates = new WeakMap<object, FooterState>();
  private readonly headerActionStates = new WeakMap<object, HeaderActionState>();
  private readonly gitTabStates = new WeakMap<object, GitTabState>();

  constructor(private readonly host: WebUiHost, private readonly createId: () => string) {}

  footerEntries(session: object): WebFooterProjection[] {
    return Array.from(this.footerState(session).footers, ([key, footer]) => ({ key, footer }));
  }

  headerActionEntries(session: object): WebHeaderActionProjection[] {
    return Array.from(this.headerActionState(session).actions, ([key, action]) => ({
      key,
      icon: cleanText(action.icon, 80),
      title: cleanText(action.title) || key,
      label: cleanText(action.label),
    }));
  }

  gitTabEntries(session: object): WebGitTabProjection[] {
    return Array.from(this.gitTabState(session).tabs, ([key, tab]) => ({
      key,
      title: cleanText(tab.title) || key,
      label: cleanText(tab.label, 80),
    }));
  }

  createPiWebUi(session: WebUiSession): PiWebUi {
    return {
      setFooter: (key, footer) => {
        const footerKey = cleanKey(key);
        if (!footerKey) return;
        const normalized = normalizeFooter(footer);
        if (normalized) this.footerState(session).footers.set(footerKey, normalized);
        else this.footerState(session).footers.delete(footerKey);
        this.host.broadcast({ type: "web_footer_changed", sessionId: session.sessionId, sessionFile: session.sessionFile, webFooters: this.footerEntries(session) });
      },
      setHeaderAction: (key, action) => {
        const actionKey = cleanKey(key);
        if (!actionKey) return;
        if (action && typeof action === "object" && typeof action.invoke === "function") this.headerActionState(session).actions.set(actionKey, action);
        else this.headerActionState(session).actions.delete(actionKey);
        this.host.broadcast({ type: "web_header_actions_changed", sessionId: session.sessionId, sessionFile: session.sessionFile, webHeaderActions: this.headerActionEntries(session) });
      },
      setGitTab: (key, tab) => {
        const tabKey = cleanKey(key);
        if (!tabKey) return;
        if (tab && typeof tab === "object" && typeof tab.render === "function") this.gitTabState(session).tabs.set(tabKey, tab);
        else this.gitTabState(session).tabs.delete(tabKey);
        this.host.broadcast({ type: "web_git_tabs_changed", sessionId: session.sessionId, sessionFile: session.sessionFile, webGitTabs: this.gitTabEntries(session) });
      },
    };
  }

  respondExtensionUi(response: unknown): boolean {
    const parsed = asResponse(response);
    if (!parsed) return false;
    const pending = this.pendingRequests.get(parsed.id.trim());
    if (!pending) return false;
    pending.resolve(parsed);
    return true;
  }

  hasHeaderAction(session: object, key: string): boolean {
    return this.headerActionState(session).actions.has(key);
  }

  hasGitTab(session: object, key: string): boolean {
    return this.gitTabState(session).tabs.has(key);
  }

  async invokeHeaderAction(session: object, key: string): Promise<{ label: string; markdown: string } | undefined> {
    const action = this.headerActionState(session).actions.get(key);
    if (!action) return undefined;
    const result = await action.invoke();
    const markdown = cleanFooterText(result?.markdown, 200_000);
    if (!markdown) return undefined;
    return { label: cleanText(action.label) || cleanText(action.title) || key, markdown };
  }

  async invokeGitTab(session: object, key: string, event: PiWebGitTabEvent): Promise<{ title: string; html: string } | undefined> {
    const tab = this.gitTabState(session).tabs.get(key);
    if (!tab) return undefined;
    const result = await tab.render(event);
    const html = cleanFooterText(result?.html, 500_000);
    if (!html) return undefined;
    return { title: cleanText(result.title) || cleanText(tab.title) || key, html };
  }

  async bindWebExtensions(session: WebUiSession) {
    if (typeof session.bindExtensions !== "function") return;
    await session.bindExtensions({
      uiContext: this.createExtensionUiContext(session),
      commandContextActions: {
        waitForIdle: () => session.agent.waitForIdle(),
        newSession: async () => {
          const newSession = await this.host.createNewSession(this.host.sessionCwd(session), session.sessionFile);
          this.host.broadcast({ type: "state_changed", ...this.host.currentStateWithThinkingLevels(newSession) });
          return { cancelled: false };
        },
        fork: async () => {
          throw new Error("Extension-initiated fork is not supported in pi-web yet.");
        },
        navigateTree: async (targetId: string, options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string }) => {
          const result = await session.navigateTree(targetId, options);
          return { cancelled: Boolean(result.cancelled) };
        },
        switchSession: async () => {
          throw new Error("Extension-initiated session switching is not supported in pi-web yet.");
        },
        reload: async () => {
          await session.reload?.();
        },
      },
      shutdownHandler: () => {
        this.host.broadcast({ type: "server_error", sessionId: session.sessionId, sessionFile: session.sessionFile, error: "An extension requested shutdown; pi-web ignored the request." });
      },
      onError: (error: { extensionPath?: unknown; error?: unknown }) => {
        this.host.broadcast({ type: "server_error", sessionId: session.sessionId, sessionFile: session.sessionFile, error: `Extension error (${error.extensionPath}): ${error.error}` });
      },
    });
  }

  private createExtensionUiContext(session: WebUiSession): ExtensionUIContext & { web: PiWebUi } {
    return {
      web: this.createPiWebUi(session),
      select: (title, options, opts) => this.request(session, "select", { title, options: options as JsonValue }, opts, undefined, (response) => response.cancelled ? undefined : typeof response.value === "string" ? response.value : undefined),
      confirm: (title, message, opts) => this.request(session, "confirm", { title, message }, opts, false, (response) => response.cancelled ? false : Boolean(response.confirmed)),
      input: (title, placeholder, opts) => this.request(session, "input", { title, placeholder }, opts, undefined, (response) => response.cancelled ? undefined : typeof response.value === "string" ? response.value : undefined),
      notify: (message, type = "info") => this.emit(session, "notify", { message, notifyType: type }),
      onTerminalInput: () => () => undefined,
      setStatus: (key, text) => this.emit(session, "setStatus", { statusKey: key, statusText: text }),
      setWorkingMessage: () => undefined,
      setWorkingVisible: () => undefined,
      setWorkingIndicator: () => undefined,
      setHiddenThinkingLabel: () => undefined,
      setWidget: (key, content, options) => {
        if (content === undefined || Array.isArray(content)) this.emit(session, "setWidget", { widgetKey: key, widgetLines: content as JsonValue | undefined, widgetPlacement: options?.placement });
      },
      setFooter: () => undefined,
      setHeader: () => undefined,
      setTitle: (title) => this.emit(session, "setTitle", { title }),
      async custom() {
        return undefined as never;
      },
      pasteToEditor(text) {
        this.setEditorText(text);
      },
      setEditorText: (text) => this.emit(session, "set_editor_text", { text }),
      getEditorText: () => "",
      editor: (title, prefill) => this.request(session, "editor", { title, prefill }, undefined, undefined, (response) => response.cancelled ? undefined : typeof response.value === "string" ? response.value : undefined),
      addAutocompleteProvider: () => undefined,
      setEditorComponent: () => undefined,
      getEditorComponent: () => undefined,
      theme: plainExtensionTheme as unknown as ExtensionUIContext["theme"],
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "Theme switching is not supported in pi-web yet" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => undefined,
    };
  }

  private emit(session: WebUiSession, method: ExtensionUiMethod, fields: Record<string, JsonValue | undefined>) {
    this.host.emitExtensionUiEvent({ type: "extension_ui_request", id: this.createId(), method, sessionId: session.sessionId, sessionFile: session.sessionFile, ...fields });
  }

  private request<T>(session: WebUiSession, method: ExtensionUiMethod, fields: Record<string, JsonValue | undefined>, opts: ExtensionUIDialogOptions | undefined, defaultValue: T, parse: (response: ExtensionUiResponse) => T): Promise<T> {
    if (opts?.signal?.aborted || this.host.clientCount() === 0) return Promise.resolve(defaultValue);
    return new Promise<T>((resolvePromise) => {
      const id = this.createId();
      const releaseWorkLease = this.host.acquireWorkLease(session);
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        opts?.signal?.removeEventListener("abort", onAbort);
        this.pendingRequests.delete(id);
        releaseWorkLease();
      };
      const finish = (result: T) => {
        cleanup();
        resolvePromise(result);
      };
      const onAbort = () => finish(defaultValue);
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      if (opts?.timeout) timeoutId = setTimeout(() => finish(defaultValue), opts.timeout);
      this.pendingRequests.set(id, { cleanup, resolve: (response) => finish(parse(response)) });
      this.host.emitExtensionUiEvent({ type: "extension_ui_request", id, method, sessionId: session.sessionId, sessionFile: session.sessionFile, timeout: opts?.timeout, ...fields });
    });
  }

  private footerState(session: object): FooterState {
    let state = this.footerStates.get(session);
    if (!state) {
      state = { footers: new Map() };
      this.footerStates.set(session, state);
    }
    return state;
  }

  private headerActionState(session: object): HeaderActionState {
    let state = this.headerActionStates.get(session);
    if (!state) {
      state = { actions: new Map() };
      this.headerActionStates.set(session, state);
    }
    return state;
  }

  private gitTabState(session: object): GitTabState {
    let state = this.gitTabStates.get(session);
    if (!state) {
      state = { tabs: new Map() };
      this.gitTabStates.set(session, state);
    }
    return state;
  }
}

export function cleanWebUiKey(value: unknown): string | undefined {
  return cleanKey(value);
}
