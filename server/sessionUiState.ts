import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type SessionMarkerColorId = "blue" | "purple" | "yellow" | "red" | "green";

export type PinnedSession = {
  id: string;
  label: string;
  cwd?: string;
};

export type SessionMarker = {
  sessionId: string;
  color: SessionMarkerColorId;
  updatedAt: string;
};

export type SessionUiState = {
  version: 1;
  pinnedSessions: PinnedSession[];
  pinnedFolders: string[];
  sessionMarkers: SessionMarker[];
  selectedMarkerColor: SessionMarkerColorId;
};

export type SessionUiStatePatch = Partial<{
  pinnedSessions: unknown;
  pinnedFolders: unknown;
  sessionMarkers: unknown;
  selectedMarkerColor: unknown;
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
  version: 1,
  pinnedSessions: [],
  pinnedFolders: [],
  sessionMarkers: [],
  selectedMarkerColor: "blue",
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

function normalizePinnedFolder(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizePinnedSession(value: unknown): PinnedSession | undefined {
  if (!isRecord(value)) return undefined;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const label = typeof value.label === "string" ? value.label.trim() : "";
  if (!id || !label) return undefined;
  const cwd = typeof value.cwd === "string" && value.cwd.trim() ? value.cwd.trim() : undefined;
  return { id, label, ...(cwd ? { cwd } : {}) };
}

function normalizeSessionMarker(value: unknown): SessionMarker | undefined {
  if (!isRecord(value)) return undefined;
  const sessionId = typeof value.sessionId === "string" ? value.sessionId.trim() : "";
  const color = normalizeMarkerColor(value.color) || (typeof value.bucket === "string" ? legacyBucketToColor[value.bucket] : undefined);
  const updatedAt = typeof value.updatedAt === "string" && value.updatedAt.trim() ? value.updatedAt.trim() : new Date().toISOString();
  if (!sessionId || !color) return undefined;
  return { sessionId, color, updatedAt };
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

  if (Array.isArray(value.pinnedSessions)) {
    state.pinnedSessions = uniqueBy(value.pinnedSessions.map(normalizePinnedSession).filter(Boolean) as PinnedSession[], (item) => item.id);
  }

  if (Array.isArray(value.pinnedFolders)) {
    state.pinnedFolders = uniqueBy(value.pinnedFolders.map(normalizePinnedFolder).filter(Boolean) as string[], (item) => item);
  }

  if (Array.isArray(value.sessionMarkers)) {
    state.sessionMarkers = uniqueBy(value.sessionMarkers.map(normalizeSessionMarker).filter(Boolean) as SessionMarker[], (item) => item.sessionId);
  }

  state.selectedMarkerColor = normalizeMarkerColor(value.selectedMarkerColor) || state.selectedMarkerColor;
  return state;
}

export function applySessionUiStatePatch(current: SessionUiState, patch: unknown): SessionUiState {
  if (!isRecord(patch)) return cloneState(current);
  const next = cloneState(current);

  if ("pinnedSessions" in patch && Array.isArray(patch.pinnedSessions)) {
    next.pinnedSessions = uniqueBy(patch.pinnedSessions.map(normalizePinnedSession).filter(Boolean) as PinnedSession[], (item) => item.id);
  }

  if ("pinnedFolders" in patch && Array.isArray(patch.pinnedFolders)) {
    next.pinnedFolders = uniqueBy(patch.pinnedFolders.map(normalizePinnedFolder).filter(Boolean) as string[], (item) => item);
  }

  if ("sessionMarkers" in patch && Array.isArray(patch.sessionMarkers)) {
    next.sessionMarkers = uniqueBy(patch.sessionMarkers.map(normalizeSessionMarker).filter(Boolean) as SessionMarker[], (item) => item.sessionId);
  }

  const selectedMarkerColor = normalizeMarkerColor(patch.selectedMarkerColor);
  if (selectedMarkerColor) next.selectedMarkerColor = selectedMarkerColor;

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
      cached = normalizeSessionUiState(JSON.parse(await readFile(file, "utf-8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`Could not read pi-web session UI state at ${file}:`, error);
      }
      cached = cloneState(defaultSessionUiState);
    }
    return cloneState(cached);
  }

  async function writeState(state: SessionUiState) {
    cached = normalizeSessionUiState(state);
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

  async function removeSession(sessionId: string) {
    return serializeWrite(async () => {
      const current = await read();
      return writeState({
        ...current,
        pinnedSessions: current.pinnedSessions.filter((item) => item.id !== sessionId),
        sessionMarkers: current.sessionMarkers.filter((item) => item.sessionId !== sessionId),
      });
    });
  }

  return { file, read, write, patch, removeSession };
}
