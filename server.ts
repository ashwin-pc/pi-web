import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createMockHarness } from "./server/mock.js";
import { resolveBundledExtensionPaths, resolvePiWebExtensionPaths } from "./server/extensions.js";
import { createSessionUiStateStore, defaultSessionUiState } from "./server/sessionUiState.js";
import { ExtensionRevisionConflictError, ExtensionSettingsBoundsError } from "./server/settings.js";
import { defaultSettingsValues, validateSettingsValues } from "./server/extensionSettings.js";
import { findArtifactFile, isValidArtifactPath } from "./server/shared/artifacts.js";
import { normalizeSubmittedAttachments, resolveAttachmentFile, storeAttachment } from "./server/shared/attachments.js";
import { assertDirectory, createDirectory, listDirectories } from "./server/shared/fsList.js";
import { gitCommitDetails, gitCwdFromRepoParam, gitDiff, gitLog, gitStatus, gitSync, isGitRepo, listGitRepos, readGitImage } from "./server/shared/git.js";
import { listWorkspaceDirectory, readWorkspaceFile, readWorkspaceImage, WorkspaceFileError, writeWorkspaceFile } from "./server/shared/workspaceFiles.js";
import type { PiWebSession } from "./server/types.js";
import type { BaseSessionStateDto, SessionInfoDto } from "./server/session/dto.js";
import { SessionActivity } from "./server/session/activity.js";
import { createHostSessionEventHandler, decorateHostMessages, decorateHostSessionState, resolveWebSocketHelloSession, type DecoratedSessionState, type WireSessionState } from "./server/session/hostEvents.js";
import { RealtimeHub, SessionUnreadTracker } from "./server/realtime.js";
import { createPushNotificationService } from "./server/pushNotifications.js";
import { LocalSessionService, SessionServiceError } from "./server/session/service.js";


const appDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const distDir = join(appDir, "dist");
const staticDir = distDir;

const isDev = process.env.PI_WEB_DEV === "1" || process.env.NODE_ENV === "development";
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8787);
const token = process.env.PI_WEB_TOKEN || "";
let piCwd = resolve(process.env.PI_WEB_CWD || process.cwd());
const knownCwds = new Set<string>([piCwd]);

const bundledExtensionsDir = join(appDir, ".pi", "extensions");
const mockMode = process.env.PI_WEB_MOCK === "1";
let mockStateOverrides: Record<string, unknown> = {};

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".xhtml": "application/xhtml+xml",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".ogv": "video/ogg",
  ".pdf": "application/pdf",
};

function sendJson(res: ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function pipeReadStream(res: ServerResponse, file: string, range?: { start: number; end: number }) {
  const stream = createReadStream(file, range);
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

function unauthorized(res: ServerResponse) {
  sendJson(res, 401, { ok: false, error: "Unauthorized" });
}

function requestToken(req: IncomingMessage): string {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice("Bearer ".length);
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  return url.searchParams.get("token") || "";
}

function isAuthorized(req: IncomingMessage): boolean {
  return !token || requestToken(req) === token;
}

async function readBytes(req: IncomingMessage, maxBytes = 30_000_000): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const text = (await readBytes(req, 40_000_000)).toString("utf-8");
  return text ? JSON.parse(text) : {};
}

async function serveArtifact(req: IncomingMessage, res: ServerResponse, sessionScoped = false) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const routePrefix = sessionScoped ? "/api/session-artifacts/" : "/api/artifacts/";
  const routePath = url.pathname.slice(routePrefix.length);
  const separator = routePath.indexOf("/");
  const pathSessionId = sessionScoped && separator > 0 ? decodeURIComponent(routePath.slice(0, separator)) : "";
  const artifactPath = decodeURIComponent(sessionScoped ? routePath.slice(separator + 1) : routePath);
  if ((sessionScoped && !pathSessionId) || !isValidArtifactPath(artifactPath)) return sendJson(res, 400, { ok: false, error: "Invalid artifact path" });

  let preferredCwd = "";
  const requestedSessionId = pathSessionId || url.searchParams.get("sessionId");
  if (requestedSessionId) {
    try { preferredCwd = await sessionService.cwdForSessionId(requestedSessionId); } catch {
      if (sessionScoped) return sendJson(res, 404, { ok: false, error: "Session not found" });
    }
  }
  const artifactRoots = sessionScoped
    ? new Set([preferredCwd])
    : new Set([...(preferredCwd ? [preferredCwd] : []), piCwd, ...knownCwds, ...sessionService.knownCwds()]);
  const resolvedFile = findArtifactFile(artifactRoots, artifactPath);
  if (!resolvedFile) return sendJson(res, 404, { ok: false, error: "Artifact not found" });

  const size = statSync(resolvedFile).size;
  const headers: Record<string, string | number> = {
    "content-type": contentTypes[extname(resolvedFile).toLowerCase()] || "application/octet-stream",
    "content-length": size,
    "accept-ranges": "bytes",
    "cache-control": "no-store",
  };
  const rangeHeader = req.headers.range?.trim();
  if (!rangeHeader) {
    res.writeHead(200, headers);
    pipeReadStream(res, resolvedFile);
    return;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  let start = match?.[1] ? Number(match[1]) : 0;
  let end = match?.[2] ? Number(match[2]) : size - 1;
  if (match && !match[1] && match[2]) {
    const suffixLength = Number(match[2]);
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  }
  if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
    res.writeHead(416, { ...headers, "content-length": 0, "content-range": `bytes */${size}` });
    res.end();
    return;
  }
  end = Math.min(end, size - 1);
  res.writeHead(206, {
    ...headers,
    "content-length": end - start + 1,
    "content-range": `bytes ${start}-${end}/${size}`,
  });
  pipeReadStream(res, resolvedFile, { start, end });
}

function serveStatic(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = resolve(staticDir, relative);

  if (!file.startsWith(staticDir) || !existsSync(file)) {
    sendJson(res, 404, { ok: false, error: "Not found" });
    return;
  }

  res.writeHead(200, { "content-type": contentTypes[extname(file)] || "application/octet-stream" });
  pipeReadStream(res, file);
}

async function ensurePiWebStorage(cwd = piCwd) {
  const webDir = join(cwd, ".pi", "web");
  await mkdir(webDir, { recursive: true });
  const ignoreFile = join(webDir, ".gitignore");
  if (!existsSync(ignoreFile)) await writeFile(ignoreFile, "*\n");
}

async function setPiCwd(path: string) {
  piCwd = await assertDirectory(path, piCwd);
  knownCwds.add(piCwd);
  await ensurePiWebStorage(piCwd);
}

async function requestCwdFromSessionId(sessionId: string | null) {
  if (!sessionId) return piCwd;
  return sessionService.cwdForSessionId(sessionId);
}

function sessionCwd(targetSession: PiWebSession | any = session) {
  return sessionService ? sessionService.cwdForSession(targetSession) : String(targetSession?.sessionManager?.getCwd?.() || targetSession?.cwd || piCwd);
}

function resolveSessionId(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : session.sessionId;
}

function applySessionUnreadState<T extends { id: string }>(sessions: T[], sessionUiState: { sessionUnreadStates?: Array<{ sessionId: string; unreadAt: string }> }) {
  const unreadById = new Map((sessionUiState.sessionUnreadStates || []).map((item) => [item.sessionId, item]));
  return sessions.map((item) => {
    const unread = unreadById.get(item.id);
    return unread ? { ...item, unread: true, unreadAt: unread.unreadAt } : { ...item, unread: false };
  });
}

function decorateState(baseState: BaseSessionStateDto, targetSession: PiWebSession, includeThinkingLevels = false): WireSessionState {
  const state = decorateHostSessionState(baseState, targetSession, sessionActivity, (value) => sessionService.webUiEntries(value), includeThinkingLevels);
  return (mockMode ? { ...state, ...mockStateOverrides } : state) as WireSessionState;
}

function currentState(targetSession: PiWebSession = session) {
  return decorateState(sessionService.projectState(targetSession), targetSession);
}

function currentStateWithThinkingLevels(targetSession: PiWebSession = session) {
  return decorateState(sessionService.projectState(targetSession), targetSession, true);
}

async function decorateServiceState(baseState: BaseSessionStateDto, includeThinkingLevels = true): Promise<DecoratedSessionState> {
  return decorateState(baseState, await sessionService.require(baseState.sessionId), includeThinkingLevels) as DecoratedSessionState;
}

const decorateMessages = (messages: Parameters<typeof decorateHostMessages>[0], sessionFile: string) =>
  decorateHostMessages(messages, sessionFile, sessionActivity);

function decorateSessionInfos(infos: SessionInfoDto[]) {
  return infos.map(({ path, ...info }) => ({ ...info, runtime: sessionActivity.runtimeForPath(path) }));
}

function envMs(name: string, fallback: number) {
  const raw = Number(process.env[name] || fallback);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

const modelRuntime = await ModelRuntime.create();
const sessionUiStateStore = createSessionUiStateStore(process.env.PI_WEB_SESSION_UI_STATE_FILE || join(getAgentDir(), "pi-web-session-ui-state.json"));
const pushNotifications = createPushNotificationService(
  process.env.PI_WEB_PUSH_FILE || join(getAgentDir(), "pi-web-push.json"),
  process.env.PI_WEB_VAPID_SUBJECT || "https://github.com/ashwin-pc/pi-web",
);
let sessionService: LocalSessionService;
const sessionActivity = new SessionActivity(
  (path) => sessionService?.sessionForPath(path),
  (path) => sessionService?.hasActiveWorkForPath(path) ?? false,
  (path) => sessionService?.hasActiveRetryForPath(path) ?? false,
);
let session: PiWebSession;

const websocketHeartbeatMs = envMs("PI_WEB_WS_HEARTBEAT_MS", 30_000);
const websocketMaxMissedHeartbeats = Math.max(1, Math.floor(envMs("PI_WEB_WS_MAX_MISSED_HEARTBEATS", 3)));
let realtimeHub: RealtimeHub;
const unreadTracker = new SessionUnreadTracker(sessionUiStateStore, sessionActivity, (value) => realtimeHub.broadcast(value));
realtimeHub = new RealtimeHub(websocketHeartbeatMs, websocketMaxMissedHeartbeats, (value) => unreadTracker.handle(value));

const mockPromptCorrelations = new Map<string, Array<{ clientMessageId: string; sourceClientId: string }>>();
function broadcast(value: unknown) {
  if (mockMode && value && typeof value === "object" && (value as any).type === "pi_event") {
    const envelope = value as Record<string, any>;
    const eventMessage = envelope.event?.message;
    const raw = eventMessage?.message && typeof eventMessage.message === "object" ? eventMessage.message : eventMessage;
    if (envelope.event?.type === "message_end" && String(raw?.role || raw?.raw?.role || "") === "user") {
      const key = String(envelope.sessionFile || envelope.sessionId || "");
      const pending = mockPromptCorrelations.get(key);
      const correlation = pending?.shift();
      if (pending && pending.length === 0) mockPromptCorrelations.delete(key);
      if (correlation) return realtimeHub.broadcast({ ...envelope, ...correlation });
    }
  }
  realtimeHub.broadcast(value);
}

function markSessionUnreadCompleted(sessionId: string, unreadAt = new Date().toISOString()) { unreadTracker.markCompleted(sessionId, unreadAt); }
function clearSessionUnread(sessionId: string) { unreadTracker.clear(sessionId); }

function cleanClientId(value: unknown) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, 120).replace(/[^a-zA-Z0-9_.:-]/g, "");
}

function clientIdFromRequest(req: IncomingMessage, fallback?: unknown) {
  const raw = req.headers["x-pi-web-client-id"];
  const headerValue = Array.isArray(raw) ? raw[0] : raw;
  return cleanClientId(headerValue) || cleanClientId(fallback);
}

function noteViewerLeaseFromRequest(req: IncomingMessage, value: PiWebSession, fallbackClientId?: unknown) {
  const clientId = clientIdFromRequest(req, fallbackClientId);
  if (clientId) sessionService.acquireViewer(value.sessionId, clientId);
}

function bindViewerSocket(clientId: string, ws: WebSocket) {
  const connection = sessionService.connectViewer(clientId);
  if (connection) ws.on("close", () => sessionService.disconnectViewer(connection));
}

const mockHarness = createMockHarness({
  piCwd,
  broadcast,
  isCurrentSession: (value: PiWebSession) => value === session,
  currentState,
});
const { mockSessions, createMockSession, resetMockSessions, getMockLifecycle } = mockHarness;

function additionalExtensionPaths(cwd = piCwd) {
  return [
    ...resolveBundledExtensionPaths({ piCwd: cwd, appDir, bundledExtensionsDir }),
    ...resolvePiWebExtensionPaths(cwd),
  ];
}

async function transferCurrentTabUiState(oldSessionId: string, newSessionId: string, _newLabel: string, cwd: string) {
  if (!oldSessionId || !newSessionId || oldSessionId === newSessionId) return sessionUiStateStore.read();
  const current = await sessionUiStateStore.read();
  const oldPinnedIndex = current.pinnedSessions.findIndex((item) => item.id === oldSessionId);
  const oldMarker = current.sessionMarkers.find((item) => item.sessionId === oldSessionId);
  const hasUnreadState = current.sessionUnreadStates.some((item) => item.sessionId === oldSessionId || item.sessionId === newSessionId);
  if (oldPinnedIndex === -1 && !oldMarker && !hasUnreadState) return current;

  const pinnedSessions = current.pinnedSessions.filter((item) => item.id !== oldSessionId && item.id !== newSessionId);
  if (oldPinnedIndex !== -1) {
    pinnedSessions.splice(Math.min(oldPinnedIndex, pinnedSessions.length), 0, { id: newSessionId, cwd });
  }

  const sessionMarkers = current.sessionMarkers.filter((item) => item.sessionId !== oldSessionId && item.sessionId !== newSessionId);
  if (oldMarker) {
    sessionMarkers.unshift({ sessionId: newSessionId, color: oldMarker.color, updatedAt: new Date().toISOString() });
  }
  const sessionUnreadStates = current.sessionUnreadStates.filter((item) => item.sessionId !== oldSessionId && item.sessionId !== newSessionId);

  const next = await sessionUiStateStore.write({ ...current, pinnedSessions, sessionMarkers, sessionUnreadStates });
  broadcast({ type: "session_ui_state_changed", sessionUiState: next });
  return next;
}

async function applyDefaultSessionBucket(sessionId: string) {
  const color = (await settingsStore.read()).defaults.sessionBucketColor;
  if (!sessionId || !color) return undefined;
  const current = await sessionUiStateStore.read();
  if (current.sessionMarkers.some((marker) => marker.sessionId === sessionId)) return current;
  const sessionUiState = await sessionUiStateStore.write({
    ...current,
    sessionMarkers: [{ sessionId, color, updatedAt: new Date().toISOString() }, ...current.sessionMarkers],
  });
  broadcast({ type: "session_ui_state_changed", sessionUiState });
  return sessionUiState;
}

const handleSessionServiceEvent = createHostSessionEventHandler({
  sessionForId: (id) => sessionService.sessionForId(id),
  projectState: (value) => sessionService.projectState(value),
  webUiEntries: (value) => sessionService.webUiEntries(value),
  sessionActivity,
  broadcast,
  markSessionUnreadCompleted,
  notifySessionCompleted: (sessionId) => {
    const target = sessionService.sessionForId(sessionId);
    if (!target) return;
    const state = sessionService.projectState(target);
    void pushNotifications.notifyRunCompleted({
      sessionId,
      title: state.sessionName?.trim() || state.sessionTitle?.trim() || "Session",
      completedAt: new Date().toISOString(),
    });
  },
});

const mockSessionFactory = mockMode ? {
  isMock: true,
  create: async ({ path }: { path?: string }) => ({ session: createMockSession(path) }),
  list: async () => mockSessions,
  remove: async (id: string) => {
    const index = mockSessions.findIndex((item) => item.id === id);
    if (index >= 0) mockSessions.splice(index, 1);
    return "deleted" as const;
  },
} : undefined;

sessionService = new LocalSessionService({
  modelRuntime,
  sessionFactory: mockSessionFactory,
  additionalExtensionPaths,
  sessionConfig: {
    defaultsFor: async () => {
      const defaults = (await settingsStore.read()).defaults;
      return { model: defaults.model, thinkingLevel: defaults.thinkingLevel };
    },
    finalizeCreatedSession: applyDefaultSessionBucket,
  },
  globalCwd: () => piCwd,
  clientCount: () => realtimeHub.clientCount,
});
const settingsStore = sessionService.settingsStore;
sessionService.subscribe((event) => {
  if (event.type === "shutdown") {
    mockPromptCorrelations.delete(event.sessionKey);
    mockPromptCorrelations.delete(event.sessionFile);
    mockPromptCorrelations.delete(event.sessionId);
  }
  handleSessionServiceEvent(event);
});

await ensurePiWebStorage();
session = await sessionService.initialize();

let viteDevServer: ViteDevServer | undefined;

const server = createServer(async (req, res) => {
  try {
    const method = req.method || "GET";
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname.startsWith("/api/")) {
      if (method === "GET" && url.pathname.startsWith("/api/session-artifacts/")) {
        return await serveArtifact(req, res, true);
      }
      if (method === "GET" && url.pathname.startsWith("/api/artifacts/")) {
        return await serveArtifact(req, res);
      }

      if (!isAuthorized(req)) return unauthorized(res);

      if (mockMode && method === "POST" && url.pathname === "/api/mock/reset") {
        await sessionService.disposeAll("reset");
        mockPromptCorrelations.clear();
        mockStateOverrides = {};
        resetMockSessions();
        await sessionUiStateStore.write(defaultSessionUiState);
        session = createMockSession();
        sessionService.setCurrentSession(session);
        broadcast({ type: "session_ui_state_changed", sessionUiState: defaultSessionUiState });
        broadcast({ type: "state_changed", ...currentState() });
        return sendJson(res, 200, { ok: true });
      }

      if (mockMode && method === "POST" && url.pathname === "/api/mock/state") {
        const body = await readBody(req);
        mockStateOverrides = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
        const state = currentState();
        broadcast({ type: "state_changed", ...state });
        return sendJson(res, 200, { ok: true, ...state });
      }

      if (mockMode && method === "GET" && url.pathname === "/api/mock/live-sessions") {
        return sendJson(res, 200, { ok: true, ...sessionService.lifecycleSnapshot(), lifecycle: getMockLifecycle() });
      }

      if (method === "GET" && url.pathname === "/api/fs/dirs") {
        try {
          return sendJson(res, 200, await listDirectories(url.searchParams.get("path") || piCwd, piCwd));
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "POST" && url.pathname === "/api/fs/dirs") {
        const body = await readBody(req) as { parent?: unknown; name?: unknown };
        try {
          return sendJson(res, 201, await createDirectory(String(body.parent || piCwd), String(body.name || ""), piCwd));
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "GET" && url.pathname === "/api/files/tree") {
        try {
          const cwd = await requestCwdFromSessionId(url.searchParams.get("sessionId"));
          return sendJson(res, 200, await listWorkspaceDirectory(cwd, url.searchParams.get("path") || "", url.searchParams.get("hidden") === "1"));
        } catch (error) {
          return sendJson(res, error instanceof WorkspaceFileError ? error.status : 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "GET" && url.pathname === "/api/files/read") {
        try {
          const cwd = await requestCwdFromSessionId(url.searchParams.get("sessionId"));
          return sendJson(res, 200, await readWorkspaceFile(cwd, url.searchParams.get("path") || ""));
        } catch (error) {
          return sendJson(res, error instanceof WorkspaceFileError ? error.status : 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "GET" && url.pathname === "/api/files/image") {
        try {
          const cwd = await requestCwdFromSessionId(url.searchParams.get("sessionId"));
          const image = await readWorkspaceImage(cwd, url.searchParams.get("path") || "");
          res.writeHead(200, { "content-type": image.mimeType, "content-length": image.data.length, "cache-control": "no-store" });
          res.end(image.data);
          return;
        } catch (error) {
          return sendJson(res, error instanceof WorkspaceFileError ? error.status : 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "PUT" && url.pathname === "/api/files/write") {
        const body = await readBody(req) as { sessionId?: unknown; path?: unknown; content?: unknown; expectedRevision?: unknown };
        try {
          const cwd = await requestCwdFromSessionId(typeof body.sessionId === "string" ? body.sessionId : null);
          return sendJson(res, 200, await writeWorkspaceFile(cwd, body.path, body.content, body.expectedRevision));
        } catch (error) {
          return sendJson(res, error instanceof WorkspaceFileError ? error.status : 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "GET" && url.pathname === "/api/git/repos") {
        return sendJson(res, 200, await listGitRepos(await requestCwdFromSessionId(url.searchParams.get("sessionId"))));
      }

      if (method === "GET" && url.pathname === "/api/git/status") {
        try {
          const baseCwd = await requestCwdFromSessionId(url.searchParams.get("sessionId"));
          return sendJson(res, 200, await gitStatus(await gitCwdFromRepoParam(url.searchParams.get("repo"), baseCwd), url.searchParams.get("fetch") === "1"));
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "GET" && url.pathname === "/api/git/log") {
        try {
          const baseCwd = await requestCwdFromSessionId(url.searchParams.get("sessionId"));
          return sendJson(res, 200, await gitLog(await gitCwdFromRepoParam(url.searchParams.get("repo"), baseCwd)));
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "GET" && url.pathname === "/api/git/commit") {
        try {
          const baseCwd = await requestCwdFromSessionId(url.searchParams.get("sessionId"));
          return sendJson(res, 200, await gitCommitDetails(url.searchParams.get("hash") || "", await gitCwdFromRepoParam(url.searchParams.get("repo"), baseCwd)));
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "GET" && url.pathname === "/api/git/diff") {
        try {
          const baseCwd = await requestCwdFromSessionId(url.searchParams.get("sessionId"));
          const cwd = await gitCwdFromRepoParam(url.searchParams.get("repo"), baseCwd);
          if (!await isGitRepo(cwd)) return sendJson(res, 404, { ok: false, error: "Not a Git repository" });
          return sendJson(res, 200, await gitDiff({
            cwd,
            path: url.searchParams.get("path") || "",
            staged: url.searchParams.get("staged") === "1",
          }));
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "GET" && url.pathname === "/api/git/image") {
        try {
          const baseCwd = await requestCwdFromSessionId(url.searchParams.get("sessionId"));
          const cwd = await gitCwdFromRepoParam(url.searchParams.get("repo"), baseCwd);
          if (!await isGitRepo(cwd)) return sendJson(res, 404, { ok: false, error: "Not a Git repository" });
          const image = await readGitImage({
            cwd,
            path: url.searchParams.get("path") || "",
            oldPath: url.searchParams.get("oldPath") || undefined,
            version: url.searchParams.get("version") || "",
            staged: url.searchParams.get("staged") === "1",
          });
          if (!image) return sendJson(res, 415, { ok: false, error: "Not an image file" });
          res.writeHead(200, {
            "content-type": contentTypes[extname(image.displayPath).toLowerCase()] || "application/octet-stream",
            "cache-control": "no-store",
          });
          if ("file" in image && typeof image.file === "string") pipeReadStream(res, image.file);
          else res.end(image.data);
          return;
        } catch (error) {
          return sendJson(res, 404, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "POST" && url.pathname === "/api/git/sync") {
        try {
          const baseCwd = await requestCwdFromSessionId(url.searchParams.get("sessionId"));
          const cwd = await gitCwdFromRepoParam(url.searchParams.get("repo"), baseCwd);
          if (!await isGitRepo(cwd)) return sendJson(res, 404, { ok: false, error: "Not a Git repository" });
          return sendJson(res, 200, await gitSync(cwd));
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "GET" && url.pathname === "/api/push/status") {
        return sendJson(res, 200, { ok: true, vapidPublicKey: await pushNotifications.publicKey() });
      }

      if (method === "POST" && url.pathname === "/api/push/subscribe") {
        const body = await readBody(req) as { installationId?: unknown; subscription?: unknown };
        try {
          return sendJson(res, 200, { ok: true, ...await pushNotifications.subscribe(body.installationId, body.subscription) });
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "DELETE" && url.pathname === "/api/push/subscribe") {
        const body = await readBody(req) as { installationId?: unknown; endpoint?: unknown };
        try {
          await pushNotifications.unsubscribe(body.installationId, body.endpoint);
          return sendJson(res, 200, { ok: true });
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "GET" && url.pathname === "/api/state") {
        const requestedSessionId = resolveSessionId(url.searchParams.get("sessionId"));
        noteViewerLeaseFromRequest(req, await sessionService.require(requestedSessionId), url.searchParams.get("clientId"));
        return sendJson(res, 200, {
          ok: true,
          ...await decorateServiceState(await sessionService.state(requestedSessionId)),
          sessionUiState: await sessionUiStateStore.read(),
          tokenRequired: Boolean(token),
        });
      }

      if (method === "POST" && url.pathname === "/api/web-header-action/invoke") {
        const body = await readBody(req) as { sessionId?: unknown; key?: unknown };
        try {
          return sendJson(res, 200, { ok: true, ...await sessionService.invokeHeaderAction(resolveSessionId(body.sessionId), body.key) });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const status = error instanceof SessionServiceError ? error.status : message === "key is required" || message === "Header action returned no markdown" ? 400 : message === "Header action not found" ? 404 : 500;
          return sendJson(res, status, { ok: false, error: message });
        }
      }

      if (method === "POST" && url.pathname === "/api/web-artifact-action/invoke") {
        const body = await readBody(req) as { sessionId?: unknown } & Record<string, unknown>;
        try {
          return sendJson(res, 200, { ok: true, ...await sessionService.invokeArtifactAction(resolveSessionId(body.sessionId), body) });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const status = error instanceof SessionServiceError ? error.status : message === "Artifact action not found" ? 404 : message === "Invalid artifact context" || message === "Artifact action does not match this artifact" || message === "key is required" || message === "Artifact action returned no result" ? 400 : 500;
          return sendJson(res, status, { ok: false, error: message });
        }
      }

      if (method === "POST" && url.pathname === "/api/web-git-tab/invoke") {
        const body = await readBody(req) as { sessionId?: unknown; key?: unknown; action?: unknown; payload?: unknown; repo?: unknown };
        try {
          return sendJson(res, 200, { ok: true, ...await sessionService.invokeGitTab(resolveSessionId(body.sessionId), body) });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const status = error instanceof SessionServiceError ? error.status : message === "key is required" || message === "Git tab returned no HTML or composer context" ? 400 : message === "Git tab not found" ? 404 : 500;
          return sendJson(res, status, { ok: false, error: message });
        }
      }

      if (method === "GET" && url.pathname === "/api/session/stats") {
        return sendJson(res, 200, { ok: true, ...await sessionService.stats(resolveSessionId(url.searchParams.get("sessionId"))) });
      }

      if (method === "GET" && url.pathname === "/api/session/tree") {
        return sendJson(res, 200, await sessionService.tree(resolveSessionId(url.searchParams.get("sessionId"))));
      }

      if (method === "POST" && url.pathname === "/api/session/tree/navigate") {
        const body = await readBody(req) as { sessionId?: unknown; targetId?: unknown; summarize?: unknown; customInstructions?: unknown; replaceInstructions?: unknown; label?: unknown };
        const requestedSessionId = resolveSessionId(body.sessionId);
        await sessionService.require(requestedSessionId);
        const targetId = String(body.targetId || "").trim();
        if (!targetId) return sendJson(res, 400, { ok: false, error: "targetId is required" });
        const { finish, state: baseState, ...result } = await sessionService.navigate(requestedSessionId, targetId, {
          summarize: Boolean(body.summarize),
          customInstructions: typeof body.customInstructions === "string" && body.customInstructions.trim() ? body.customInstructions.trim() : undefined,
          replaceInstructions: Boolean(body.replaceInstructions),
          label: typeof body.label === "string" && body.label.trim() ? body.label.trim() : undefined,
        });
        const state = await decorateServiceState(baseState);
        try {
          return sendJson(res, 200, { ok: true, ...result, state });
        } finally {
          finish();
        }
      }

      if (method === "POST" && url.pathname === "/api/session/tree/abort-summary") {
        const body = await readBody(req) as { sessionId?: unknown };
        return sendJson(res, 202, { ok: true, ...await sessionService.abortBranchSummary(resolveSessionId(body.sessionId)) });
      }

      if (method === "GET" && url.pathname === "/api/messages") {
        const requestedSessionId = resolveSessionId(url.searchParams.get("sessionId"));
        const target = await sessionService.require(requestedSessionId);
        return sendJson(res, 200, { ok: true, messages: decorateMessages(await sessionService.messages(target.sessionId), target.sessionFile) });
      }

      if (method === "GET" && url.pathname === "/api/sessions") {
        const extraCwds = url.searchParams.getAll("cwd");
        const sessionUiState = await sessionUiStateStore.read();
        return sendJson(res, 200, { ok: true, sessions: applySessionUnreadState(decorateSessionInfos(await sessionService.list(extraCwds)), sessionUiState) });
      }

      if (method === "GET" && url.pathname === "/api/session-ui-state") {
        return sendJson(res, 200, { ok: true, sessionUiState: await sessionUiStateStore.read() });
      }

      if (method === "PATCH" && url.pathname === "/api/session-ui-state") {
        const sessionUiState = await sessionUiStateStore.patch(await readBody(req));
        broadcast({ type: "session_ui_state_changed", sessionUiState });
        return sendJson(res, 200, { ok: true, sessionUiState });
      }

      if (method === "POST" && url.pathname === "/api/session-ui-state/read") {
        const body = await readBody(req) as { sessionId?: unknown };
        const sessionId = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : session.sessionId;
        const sessionUiState = await sessionUiStateStore.markRead(sessionId);
        broadcast({ type: "session_ui_state_changed", sessionUiState });
        return sendJson(res, 200, { ok: true, sessionUiState });
      }

      if (method === "POST" && url.pathname === "/api/sessions/delete") {
        const body = await readBody(req) as { sessionId?: unknown; id?: unknown; cwd?: unknown; activeSessionId?: unknown };
        const requestedId = typeof body.sessionId === "string" ? body.sessionId : typeof body.id === "string" ? body.id : "";
        const activeSessionId = typeof body.activeSessionId === "string" ? body.activeSessionId : "";
        if (!requestedId) return sendJson(res, 400, { ok: false, error: "sessionId is required" });
        if (activeSessionId && activeSessionId === requestedId) return sendJson(res, 409, { ok: false, error: "Switch to another session before deleting the current session." });
        try {
          const result = await sessionService.delete(requestedId, typeof body.cwd === "string" && body.cwd.trim() ? body.cwd : undefined) as { id: string; disposition: "trashed" | "deleted" };
          const sessionUiState = await sessionUiStateStore.removeSession(result.id);
          broadcast({ type: "session_deleted", sessionId: result.id, disposition: result.disposition });
          broadcast({ type: "session_ui_state_changed", sessionUiState });
          return sendJson(res, 200, { ok: true, ...result });
        } catch (error: any) {
          return sendJson(res, Number(error?.status) || 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }


      if (method === "GET" && url.pathname === "/api/settings") {
        return sendJson(res, 200, { ok: true, settings: await settingsStore.read(), webSettingsSchemas: sessionService.settingsSchemas() });
      }

      if (method === "PATCH" && url.pathname === "/api/settings") {
        const settings = await settingsStore.patch(await readBody(req));
        broadcast({ type: "settings_updated", settings });
        return sendJson(res, 200, { ok: true, settings });
      }

      if (method === "GET" && url.pathname === "/api/extensions/status") {
        return sendJson(res, 200, { ok: true, status: sessionService.extensionStatus(resolveSessionId(url.searchParams.get("sessionId"))) });
      }

      if (method === "POST" && url.pathname === "/api/extensions/reload") {
        const body = await readBody(req) as { sessionId?: unknown };
        return sendJson(res, 200, { ok: true, status: await sessionService.reloadExtensions(resolveSessionId(body.sessionId)) });
      }

      if (url.pathname.startsWith("/api/settings/extensions/")) {
        const rest = url.pathname.slice("/api/settings/extensions/".length);
        const isReset = rest.endsWith("/reset");
        let ownerId: string;
        try {
          ownerId = decodeURIComponent(isReset ? rest.slice(0, -"/reset".length) : rest);
        } catch {
          return sendJson(res, 400, { ok: false, error: "malformed owner id" });
        }
        const entry = sessionService.settingsSchemaEntry(ownerId);
        // Reset only needs stored data, not a live schema, so configuration for
        // an unloaded extension can still be cleared. Editing needs the schema.
        const storedOwner = (await settingsStore.read()).extensions?.[ownerId];
        if (!entry && !(isReset && storedOwner)) {
          return sendJson(res, 409, { ok: false, error: "extension not loaded" });
        }

        if (method === "POST" && isReset) {
          const body = await readBody(req) as { expectedRevision?: unknown };
          if (typeof body?.expectedRevision !== "number" || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) {
            return sendJson(res, 400, { ok: false, error: "expectedRevision must be a non-negative integer" });
          }
          try {
            const settings = await settingsStore.resetExtension(ownerId, body.expectedRevision);
            broadcast({ type: "settings_updated", settings });
            if (entry) sessionService.notifySettingsChanged(ownerId, defaultSettingsValues(entry.schema));
            return sendJson(res, 200, { ok: true, settings });
          } catch (error) {
            if (error instanceof ExtensionRevisionConflictError) {
              return sendJson(res, 409, { ok: false, error: "revision conflict", actualRevision: error.actualRevision });
            }
            throw error;
          }
        }

        if (method === "PATCH" && !isReset) {
          if (!entry) return sendJson(res, 409, { ok: false, error: "extension not loaded" });
          const body = await readBody(req) as { values?: unknown; expectedRevision?: unknown };
          if (typeof body?.expectedRevision !== "number" || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) {
            return sendJson(res, 400, { ok: false, error: "expectedRevision must be a non-negative integer" });
          }
          const { values, errors } = validateSettingsValues(entry.schema, body?.values, { modelOptions: sessionService.modelOptionTokens() });
          if (errors.length) return sendJson(res, 422, { ok: false, errors });
          try {
            const settings = await settingsStore.patchExtension(ownerId, values, {
              schemaVersion: entry.schema.schemaVersion,
              expectedRevision: body.expectedRevision,
            });
            broadcast({ type: "settings_updated", settings });
            sessionService.notifySettingsChanged(ownerId, values);
            return sendJson(res, 200, { ok: true, settings, revision: settings.extensions?.[ownerId]?.revision ?? 0 });
          } catch (error) {
            if (error instanceof ExtensionRevisionConflictError) {
              return sendJson(res, 409, { ok: false, error: "revision conflict", actualRevision: error.actualRevision });
            }
            if (error instanceof ExtensionSettingsBoundsError) {
              return sendJson(res, 413, { ok: false, error: error.message });
            }
            throw error;
          }
        }

        return sendJson(res, 405, { ok: false, error: "method not allowed" });
      }

      if (method === "GET" && url.pathname === "/api/commands") {
        return sendJson(res, 200, { ok: true, commands: await sessionService.commands(resolveSessionId(url.searchParams.get("sessionId"))) });
      }

      if (method === "GET" && url.pathname === "/api/models") {
        return sendJson(res, 200, { ok: true, ...await sessionService.models(resolveSessionId(url.searchParams.get("sessionId"))) });
      }

      if (method === "POST" && url.pathname === "/api/model") {
        const body = await readBody(req) as { sessionId?: unknown; provider?: unknown; id?: unknown; thinkingLevel?: unknown };
        const provider = String(body.provider || "").trim();
        const id = String(body.id || "").trim();
        if (!provider || !id) return sendJson(res, 400, { ok: false, error: "provider and id are required" });
        const state = await decorateServiceState(await sessionService.setModel(resolveSessionId(body.sessionId), provider, id, typeof body.thinkingLevel === "string" ? body.thinkingLevel : undefined));
        broadcast({ type: "state_changed", ...state });
        return sendJson(res, 200, { ok: true, ...state });
      }

      if (method === "POST" && url.pathname === "/api/command") {
        const body = await readBody(req) as { sessionId?: unknown; command?: unknown };
        const command = String(body.command || "").trim();
        if (!command.startsWith("/")) return sendJson(res, 400, { ok: false, error: "Slash command is required" });

        const target = await sessionService.require(resolveSessionId(body.sessionId));
        const result = await sessionService.executeCommand(target.sessionId, command);
        const created = result.state.sessionId !== target.sessionId;
        const decorated = await decorateServiceState(result.state);
        const state = created && /^\/+clear(?:\s|$)/i.test(command)
          ? { ...decorated, sessionUiState: await transferCurrentTabUiState(target.sessionId, decorated.sessionId, decorated.sessionTitle || "New session", decorated.cwd) }
          : decorated;
        noteViewerLeaseFromRequest(req, await sessionService.require(state.sessionId));
        return sendJson(res, 200, { ok: true, message: result.message, state });
      }

      if (method === "POST" && url.pathname === "/api/shell") {
        const body = await readBody(req) as { sessionId?: unknown; command?: unknown; excludeFromContext?: unknown };
        const command = String(body.command || "").trim();
        if (!command) return sendJson(res, 400, { ok: false, error: "command is required" });
        return sendJson(res, 200, { ok: true, ...await sessionService.executeShell(resolveSessionId(body.sessionId), command, Boolean(body.excludeFromContext)) });
      }

      if (method === "POST" && url.pathname === "/api/extension-ui/respond") {
        const body = await readBody(req) as { id?: unknown } & Record<string, unknown>;
        const id = String(body.id || "").trim();
        if (!id) return sendJson(res, 400, { ok: false, error: "id is required" });
        if (!sessionService.respondExtensionUi(id, body)) return sendJson(res, 404, { ok: false, error: "Extension UI request not found" });
        return sendJson(res, 200, { ok: true });
      }

      if (method === "GET" && url.pathname.startsWith("/api/attachments/")) {
        const parts = url.pathname.slice("/api/attachments/".length).split("/");
        if (parts.length !== 2) return sendJson(res, 400, { ok: false, error: "Invalid attachment path" });
        const id = decodeURIComponent(parts[0] || "");
        const name = decodeURIComponent(parts[1] || "");
        const roots = new Set([piCwd, ...knownCwds, ...sessionService.knownCwds()]);
        const file = resolveAttachmentFile(roots, id, name);
        if (!file) return sendJson(res, 410, { ok: false, error: "Attachment unavailable" });
        res.writeHead(200, {
          "content-type": contentTypes[extname(file).toLowerCase()] || "application/octet-stream",
          "content-length": statSync(file).size,
          "cache-control": "private, no-store",
          "content-disposition": `inline; filename="${name.replaceAll('"', "")}"`,
        });
        pipeReadStream(res, file);
        return;
      }

      if (method === "POST" && url.pathname === "/api/attachments") {
        const sessionId = url.searchParams.get("sessionId");
        const target = await sessionService.require(resolveSessionId(sessionId));
        const name = url.searchParams.get("name") || "attachment";
        const requestedMediaType = url.searchParams.get("mediaType") || "";
        const mediaType = requestedMediaType && requestedMediaType.length <= 160 ? requestedMediaType : "application/octet-stream";
        const bytes = await readBytes(req);
        const attachment = await storeAttachment(sessionService.cwdForSession(target), { name, mediaType, bytes });
        return sendJson(res, 201, { ok: true, attachment });
      }

      if (method === "POST" && url.pathname === "/api/prompt") {
        const body = await readBody(req) as { sessionId?: unknown; clientMessageId?: unknown; message?: unknown; mode?: unknown; attachments?: unknown; images?: unknown };
        const message = String(body.message || "").trim();
        const target = await sessionService.require(resolveSessionId(body.sessionId));
        const attachments = normalizeSubmittedAttachments(sessionService.cwdForSession(target), body.attachments);
        if (!message && attachments.length === 0) return sendJson(res, 400, { ok: false, error: "message or attachment is required" });
        const clientMessageId = cleanClientId(body.clientMessageId);
        const sourceClientId = clientIdFromRequest(req);
        if (mockMode && clientMessageId && sourceClientId) {
          const key = target.sessionFile || target.sessionId;
          const pending = mockPromptCorrelations.get(key) || [];
          pending.push({ clientMessageId, sourceClientId });
          mockPromptCorrelations.set(key, pending);
        }
        const result = await sessionService.prompt(target.sessionId, {
          message,
          mode: body.mode === "followUp" ? "followUp" : "steer",
          attachments,
          clientMessageId,
          sourceClientId,
        });
        return sendJson(res, 202, { ok: true, ...result });
      }

      if (method === "POST" && url.pathname === "/api/session/retry") {
        const body = await readBody(req) as { sessionId?: unknown };
        return sendJson(res, 202, { ok: true, ...await sessionService.retry(resolveSessionId(body.sessionId)) });
      }

      if (method === "POST" && url.pathname === "/api/abort") {
        const body = await readBody(req) as { sessionId?: unknown };
        return sendJson(res, 202, { ok: true, ...await sessionService.abort(resolveSessionId(body.sessionId)) });
      }

      if (method === "POST" && url.pathname === "/api/compaction/abort") {
        const body = await readBody(req) as { sessionId?: unknown };
        return sendJson(res, 202, { ok: true, ...await sessionService.abortCompaction(resolveSessionId(body.sessionId)) });
      }

      if (method === "POST" && url.pathname === "/api/session/name") {
        const body = await readBody(req) as { sessionId?: unknown; name?: unknown };
        const name = String(body.name || "").trim();
        const state = await decorateServiceState(await sessionService.rename(resolveSessionId(body.sessionId), name));
        return sendJson(res, 200, { ok: true, ...state });
      }

      if (method === "POST" && (url.pathname === "/api/new-chat" || url.pathname === "/api/sessions/new")) {
        const body = await readBody(req) as { cwd?: unknown; sessionId?: unknown; origin?: unknown };
        const baseState = await sessionService.create(resolveSessionId(body.sessionId), typeof body.cwd === "string" ? body.cwd : undefined);
        const state = await decorateServiceState(baseState);
        noteViewerLeaseFromRequest(req, await sessionService.require(state.sessionId));
        const origin = body.origin && typeof body.origin === "object" ? body.origin as { sessionId?: unknown; kind?: unknown } : undefined;
        let originWarning: string | undefined;
        if (origin && typeof origin.sessionId === "string" && origin.sessionId.trim() && state.sessionId) {
          // Lineage is best-effort metadata: the session already exists, so a
          // failure here must not fail the request (that would hide the new
          // session's id from the caller and leak an unreachable session).
          try {
            const sessionUiState = await sessionUiStateStore.setSessionOrigin(
              state.sessionId,
              origin.sessionId.trim(),
              typeof origin.kind === "string" && origin.kind.trim() ? origin.kind.trim() : "spawn",
            );
            broadcast({ type: "session_ui_state_changed", sessionUiState });
          } catch (error) {
            originWarning = error instanceof Error ? error.message : String(error);
            console.warn(`Could not record session origin for ${state.sessionId}:`, error);
          }
        }
        broadcast({ type: "state_changed", ...state });
        return sendJson(res, 200, { ok: true, ...state, ...(originWarning ? { originWarning } : {}) });
      }

      if (method === "POST" && url.pathname === "/api/session/cwd") {
        const body = await readBody(req) as { sessionId?: unknown; cwd?: unknown };
        const cwd = String(body.cwd || "").trim();
        if (!cwd) return sendJson(res, 400, { ok: false, error: "cwd is required" });
        try {
          const baseState = await sessionService.switchCwd(resolveSessionId(body.sessionId), cwd);
          const state = await decorateServiceState(baseState);
          noteViewerLeaseFromRequest(req, await sessionService.require(state.sessionId));
          broadcast({ type: "state_changed", ...state });
          return sendJson(res, 200, { ok: true, ...state });
        } catch (error) {
          const status = error instanceof SessionServiceError ? error.status : 400;
          return sendJson(res, status, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "POST" && url.pathname === "/api/sessions/open") {
        const body = await readBody(req) as { id?: unknown; sessionId?: unknown; cwd?: unknown; clientId?: unknown };
        const requestedId = typeof body.sessionId === "string" ? body.sessionId : typeof body.id === "string" ? body.id : "";
        if (!requestedId) return sendJson(res, 400, { ok: false, error: "sessionId is required" });

        const state = await decorateServiceState(await sessionService.open(requestedId, typeof body.cwd === "string" && body.cwd.trim() ? body.cwd : undefined));
        noteViewerLeaseFromRequest(req, await sessionService.require(requestedId), body.clientId);
        return sendJson(res, 200, { ok: true, ...state });
      }

      return sendJson(res, 404, { ok: false, error: "Unknown API route" });
    }

    if (viteDevServer) {
      viteDevServer.middlewares(req, res, () => {
        if (!res.writableEnded) sendJson(res, 404, { ok: false, error: "Not found" });
      });
      return;
    }

    serveStatic(req, res);
  } catch (error) {
    const status = error instanceof SessionServiceError ? error.status : 500;
    sendJson(res, status, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/ws") return;

  if (!isAuthorized(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", async (ws, req) => {
  const realtimeWs = ws;
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const lastSeq = Number(url.searchParams.get("lastSeq") || 0);
  const latestSeq = realtimeHub.attach(realtimeWs, lastSeq);

  const requestedSessionId = url.searchParams.get("sessionId") || session.sessionId;
  let targetSession: PiWebSession | undefined;
  try {
    targetSession = await resolveWebSocketHelloSession(requestedSessionId, session, (id) => sessionService.find(id));
  } catch {
    realtimeWs.close(1011, "Could not open requested session");
    return;
  }
  const clientId = cleanClientId(url.searchParams.get("clientId") || "");
  if (clientId) {
    sessionService.acquireViewer((targetSession || session).sessionId, clientId);
    bindViewerSocket(clientId, realtimeWs);
  }
  const helloState = targetSession ? currentState(targetSession) : currentState();
  realtimeWs.send(JSON.stringify({
    type: "hello",
    seq: latestSeq,
    ...helloState,
  }));
});

if (isDev) {
  viteDevServer = await createViteServer({
    appType: "spa",
    server: {
      middlewareMode: true,
      hmr: { server },
    },
  });
}

server.listen(port, host, () => {
  console.log(`pi-web listening on http://${host}:${port}`);
  console.log(`Pi cwd: ${piCwd}`);
  console.log(isDev ? "Mode: development (Vite HMR enabled)" : "Mode: production");
  console.log(token ? "Auth: bearer token required" : "Auth: disabled (set PI_WEB_TOKEN to enable)");
});
