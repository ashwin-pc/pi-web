import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type SessionMarkerColorId = "blue" | "purple" | "yellow" | "red" | "green" | "orange" | "cyan" | "pink";

export type SessionLaneId = "pinned" | "parked" | "bookmarks";
export type SessionLaneEntry = { sessionId: string; lane: SessionLaneId; cwd?: string; since: string };

export type SessionNote = {
  sessionId: string;
  note: string;
  updatedAt: string;
};

export type SessionMarker = {
  sessionId: string;
  color: SessionMarkerColorId;
  updatedAt: string;
};

export type SessionUnreadState = {
  sessionId: string;
  unreadAt: string;
  updatedAt: string;
};

/**
 * Session creation provenance: records that `sessionId` was created by
 * `originSessionId` (e.g. kind "spawn" for orchestrated workers, or future
 * kinds like "continuation"). Written once at creation; immutable in spirit.
 */
export type SessionOrigin = {
  sessionId: string;
  originSessionId: string;
  kind: string;
  updatedAt: string;
};

export type SessionUiState = {
  version: 3;
  revision: number;
  initialized: boolean;
  lanes: SessionLaneEntry[];
  sessionNotes: SessionNote[];
  pinnedFolders: string[];
  favoriteFolders: string[];
  sessionMarkers: SessionMarker[];
  sessionUnreadStates: SessionUnreadState[];
  sessionOrigins: SessionOrigin[];
  selectedMarkerColor: SessionMarkerColorId;
  allowedMarkerColors: SessionMarkerColorId[];
  bucketLabels: Partial<Record<SessionMarkerColorId, string>>;
  bucketOrder: SessionMarkerColorId[];
};

export type SessionUiStatePatch = Partial<{
  lanes: unknown;
  pinnedSessions: unknown; // legacy v1 patch alias
  sessionNotes: unknown;
  pinnedFolders: unknown;
  favoriteFolders: unknown;
  sessionMarkers: unknown;
  sessionUnreadStates: unknown;
  sessionOrigins: unknown;
  selectedMarkerColor: unknown;
  allowedMarkerColors: unknown;
  bucketLabels: unknown;
  bucketOrder: unknown;
  expectedRevision: unknown;
  initialize: unknown;
  force: unknown; // ignored: never bypasses revision checks
}>;

export class SessionUiStatePreconditionError extends Error {
  constructor(readonly status: 428 | 400, message: string) { super(message); this.name = "SessionUiStatePreconditionError"; }
}
export class SessionUiStateConflictError extends Error {
  constructor(readonly revision: number, message = "Session UI state revision conflict") { super(message); this.name = "SessionUiStateConflictError"; }
}
export class SessionUiStateUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = "SessionUiStateUnavailableError"; }
}

const defaultBucketOrder: SessionMarkerColorId[] = ["blue", "purple", "yellow", "red", "green", "orange", "cyan", "pink"];
const markerColors = new Set<SessionMarkerColorId>(defaultBucketOrder);
const legacyBucketToColor: Record<string, SessionMarkerColorId> = {
  later: "blue",
  review: "purple",
  waiting: "yellow",
  important: "red",
  green: "green",
};

export const defaultSessionUiState: SessionUiState = {
  version: 3,
  revision: 0,
  initialized: false,
  lanes: [],
  sessionNotes: [],
  pinnedFolders: [],
  favoriteFolders: [],
  sessionMarkers: [],
  sessionUnreadStates: [],
  sessionOrigins: [],
  selectedMarkerColor: "blue",
  allowedMarkerColors: [],
  bucketLabels: {},
  bucketOrder: [...defaultBucketOrder],
};

function cloneState(value: SessionUiState): SessionUiState {
  return JSON.parse(JSON.stringify(value)) as SessionUiState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeMarkerColor(value: unknown): SessionMarkerColorId | undefined {
  return typeof value === "string" && markerColors.has(value as SessionMarkerColorId)
    ? value as SessionMarkerColorId
    : undefined;
}

function normalizeBucketLabels(value: unknown): Partial<Record<SessionMarkerColorId, string>> {
  if (!isRecord(value)) return {};
  const result: Partial<Record<SessionMarkerColorId, string>> = {};
  for (const [key, rawLabel] of Object.entries(value)) {
    const color = normalizeMarkerColor(key);
    const label = typeof rawLabel === "string" ? rawLabel.trim().slice(0, 40) : "";
    if (color && label) result[color] = label;
  }
  return result;
}

function normalizeMarkerColors(value: unknown): SessionMarkerColorId[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<SessionMarkerColorId>();
  const result: SessionMarkerColorId[] = [];
  for (const item of value) {
    const color = normalizeMarkerColor(item);
    if (!color || seen.has(color)) continue;
    seen.add(color);
    result.push(color);
  }
  return result;
}

function normalizeBucketOrder(value: unknown): SessionMarkerColorId[] {
  const ordered = normalizeMarkerColors(value);
  const seen = new Set(ordered);
  return [...ordered, ...defaultBucketOrder.filter((color) => !seen.has(color))];
}

function normalizeLaneEntry(value: unknown): SessionLaneEntry | undefined {
  if (!isRecord(value)) return undefined;
  const sessionId = typeof value.sessionId === "string" ? value.sessionId.trim() : "";
  const lane = value.lane;
  if (!sessionId || (lane !== "pinned" && lane !== "parked" && lane !== "bookmarks")) return undefined;
  const cwd = typeof value.cwd === "string" && value.cwd.trim() ? value.cwd.trim() : undefined;
  const parsedSince = typeof value.since === "string" ? new Date(value.since) : new Date(NaN);
  const since = Number.isNaN(parsedSince.getTime()) ? new Date().toISOString() : parsedSince.toISOString();
  return { sessionId, lane, ...(cwd ? { cwd } : {}), since };
}

export function migrateSessionUiState(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  let value = { ...raw };
  let version = typeof value.version === "number" ? value.version : 1;
  while (version === 1) {
    value = { ...value, version: 2, lanes: (Array.isArray(value.pinnedSessions) ? value.pinnedSessions : []).map((item) => isRecord(item) ? ({ sessionId: item.id, lane: "pinned", ...(item.cwd ? { cwd: item.cwd } : {}), since: new Date().toISOString() }) : item) };
    delete value.pinnedSessions;
    version = 2;
  }
  while (version === 2) {
    const lanes = Array.isArray(value.lanes) ? value.lanes : [];
    const migratedAt = new Date().toISOString();
    value = {
      ...value,
      version: 3,
      lanes: lanes.map((item) => {
        if (!isRecord(item)) return item;
        const { note: _note, ...lane } = item;
        return lane;
      }),
      sessionNotes: lanes.flatMap((item) => {
        if (!isRecord(item)) return [];
        const sessionId = typeof item.sessionId === "string" ? item.sessionId.trim() : "";
        const note = typeof item.note === "string" ? item.note.trim() : "";
        return sessionId && note ? [{ sessionId, note, updatedAt: migratedAt }] : [];
      }),
    };
    version = 3;
  }
  return value;
}

function normalizePinnedFolder(value: unknown): string | undefined {
  const cwd = typeof value === "string" ? value.trim() : "";
  return cwd || undefined;
}

function normalizeSessionNote(value: unknown): SessionNote | undefined {
  if (!isRecord(value)) return undefined;
  const sessionId = typeof value.sessionId === "string" ? value.sessionId.trim() : "";
  const note = typeof value.note === "string" ? value.note.trim() : "";
  if (!sessionId || !note) return undefined;
  const updatedAt = typeof value.updatedAt === "string" && value.updatedAt.trim() ? value.updatedAt.trim() : new Date().toISOString();
  return { sessionId, note, updatedAt };
}

function normalizeSessionMarker(value: unknown): SessionMarker | undefined {
  if (!isRecord(value)) return undefined;
  const sessionId = typeof value.sessionId === "string" ? value.sessionId.trim() : "";
  const color = normalizeMarkerColor(value.color) || (typeof value.bucket === "string" ? legacyBucketToColor[value.bucket] : undefined);
  const updatedAt = typeof value.updatedAt === "string" && value.updatedAt.trim() ? value.updatedAt.trim() : new Date().toISOString();
  if (!sessionId || !color) return undefined;
  return { sessionId, color, updatedAt };
}

function normalizeSessionUnreadState(value: unknown): SessionUnreadState | undefined {
  if (!isRecord(value)) return undefined;
  const sessionId = typeof value.sessionId === "string" ? value.sessionId.trim() : "";
  if (!sessionId) return undefined;
  const unreadAt = typeof value.unreadAt === "string" && value.unreadAt.trim() ? value.unreadAt.trim() : new Date().toISOString();
  const updatedAt = typeof value.updatedAt === "string" && value.updatedAt.trim() ? value.updatedAt.trim() : unreadAt;
  return { sessionId, unreadAt, updatedAt };
}

function normalizeSessionOrigin(value: unknown): SessionOrigin | undefined {
  if (!isRecord(value)) return undefined;
  const sessionId = typeof value.sessionId === "string" ? value.sessionId.trim() : "";
  const originSessionId = typeof value.originSessionId === "string" ? value.originSessionId.trim() : "";
  const kind = typeof value.kind === "string" && value.kind.trim() ? value.kind.trim() : "spawn";
  if (!sessionId || !originSessionId || sessionId === originSessionId) return undefined;
  const updatedAt = typeof value.updatedAt === "string" && value.updatedAt.trim() ? value.updatedAt.trim() : new Date().toISOString();
  return { sessionId, originSessionId, kind, updatedAt };
}

function uniqueBy<T>(items: T[], key: (item: T) => string) {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const id = key(item);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(item);
  }
  return result;
}

export function normalizeSessionUiState(value: unknown): SessionUiState {
  const state = cloneState(defaultSessionUiState);
  if (!isRecord(value)) return state;

  if (typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision >= 0) state.revision = value.revision;
  if (typeof value.initialized === "boolean") state.initialized = value.initialized;

  if (Array.isArray(value.lanes)) state.lanes = uniqueBy(value.lanes.map(normalizeLaneEntry).filter(Boolean) as SessionLaneEntry[], (item) => item.sessionId);

  const notes = Array.isArray(value.sessionNotes) ? value.sessionNotes.map(normalizeSessionNote).filter(Boolean) as SessionNote[] : [];
  const migratedLaneNotes = Array.isArray(value.lanes) ? value.lanes.map(normalizeSessionNote).filter(Boolean) as SessionNote[] : [];
  state.sessionNotes = uniqueBy([...notes, ...migratedLaneNotes], (item) => item.sessionId);

  if (Array.isArray(value.pinnedFolders)) {
    state.pinnedFolders = uniqueBy(value.pinnedFolders.map(normalizePinnedFolder).filter(Boolean) as string[], (item) => item);
  }
  if (Array.isArray(value.favoriteFolders)) {
    state.favoriteFolders = uniqueBy(value.favoriteFolders.map(normalizePinnedFolder).filter(Boolean) as string[], (item) => item);
  }

  if (Array.isArray(value.sessionMarkers)) {
    state.sessionMarkers = uniqueBy(value.sessionMarkers.map(normalizeSessionMarker).filter(Boolean) as SessionMarker[], (item) => item.sessionId);
  }

  if (Array.isArray(value.sessionUnreadStates)) {
    state.sessionUnreadStates = uniqueBy(value.sessionUnreadStates.map(normalizeSessionUnreadState).filter(Boolean) as SessionUnreadState[], (item) => item.sessionId);
  }

  if (Array.isArray(value.sessionOrigins)) {
    state.sessionOrigins = uniqueBy(value.sessionOrigins.map(normalizeSessionOrigin).filter(Boolean) as SessionOrigin[], (item) => item.sessionId);
  }

  state.selectedMarkerColor = normalizeMarkerColor(value.selectedMarkerColor) || state.selectedMarkerColor;
  state.allowedMarkerColors = normalizeMarkerColors(value.allowedMarkerColors);
  state.bucketLabels = normalizeBucketLabels(value.bucketLabels);
  state.bucketOrder = normalizeBucketOrder(value.bucketOrder);
  return state;
}

export function applySessionUiStatePatch(current: SessionUiState, patch: unknown): SessionUiState {
  if (!isRecord(patch)) return cloneState(current);
  const next = cloneState(current);

  if ("lanes" in patch && Array.isArray(patch.lanes)) next.lanes = uniqueBy(patch.lanes.map(normalizeLaneEntry).filter(Boolean) as SessionLaneEntry[], (item) => item.sessionId);
  else if ("pinnedSessions" in patch && Array.isArray(patch.pinnedSessions)) {
    const existingPinned = new Map(next.lanes.filter((item) => item.lane === "pinned").map((item) => [item.sessionId, item]));
    const pinned = patch.pinnedSessions.map((item) => isRecord(item) ? normalizeLaneEntry({ sessionId: item.id, lane: "pinned", cwd: item.cwd, since: existingPinned.get(typeof item.id === "string" ? item.id.trim() : "")?.since || new Date().toISOString() }) : undefined).filter(Boolean) as SessionLaneEntry[];
    next.lanes = [...uniqueBy(pinned, (item) => item.sessionId), ...next.lanes.filter((item) => item.lane !== "pinned")];
  }

  if ("sessionNotes" in patch && Array.isArray(patch.sessionNotes)) {
    next.sessionNotes = uniqueBy(patch.sessionNotes.map(normalizeSessionNote).filter(Boolean) as SessionNote[], (item) => item.sessionId);
  }

  if ("pinnedFolders" in patch && Array.isArray(patch.pinnedFolders)) {
    next.pinnedFolders = uniqueBy(patch.pinnedFolders.map(normalizePinnedFolder).filter(Boolean) as string[], (item) => item);
  }
  if ("favoriteFolders" in patch && Array.isArray(patch.favoriteFolders)) {
    next.favoriteFolders = uniqueBy(patch.favoriteFolders.map(normalizePinnedFolder).filter(Boolean) as string[], (item) => item);
  }

  if ("sessionMarkers" in patch && Array.isArray(patch.sessionMarkers)) {
    next.sessionMarkers = uniqueBy(patch.sessionMarkers.map(normalizeSessionMarker).filter(Boolean) as SessionMarker[], (item) => item.sessionId);
  }

  if ("sessionUnreadStates" in patch && Array.isArray(patch.sessionUnreadStates)) {
    next.sessionUnreadStates = uniqueBy(patch.sessionUnreadStates.map(normalizeSessionUnreadState).filter(Boolean) as SessionUnreadState[], (item) => item.sessionId);
  }

  if ("sessionOrigins" in patch && Array.isArray(patch.sessionOrigins)) {
    next.sessionOrigins = uniqueBy(patch.sessionOrigins.map(normalizeSessionOrigin).filter(Boolean) as SessionOrigin[], (item) => item.sessionId);
  }

  const selectedMarkerColor = normalizeMarkerColor(patch.selectedMarkerColor);
  if (selectedMarkerColor) next.selectedMarkerColor = selectedMarkerColor;

  if ("allowedMarkerColors" in patch && Array.isArray(patch.allowedMarkerColors)) {
    next.allowedMarkerColors = normalizeMarkerColors(patch.allowedMarkerColors);
  }
  if ("bucketLabels" in patch && isRecord(patch.bucketLabels)) {
    next.bucketLabels = normalizeBucketLabels(patch.bucketLabels);
  }
  if ("bucketOrder" in patch && Array.isArray(patch.bucketOrder)) {
    next.bucketOrder = normalizeBucketOrder(patch.bucketOrder);
  }

  return normalizeSessionUiState(next);
}

function validPersistedState(raw: unknown): SessionUiState {
  if (!isRecord(raw)) throw new Error("Invalid session UI state object");
  const version = raw.version === undefined ? 1 : raw.version;
  // Persisted v2/v3 always include lanes; legacy v1 always includes pinnedSessions.
  // Revision-only and preference-only fragments are damaged files, not empty history.
  if ((version === 1 && !Array.isArray(raw.pinnedSessions)) || ((version === 2 || version === 3) && !Array.isArray(raw.lanes))) throw new Error("Incomplete session UI state");
  if (!Number.isSafeInteger(version) || (version as number) < 1 || (version as number) > 3) throw new Error(`Unsupported session UI state version ${String(version)}`);
  if (raw.revision !== undefined && (!Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0)) throw new Error("Invalid session UI state revision");
  if (raw.initialized !== undefined && raw.initialized !== true) throw new Error("Invalid persisted initialization marker");
  const arrays = ["lanes", "sessionNotes", "pinnedFolders", "favoriteFolders", "sessionMarkers", "sessionUnreadStates", "sessionOrigins", "allowedMarkerColors", "bucketOrder"];
  for (const key of arrays) if (key in raw && !Array.isArray(raw[key])) throw new Error(`Invalid ${key}`);
  if ("pinnedSessions" in raw && !Array.isArray(raw.pinnedSessions)) throw new Error("Invalid pinnedSessions");
  for (const key of ["pinnedFolders", "favoriteFolders"]) if (Array.isArray(raw[key]) && !raw[key].every((item) => typeof item === "string" && item.trim())) throw new Error(`Invalid ${key} entry`);
  if ("selectedMarkerColor" in raw && !normalizeMarkerColor(raw.selectedMarkerColor)) throw new Error("Invalid selectedMarkerColor");
  for (const key of ["allowedMarkerColors", "bucketOrder"]) if (Array.isArray(raw[key]) && !raw[key].every((item) => normalizeMarkerColor(item))) throw new Error(`Invalid ${key} entry`);
  if ("bucketLabels" in raw && (!isRecord(raw.bucketLabels) || !Object.entries(raw.bucketLabels).every(([key, label]) => normalizeMarkerColor(key) && typeof label === "string"))) throw new Error("Invalid bucketLabels");
  const migrated = migrateSessionUiState(raw);
  if (!isRecord(migrated)) throw new Error("Invalid migrated state");
  const timestamp = (value: unknown) => value === undefined || (typeof value === "string" && !Number.isNaN(Date.parse(value)));
  const entries: [string, (item: unknown) => boolean][] = [
    ["lanes", (item) => Boolean(normalizeLaneEntry(item)) && isRecord(item) && typeof item.since === "string" && timestamp(item.since) && (item.cwd === undefined || typeof item.cwd === "string")],
    ["sessionNotes", (item) => Boolean(normalizeSessionNote(item)) && isRecord(item) && timestamp(item.updatedAt)],
    ["sessionMarkers", (item) => Boolean(normalizeSessionMarker(item)) && isRecord(item) && timestamp(item.updatedAt)],
    ["sessionUnreadStates", (item) => Boolean(normalizeSessionUnreadState(item)) && isRecord(item) && timestamp(item.unreadAt) && timestamp(item.updatedAt)],
    ["sessionOrigins", (item) => Boolean(normalizeSessionOrigin(item)) && isRecord(item) && timestamp(item.updatedAt)],
  ];
  for (const [key, valid] of entries) if (key in migrated && (!Array.isArray(migrated[key]) || !migrated[key].every(valid))) throw new Error(`Invalid ${key} entry`);
  if (version === 1 && (raw.pinnedSessions !== undefined && (!Array.isArray(raw.pinnedSessions) || !raw.pinnedSessions.every((item) => isRecord(item) && typeof item.id === "string" && item.id.trim() && (item.cwd === undefined || typeof item.cwd === "string"))))) throw new Error("Invalid pinnedSessions entry");
  return { ...normalizeSessionUiState(migrated), initialized: true };
}

export function createSessionUiStateStore(file: string, hooks: { beforeLoad?: () => Promise<void>; beforePrimaryCommit?: () => Promise<void>; beforeMirror?: () => Promise<void> } = {}) {
  let cached: SessionUiState | undefined;
  let loadPromise: Promise<SessionUiState> | undefined;
  let highWater = 0;
  let writeQueue = Promise.resolve();
  const historyFile = `${file}.history.json`;
  const backup = (index: number) => `${file}.bak-${index}.json`;
  const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
  let tempSequence = 0;
  const tempPath = (target: string) => `${target}.${process.pid}.${++tempSequence}.tmp`;

  async function atomicFile(target: string, contents: string) {
    const temp = tempPath(target);
    try { await writeFile(temp, contents, { flag: "wx" }); await rename(temp, target); }
    catch (error) { await rm(temp, { force: true }).catch(() => undefined); throw error; }
  }
  async function reserveRevision(revision: number) {
    await atomicFile(historyFile, `${JSON.stringify({ highWater: revision })}\n`);
    highWater = revision;
  }
  async function serializeWrite<T>(operation: () => Promise<T>) {
    const result = writeQueue.then(operation, operation);
    writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }
  async function readValidated(path: string) {
    return validPersistedState(JSON.parse(await readFile(path, "utf-8")));
  }
  async function loadCommitted() {
    if (cached) return cloneState(cached);
    if (loadPromise) return cloneState(await loadPromise);
    loadPromise = loadFromDisk();
    try { return cloneState(await loadPromise); }
    finally { loadPromise = undefined; }
  }
  async function read() { return serializeWrite(loadCommitted); }
  async function loadFromDisk(): Promise<SessionUiState> {
    await hooks.beforeLoad?.();
    let historyExists = false;
    try {
      const history = JSON.parse(await readFile(historyFile, "utf-8"));
      if (!isRecord(history) || !Number.isSafeInteger(history.highWater) || (history.highWater as number) < 0) throw new Error("Invalid revision history");
      highWater = history.highWater as number;
      historyExists = true;
    } catch (error) { if (!missing(error)) throw new SessionUiStateUnavailableError(`Cannot read session UI history: ${String(error)}`); }
    let primaryMissing = false;
    let primaryError: unknown;
    try {
      const primary = await readValidated(file);
      if (primary.revision > highWater) { await reserveRevision(primary.revision); }
      cached = primary;
      return cloneState(primary);
    } catch (error) { primaryMissing = missing(error); primaryError = error; }
    // Never use backups to downgrade an unsupported future-format primary.
    if (!primaryMissing) {
      try {
        const raw = JSON.parse(await readFile(file, "utf-8"));
        if (isRecord(raw) && typeof raw.version === "number" && raw.version > 3) throw new SessionUiStateUnavailableError(`Unsupported session UI state version ${raw.version}`);
      } catch (error) { if (error instanceof SessionUiStateUnavailableError) throw error; }
    }
    let recovered: SessionUiState | undefined;
    let backupExists = false;
    for (let index = 1; index <= 5; index++) {
      try {
        const candidate = await readValidated(backup(index));
        backupExists = true;
        if (!recovered || candidate.revision > recovered.revision) recovered = candidate;
      } catch (error) {
        if (!missing(error)) backupExists = true;
      }
    }
    if (!recovered) {
      if (primaryMissing && !historyExists && !backupExists) return cloneState(cached = cloneState(defaultSessionUiState));
      throw new SessionUiStateUnavailableError(`Session UI state unavailable; no valid backup (${String(primaryError)})`);
    }
    // Preserve damaged primary bytes for investigation; recovery is a new, strictly higher revision.
    if (!primaryMissing) await rename(file, `${file}.corrupt-${Date.now()}-${process.pid}`);
    const revision = Math.max(highWater, recovered.revision) + 1;
    if (!Number.isSafeInteger(revision)) throw new SessionUiStateUnavailableError("Session UI state revision exhausted");
    const next = { ...recovered, initialized: true, revision };
    try {
      await reserveRevision(next.revision);
      await atomicFile(file, `${JSON.stringify(next, null, 2)}\n`);
    } catch (error) { throw new SessionUiStateUnavailableError(`Cannot restore session UI state: ${String(error)}`); }
    cached = next;
    return cloneState(next);
  }

  async function rotateBackups(current: SessionUiState) {
    // Back up validated state only; preserve the immediately preceding commit before replacing primary.
    for (let index = 5; index >= 2; index--) {
      try { await rename(backup(index - 1), backup(index)); }
      catch (error) { if (!missing(error)) throw error; }
    }
    await atomicFile(backup(1), `${JSON.stringify(current, null, 2)}\n`);
  }
  async function writeState(state: SessionUiState) {
    const current = await loadCommitted();
    const revision = Math.max(current.revision, highWater) + 1;
    if (!Number.isSafeInteger(revision)) throw new SessionUiStateUnavailableError("Session UI state revision exhausted");
    const next: SessionUiState = { ...normalizeSessionUiState(state), initialized: true, revision };
    // The same validator used on restart must accept every state we commit.
    // Validate before touching history, backups, temp files, or the cache.
    try { validPersistedState(next); }
    catch { throw new SessionUiStatePreconditionError(400, "Invalid session UI state payload"); }
    await mkdir(dirname(file), { recursive: true });
    const temp = tempPath(file);
    try {
      await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx" });
      if (current.initialized) await rotateBackups(current);
      await reserveRevision(next.revision);
      await hooks.beforePrimaryCommit?.();
      // Atomic primary rename is the commit point. No fallible work after it before cache publish.
      await rename(temp, file);
      cached = next;
      // Mirror latest committed state inside the five slots, including on the first write.
      // Post-commit mirror failure is logged, never reported as a failed PATCH.
      try {
        await hooks.beforeMirror?.();
        await atomicFile(backup(1), `${JSON.stringify(next, null, 2)}\n`);
      } catch (error) { console.warn(`Could not mirror committed session UI state at ${file}:`, error); }
      return cloneState(next);
    } catch (error) {
      // A reserved revision without a committed primary must be re-evaluated from disk.
      cached = undefined;
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  async function update(reducer: (current: SessionUiState) => SessionUiState | undefined) {
    return serializeWrite(async () => {
      const current = await loadCommitted();
      const next = reducer(current);
      return next ? writeState(next) : current;
    });
  }
  async function reset() { return update(() => cloneState(defaultSessionUiState)); }
  async function patch(value: SessionUiStatePatch | unknown) {
    if (!isRecord(value) || !Object.hasOwn(value, "expectedRevision")) throw new SessionUiStatePreconditionError(428, "expectedRevision is required");
    if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0) throw new SessionUiStatePreconditionError(400, "expectedRevision must be a safe nonnegative integer");
    if ("initialize" in value && value.initialize !== true) throw new SessionUiStatePreconditionError(400, "initialize must be true when provided");
    return update((current) => {
      if (value.expectedRevision !== current.revision) throw new SessionUiStateConflictError(current.revision);
      if (value.initialize === true && (current.initialized || current.revision !== 0)) throw new SessionUiStateConflictError(current.revision, "Session UI state already initialized");
      return applySessionUiStatePatch(current, value);
    });
  }

  async function markUnread(sessionId: string, unreadAt = new Date().toISOString()) {
    const id = sessionId.trim();
    if (!id) return read();
    return update((current) => {
      if (current.sessionUnreadStates.some((item) => item.sessionId === id)) return undefined;
      const next: SessionUnreadState = { sessionId: id, unreadAt, updatedAt: new Date().toISOString() };
      return { ...current, sessionUnreadStates: [next, ...current.sessionUnreadStates] };
    });
  }

  async function markRead(sessionId: string) {
    const id = sessionId.trim();
    if (!id) return read();
    return update((current) => {
      const sessionUnreadStates = current.sessionUnreadStates.filter((item) => item.sessionId !== id);
      return sessionUnreadStates.length === current.sessionUnreadStates.length ? undefined : { ...current, sessionUnreadStates };
    });
  }

  async function setSessionOrigin(sessionId: string, originSessionId: string, kind = "spawn") {
    const origin = normalizeSessionOrigin({ sessionId, originSessionId, kind });
    if (!origin) return read();
    return update((current) => ({ ...current, sessionOrigins: [origin, ...current.sessionOrigins.filter((item) => item.sessionId !== origin.sessionId)] }));
  }

  async function removeSession(sessionId: string) {
    return update((current) => ({
      ...current,
      lanes: current.lanes.filter((item) => item.sessionId !== sessionId),
      sessionNotes: current.sessionNotes.filter((item) => item.sessionId !== sessionId),
      sessionMarkers: current.sessionMarkers.filter((item) => item.sessionId !== sessionId),
      sessionUnreadStates: current.sessionUnreadStates.filter((item) => item.sessionId !== sessionId),
      sessionOrigins: current.sessionOrigins.filter((item) => item.sessionId !== sessionId && item.originSessionId !== sessionId),
    }));
  }

  return { file, read, update, reset, patch, markUnread, markRead, removeSession, setSessionOrigin };
}
