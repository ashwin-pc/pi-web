import { randomUUID } from "node:crypto";
import type { ExtensionUIDialogOptions, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { PiWebFooter, PiWebGitTab, PiWebHeaderAction, PiWebUi } from "../../src/extensions.js";

export interface WebUiBridgeDependencies {
  emit(value: unknown): void;
  clientCount(): number;
  acquireWorkLease(session: any): () => void;
  createNewSession(cwd: string, previousSessionFile?: string): Promise<any>;
  sessionCwd(session: any): string;
  state(session: any): Record<string, unknown>;
}

export function createWebUiBridge(deps: WebUiBridgeDependencies) {
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

type PendingExtensionUiRequest = {
  resolve: (response: Record<string, unknown>) => void;
  cleanup: () => void;
};
const pendingExtensionUiRequests = new Map<string, PendingExtensionUiRequest>();

type WebFooterState = {
  footers: Map<string, PiWebFooter>;
};

type WebHeaderActionState = {
  actions: Map<string, PiWebHeaderAction>;
};

type WebGitTabState = {
  tabs: Map<string, PiWebGitTab>;
};

const webFooterStates = new WeakMap<object, WebFooterState>();
const webHeaderActionStates = new WeakMap<object, WebHeaderActionState>();
const webGitTabStates = new WeakMap<object, WebGitTabState>();

function getWebFooterState(value: any): WebFooterState {
  const key = value as object;
  let state = webFooterStates.get(key);
  if (!state) {
    state = { footers: new Map() };
    webFooterStates.set(key, state);
  }
  return state;
}

function cleanFooterKey(value: unknown) {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim().slice(0, 80).replace(/[^a-zA-Z0-9_.:-]/g, "-");
  return cleaned || undefined;
}

const cleanHeaderActionKey = cleanFooterKey;
const cleanGitTabKey = cleanFooterKey;

function cleanHeaderActionText(value: unknown, maxLength = 200) {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001F\u007F]/g, "").trim();
  return cleaned ? cleaned.slice(0, maxLength) : undefined;
}

function getWebHeaderActionState(value: any): WebHeaderActionState {
  const key = value as object;
  let state = webHeaderActionStates.get(key);
  if (!state) {
    state = { actions: new Map() };
    webHeaderActionStates.set(key, state);
  }
  return state;
}

function getWebGitTabState(value: any): WebGitTabState {
  const key = value as object;
  let state = webGitTabStates.get(key);
  if (!state) {
    state = { tabs: new Map() };
    webGitTabStates.set(key, state);
  }
  return state;
}

function cleanFooterText(value: unknown, maxLength = 2_000) {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trimEnd();
  return cleaned ? cleaned.slice(0, maxLength) : undefined;
}

function normalizeTextLines(value: unknown) {
  const rawLines = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const lines = rawLines.slice(0, 8).map((line) => cleanFooterText(line)).filter((line): line is string => Boolean(line));
  return lines.length ? { kind: "text" as const, lines } : undefined;
}

function normalizePiWebFooter(value: unknown): PiWebFooter | undefined {
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

function webFooterEntries(value: any) {
  return Array.from(getWebFooterState(value).footers.entries()).map(([key, footer]) => ({ key, footer }));
}

function broadcastWebFooters(value: any) {
  const webFooters = webFooterEntries(value);
  deps.emit({
    type: "web_footer_changed",
    sessionId: value.sessionId,
    sessionFile: value.sessionFile,
    webFooters,
  });
  return webFooters;
}

function webHeaderActionEntries(value: any) {
  return Array.from(getWebHeaderActionState(value).actions.entries()).map(([key, action]) => ({
    key,
    icon: cleanHeaderActionText(action.icon, 80),
    title: cleanHeaderActionText(action.title) || key,
    label: cleanHeaderActionText(action.label),
  }));
}

function broadcastWebHeaderActions(value: any) {
  const webHeaderActions = webHeaderActionEntries(value);
  deps.emit({
    type: "web_header_actions_changed",
    sessionId: value.sessionId,
    sessionFile: value.sessionFile,
    webHeaderActions,
  });
  return webHeaderActions;
}

function webGitTabEntries(value: any) {
  return Array.from(getWebGitTabState(value).tabs.entries()).map(([key, tab]) => ({
    key,
    title: cleanHeaderActionText(tab.title) || key,
    label: cleanHeaderActionText(tab.label, 80),
  }));
}

function broadcastWebGitTabs(value: any) {
  const webGitTabs = webGitTabEntries(value);
  deps.emit({
    type: "web_git_tabs_changed",
    sessionId: value.sessionId,
    sessionFile: value.sessionFile,
    webGitTabs,
  });
  return webGitTabs;
}

function createPiWebUi(value: any): PiWebUi {
  return {
    setFooter(key, footer) {
      const footerKey = cleanFooterKey(key);
      if (!footerKey) return;
      const footerState = getWebFooterState(value);
      const normalized = normalizePiWebFooter(footer);
      if (normalized) footerState.footers.set(footerKey, normalized);
      else footerState.footers.delete(footerKey);
      broadcastWebFooters(value);
    },
    setHeaderAction(key, action) {
      const actionKey = cleanHeaderActionKey(key);
      if (!actionKey) return;
      const actionState = getWebHeaderActionState(value);
      if (action && typeof action === "object" && typeof action.invoke === "function") {
        actionState.actions.set(actionKey, action);
      } else {
        actionState.actions.delete(actionKey);
      }
      broadcastWebHeaderActions(value);
    },
    setGitTab(key, tab) {
      const tabKey = cleanGitTabKey(key);
      if (!tabKey) return;
      const tabState = getWebGitTabState(value);
      if (tab && typeof tab === "object" && typeof tab.render === "function") {
        tabState.tabs.set(tabKey, tab);
      } else {
        tabState.tabs.delete(tabKey);
      }
      broadcastWebGitTabs(value);
    },
  };
}

function broadcastExtensionUiRequest(value: any, method: string, payload: Record<string, unknown>) {
  const id = randomUUID();
  deps.emit({
    type: "extension_ui_request",
    id,
    method,
    sessionId: value.sessionId,
    sessionFile: value.sessionFile,
    ...payload,
  });
  return id;
}

function requestExtensionUi<T>(
  value: any,
  method: string,
  payload: Record<string, unknown>,
  opts: ExtensionUIDialogOptions | undefined,
  defaultValue: T,
  parse: (response: Record<string, unknown>) => T,
): Promise<T> {
  if (opts?.signal?.aborted || deps.clientCount() === 0) return Promise.resolve(defaultValue);

  return new Promise<T>((resolvePromise) => {
    const id = randomUUID();
    const releaseWorkLease = deps.acquireWorkLease(value);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      opts?.signal?.removeEventListener("abort", onAbort);
      pendingExtensionUiRequests.delete(id);
      releaseWorkLease();
    };
    const finish = (result: T) => {
      cleanup();
      resolvePromise(result);
    };
    const onAbort = () => finish(defaultValue);

    opts?.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts?.timeout) timeoutId = setTimeout(() => finish(defaultValue), opts.timeout);

    pendingExtensionUiRequests.set(id, {
      cleanup,
      resolve: (response) => finish(parse(response)),
    });

    deps.emit({
      type: "extension_ui_request",
      id,
      method,
      sessionId: value.sessionId,
      sessionFile: value.sessionFile,
      timeout: opts?.timeout,
      ...payload,
    });
  });
}

function createWebExtensionUiContext(value: any): ExtensionUIContext & { web: PiWebUi } {
  return {
    web: createPiWebUi(value),
    select: (title, options, opts) => requestExtensionUi(
      value,
      "select",
      { title, options },
      opts,
      undefined,
      (response) => response.cancelled ? undefined : typeof response.value === "string" ? response.value : undefined,
    ),
    confirm: (title, message, opts) => requestExtensionUi(
      value,
      "confirm",
      { title, message },
      opts,
      false,
      (response) => response.cancelled ? false : Boolean(response.confirmed),
    ),
    input: (title, placeholder, opts) => requestExtensionUi(
      value,
      "input",
      { title, placeholder },
      opts,
      undefined,
      (response) => response.cancelled ? undefined : typeof response.value === "string" ? response.value : undefined,
    ),
    notify(message, type = "info") {
      broadcastExtensionUiRequest(value, "notify", { message, notifyType: type });
    },
    onTerminalInput: () => () => undefined,
    setStatus(key, text) {
      broadcastExtensionUiRequest(value, "setStatus", { statusKey: key, statusText: text });
    },
    setWorkingMessage: () => undefined,
    setWorkingVisible: () => undefined,
    setWorkingIndicator: () => undefined,
    setHiddenThinkingLabel: () => undefined,
    setWidget(key, content, options) {
      if (content === undefined || Array.isArray(content)) {
        broadcastExtensionUiRequest(value, "setWidget", { widgetKey: key, widgetLines: content, widgetPlacement: options?.placement });
      }
    },
    setFooter: () => undefined,
    setHeader: () => undefined,
    setTitle(title) {
      broadcastExtensionUiRequest(value, "setTitle", { title });
    },
    async custom() {
      return undefined as never;
    },
    pasteToEditor(text) {
      this.setEditorText(text);
    },
    setEditorText(text) {
      broadcastExtensionUiRequest(value, "set_editor_text", { text });
    },
    getEditorText: () => "",
    editor: (title, prefill) => requestExtensionUi(
      value,
      "editor",
      { title, prefill },
      undefined,
      undefined,
      (response) => response.cancelled ? undefined : typeof response.value === "string" ? response.value : undefined,
    ),
    addAutocompleteProvider: () => undefined,
    setEditorComponent: () => undefined,
    getEditorComponent: () => undefined,
    theme: plainExtensionTheme as any,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "Theme switching is not supported in pi-web yet" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => undefined,
  };
}

async function bindWebExtensions(value: any) {
  if (typeof value.bindExtensions !== "function") return;
  await value.bindExtensions({
    uiContext: createWebExtensionUiContext(value),
    commandContextActions: {
      waitForIdle: () => value.agent.waitForIdle(),
      newSession: async () => {
        const newSession = await deps.createNewSession(deps.sessionCwd(value), value.sessionFile);
        const state = deps.state(newSession);
        deps.emit({ type: "state_changed", ...state });
        return { cancelled: false };
      },
      fork: async () => {
        throw new Error("Extension-initiated fork is not supported in pi-web yet.");
      },
      navigateTree: async (targetId: string, options: any) => {
        const result = await value.navigateTree(targetId, options);
        return { cancelled: Boolean(result?.cancelled) };
      },
      switchSession: async () => {
        throw new Error("Extension-initiated session switching is not supported in pi-web yet.");
      },
      reload: async () => {
        await value.reload?.();
      },
    },
    shutdownHandler: () => {
      deps.emit({ type: "server_error", sessionId: value.sessionId, sessionFile: value.sessionFile, error: "An extension requested shutdown; pi-web ignored the request." });
    },
    onError: (error: any) => {
      deps.emit({ type: "server_error", sessionId: value.sessionId, sessionFile: value.sessionFile, error: `Extension error (${error.extensionPath}): ${error.error}` });
    },
  });
}


  async function invokeHeaderAction(value: any, keyValue: unknown) {
    const key = cleanHeaderActionKey(keyValue);
    if (!key) throw new Error("key is required");
    const action = getWebHeaderActionState(value).actions.get(key);
    if (!action) throw new Error("Header action not found");
    const result = await action.invoke();
    const markdown = cleanFooterText(result?.markdown, 200_000);
    if (!markdown) throw new Error("Header action returned no markdown");
    return { label: cleanHeaderActionText(action.label) || cleanHeaderActionText(action.title) || key, markdown };
  }

  async function invokeGitTab(value: any, input: { key?: unknown; action?: unknown; payload?: unknown; repo?: unknown }) {
    const key = cleanGitTabKey(input.key);
    if (!key) throw new Error("key is required");
    const tab = getWebGitTabState(value).tabs.get(key);
    if (!tab) throw new Error("Git tab not found");
    const repo = input.repo && typeof input.repo === "object" ? input.repo as Record<string, unknown> : undefined;
    const result = await tab.render({
      action: typeof input.action === "string" ? input.action : undefined,
      payload: input.payload,
      repo: repo ? {
        path: typeof repo.path === "string" ? repo.path : undefined,
        root: typeof repo.root === "string" ? repo.root : undefined,
        branch: typeof repo.branch === "string" ? repo.branch : undefined,
      } : undefined,
    });
    const html = cleanFooterText(result?.html, 500_000);
    if (!html) throw new Error("Git tab returned no HTML");
    return { title: cleanHeaderActionText(result?.title) || cleanHeaderActionText(tab.title) || key, html };
  }

  function respond(id: string, response: Record<string, unknown>): boolean {
    const pending = pendingExtensionUiRequests.get(id);
    if (!pending) return false;
    pending.resolve(response);
    return true;
  }

  return {
    bind: bindWebExtensions,
    entries: (value: any) => ({ webFooters: webFooterEntries(value), webHeaderActions: webHeaderActionEntries(value), webGitTabs: webGitTabEntries(value) }),
    invokeHeaderAction,
    invokeGitTab,
    respond,
  };
}
