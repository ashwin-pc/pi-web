import { randomUUID } from "node:crypto";
import type { ExtensionUIDialogOptions, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { PiWebArtifactAction, PiWebFabAction, PiWebFooter, PiWebGitTab, PiWebHeaderAction, PiWebPanel, PiWebRegisterSettingsResult, PiWebSettingsRegistration, PiWebStoredSettings, PiWebUi } from "../../src/extensions.js";
import type { createSettingsStore } from "../settings.js";
import { ExtensionRevisionConflictError, isValidExtensionOwnerId } from "../settings.js";
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

type WebPanelState = {
  panels: Map<string, PiWebPanel>;
};

type WebFabActionState = {
  actions: Map<string, PiWebFabAction>;
};

type WebArtifactActionState = {
  actions: Map<string, PiWebArtifactAction>;
};

const webFooterStates = new WeakMap<object, WebFooterState>();
const webHeaderActionStates = new WeakMap<object, WebHeaderActionState>();
const webGitTabStates = new WeakMap<object, WebGitTabState>();
const webPanelStates = new WeakMap<object, WebPanelState>();
const webFabActionStates = new WeakMap<object, WebFabActionState>();
const webArtifactActionStates = new WeakMap<object, WebArtifactActionState>();

// Process-global extension-settings schema registry: decoupled from any one
// session. Values live in settingsStore (global). A schema stays registered
// while at least one live session registers it, and every live registrant is
// notified of changes with its own callback.
type SettingsRegistrant = { schema: PiWebSettingsRegistration; sessionId: string };
type RegisteredSettingsSchema = {
  /** Canonical (first) registrant's schema: used for validation + transport. */
  schema: PiWebSettingsRegistration;
  canonicalKey: string;
  registrants: Map<object, SettingsRegistrant>;
  /** Shared so concurrent first registrations migrate exactly once. */
  migration: Promise<{ migrated: boolean; usedBackup: boolean; error?: string }>;
  /** Registrations awaiting migration; the entry must not be dropped under them. */
  pending: number;
  /** Only exposed once migration settled, so nothing validates mid-migration. */
  ready: boolean;
  migrationError?: string;
};
const activeSettingsSchemas = new Map<string, RegisteredSettingsSchema>();
// Sessions that shut down; a registration awaiting migration must not complete.
const disposedSettingsSessions = new WeakSet<object>();

const settingsFieldTypes = new Set(["toggle", "text", "textarea", "number", "select", "list"]);
const settingsFieldKeyPattern = /^[A-Za-z0-9_]{1,64}$/;

/** Structural validation of a contributed descriptor, before anything is reserved. */
function settingsSchemaProblem(schema: PiWebSettingsRegistration, depth = 0, fields = schema?.fields): string | undefined {
  if (depth === 0) {
    if (!schema || typeof schema !== "object") return "schema must be an object";
    if (!isValidExtensionOwnerId(schema.id)) return `settings id "${String(schema.id)}" must be namespaced as <extension>.<schema>`;
    if (typeof schema.title !== "string" || !schema.title.trim()) return "schema.title is required";
    if (!Number.isInteger(schema.schemaVersion) || schema.schemaVersion < 1) return "schema.schemaVersion must be a positive integer";
  }
  if (depth > 2) return "schema nesting is too deep";
  if (!Array.isArray(fields) || fields.length === 0) return "schema.fields must be a non-empty array";
  if (fields.length > 64) return "schema.fields has too many entries (max 64)";
  const keys = new Set<string>();
  for (const field of fields) {
    if (!field || typeof field !== "object") return "each field must be an object";
    if (!settingsFieldKeyPattern.test(String(field.key))) return `invalid field key "${String(field.key)}"`;
    if (keys.has(field.key)) return `duplicate field key "${field.key}"`;
    keys.add(field.key);
    if (!settingsFieldTypes.has(String(field.type))) return `unsupported field type "${String(field.type)}" on "${field.key}"`;
    if (typeof field.label !== "string" || !field.label.trim()) return `field "${field.key}" needs a label`;
    if (field.type === "list") {
      if (depth > 0) return `field "${field.key}": nested list fields are not supported`;
      const nested = settingsSchemaProblem(schema, depth + 1, field.itemFields);
      if (nested) return nested;
    }
    if (field.optionsFromField !== undefined) {
      const [listKey, itemKey] = String(field.optionsFromField).split(".");
      if (!listKey || !itemKey) return `field "${field.key}" has a malformed optionsFromField`;
    }
  }
  return undefined;
}

function serializableSettingsSchema(entry: RegisteredSettingsSchema) {
  const { migrate: _migrate, onChange: _onChange, ...rest } = entry.schema;
  return entry.migrationError ? { ...rest, migrationError: entry.migrationError } : rest;
}

function activeSettingsSchemaList() {
  return Array.from(activeSettingsSchemas.values())
    .filter((entry) => entry.ready && entry.registrants.size > 0)
    .map(serializableSettingsSchema);
}

function settingsSchemaListKey() {
  return JSON.stringify(activeSettingsSchemaList());
}

function broadcastSettingsSchemasIfChanged(previousKey: string) {
  const webSettingsSchemas = activeSettingsSchemaList();
  if (JSON.stringify(webSettingsSchemas) === previousKey) return;
  deps.emit({ type: "web_settings_schemas_changed", webSettingsSchemas });
}

/**
 * Migrate stored values for one owner. NEVER rejects: a store failure resolves
 * with an `error` instead, because this promise is shared by every concurrent
 * registration of the id — a rejection would poison the id until restart.
 */
async function migrateStoredSettings(
  schema: PiWebSettingsRegistration,
): Promise<{ migrated: boolean; usedBackup: boolean; error?: string }> {
  const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
  try {
    const settings = await deps.settingsStore.read();
    const stored = settings.extensions?.[schema.id];
    if (!stored || stored.schemaVersion >= schema.schemaVersion) {
      return { migrated: false, usedBackup: false };
    }
    const backup = { schemaVersion: stored.schemaVersion, values: stored.values };
    const defaults = defaultSettingsValues(schema);
    if (typeof schema.migrate === "function") {
      let migratedValues: Record<string, unknown> | undefined;
      let migrateError: string | undefined;
      try {
        migratedValues = await schema.migrate(stored.values, stored.schemaVersion);
      } catch (error) {
        migrateError = describe(error);
      }
      if (migrateError === undefined && migratedValues !== undefined) {
        const { values, errors } = validateSettingsValues(schema, migratedValues, { modelOptions: deps.modelOptions() });
        if (errors.length === 0) {
          await deps.settingsStore.patchExtension(schema.id, values, {
            schemaVersion: schema.schemaVersion,
            expectedRevision: stored.revision,
            backup,
          });
          return { migrated: true, usedBackup: false };
        }
        migrateError = `migration produced invalid values (${errors.length})`;
      }
      await deps.settingsStore.patchExtension(schema.id, defaults, {
        schemaVersion: schema.schemaVersion,
        expectedRevision: stored.revision,
        backup,
      });
      return { migrated: false, usedBackup: true, error: migrateError };
    }
    // No migrate() provided: reset to defaults, keep a one-slot backup.
    await deps.settingsStore.patchExtension(schema.id, defaults, {
      schemaVersion: schema.schemaVersion,
      expectedRevision: stored.revision,
      backup,
    });
    return { migrated: false, usedBackup: true };
  } catch (error) {
    const message = describe(error);
    if (error instanceof ExtensionRevisionConflictError) {
      return {
        migrated: false,
        usedBackup: false,
        error: `migration skipped because settings changed concurrently: ${message}`,
      };
    }
    return { migrated: false, usedBackup: false, error: message };
  }
}

async function registerSessionSettings(
  value: any,
  schema: PiWebSettingsRegistration,
): Promise<PiWebRegisterSettingsResult> {
  const problem = settingsSchemaProblem(schema);
  if (problem) {
    console.warn(`pi-web: rejected settings registration: ${problem}`);
    return { registered: false, migrated: false, usedBackup: false, error: problem };
  }
  const id = schema.id;
  const canonical = canonicalSchemaKey(schema);
  const session = value as object;

  // Reserve the id SYNCHRONOUSLY (before any await) so concurrent first
  // registrations cannot both migrate or both claim the id.
  let entry = activeSettingsSchemas.get(id);
  if (entry && entry.canonicalKey !== canonical) {
    const error = `settings id "${id}" is already registered with a different schema`;
    console.warn(`pi-web: ${error}; rejecting new registration.`);
    return { registered: false, migrated: false, usedBackup: false, error };
  }
  if (!entry) {
    entry = {
      schema,
      canonicalKey: canonical,
      registrants: new Map(),
      migration: migrateStoredSettings(schema),
      pending: 0,
      ready: false,
    };
    activeSettingsSchemas.set(id, entry);
  }

  let result: { migrated: boolean; usedBackup: boolean; error?: string };
  while (true) {
    // Count ourselves as in-flight BEFORE awaiting, so releasing the last
    // registrant cannot drop this entry while this registration can still use it.
    entry.pending += 1;
    try {
      result = await entry.migration;
    } catch (error) {
      // migrateStoredSettings is written not to reject; treat a rejection as a
      // failed registration and release the reservation so the id stays usable.
      const message = error instanceof Error ? error.message : String(error);
      entry.pending -= 1;
      if (entry.registrants.size === 0 && entry.pending === 0 && activeSettingsSchemas.get(id) === entry) {
        activeSettingsSchemas.delete(id);
      }
      return { registered: false, migrated: false, usedBackup: false, error: message };
    }
    entry.pending -= 1;
    entry.ready = true;
    if (result.error) {
      entry.migrationError = result.error;
      console.warn(`pi-web: settings migration for "${id}" did not complete: ${result.error}`);
    }

    // The session may have shut down while migration was in flight; never
    // register a dead session (and drop a reservation nobody else is claiming).
    if (disposedSettingsSessions.has(session)) {
      if (entry.registrants.size === 0 && entry.pending === 0 && activeSettingsSchemas.get(id) === entry) {
        activeSettingsSchemas.delete(id);
      }
      return { registered: false, migrated: result.migrated, usedBackup: result.usedBackup, error: "session shut down during registration" };
    }

    const current = activeSettingsSchemas.get(id);
    if (!current) {
      // The id is still unclaimed, so this completed reservation may publish.
      activeSettingsSchemas.set(id, entry);
      break;
    }
    if (current === entry) break;
    if (current.canonicalKey !== canonical) {
      const error = `settings id "${id}" is now registered with a different schema`;
      console.warn(`pi-web: ${error}; rejecting registration completed against a stale reservation.`);
      return { registered: false, migrated: result.migrated, usedBackup: result.usedBackup, error };
    }

    // Another equivalent entry became canonical while this migration awaited.
    // Join it (and await its shared migration) instead of overwriting it.
    entry = current;
  }

  const previousSchemaList = settingsSchemaListKey();
  entry.registrants.set(session, { schema, sessionId: String(value?.sessionId || "") });
  broadcastSettingsSchemasIfChanged(previousSchemaList);
  return { registered: true, migrated: result.migrated, usedBackup: result.usedBackup, error: result.error };
}

/** Notify every live registrant, each with its own callback and session id. */
function notifySettingsChanged(id: string, values: Record<string, unknown>) {
  const entry = activeSettingsSchemas.get(id);
  if (!entry) return;
  for (const registrant of entry.registrants.values()) {
    try {
      registrant.schema.onChange?.(values, { sessionId: registrant.sessionId });
    } catch (error) {
      console.warn(`pi-web: settings onChange for "${id}" threw:`, error);
    }
  }
}

function releaseSessionSettings(value: any) {
  const session = value as object;
  disposedSettingsSessions.add(session);
  const previousSchemaList = settingsSchemaListKey();
  for (const [id, entry] of activeSettingsSchemas) {
    if (!entry.registrants.delete(session)) continue;
    if (entry.registrants.size === 0 && entry.pending === 0) activeSettingsSchemas.delete(id);
  }
  broadcastSettingsSchemasIfChanged(previousSchemaList);
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
const cleanPanelKey = cleanFooterKey;

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

function getWebPanelState(value: any): WebPanelState {
  const key = value as object;
  let state = webPanelStates.get(key);
  if (!state) {
    state = { panels: new Map() };
    webPanelStates.set(key, state);
  }
  return state;
}

function getWebFabActionState(value: any): WebFabActionState {
  const key = value as object;
  let state = webFabActionStates.get(key);
  if (!state) {
    state = { actions: new Map() };
    webFabActionStates.set(key, state);
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

function webPanelEntries(value: any) {
  return Array.from(getWebPanelState(value).panels.entries()).map(([key, panel]) => ({
    key,
    icon: cleanHeaderActionText(panel.icon, 80),
    title: cleanHeaderActionText(panel.title) || key,
    label: cleanHeaderActionText(panel.label, 80),
  }));
}

function webFabActionEntries(value: any) {
  return Array.from(getWebFabActionState(value).actions.entries()).map(([key, action]) => ({
    key,
    icon: cleanHeaderActionText(action.icon, 80),
    title: cleanHeaderActionText(action.title) || key,
    label: cleanHeaderActionText(action.label, 80),
    opens: cleanPanelKey(action.opens),
  }));
}

function broadcastWebFabActions(value: any) {
  const webFabActions = webFabActionEntries(value);
  deps.emit({
    type: "web_fab_actions_changed",
    sessionId: value.sessionId,
    sessionFile: value.sessionFile,
    webFabActions,
  });
  return webFabActions;
}

function broadcastWebPanels(value: any) {
  const webPanels = webPanelEntries(value);
  deps.emit({
    type: "web_panels_changed",
    sessionId: value.sessionId,
    sessionFile: value.sessionFile,
    webPanels,
  });
  return webPanels;
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
    setPanel(key, panel) {
      const panelKey = cleanPanelKey(key);
      if (!panelKey) return;
      const panelState = getWebPanelState(value);
      if (panel && typeof panel === "object" && typeof panel.render === "function") {
        panelState.panels.set(panelKey, panel);
      } else {
        panelState.panels.delete(panelKey);
      }
      broadcastWebPanels(value);
    },
    setFabAction(key, action) {
      const actionKey = cleanPanelKey(key);
      if (!actionKey) return;
      const state = getWebFabActionState(value);
      if (action && typeof action === "object" && cleanPanelKey(action.opens)) {
        state.actions.set(actionKey, action);
      } else {
        state.actions.delete(actionKey);
      }
      broadcastWebFabActions(value);
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
    const openPanel = cleanPanelKey((result as any)?.openPanel);
    if (openPanel && !getWebPanelState(value).panels.has(openPanel)) {
      throw new Error(`Header action requested unknown panel "${openPanel}"`);
    }
    if (!markdown && !openPanel) throw new Error("Header action returned no markdown");
    return {
      label: cleanHeaderActionText(action.label) || cleanHeaderActionText(action.title) || key,
      ...(markdown ? { markdown } : {}),
      ...(openPanel ? { openPanel } : {}),
    };
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

  function normalizePanelFields(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const fields: Record<string, string | string[]> = {};
    let totalChars = 0;
    for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>).slice(0, 128)) {
      const key = cleanHeaderActionText(rawKey, 200);
      if (!key) continue;
      const cleanValue = (candidate: unknown) => {
        if (typeof candidate !== "string") return undefined;
        const cleaned = candidate.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").slice(0, 200_000);
        if (totalChars + cleaned.length > 500_000) return undefined;
        totalChars += cleaned.length;
        return cleaned;
      };
      if (Array.isArray(rawValue)) {
        const values = rawValue.slice(0, 100).map(cleanValue).filter((item): item is string => item !== undefined);
        if (values.length) fields[key] = values;
      } else {
        const cleaned = cleanValue(rawValue);
        if (cleaned !== undefined) fields[key] = cleaned;
      }
    }
    return fields;
  }

  async function invokePanel(value: any, input: { key?: unknown; action?: unknown; payload?: unknown; fields?: unknown }) {
    const key = cleanPanelKey(input.key);
    if (!key) throw new Error("key is required");
    const panel = getWebPanelState(value).panels.get(key);
    if (!panel) throw new Error("Panel not found");
    const result = await panel.render({
      action: typeof input.action === "string" ? cleanHeaderActionText(input.action, 120) : undefined,
      payload: input.payload,
      fields: normalizePanelFields(input.fields),
    });
    const html = cleanFooterText(result?.html, 500_000);
    if (!html) throw new Error("Panel returned no HTML");
    return {
      title: cleanHeaderActionText(result?.title) || cleanHeaderActionText(panel.title) || key,
      html,
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
    entries: (value: any) => ({ webFooters: webFooterEntries(value), webHeaderActions: webHeaderActionEntries(value), webArtifactActions: webArtifactActionEntries(value), webGitTabs: webGitTabEntries(value), webPanels: webPanelEntries(value), webFabActions: webFabActionEntries(value) }),
    invokeHeaderAction,
    invokeArtifactAction,
    invokeGitTab,
    invokePanel,
    respond,
    registerSettings: (session: any, schema: PiWebSettingsRegistration) => registerSessionSettings(session, schema),
    settingsSchemas: activeSettingsSchemaList,
    settingsSchemaEntry: (id: string) => {
      const entry = activeSettingsSchemas.get(id);
      return entry?.ready && entry.registrants.size > 0 ? entry : undefined;
    },
    notifySettingsChanged,
    releaseSessionSettings,
  };
}
