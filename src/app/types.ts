export type Role = "user" | "assistant" | "tool" | "system";

export type PiEvent = {
  type: string;
  [key: string]: any;
};

export type QueueMode = "steer" | "followUp";

export type SlashCommandSource = "web" | "extension" | "prompt" | "skill";

export type SlashCommand = {
  name: string;
  description?: string;
  source: SlashCommandSource;
  sourceInfo?: {
    path?: string;
    source?: string;
    scope?: string;
    origin?: string;
    baseDir?: string;
  };
};

export type ImageAttachment = {
  type: "image";
  data: string;
  mimeType: string;
  name: string;
};

export type PiWebModelSetting = {
  provider: string;
  id: string;
};

export type ContextUsage = {
  tokens?: number | null;
  contextWindow?: number | null;
  percent?: number | null;
};

export type SessionStats = {
  userMessages?: number;
  assistantMessages?: number;
  toolResults?: number;
  totalMessages?: number;
  tokens?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  cost?: number;
  contextUsage?: ContextUsage | null;
};

export type PiWebSettings = {
  version: 1;
  appearance: {
    density: "comfortable" | "compact";
  };
  composer: {
    queueMode: QueueMode;
    expanded: boolean;
  };
  defaults: {
    model?: PiWebModelSetting;
    thinkingLevel?: string;
    sessionBucketColor?: SessionMarkerColorId;
  };
};

export type AttachedImage = {
  data?: string;
  mimeType?: string;
  path?: string;
};

export type PinnedSession = { id: string; label: string; cwd?: string };
export type SessionMarkerColorId = "blue" | "purple" | "yellow" | "red" | "green";
export type SessionMarkerColor = { id: SessionMarkerColorId; label: string };
export type SessionMarker = { sessionId: string; color: SessionMarkerColorId; note?: string; updatedAt: string };
export type SessionUiState = {
  version: 1;
  pinnedSessions: PinnedSession[];
  pinnedFolders: string[];
  sessionMarkers: SessionMarker[];
  selectedMarkerColor: SessionMarkerColorId;
};

export const sessionMarkerColors: SessionMarkerColor[] = [
  { id: "blue", label: "Blue" },
  { id: "purple", label: "Purple" },
  { id: "yellow", label: "Yellow" },
  { id: "red", label: "Red" },
  { id: "green", label: "Green" },
];

export const defaultSessionUiState: SessionUiState = {
  version: 1,
  pinnedSessions: [],
  pinnedFolders: [],
  sessionMarkers: [],
  selectedMarkerColor: "blue",
};

const markerColorIds = new Set<SessionMarkerColorId>(sessionMarkerColors.map((color) => color.id));
const legacyMarkerBucketToColor: Record<string, SessionMarkerColorId> = {
  later: "blue",
  review: "purple",
  waiting: "yellow",
  important: "red",
  green: "green",
};

const pinnedSessionsKey = "pi-web-pinned-sessions";
const pinnedFoldersKey = "pi-web-pinned-folders";
const sessionMarkersKey = "pi-web-session-markers";
const selectedMarkerColorKey = "pi-web-selected-session-marker-color";

export function normalizeMarkerColor(value: unknown): SessionMarkerColorId | undefined {
  return typeof value === "string" && markerColorIds.has(value as SessionMarkerColorId)
    ? value as SessionMarkerColorId
    : undefined;
}

export function normalizePinnedFolders(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    const cwd = typeof item === "string" ? item.trim() : "";
    if (!cwd || seen.has(cwd)) continue;
    seen.add(cwd);
    result.push(cwd);
  }
  return result;
}

export function normalizePinnedSessions(value: unknown): PinnedSession[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: PinnedSession[] = [];
  for (const item of value) {
    const id = typeof item?.id === "string" ? item.id.trim() : "";
    const label = typeof item?.label === "string" ? item.label.trim() : "";
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    const cwd = typeof item?.cwd === "string" && item.cwd.trim() ? item.cwd.trim() : undefined;
    result.push({ id, label, ...(cwd ? { cwd } : {}) });
  }
  return result;
}

export function normalizeSessionMarkers(value: unknown): SessionMarker[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: SessionMarker[] = [];
  for (const item of value) {
    const sessionId = typeof item?.sessionId === "string" ? item.sessionId.trim() : "";
    const color = normalizeMarkerColor(item?.color) || (typeof item?.bucket === "string" ? legacyMarkerBucketToColor[item.bucket] : undefined);
    if (!sessionId || !color || seen.has(sessionId)) continue;
    seen.add(sessionId);
    result.push({ sessionId, color, updatedAt: typeof item?.updatedAt === "string" ? item.updatedAt : new Date().toISOString() });
  }
  return result;
}

export function normalizeSessionUiState(value: unknown): SessionUiState {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    version: 1,
    pinnedSessions: normalizePinnedSessions(raw.pinnedSessions),
    pinnedFolders: normalizePinnedFolders(raw.pinnedFolders),
    sessionMarkers: normalizeSessionMarkers(raw.sessionMarkers),
    selectedMarkerColor: normalizeMarkerColor(raw.selectedMarkerColor) || defaultSessionUiState.selectedMarkerColor,
  };
}

export function readLegacyPinnedSessions(): PinnedSession[] {
  try {
    return normalizePinnedSessions(JSON.parse(localStorage.getItem(pinnedSessionsKey) || "[]"));
  } catch { return []; }
}

export function readLegacyPinnedFolders(): string[] {
  try {
    return normalizePinnedFolders(JSON.parse(localStorage.getItem(pinnedFoldersKey) || "[]"));
  } catch { return []; }
}

export function readLegacySessionMarkers(): SessionMarker[] {
  try {
    return normalizeSessionMarkers(JSON.parse(localStorage.getItem(sessionMarkersKey) || "[]"));
  } catch { return []; }
}

export function readLegacySelectedMarkerColor(): SessionMarkerColorId | undefined {
  return normalizeMarkerColor(localStorage.getItem(selectedMarkerColorKey));
}

export type SessionInfo = {
  id: string;
  name?: string;
  firstMessage?: string;
  created: string;
  modified: string;
  messageCount: number;
  cwd?: string;
  isCurrent: boolean;
  runtime?: {
    loaded: boolean;
    isRunning: boolean;
    isStreaming: boolean;
    isCompacting: boolean;
    startedAt?: string;
    pendingMessageCount: number;
  };
};

export type AppState = {
  token: string;
  currentModelKey: string;
  currentModelDisplay: string;
  currentThinkingLevel: string;
  currentSessionId: string;
  currentCwd: string;
  currentSessionTitle: string;
  statusTitleEditing: boolean;
  isStreaming: boolean;
  isCompacting: boolean;
  wsHasOpened: boolean;
  wsDisconnected: boolean;
  initialSyncComplete: boolean;
  lastRealtimeSeq: number;
  reconnectNoticeTimer: number | undefined;
  connectionLostTimer: number | undefined;
  reconnectedClearTimer: number | undefined;
  pinnedSessions: PinnedSession[];
  pinnedFolders: string[];
  sessionMarkers: SessionMarker[];
  selectedMarkerColor: SessionMarkerColorId;
  collapsedSessionFolders: Set<string>;
  expandedSessionFolders: Set<string>;
  queueMode: QueueMode;
  attachedImages: ImageAttachment[];
  editorExpanded: boolean;
  settings: PiWebSettings;
  stats?: SessionStats;
};

export const reconnectDelayMs = 1500;
export const reconnectNoticeDelayMs = 2500;
export const connectionLostDelayMs = 15000;
export const sessionFolderPreviewLimit = 8;

export const defaultPiWebSettings: PiWebSettings = {
  version: 1,
  appearance: { density: "comfortable" },
  composer: { queueMode: "steer", expanded: false },
  defaults: {},
};

const tokenStorageKey = "pi-web-token";
const collapsedFoldersStorageKey = "pi-web-collapsed-session-folders";
const sessionIdUrlParam = "sessionId";

function consumeUrlToken() {
  const urlToken = new URLSearchParams(location.search).get("token");
  if (!urlToken) return;

  localStorage.setItem(tokenStorageKey, urlToken);
  const url = new URL(location.href);
  url.searchParams.delete("token");
  history.replaceState(null, "", url.toString());
}

export function readActiveSessionIdFromUrl() {
  return new URLSearchParams(location.search).get(sessionIdUrlParam) || "";
}

export function writeActiveSessionIdToUrl(sessionId: string, mode: "push" | "replace" = "push") {
  const url = new URL(location.href);
  if (sessionId) url.searchParams.set(sessionIdUrlParam, sessionId);
  else url.searchParams.delete(sessionIdUrlParam);
  if (url.href === location.href) return;
  history[mode === "replace" ? "replaceState" : "pushState"](null, "", url.toString());
}

function readCollapsedSessionFolders() {
  try {
    const raw = JSON.parse(localStorage.getItem(collapsedFoldersStorageKey) || "[]");
    return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

export function persistCollapsedSessionFolders(folders: Set<string>) {
  localStorage.setItem(collapsedFoldersStorageKey, JSON.stringify(Array.from(folders)));
}

export function createAppState(): AppState {
  consumeUrlToken();

  return {
    token: localStorage.getItem(tokenStorageKey) || "",
    currentModelKey: "",
    currentModelDisplay: "No model",
    currentThinkingLevel: "off",
    currentSessionId: readActiveSessionIdFromUrl(),
    currentCwd: "",
    currentSessionTitle: "New session",
    statusTitleEditing: false,
    isStreaming: false,
    isCompacting: false,
    wsHasOpened: false,
    wsDisconnected: false,
    initialSyncComplete: false,
    lastRealtimeSeq: 0,
    reconnectNoticeTimer: undefined,
    connectionLostTimer: undefined,
    reconnectedClearTimer: undefined,
    pinnedSessions: readLegacyPinnedSessions(),
    pinnedFolders: readLegacyPinnedFolders(),
    sessionMarkers: readLegacySessionMarkers(),
    selectedMarkerColor: readLegacySelectedMarkerColor() || defaultSessionUiState.selectedMarkerColor,
    collapsedSessionFolders: new Set(readCollapsedSessionFolders()),
    expandedSessionFolders: new Set(),
    queueMode: "steer",
    attachedImages: [],
    editorExpanded: defaultPiWebSettings.composer.expanded,
    settings: defaultPiWebSettings,
    stats: undefined,
  };
}

export function saveToken(token: string) {
  localStorage.setItem(tokenStorageKey, token);
}

export function clearToken() {
  localStorage.removeItem(tokenStorageKey);
}
