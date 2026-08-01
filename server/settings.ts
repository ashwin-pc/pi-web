import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type PiWebModelSetting = {
  provider: string;
  id: string;
};

/** A plain JSON object (no functions/undefined at the top level after round-trip). */
export type JsonObject = Record<string, unknown>;

/**
 * Canonical persisted shape for one extension-owned settings record.
 * `backup` lives OUTSIDE `values` so descriptor validation of user fields can
 * never collide with it. `revision` powers the optimistic write guard.
 */
export type StoredExtensionSettings = {
  schemaVersion: number;
  revision: number;
  values: JsonObject;
  backup?: { schemaVersion: number; values: JsonObject };
};

export const extensionSettingsLimits = {
  maxOwners: 32,
  maxKeysPerOwner: 128,
  /** Serialized bytes for one owner record (values + backup counted together). */
  maxBytesPerOwner: 64 * 1024,
} as const;

/** Namespaced owner id: `<extensionName>.<schemaId>` (at least one dot). */
const ownerIdPattern = /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)+$/;
export function isValidExtensionOwnerId(id: unknown): id is string {
  return typeof id === "string" && id.length <= 128 && ownerIdPattern.test(id);
}

export class ExtensionSettingsBoundsError extends Error {
  constructor(public readonly ownerId: string, message: string) {
    super(message);
    this.name = "ExtensionSettingsBoundsError";
  }
}

export class ExtensionRevisionConflictError extends Error {
  constructor(
    public readonly ownerId: string,
    public readonly actualRevision: number,
    public readonly expectedRevision: number,
  ) {
    super(`revision conflict for ${ownerId}: expected ${expectedRevision}, found ${actualRevision}`);
    this.name = "ExtensionRevisionConflictError";
  }
}

export type SessionMarkerColorId = "blue" | "purple" | "yellow" | "red" | "green";

const sessionMarkerColors = new Set<SessionMarkerColorId>(["blue", "purple", "yellow", "red", "green"]);

export const defaultAccentColor = "#e2b15f";
export const defaultLoadingAnimation = "fireworks";

export type LoadingAnimation = "fireworks" | "glow" | "pulse";

const loadingAnimations = new Set<LoadingAnimation>(["fireworks", "glow", "pulse"]);

export type PiWebSettings = {
  version: 1;
  appearance: {
    density: "comfortable" | "compact";
    accentColor: string;
    loadingAnimation: LoadingAnimation;
  };
  composer: {
    queueMode: "steer" | "followUp";
    expanded: boolean;
  };
  defaults: {
    model?: PiWebModelSetting;
    thinkingLevel?: string;
    sessionBucketColor?: SessionMarkerColorId;
  };
  /**
   * Extension-contributed settings, keyed by namespaced owner id. Carried
   * through verbatim (bounds-only) so an absent/unregistered extension never
   * loses its config. Field-level validation happens server-side against the
   * live `activeSchemas` registry, not here.
   */
  extensions?: Record<string, StoredExtensionSettings>;
};

export type PiWebSettingsPatch = Partial<{
  appearance: Partial<{
    density: unknown;
    accentColor: unknown;
    loadingAnimation: unknown;
  }>;
  composer: Partial<{
    queueMode: unknown;
    expanded: unknown;
  }>;
  defaults: Partial<{
    model: unknown;
    thinkingLevel: unknown;
    sessionBucketColor: unknown;
  }>;
}>;

export const defaultPiWebSettings: PiWebSettings = {
  version: 1,
  appearance: {
    density: "comfortable",
    accentColor: defaultAccentColor,
    loadingAnimation: defaultLoadingAnimation,
  },
  composer: {
    queueMode: "steer",
    expanded: false,
  },
  defaults: {},
};

function cloneSettings(value: PiWebSettings): PiWebSettings {
  return JSON.parse(JSON.stringify(value)) as PiWebSettings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function serializedBytes(value: unknown): number | undefined {
  try {
    const json = JSON.stringify(value);
    if (typeof json !== "string") return undefined;
    return Buffer.byteLength(json);
  } catch {
    return undefined;
  }
}

/** Coerce one raw owner record into canonical shape, or undefined if unusable. */
function normalizeStoredExtension(value: unknown): StoredExtensionSettings | undefined {
  if (!isRecord(value) || !isRecord(value.values)) return undefined;
  const record: StoredExtensionSettings = {
    schemaVersion: Number.isFinite(value.schemaVersion) ? Number(value.schemaVersion) : 0,
    revision: Number.isFinite(value.revision) ? Number(value.revision) : 0,
    values: value.values,
  };
  if (isRecord(value.backup) && isRecord(value.backup.values)) {
    record.backup = {
      schemaVersion: Number.isFinite(value.backup.schemaVersion) ? Number(value.backup.schemaVersion) : 0,
      values: value.backup.values,
    };
  }
  // Bounds: drop the owner rather than corrupt it, but say so — silently losing
  // a user's stored configuration is worse than a noisy log.
  if (Object.keys(record.values).length > extensionSettingsLimits.maxKeysPerOwner) {
    console.warn(`pi-web: ignoring stored extension settings with too many keys (max ${extensionSettingsLimits.maxKeysPerOwner})`);
    return undefined;
  }
  const bytes = serializedBytes(record);
  if (bytes === undefined || bytes > extensionSettingsLimits.maxBytesPerOwner) {
    console.warn(`pi-web: ignoring stored extension settings that are not serializable or exceed ${extensionSettingsLimits.maxBytesPerOwner} bytes`);
    return undefined;
  }
  return record;
}

/** Preserve-verbatim (bounds-only) normalization for the extensions blob. */
export function normalizeExtensionSettings(value: unknown): Record<string, StoredExtensionSettings> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, StoredExtensionSettings> = {};
  let count = 0;
  for (const [id, raw] of Object.entries(value)) {
    if (count >= extensionSettingsLimits.maxOwners) break;
    if (!isValidExtensionOwnerId(id)) continue;
    const record = normalizeStoredExtension(raw);
    if (!record) continue;
    out[id] = record;
    count += 1;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Throw if a to-be-written owner record would exceed bounds. */
function assertOwnerWithinBounds(ownerId: string, record: StoredExtensionSettings): void {
  if (Object.keys(record.values).length > extensionSettingsLimits.maxKeysPerOwner) {
    throw new ExtensionSettingsBoundsError(ownerId, `too many keys (max ${extensionSettingsLimits.maxKeysPerOwner})`);
  }
  const bytes = serializedBytes(record);
  if (bytes === undefined) {
    throw new ExtensionSettingsBoundsError(ownerId, "values are not JSON-serializable");
  }
  if (bytes > extensionSettingsLimits.maxBytesPerOwner) {
    throw new ExtensionSettingsBoundsError(ownerId, `too large (${bytes} > ${extensionSettingsLimits.maxBytesPerOwner} bytes)`);
  }
}

/**
 * Write validated `values` for one owner, bumping `revision`. Field validation
 * is the caller's responsibility (done against the live schema). Optionally
 * enforces an optimistic revision guard and/or writes a migration backup.
 */
export function applyExtensionValues(
  current: PiWebSettings,
  ownerId: string,
  nextValues: JsonObject,
  opts?: {
    schemaVersion?: number;
    expectedRevision?: number;
    backup?: { schemaVersion: number; values: JsonObject };
  },
): PiWebSettings {
  if (!isValidExtensionOwnerId(ownerId)) {
    throw new ExtensionSettingsBoundsError(String(ownerId), "owner id must be namespaced (<ext>.<schema>)");
  }
  const next = cloneSettings(current);
  const existing = next.extensions?.[ownerId];
  const actualRevision = existing?.revision ?? 0;
  if (opts?.expectedRevision !== undefined && actualRevision !== opts.expectedRevision) {
    throw new ExtensionRevisionConflictError(ownerId, actualRevision, opts.expectedRevision);
  }
  const record: StoredExtensionSettings = {
    schemaVersion: opts?.schemaVersion ?? existing?.schemaVersion ?? 0,
    revision: (existing?.revision ?? 0) + 1,
    values: nextValues,
  };
  const backup = opts?.backup ?? existing?.backup;
  if (backup) record.backup = backup;
  assertOwnerWithinBounds(ownerId, record);
  next.extensions = { ...(next.extensions ?? {}), [ownerId]: record };
  if (Object.keys(next.extensions).length > extensionSettingsLimits.maxOwners) {
    throw new ExtensionSettingsBoundsError(ownerId, `too many extension owners (max ${extensionSettingsLimits.maxOwners})`);
  }
  return normalizeSettings(next);
}

/** Drop one owner's stored record entirely (reset), guarded by its current revision. */
export function resetExtensionValues(
  current: PiWebSettings,
  ownerId: string,
  expectedRevision: number,
): PiWebSettings {
  const next = cloneSettings(current);
  const existing = next.extensions?.[ownerId];
  if (existing && existing.revision !== expectedRevision) {
    throw new ExtensionRevisionConflictError(ownerId, existing.revision, expectedRevision);
  }
  if (next.extensions && ownerId in next.extensions) {
    delete next.extensions[ownerId];
    if (Object.keys(next.extensions).length === 0) delete next.extensions;
  }
  return normalizeSettings(next);
}

function normalizeModel(value: unknown) {
  if (!isRecord(value)) return undefined;
  const provider = typeof value.provider === "string" ? value.provider.trim() : "";
  const id = typeof value.id === "string" ? value.id.trim() : "";
  return provider && id ? { provider, id } : undefined;
}

export function normalizeSessionBucketColor(value: unknown): SessionMarkerColorId | undefined {
  return typeof value === "string" && sessionMarkerColors.has(value as SessionMarkerColorId)
    ? value as SessionMarkerColorId
    : undefined;
}

export function normalizeAccentColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const [, r, g, b] = trimmed;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return undefined;
}

export function normalizeLoadingAnimation(value: unknown): LoadingAnimation | undefined {
  return typeof value === "string" && loadingAnimations.has(value as LoadingAnimation)
    ? value as LoadingAnimation
    : undefined;
}

export function normalizeSettings(value: unknown): PiWebSettings {
  const settings = cloneSettings(defaultPiWebSettings);
  if (!isRecord(value)) return settings;

  const appearance = isRecord(value.appearance) ? value.appearance : undefined;
  if (appearance?.density === "compact" || appearance?.density === "comfortable") {
    settings.appearance.density = appearance.density;
  }
  settings.appearance.accentColor = normalizeAccentColor(appearance?.accentColor) || settings.appearance.accentColor;
  settings.appearance.loadingAnimation = normalizeLoadingAnimation(appearance?.loadingAnimation) || settings.appearance.loadingAnimation;

  const composer = isRecord(value.composer) ? value.composer : undefined;
  if (composer?.queueMode === "followUp" || composer?.queueMode === "steer") {
    settings.composer.queueMode = composer.queueMode;
  }
  if (typeof composer?.expanded === "boolean") settings.composer.expanded = composer.expanded;

  const defaults = isRecord(value.defaults) ? value.defaults : undefined;
  const model = normalizeModel(defaults?.model);
  if (model) settings.defaults.model = model;
  if (typeof defaults?.thinkingLevel === "string" && defaults.thinkingLevel.trim()) {
    settings.defaults.thinkingLevel = defaults.thinkingLevel.trim();
  }
  const sessionBucketColor = normalizeSessionBucketColor(defaults?.sessionBucketColor);
  if (sessionBucketColor) settings.defaults.sessionBucketColor = sessionBucketColor;

  const extensions = normalizeExtensionSettings(value.extensions);
  if (extensions) settings.extensions = extensions;

  return settings;
}

export function applySettingsPatch(current: PiWebSettings, patch: unknown): PiWebSettings {
  if (!isRecord(patch)) return cloneSettings(current);
  const next = cloneSettings(current);

  if (isRecord(patch.appearance)) {
    if (patch.appearance.density === "comfortable" || patch.appearance.density === "compact") {
      next.appearance.density = patch.appearance.density;
    }
    const accentColor = normalizeAccentColor(patch.appearance.accentColor);
    if (accentColor) next.appearance.accentColor = accentColor;
    const loadingAnimation = normalizeLoadingAnimation(patch.appearance.loadingAnimation);
    if (loadingAnimation) next.appearance.loadingAnimation = loadingAnimation;
  }

  if (isRecord(patch.composer)) {
    if (patch.composer.queueMode === "steer" || patch.composer.queueMode === "followUp") {
      next.composer.queueMode = patch.composer.queueMode;
    }
    if (typeof patch.composer.expanded === "boolean") next.composer.expanded = patch.composer.expanded;
  }

  if (isRecord(patch.defaults)) {
    if ("model" in patch.defaults) {
      const model = normalizeModel(patch.defaults.model);
      if (model) next.defaults.model = model;
      else delete next.defaults.model;
    }
    if ("thinkingLevel" in patch.defaults) {
      if (typeof patch.defaults.thinkingLevel === "string" && patch.defaults.thinkingLevel.trim()) {
        next.defaults.thinkingLevel = patch.defaults.thinkingLevel.trim();
      } else {
        delete next.defaults.thinkingLevel;
      }
    }
    if ("sessionBucketColor" in patch.defaults) {
      const sessionBucketColor = normalizeSessionBucketColor(patch.defaults.sessionBucketColor);
      if (sessionBucketColor) next.defaults.sessionBucketColor = sessionBucketColor;
      else delete next.defaults.sessionBucketColor;
    }
  }

  return normalizeSettings(next);
}

export function createSettingsStore(file: string) {
  let cached: PiWebSettings | undefined;
  let operationChain: Promise<void> = Promise.resolve();

  /** Keep every store operation ordered; mutation read/apply/write sequences never interleave. */
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationChain.then(operation);
    operationChain = result.then(() => undefined, () => undefined);
    return result;
  }

  async function readUnlocked() {
    if (cached) return cloneSettings(cached);
    try {
      cached = normalizeSettings(JSON.parse(await readFile(file, "utf-8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`Could not read pi-web settings at ${file}:`, error);
      }
      cached = cloneSettings(defaultPiWebSettings);
    }
    return cloneSettings(cached);
  }

  async function writeUnlocked(settings: PiWebSettings) {
    const normalized = normalizeSettings(settings);
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
    await rename(tmp, file);
    cached = normalized;
    return cloneSettings(cached);
  }

  function read() {
    return enqueue(readUnlocked);
  }

  function write(settings: PiWebSettings) {
    return enqueue(() => writeUnlocked(settings));
  }

  function patch(value: unknown) {
    return enqueue(async () => writeUnlocked(applySettingsPatch(await readUnlocked(), value)));
  }

  return { file, read, write, patch, patchExtension, resetExtension };

  /**
   * Persist already-validated `values` for one extension owner. Field-level
   * validation must be done by the caller against the live schema; this only
   * enforces bounds + the optional revision guard, then writes.
   */
  function patchExtension(
    ownerId: string,
    nextValues: JsonObject,
    opts?: {
      schemaVersion?: number;
      expectedRevision?: number;
      backup?: { schemaVersion: number; values: JsonObject };
    },
  ) {
    return enqueue(async () => writeUnlocked(applyExtensionValues(await readUnlocked(), ownerId, nextValues, opts)));
  }

  /** Drop one owner's stored record (reset to unconfigured). */
  function resetExtension(ownerId: string, expectedRevision: number) {
    return enqueue(async () => writeUnlocked(resetExtensionValues(await readUnlocked(), ownerId, expectedRevision)));
  }
}
