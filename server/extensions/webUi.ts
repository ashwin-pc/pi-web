import { randomUUID } from "node:crypto";
import type { ExtensionUIDialogOptions, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { PiWebArtifactAction, PiWebContribution, PiWebFabAction, PiWebFooter, PiWebGitTab, PiWebHeaderAction, PiWebPanel, PiWebRegisterSettingsResult, PiWebSettingsRegistration, PiWebStoredSettings, PiWebUi } from "../../src/extensions.js";
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

type WebContribution =
  | { version: 1; key: string; slot: "footer"; kind: "static"; view: PiWebFooter }
  | { version: 1; key: string; slot: "header-action"; kind: "rendered"; source: PiWebHeaderAction }
  | { version: 1; key: string; slot: "artifact-action"; kind: "rendered"; source: PiWebArtifactAction }
  | { version: 1; key: string; slot: "git-tab"; kind: "rendered"; source: PiWebGitTab }
  | { version: 1; key: string; slot: "panel"; kind: "rendered"; source: PiWebPanel }
  | { version: 1; key: string; slot: "fab"; kind: "static"; source: PiWebFabAction };

/** Canonical per-runtime registry. Legacy surfaces below are wire adapters over it. */
const webContributionStates = new WeakMap<object, Map<string, WebContribution>>();
type ExtensionRuntimeError = { path: string; event: string; error: string; timestamp: string };
const extensionRuntimeErrors = new WeakMap<object, ExtensionRuntimeError[]>();

function recordExtensionRuntimeError(session: object, input: any) {
  const errors = extensionRuntimeErrors.get(session) || [];
  errors.push({
    path: String(input?.extensionPath || input?.path || "unknown extension"),
    event: String(input?.event?.type || input?.eventName || input?.hook || input?.event || "unknown event"),
    error: input?.error instanceof Error ? input.error.message : String(input?.error || input),
    timestamp: new Date().toISOString(),
  });
  if (errors.length > 20) errors.splice(0, errors.length - 20);
  extensionRuntimeErrors.set(session, errors);
}

function contributionId(slot: WebContribution["slot"], key: string) {
  return `${slot}\0${key}`;
}

function contributionState(value: any) {
  const session = value as object;
  let state = webContributionStates.get(session);
  if (!state) {
    state = new Map();
    webContributionStates.set(session, state);
  }
  return state;
}

function contributionsFor<S extends WebContribution["slot"]>(value: any, slot: S) {
  return Array.from(contributionState(value).values()).filter(
    (entry): entry is Extract<WebContribution, { slot: S }> => entry.slot === slot,
  );
}

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

function cleanContributionKey(value: unknown) {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim().slice(0, 80).replace(/[^a-zA-Z0-9_.:-]/g, "-");
  return cleaned || undefined;
}

function cleanHeaderActionText(value: unknown, maxLength = 200) {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001F\u007F]/g, "").trim();
  return cleaned ? cleaned.slice(0, maxLength) : undefined;
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
    const html = cleanFooterText(footer.html, contributionPolicies.footer.viewBudget);
    return html ? { kind: "html", html } : undefined;
  }
  return undefined;
}

const cleanIcon = (value: unknown) => cleanHeaderActionText(value, 80);
const cleanArtifactExtensions = (value: unknown) => Array.isArray(value) ? value.flatMap((extension) => {
  const cleaned = cleanHeaderActionText(extension, 30)?.toLowerCase();
  return cleaned && /^\.[a-z0-9]+$/.test(cleaned) ? [cleaned] : [];
}).slice(0, 20) : undefined;

// `allowedKinds`, budgets, and field limits are executable guards. `viewFields`
// and `effects` document each slot's output contract; the slot-specific
// sanitizers below enforce those structural shapes.
const contributionPolicies = {
  footer: {
    allowedKinds: ["static"], viewFields: ["view"], viewBudget: 20_000,
    descriptor: (entry: Extract<WebContribution, { slot: "footer" }>) => ({ view: entry.view }),
  },
  "header-action": {
    allowedKinds: ["rendered"], viewFields: ["markdown"], effects: ["open-panel"], viewBudget: 200_000,
    descriptor: (_entry: Extract<WebContribution, { slot: "header-action" }>) => ({}),
  },
  "artifact-action": {
    allowedKinds: ["rendered"], viewFields: ["markdown", "message", "download"], viewBudget: 200_000,
    descriptor: (entry: Extract<WebContribution, { slot: "artifact-action" }>) => ({ match: {
      kinds: Array.isArray(entry.source.kinds) ? entry.source.kinds.filter((kind) => kind === "markdown" || kind === "html" || kind === "video") : undefined,
      extensions: cleanArtifactExtensions(entry.source.extensions),
    } }),
  },
  "git-tab": {
    allowedKinds: ["rendered"], viewFields: ["html", "composerContext"], viewBudget: 500_000,
    descriptor: (_entry: Extract<WebContribution, { slot: "git-tab" }>) => ({}),
  },
  panel: {
    allowedKinds: ["rendered"], viewFields: ["html"], viewBudget: 500_000, maxFields: 128,
    descriptor: (_entry: Extract<WebContribution, { slot: "panel" }>) => ({}),
  },
  fab: {
    allowedKinds: ["static"], viewFields: [], viewBudget: 0,
    descriptor: (entry: Extract<WebContribution, { slot: "fab" }>) => ({ opens: cleanContributionKey(entry.source.opens) }),
  },
} as const;

type ContributionSlot = keyof typeof contributionPolicies;

const webCapabilities = Object.freeze({
  apiVersion: 1 as const,
  slots: Object.freeze(Object.keys(contributionPolicies)),
  kinds: Object.freeze([...new Set(Object.values(contributionPolicies).flatMap((policy) => [...policy.allowedKinds]))]),
  effects: Object.freeze([...new Set(Object.values(contributionPolicies).flatMap((policy) => "effects" in policy ? [...policy.effects] : []))]),
});

function webContributionEntries(value: any) {
  return Array.from(contributionState(value).values()).flatMap((entry) => {
    const source = "source" in entry ? entry.source : undefined;
    const descriptor = contributionPolicies[entry.slot].descriptor(entry as never);
    if (entry.slot === "fab" && !(descriptor as { opens?: string }).opens) return [];
    return [{
      version: entry.version,
      key: entry.key,
      slot: entry.slot,
      kind: entry.kind,
      ...(source && "title" in source ? { title: cleanHeaderActionText(source.title) || entry.key } : {}),
      ...(source && "label" in source ? { label: cleanHeaderActionText(source.label, 80) } : {}),
      ...(source && "icon" in source ? { icon: cleanIcon(source.icon) } : {}),
      ...descriptor,
    }];
  });
}

function broadcastContributions(value: any) {
  const webContributions = webContributionEntries(value);
  deps.emit({ type: "web_contributions_changed", sessionId: value.sessionId, sessionFile: value.sessionFile, webContributions });
  return webContributions;
}

function setContribution(
  value: any,
  slot: ContributionSlot,
  keyValue: unknown,
  create: (key: string) => WebContribution | undefined,
) {
  const key = cleanContributionKey(keyValue);
  if (!key) return;
  const contribution = create(key);
  const id = contributionId(slot, key);
  if (contribution) contributionState(value).set(id, contribution);
  else contributionState(value).delete(id);
  broadcastContributions(value);
}

function normalizedPublicContribution(key: string, spec: PiWebContribution): WebContribution {
  if (!spec || typeof spec !== "object") throw new TypeError("Contribution must be an object");
  const delivery = spec as PiWebContribution & { view?: unknown; render?: unknown; entry?: unknown };
  const deliveryFields = [delivery.view !== undefined, delivery.render !== undefined, delivery.entry !== undefined].filter(Boolean).length;
  if (delivery.entry !== undefined) throw new TypeError("Webview contributions are not supported yet");
  if (spec.slot === "fab" ? deliveryFields !== 0 : deliveryFields !== 1) {
    throw new TypeError("Contribution has conflicting or missing delivery fields");
  }
  const policy = contributionPolicies[spec.slot as ContributionSlot];
  if (!policy || !(policy.allowedKinds as readonly string[]).includes(spec.kind)) {
    throw new TypeError(`Unsupported contribution slot/kind: ${String(spec.slot)}/${String(spec.kind)}`);
  }
  if (spec.slot === "footer" && spec.kind === "static") {
    const view = normalizePiWebFooter(spec.view);
    if (!view) throw new TypeError("Footer contribution requires a valid view");
    return { version: 1, key, slot: "footer", kind: "static", view };
  }
  if (spec.slot === "fab" && spec.kind === "static") {
    if (!cleanContributionKey(spec.opens)) throw new TypeError("FAB contribution requires a valid panel key in opens");
    return { version: 1, key, slot: "fab", kind: "static", source: spec };
  }
  if ((spec.slot === "header-action" || spec.slot === "artifact-action" || spec.slot === "git-tab" || spec.slot === "panel")
    && spec.kind === "rendered" && typeof spec.render === "function") {
    if (spec.slot === "header-action") return {
      version: 1, key, slot: spec.slot, kind: "rendered",
      source: { ...spec, invoke: () => spec.render() },
    };
    if (spec.slot === "artifact-action") return {
      version: 1, key, slot: spec.slot, kind: "rendered",
      source: { ...spec, kinds: spec.match?.kinds, extensions: spec.match?.extensions, invoke: (artifact) => spec.render({ context: artifact }) },
    };
    if (spec.slot === "git-tab") return {
      version: 1, key, slot: spec.slot, kind: "rendered",
      source: { ...spec, render: (event) => spec.render({ action: event?.action, payload: event?.payload, context: event?.repo }) },
    };
    return {
      version: 1, key, slot: spec.slot, kind: "rendered",
      source: { ...spec, render: spec.render } as PiWebPanel,
    };
  }
  throw new TypeError(`Unsupported contribution slot/kind: ${String((spec as any).slot)}/${String((spec as any).kind)}`);
}

function createPiWebUi(value: any): PiWebUi {
  const contributeForSlot = (keyValue: unknown, slot: ContributionSlot, spec: PiWebContribution | undefined) => {
    setContribution(value, slot, keyValue, (key) => spec ? normalizedPublicContribution(key, spec) : undefined);
  };
  return {
    capabilities: webCapabilities,
    contribute(keyValue, spec) {
      const key = cleanContributionKey(keyValue);
      if (!key) throw new TypeError("Contribution key is required");
      if (!spec) {
        for (const slot of Object.keys(contributionPolicies) as ContributionSlot[]) contributionState(value).delete(contributionId(slot, key));
        broadcastContributions(value);
        return;
      }
      const contribution = normalizedPublicContribution(key, spec);
      for (const slot of Object.keys(contributionPolicies) as ContributionSlot[]) contributionState(value).delete(contributionId(slot, key));
      contributionState(value).set(contributionId(contribution.slot, key), contribution);
      broadcastContributions(value);
    },
    update(keyValue) {
      const key = cleanContributionKey(keyValue);
      if (!key || !Array.from(contributionState(value).values()).some((entry) => entry.key === key)) return;
      deps.emit({ type: "web_contribution_updated", sessionId: value.sessionId, sessionFile: value.sessionFile, key });
    },
    setFooter: (key, footer) => contributeForSlot(key, "footer", footer === undefined ? undefined : { slot: "footer", kind: "static", view: footer }),
    setHeaderAction: (key, action) => contributeForSlot(key, "header-action", action === undefined ? undefined : { slot: "header-action", kind: "rendered", ...action, render: () => action.invoke() }),
    setArtifactAction: (key, action) => contributeForSlot(key, "artifact-action", action === undefined ? undefined : { slot: "artifact-action", kind: "rendered", title: action.title, label: action.label, match: { kinds: action.kinds, extensions: action.extensions }, render: (event) => action.invoke(event?.context as any) }),
    setGitTab: (key, tab) => contributeForSlot(key, "git-tab", tab === undefined ? undefined : { slot: "git-tab", kind: "rendered", title: tab.title, label: tab.label, render: (event) => tab.render({ action: event?.action, payload: event?.payload, repo: event?.context }) }),
    setPanel: (key, panel) => contributeForSlot(key, "panel", panel === undefined ? undefined : { slot: "panel", kind: "rendered", ...panel }),
    setFabAction: (key, action) => contributeForSlot(key, "fab", action === undefined ? undefined : { slot: "fab", kind: "static", ...action }),
    async registerSettings(schema) { return registerSessionSettings(value, schema); },
    async getSettings(id) { return getExtensionSettings(id); },
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
      recordExtensionRuntimeError(value, error);
      deps.emit({ type: "server_error", sessionId: value.sessionId, sessionFile: value.sessionFile, error: `Extension error (${error.extensionPath}): ${error.error}` });
    },
  });
}


  function renderedContribution<S extends "header-action" | "artifact-action" | "git-tab" | "panel">(value: any, slot: S, keyValue: unknown) {
    const key = cleanContributionKey(keyValue);
    if (!key) throw new Error("key is required");
    const contribution = contributionState(value).get(contributionId(slot, key));
    return { key, contribution: contribution?.slot === slot ? contribution as Extract<WebContribution, { slot: S }> : undefined };
  }

  async function invokeHeaderAction(value: any, keyValue: unknown) {
    const { key, contribution } = renderedContribution(value, "header-action", keyValue);
    if (!contribution) throw new Error("Header action not found");
    const action = contribution.source;
    const result = await action.invoke();
    const markdown = cleanFooterText(result?.markdown, contributionPolicies["header-action"].viewBudget);
    const openPanelEffect = Array.isArray(result?.effects)
      ? result.effects.find((effect) => effect?.type === "open-panel")
      : undefined;
    const openPanel = cleanContributionKey(openPanelEffect?.key);
    if (openPanel && !contributionState(value).has(contributionId("panel", openPanel))) throw new Error(`Header action returned unknown panel "${openPanel}"`);
    if (!markdown && !openPanel) throw new Error("Header action returned no result");
    return {
      label: cleanHeaderActionText(action.label) || cleanHeaderActionText(action.title) || key,
      ...(markdown ? { markdown } : {}),
      ...(openPanel ? { effects: [{ type: "open-panel", key: openPanel }] } : {}),
    };
  }

  async function invokeArtifactAction(value: any, input: { key?: unknown; name?: unknown; path?: unknown; kind?: unknown }) {
    const { key, contribution } = renderedContribution(value, "artifact-action", input.key);
    if (!contribution) throw new Error("Artifact action not found");
    const action = contribution.source;
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
    const markdown = cleanFooterText(result?.markdown, contributionPolicies["artifact-action"].viewBudget);
    const message = cleanHeaderActionText(result?.message, 2_000);
    const download = result?.download && typeof result.download === "object" ? { path, filename: cleanHeaderActionText(result.download.filename, 500) || name } : undefined;
    if (!markdown && !message && !download) throw new Error("Artifact action returned no result");
    return {
      label: cleanHeaderActionText(action.label) || cleanHeaderActionText(action.title) || key,
      ...(markdown ? { markdown } : {}),
      ...(message ? { message } : {}),
      ...(download ? { download } : {}),
    };
  }

  async function invokeGitTab(value: any, input: { key?: unknown; action?: unknown; payload?: unknown; repo?: unknown }) {
    const { key, contribution } = renderedContribution(value, "git-tab", input.key);
    if (!contribution) throw new Error("Git tab not found");
    const tab = contribution.source;
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
    const html = cleanFooterText(result?.html, contributionPolicies["git-tab"].viewBudget);
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

  async function invokePanel(value: any, input: { key?: unknown; action?: unknown; payload?: unknown; fields?: unknown }) {
    const { contribution } = renderedContribution(value, "panel", input.key);
    if (!contribution) throw new Error("Panel not found");
    const rawFields = input.fields && typeof input.fields === "object" && !Array.isArray(input.fields)
      ? input.fields as Record<string, unknown>
      : undefined;
    const cleanFieldValue = (field: string) => field
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      .slice(0, 100_000);
    const fields = rawFields ? Object.entries(rawFields).slice(0, contributionPolicies.panel.maxFields).reduce<Record<string, string | string[]>>((cleaned, [name, field]) => {
      const cleanName = cleanHeaderActionText(name, 200);
      if (!cleanName) return cleaned;
      if (typeof field === "string") cleaned[cleanName] = cleanFieldValue(field);
      else if (Array.isArray(field)) cleaned[cleanName] = field.flatMap((item) => typeof item === "string" ? [cleanFieldValue(item)] : []).slice(0, 100);
      return cleaned;
    }, {}) : undefined;
    const result = await contribution.source.render({
      action: cleanHeaderActionText(input.action, 200),
      payload: input.payload,
      fields,
    });
    const html = cleanFooterText(result?.html, contributionPolicies.panel.viewBudget);
    if (!html) throw new Error("Panel returned no HTML");
    return { title: cleanHeaderActionText(result?.title), html };
  }

  async function invokeContribution(value: any, input: { slot?: unknown; key?: unknown; event?: unknown }) {
    const slot = input.slot;
    const event = input.event && typeof input.event === "object" ? input.event as Record<string, unknown> : {};
    if (slot === "header-action") return invokeHeaderAction(value, input.key);
    if (slot === "artifact-action") {
      const context = event.context && typeof event.context === "object" ? event.context as Record<string, unknown> : {};
      return invokeArtifactAction(value, { ...context, key: input.key });
    }
    if (slot === "git-tab") {
      return invokeGitTab(value, { key: input.key, action: event.action, payload: event.payload, repo: event.context });
    }
    if (slot === "panel") {
      return invokePanel(value, { key: input.key, action: event.action, payload: event.payload, fields: event.fields });
    }
    throw new Error("Contribution is not invokable");
  }

  function respond(id: string, response: Record<string, unknown>): boolean {
    const pending = pendingExtensionUiRequests.get(id);
    if (!pending) return false;
    pending.resolve(response);
    return true;
  }

  return {
    bind: bindWebExtensions,
    entries: (value: any) => ({ webContributions: webContributionEntries(value) }),
    invokeContribution,
    invokeHeaderAction,
    invokeArtifactAction,
    invokeGitTab,
    invokePanel,
    respond,
    runtimeErrors: (value: object) => [...(extensionRuntimeErrors.get(value) || [])],
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
