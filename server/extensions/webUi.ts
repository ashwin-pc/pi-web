import { randomUUID } from "node:crypto";
import type { ExtensionUIDialogOptions, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { PiWebArtifactAction, PiWebFooter, PiWebGitTab, PiWebHeaderAction, PiWebRegisterSettingsResult, PiWebSettingsRegistration, PiWebStoredSettings, PiWebUi } from "../../src/extensions.js";
import type { createSettingsStore } from "../settings.js";
import { canonicalSchemaKey, defaultSettingsValues, validateSettingsValues } from "../extensionSettings.js";

export interface WebUiBridgeDependencies {
  emit(value: unknown): void;
  clientCount(): number;
  acquireWorkLease(session: any): () => void;
  createNewSession(cwd: string, previousSessionFile?: string): Promise<any>;
  sessionCwd(session: any): string;
  state(session: any): Record<string, unknown>;
  settingsStore: ReturnType<typeof createSettingsStore>;
  /** Allowed model tokens ("<provider>:<id>") for `optionsSource: "models"` fields. */
  modelOptions(): Set<string>;
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

type WebArtifactActionState = {
  actions: Map<string, PiWebArtifactAction>;
};

const webFooterStates = new WeakMap<object, WebFooterState>();
const webHeaderActionStates = new WeakMap<object, WebHeaderActionState>();
const webGitTabStates = new WeakMap<object, WebGitTabState>();
const webArtifactActionStates = new WeakMap<object, WebArtifactActionState>();

// Process-global extension-settings schema registry (R2.2): decoupled from any
// one session. Values live in settingsStore (global); schemas are refcounted
// across the live sessions that registered them.
type RegisteredSettingsSchema = {
  schema: PiWebSettingsRegistration;
  canonicalKey: string;
  refCount: number;
};
const activeSettingsSchemas = new Map<string, RegisteredSettingsSchema>();
// Which owner ids each live session registered (for shutdown decrement).
const sessionRegisteredSettings = new WeakMap<object, Set<string>>();

function serializableSettingsSchema(schema: PiWebSettingsRegistration) {
  const { migrate: _migrate, onChange: _onChange, ...rest } = schema;
  return rest;
}

function activeSettingsSchemaList() {
  return Array.from(activeSettingsSchemas.values()).map((e) => serializableSettingsSchema(e.schema));
}

function broadcastSettingsSchemas() {
  deps.emit({ type: "web_settings_schemas_changed", webSettingsSchemas: activeSettingsSchemaList() });
}

async function migrateStoredSettings(
  schema: PiWebSettingsRegistration,
): Promise<{ migrated: boolean; usedBackup: boolean; error?: string }> {
  const settings = await deps.settingsStore.read();
  const stored = settings.extensions?.[schema.id];
  if (!stored || stored.schemaVersion >= schema.schemaVersion) {
    return { migrated: false, usedBackup: false };
  }
  const backup = { schemaVersion: stored.schemaVersion, values: stored.values };
  const defaults = defaultSettingsValues(schema);
  if (typeof schema.migrate === "function") {
    try {
      const migratedValues = await schema.migrate(stored.values, stored.schemaVersion);
      const { values, errors } = validateSettingsValues(schema, migratedValues, { modelOptions: deps.modelOptions() });
      if (errors.length) {
        await deps.settingsStore.patchExtension(schema.id, defaults, { schemaVersion: schema.schemaVersion, backup });
        return { migrated: false, usedBackup: true, error: `migration produced invalid values (${errors.length})` };
      }
      await deps.settingsStore.patchExtension(schema.id, values, { schemaVersion: schema.schemaVersion, backup });
      return { migrated: true, usedBackup: false };
    } catch (error) {
      await deps.settingsStore.patchExtension(schema.id, defaults, { schemaVersion: schema.schemaVersion, backup });
      return { migrated: false, usedBackup: true, error: error instanceof Error ? error.message : String(error) };
    }
  }
  // No migrate() provided: reset to defaults, keep a one-slot backup.
  await deps.settingsStore.patchExtension(schema.id, defaults, { schemaVersion: schema.schemaVersion, backup });
  return { migrated: false, usedBackup: true };
}

async function registerSessionSettings(
  value: any,
  schema: PiWebSettingsRegistration,
): Promise<PiWebRegisterSettingsResult> {
  if (!schema || typeof schema.id !== "string" || !Array.isArray(schema.fields)) {
    return { registered: false, migrated: false, usedBackup: false, error: "invalid settings schema" };
  }
  const id = schema.id;
  const canonical = canonicalSchemaKey(schema);
  const existing = activeSettingsSchemas.get(id);
  if (existing && existing.canonicalKey !== canonical) {
    // First-registered wins; a divergent schema for the same id is rejected.
    console.warn(`pi-web: settings id "${id}" already registered with a different schema; rejecting new registration.`);
    return { registered: false, migrated: false, usedBackup: false, error: `settings id "${id}" already registered with a different schema` };
  }

  let migrated = false;
  let usedBackup = false;
  let error: string | undefined;
  if (!existing) {
    const result = await migrateStoredSettings(schema);
    migrated = result.migrated;
    usedBackup = result.usedBackup;
    error = result.error;
    activeSettingsSchemas.set(id, { schema, canonicalKey: canonical, refCount: 0 });
  } else {
    existing.schema = schema; // refresh callbacks to the latest registrant
  }

  const entry = activeSettingsSchemas.get(id)!;
  const owned = sessionRegisteredSettings.get(value as object) ?? new Set<string>();
  if (!owned.has(id)) {
    entry.refCount += 1;
    owned.add(id);
    sessionRegisteredSettings.set(value as object, owned);
  }
  broadcastSettingsSchemas();
  return { registered: true, migrated, usedBackup, error };
}

function releaseSessionSettings(value: any) {
  const owned = sessionRegisteredSettings.get(value as object);
  if (!owned) return;
  let changed = false;
  for (const id of owned) {
    const entry = activeSettingsSchemas.get(id);
    if (!entry) continue;
    entry.refCount -= 1;
    if (entry.refCount <= 0) {
      activeSettingsSchemas.delete(id);
      changed = true;
    }
  }
  sessionRegisteredSettings.delete(value as object);
  if (changed) broadcastSettingsSchemas();
}

async function getExtensionSettings(id: string): Promise<PiWebStoredSettings> {
  const settings = await deps.settingsStore.read();
  const stored = settings.extensions?.[id];
  if (stored) return { schemaVersion: stored.schemaVersion, values: stored.values };
  const entry = activeSettingsSchemas.get(id);
  if (entry) return { schemaVersion: entry.schema.schemaVersion, values: defaultSettingsValues(entry.schema) };
  return { schemaVersion: 0, values: {} };
}

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

function getWebArtifactActionState(value: any): WebArtifactActionState {
  const key = value as object;
  let state = webArtifactActionStates.get(key);
  if (!state) {
    state = { actions: new Map() };
    webArtifactActionStates.set(key, state);
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

function webArtifactActionEntries(value: any) {
  return Array.from(getWebArtifactActionState(value).actions.entries()).map(([key, action]) => ({
    key,
    title: cleanHeaderActionText(action.title) || key,
    label: cleanHeaderActionText(action.label, 80),
    kinds: Array.isArray(action.kinds) ? action.kinds.filter((kind) => kind === "markdown" || kind === "html" || kind === "video") : undefined,
    extensions: Array.isArray(action.extensions) ? action.extensions.flatMap((extension) => {
      const cleaned = cleanHeaderActionText(extension, 30)?.toLowerCase();
      return cleaned && /^\.[a-z0-9]+$/.test(cleaned) ? [cleaned] : [];
    }).slice(0, 20) : undefined,
  }));
}

function broadcastWebArtifactActions(value: any) {
  const webArtifactActions = webArtifactActionEntries(value);
  deps.emit({ type: "web_artifact_actions_changed", sessionId: value.sessionId, sessionFile: value.sessionFile, webArtifactActions });
  return webArtifactActions;
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
    setArtifactAction(key, action) {
      const actionKey = cleanHeaderActionKey(key);
      if (!actionKey) return;
      const state = getWebArtifactActionState(value);
      if (action && typeof action === "object" && typeof action.invoke === "function") state.actions.set(actionKey, action);
      else state.actions.delete(actionKey);
      broadcastWebArtifactActions(value);
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
    async registerSettings(schema) {
      return registerSessionSettings(value, schema);
    },
    async getSettings(id) {
      return getExtensionSettings(id);
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

  async function invokeArtifactAction(value: any, input: { key?: unknown; name?: unknown; path?: unknown; kind?: unknown }) {
    const key = cleanHeaderActionKey(input.key);
    if (!key) throw new Error("key is required");
    const action = getWebArtifactActionState(value).actions.get(key);
    if (!action) throw new Error("Artifact action not found");
    const name = cleanHeaderActionText(input.name, 500);
    const path = cleanHeaderActionText(input.path, 2_000);
    const kind = input.kind === "markdown" || input.kind === "html" || input.kind === "video" ? input.kind : undefined;
    let pathName: string | undefined;
    try {
      if (path && path.startsWith("/api/artifacts/")) pathName = decodeURIComponent(path.slice("/api/artifacts/".length)).split("/").at(-1);
    } catch { /* invalid encoded artifact path */ }
    if (!name || !path || !kind || pathName !== name) throw new Error("Invalid artifact context");
    if (Array.isArray(action.kinds) && action.kinds.length && !action.kinds.includes(kind)) throw new Error("Artifact action does not match this artifact");
    if (Array.isArray(action.extensions) && action.extensions.length && !action.extensions.some((extension) => typeof extension === "string" && name.toLowerCase().endsWith(extension.toLowerCase()))) throw new Error("Artifact action does not match this artifact");
    const result = await action.invoke({ name, path, kind });
    const markdown = cleanFooterText(result?.markdown, 200_000);
    const message = cleanHeaderActionText(result?.message, 2_000);
    const download = result?.download && typeof result.download === "object"
      ? { path, filename: cleanHeaderActionText(result.download.filename, 500) || name }
      : undefined;
    if (!markdown && !message && !download) throw new Error("Artifact action returned no result");
    return { label: cleanHeaderActionText(action.label) || cleanHeaderActionText(action.title) || key, ...(markdown ? { markdown } : {}), ...(message ? { message } : {}), ...(download ? { download } : {}) };
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
    const rawContext = result?.composerContext && typeof result.composerContext === "object"
      ? result.composerContext as Record<string, unknown>
      : undefined;
    const contextLabel = cleanHeaderActionText(rawContext?.label, 200);
    const contextContent = cleanFooterText(rawContext?.content, 200_000);
    const composerContext = contextLabel && contextContent ? {
      ...(cleanHeaderActionText(rawContext?.id, 500) ? { id: cleanHeaderActionText(rawContext?.id, 500) } : {}),
      label: contextLabel,
      ...(cleanHeaderActionText(rawContext?.title, 500) ? { title: cleanHeaderActionText(rawContext?.title, 500) } : {}),
      content: contextContent,
    } : undefined;
    if (!html && !composerContext) throw new Error("Git tab returned no HTML or composer context");
    return {
      title: cleanHeaderActionText(result?.title) || cleanHeaderActionText(tab.title) || key,
      ...(html ? { html } : {}),
      ...(composerContext ? { composerContext } : {}),
    };
  }

  function respond(id: string, response: Record<string, unknown>): boolean {
    const pending = pendingExtensionUiRequests.get(id);
    if (!pending) return false;
    pending.resolve(response);
    return true;
  }

  return {
    bind: bindWebExtensions,
    entries: (value: any) => ({ webFooters: webFooterEntries(value), webHeaderActions: webHeaderActionEntries(value), webArtifactActions: webArtifactActionEntries(value), webGitTabs: webGitTabEntries(value) }),
    invokeHeaderAction,
    invokeArtifactAction,
    invokeGitTab,
    respond,
    settingsSchemas: activeSettingsSchemaList,
    settingsSchemaEntry: (id: string) => activeSettingsSchemas.get(id),
    releaseSessionSettings,
  };
}
