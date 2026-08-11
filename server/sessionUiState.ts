import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type SessionMarkerColorId = "blue" | "purple" | "yellow" | "red" | "green";

export type SessionLaneId = "pinned" | "parked" | "bookmarks";
export type SessionLaneEntry = { sessionId: string; lane: SessionLaneId; cwd?: string; note?: string; since: string };

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
  version: 2;
  revision: number;
  lanes: SessionLaneEntry[];
  pinnedFolders: string[];
  sessionMarkers: SessionMarker[];
  sessionUnreadStates: SessionUnreadState[];
  sessionOrigins: SessionOrigin[];
  selectedMarkerColor: SessionMarkerColorId;
  allowedMarkerColors: SessionMarkerColorId[];
};

export type SessionUiStatePatch = Partial<{
  lanes: unknown;
  pinnedSessions: unknown; // legacy v1 patch alias
  pinnedFolders: unknown;
  sessionMarkers: unknown;
  sessionUnreadStates: unknown;
  sessionOrigins: unknown;
  selectedMarkerColor: unknown;
  allowedMarkerColors: unknown;
}>;

const markerColors = new Set<SessionMarkerColorId>(["blue", "purple", "yellow", "red", "green"]);
const legacyBucketToColor: Record<string, SessionMarkerColorId> = {
  later: "blue",
  review: "purple",
  waiting: "yellow",
  important: "red",
  green: "green",
};

export const defaultSessionUiState: SessionUiState = {
  version: 2,
  revision: 0,
  lanes: [],
  pinnedFolders: [],
  sessionMarkers: [],
  sessionUnreadStates: [],
  sessionOrigins: [],
  selectedMarkerColor: "blue",
  allowedMarkerColors: [],
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

function normalizeLaneEntry(value: unknown): SessionLaneEntry | undefined {
  if (!isRecord(value)) return undefined;
  const sessionId = typeof value.sessionId === "string" ? value.sessionId.trim() : "";
  const lane = value.lane;
  if (!sessionId || (lane !== "pinned" && lane !== "parked" && lane !== "bookmarks")) return undefined;
  const cwd = typeof value.cwd === "string" && value.cwd.trim() ? value.cwd.trim() : undefined;
  const note = typeof value.note === "string" && value.note.trim() ? value.note.trim() : undefined;
  const parsedSince = typeof value.since === "string" ? new Date(value.since) : new Date(NaN);
  const since = Number.isNaN(parsedSince.getTime()) ? new Date().toISOString() : parsedSince.toISOString();
  return { sessionId, lane, ...(cwd ? { cwd } : {}), ...(note ? { note } : {}), since };
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
  return value;
}

function normalizePinnedFolder(value: unknown): string | undefined {
  const cwd = typeof value === "string" ? value.trim() : "";
  return cwd || undefined;
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

  if (Array.isArray(value.lanes)) state.lanes = uniqueBy(value.lanes.map(normalizeLaneEntry).filter(Boolean) as SessionLaneEntry[], (item) => item.sessionId);

  if (Array.isArray(value.pinnedFolders)) {
    state.pinnedFolders = uniqueBy(value.pinnedFolders.map(normalizePinnedFolder).filter(Boolean) as string[], (item) => item);
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
  return state;
}

export function applySessionUiStatePatch(current: SessionUiState, patch: unknown): SessionUiState {
  if (!isRecord(patch)) return cloneState(current);
  const next = cloneState(current);

  if ("lanes" in patch && Array.isArray(patch.lanes)) next.lanes = uniqueBy(patch.lanes.map(normalizeLaneEntry).filter(Boolean) as SessionLaneEntry[], (item) => item.sessionId);
  else if ("pinnedSessions" in patch && Array.isArray(patch.pinnedSessions)) {
    const pinned = patch.pinnedSessions.map((item) => isRecord(item) ? normalizeLaneEntry({ sessionId: item.id, lane: "pinned", cwd: item.cwd, since: new Date().toISOString() }) : undefined).filter(Boolean) as SessionLaneEntry[];
    next.lanes = [...uniqueBy(pinned, (item) => item.sessionId), ...next.lanes.filter((item) => item.lane !== "pinned")];
  }

  if ("pinnedFolders" in patch && Array.isArray(patch.pinnedFolders)) {
    next.pinnedFolders = uniqueBy(patch.pinnedFolders.map(normalizePinnedFolder).filter(Boolean) as string[], (item) => item);
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

  return normalizeSessionUiState(next);
}

export function createSessionUiStateStore(file: string) {
  let cached: SessionUiState | undefined;
  let writeQueue = Promise.resolve();

  async function serializeWrite<T>(operation: () => Promise<T>) {
    const result = writeQueue.then(operation, operation);
    writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function read() {
    if (cached) return cloneState(cached);
    try {
      const raw = JSON.parse(await readFile(file, "utf-8"));
      if (isRecord(raw) && typeof raw.version === "number" && raw.version > 2) {
        console.warn(`Refusing to read future session UI state version ${raw.version} at ${file}`);
        cached = cloneState(defaultSessionUiState);
      } else cached = normalizeSessionUiState(migrateSessionUiState(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`Could not read pi-web session UI state at ${file}:`, error);
      }
      cached = cloneState(defaultSessionUiState);
    }
    return cloneState(cached);
  }

  async function writeState(state: SessionUiState) {
    const normalized = normalizeSessionUiState(state);
    cached = { ...normalized, revision: Math.max(cached?.revision || 0, normalized.revision) + 1 };
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(cached, null, 2)}\n`, "utf-8");
    await rename(tmp, file);
    return cloneState(cached);
  }

  async function write(state: SessionUiState) {
    return serializeWrite(() => writeState(state));
  }

  async function patch(value: SessionUiStatePatch | unknown) {
    return serializeWrite(async () => writeState(applySessionUiStatePatch(await read(), value)));
  }

  async function markUnread(sessionId: string, unreadAt = new Date().toISOString()) {
    const id = sessionId.trim();
    if (!id) return read();
    return serializeWrite(async () => {
      const current = await read();
      if (current.sessionUnreadStates.some((item) => item.sessionId === id)) return current;
      const next: SessionUnreadState = { sessionId: id, unreadAt, updatedAt: new Date().toISOString() };
      return writeState({ ...current, sessionUnreadStates: [next, ...current.sessionUnreadStates] });
    });
  }

  async function markRead(sessionId: string) {
    const id = sessionId.trim();
    if (!id) return read();
    return serializeWrite(async () => {
      const current = await read();
      const sessionUnreadStates = current.sessionUnreadStates.filter((item) => item.sessionId !== id);
      if (sessionUnreadStates.length === current.sessionUnreadStates.length) return current;
      return writeState({ ...current, sessionUnreadStates });
    });
  }

  async function setSessionOrigin(sessionId: string, originSessionId: string, kind = "spawn") {
    const origin = normalizeSessionOrigin({ sessionId, originSessionId, kind });
    if (!origin) return read();
    return serializeWrite(async () => {
      const current = await read();
      const sessionOrigins = [origin, ...current.sessionOrigins.filter((item) => item.sessionId !== origin.sessionId)];
      return writeState({ ...current, sessionOrigins });
    });
  }

  async function removeSession(sessionId: string) {
    return serializeWrite(async () => {
      const current = await read();
      return writeState({
        ...current,
        lanes: current.lanes.filter((item) => item.sessionId !== sessionId),
        sessionMarkers: current.sessionMarkers.filter((item) => item.sessionId !== sessionId),
        sessionUnreadStates: current.sessionUnreadStates.filter((item) => item.sessionId !== sessionId),
        sessionOrigins: current.sessionOrigins.filter((item) => item.sessionId !== sessionId && item.originSessionId !== sessionId),
      });
    });
  }

  return { file, read, write, patch, markUnread, markRead, removeSession, setSessionOrigin };
}
