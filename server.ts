import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extname, join, resolve } from "node:path";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  type SessionStartEvent,
  type SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import { createMockHarness } from "./server/mock.js";
import { resolveBundledExtensionPaths, resolvePiWebExtensionPaths } from "./server/extensions.js";
import { createSessionUiStateStore, defaultSessionUiState } from "./server/sessionUiState.js";
import { createSettingsStore } from "./server/settings.js";
import { artifactDirForCwd, legacyArtifactDirForCwd, safeArtifactName } from "./server/shared/artifacts.js";
import { assertDirectory, createDirectory, listDirectories } from "./server/shared/fsList.js";
import { gitCommitDetails, gitCwdFromRepoParam, gitDiff, gitImageBase64, gitLog, gitStatus, gitSync, isGitRepo, listGitRepos } from "./server/shared/git.js";
import type { PiWebSession } from "./server/types.js";
import { RealtimeHub, UnreadEventBookkeeper, ViewerLeaseBookkeeper, type RealtimeSocket } from "./server/realtime.js";
import { SessionActivityTracker } from "./server/session/activity.js";
import { WebUiExtensionService, cleanWebUiKey, type WebUiSession } from "./server/extensions/webUi.js";
import {
  hasUserMessages,
  isAssistantAbortedMessage,
  isAssistantFailureMessage,
  isIncompleteToolResultMessage,
  messageEntryRefs as projectMessageEntryRefs,
  projectConversationTree,
  projectSessionState,
  projectSessionStats,
  projectSessionTitle,
  simplifyMessage as projectSimplifiedMessage,
  simplifyModel,
} from "./server/session/projection.js";

const appDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const distDir = join(appDir, "dist");
const staticDir = distDir;

const isDev = process.env.PI_WEB_DEV === "1" || process.env.NODE_ENV === "development";
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8787);
const token = process.env.PI_WEB_TOKEN || "";
let piCwd = resolve(process.env.PI_WEB_CWD || process.cwd());
let artifactDir = artifactDirForCwd(piCwd);
let legacyArtifactDir = legacyArtifactDirForCwd(piCwd);
const knownCwds = new Set<string>([piCwd]);

const webUiContextFile = join(appDir, "contexts", "web-ui.md");
const bundledExtensionsDir = join(appDir, ".pi", "extensions");
const noSession = process.env.PI_WEB_NO_SESSION === "1";
const mockMode = process.env.PI_WEB_MOCK === "1";
const execFileAsync = promisify(execFile);

type WebSlashCommandInfo = Omit<SlashCommandInfo, "source"> & { source: SlashCommandInfo["source"] | "web" };

const webSlashCommands: WebSlashCommandInfo[] = [
  { name: "help", description: "Show slash command help", source: "web", sourceInfo: { path: "<pi-web>", source: "pi-web", scope: "temporary", origin: "top-level" } },
  { name: "commands", description: "List available web, extension, prompt, and skill commands", source: "web", sourceInfo: { path: "<pi-web>", source: "pi-web", scope: "temporary", origin: "top-level" } },
  { name: "reload", description: "Reload pi resources, extensions, skills, prompts, and models", source: "web", sourceInfo: { path: "<pi-web>", source: "pi-web", scope: "temporary", origin: "top-level" } },
  { name: "model", description: "List models or switch with /model <provider/model-id>", source: "web", sourceInfo: { path: "<pi-web>", source: "pi-web", scope: "temporary", origin: "top-level" } },
  { name: "models", description: "List available models", source: "web", sourceInfo: { path: "<pi-web>", source: "pi-web", scope: "temporary", origin: "top-level" } },
  { name: "thinking", description: "Show or set reasoning level", source: "web", sourceInfo: { path: "<pi-web>", source: "pi-web", scope: "temporary", origin: "top-level" } },
  { name: "new", description: "Start a new session", source: "web", sourceInfo: { path: "<pi-web>", source: "pi-web", scope: "temporary", origin: "top-level" } },
  { name: "clear", description: "Release this session to history and start fresh in the same tab", source: "web", sourceInfo: { path: "<pi-web>", source: "pi-web", scope: "temporary", origin: "top-level" } },
  { name: "compact", description: "Compact conversation context; optional instructions after the command", source: "web", sourceInfo: { path: "<pi-web>", source: "pi-web", scope: "temporary", origin: "top-level" } },
  { name: "abort", description: "Stop the current response", source: "web", sourceInfo: { path: "<pi-web>", source: "pi-web", scope: "temporary", origin: "top-level" } },
  { name: "stop", description: "Stop the current response", source: "web", sourceInfo: { path: "<pi-web>", source: "pi-web", scope: "temporary", origin: "top-level" } },
  { name: "logout", description: "Clear the web UI token in this browser", source: "web", sourceInfo: { path: "<pi-web>", source: "pi-web", scope: "temporary", origin: "top-level" } },
];

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
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
};

function sendJson(res: ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function pipeReadStream(res: ServerResponse, file: string) {
  const stream = createReadStream(file);
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

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf-8");
  return text ? JSON.parse(text) : {};
}

function serveArtifact(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const rawName = decodeURIComponent(url.pathname.slice("/api/artifacts/".length));
  const name = safeArtifactName(rawName);
  if (!name || rawName.includes("..") || rawName.includes("/") || name !== rawName) return sendJson(res, 400, { ok: false, error: "Invalid artifact name" });

  let resolvedFile = "";
  const artifactRoots = Array.from(new Set([piCwd, ...knownCwds]));
  for (const cwd of artifactRoots) {
    const currentArtifactDir = artifactDirForCwd(cwd);
    const currentLegacyArtifactDir = legacyArtifactDirForCwd(cwd);
    const file = resolve(currentArtifactDir, name);
    const legacyFile = resolve(currentLegacyArtifactDir, name);
    if (file.startsWith(currentArtifactDir) && existsSync(file)) {
      resolvedFile = file;
      break;
    }
    if (legacyFile.startsWith(currentLegacyArtifactDir) && existsSync(legacyFile)) {
      resolvedFile = legacyFile;
      break;
    }
  }
  if (!resolvedFile) return sendJson(res, 404, { ok: false, error: "Artifact not found" });

  res.writeHead(200, {
    "content-type": contentTypes[extname(resolvedFile).toLowerCase()] || "application/octet-stream",
    "cache-control": "no-store",
  });
  pipeReadStream(res, resolvedFile);
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
  piCwd = await assertDirectory(path);
  knownCwds.add(piCwd);
  artifactDir = artifactDirForCwd(piCwd);
  legacyArtifactDir = legacyArtifactDirForCwd(piCwd);
  await ensurePiWebStorage(piCwd);
}

async function sendGitImage(res: ServerResponse, options: { cwd: string; path: string; oldPath?: string; version: string; staged: boolean }) {
  try {
    const image = await gitImageBase64(options);
    res.writeHead(200, {
      "content-type": contentTypes[extname(image.path).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(Buffer.from(image.base64, "base64"));
  } catch (error: any) {
    if (Number(error?.status) === 415) return sendJson(res, 415, { ok: false, error: error.message });
    throw error;
  }
}

async function requestCwdFromSessionId(sessionId: string | null) {
  if (!sessionId) return piCwd;
  if (sessionId === session.sessionId) return sessionCwd(session);
  for (const entry of liveSessions.values()) {
    if (entry.session.sessionId === sessionId) return sessionCwd(entry.session);
  }
  const info = await findSessionInfoById(sessionId);
  if (!info) throw new Error("Session not found");
  return info.cwd || piCwd;
}

// Models confirmed broken with this Copilot integration — tracked at runtime.
const blockedModelIds = new Set<string>();

// Parse allowed model IDs from Copilot's model_not_available_for_integrator error.
// Returns null if no such error has been seen yet.
function copilotAllowedIdsFromSession(targetSession: PiWebSession = session): Set<string> | null {
  const entries = targetSession.messages;
  for (let i = entries.length - 1; i >= 0; i--) {
    const msg = entries[i] as any;
    const err: string = msg?.errorMessage || msg?.message?.errorMessage || "";
    if (!err.includes("model_not_available_for_integrator")) continue;
    const match = err.match(/Available models: \[([^\]]+)\]/);
    if (!match) continue;
    return new Set(match[1].split(/\s+/).map((s: string) => s.trim()).filter(Boolean));
  }
  return null;
}

function getAvailableModels(targetSession: PiWebSession = session) {
  const all = targetSession.modelRegistry.getAvailable();
  const allowed = copilotAllowedIdsFromSession(targetSession);
  return all.filter((m: any) => {
    if (blockedModelIds.has(m.id)) return false;
    if (allowed && !allowed.has(m.id)) return false;
    return true;
  });
}

const imageExtensions: Record<string, string> = {
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

async function persistPromptImages(images: Array<{ data: string; mimeType: string; name?: string }>, cwd = piCwd) {
  if (!images.length) return "";
  await ensurePiWebStorage(cwd);
  const uploadDir = join(cwd, ".pi", "web", "uploads");
  await mkdir(uploadDir, { recursive: true });

  const lines: string[] = [];
  for (const image of images) {
    const extension = imageExtensions[image.mimeType] || ".img";
    const safeName = String(image.name || "image").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
    const fileName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}-${safeName}${safeName.endsWith(extension) ? "" : extension}`;
    const filePath = join(uploadDir, fileName);
    const data = Buffer.from(image.data, "base64");
    await writeFile(filePath, data);
    lines.push(`- ${filePath}`);
  }

  return `\n\nAttached image file${images.length === 1 ? "" : "s"}:\n${lines.join("\n")}`;
}

function messageEntryRefs(targetSession: PiWebSession) {
  const getBranch = targetSession.sessionManager?.getBranch;
  if (typeof getBranch !== "function") return [];
  try {
    const branch = getBranch.call(targetSession.sessionManager);
    return Array.isArray(branch) ? projectMessageEntryRefs(branch) : [];
  } catch {
    return [];
  }
}

// Runtime tool timestamps are host state; the projection receives the decorated message.
function simplifyMessage(message: unknown, toolCallArgs?: Map<string, Record<string, unknown>>, sessionFile?: string, entryId?: string) {
  if (!message || typeof message !== "object") return projectSimplifiedMessage(message, toolCallArgs, entryId);
  const value = message as Record<string, unknown>;
  const content = activity.decorateMessageContent(value.content, sessionFile);
  return projectSimplifiedMessage(content === value.content ? message : { ...value, content }, toolCallArgs, entryId);
}

function conversationTreeForSession(targetSession: PiWebSession) {
  const manager = targetSession.sessionManager;
  if (typeof manager.getTree !== "function") throw new Error("Session tree is not available");
  const leafId = typeof manager.getLeafId === "function" ? manager.getLeafId() : null;
  const activePath = typeof manager.getBranch === "function" ? manager.getBranch() : [];
  return projectConversationTree({
    sessionId: targetSession.sessionId,
    leafId,
    activePath,
    roots: manager.getTree(),
  });
}

function sessionCwd(targetSession: PiWebSession | any) {
  return String(targetSession?.sessionManager?.getCwd?.() || targetSession?.cwd || piCwd);
}

type RetrySessionTarget =
  | { kind: "failure"; messages: any[]; index: number; message: any }
  | { kind: "aborted"; messages: any[]; index: number; message: any }
  | { kind: "toolResult"; messages: any[]; index: number; message: any };

function trailingRetryTarget(targetSession: PiWebSession): RetrySessionTarget | undefined {
  const messages = Array.isArray(targetSession.agent?.state?.messages) ? targetSession.agent.state.messages as any[] : [];
  const index = messages.length - 1;
  const message = index >= 0 ? messages[index] : undefined;
  if (isAssistantFailureMessage(message)) return { kind: "failure", messages, index, message };
  if (isAssistantAbortedMessage(message)) return { kind: "aborted", messages, index, message };
  if (isIncompleteToolResultMessage(message)) return { kind: "toolResult", messages, index, message };
  return undefined;
}

function branchBeforeTrailingMessages(targetSession: PiWebSession, shouldBranchBefore: (message: any) => boolean) {
  const manager = targetSession.sessionManager;
  if (typeof manager.getBranch !== "function") return false;
  let branch: any[];
  try {
    branch = manager.getBranch();
  } catch {
    return false;
  }
  if (!Array.isArray(branch)) return false;

  let lastMessageIndex = -1;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    if (branch[index]?.type === "message") {
      lastMessageIndex = index;
      break;
    }
  }
  if (lastMessageIndex < 0) return false;
  const lastMessage = branch[lastMessageIndex]?.message;
  if (!shouldBranchBefore(lastMessage)) return false;

  let firstRemovedIndex = lastMessageIndex;
  while (firstRemovedIndex > 0) {
    const previous = branch[firstRemovedIndex - 1];
    if (previous?.type !== "message" || !shouldBranchBefore(previous.message)) break;
    firstRemovedIndex -= 1;
  }

  const firstRemoved = branch[firstRemovedIndex];
  const parentId = typeof firstRemoved?.parentId === "string" ? firstRemoved.parentId : null;
  if (parentId && typeof manager.branch === "function") manager.branch(parentId);
  else if (!parentId && typeof manager.resetLeaf === "function") manager.resetLeaf();
  else return false;
  return true;
}

function syncAgentMessagesToSessionContext(targetSession: PiWebSession) {
  const internal = targetSession as any;
  if (typeof targetSession.sessionManager?.buildSessionContext !== "function") return false;
  internal.agent.state.messages = targetSession.sessionManager.buildSessionContext().messages;
  return true;
}

function assertCanRetryFromFailure(targetSession: PiWebSession) {
  if (targetSession.isStreaming) throw new Error("Wait for the current response to finish before retrying.");
  if (targetSession.isCompacting) throw new Error("Wait for compaction to finish before retrying.");
  if (!trailingRetryTarget(targetSession)) throw new Error("There is no failed or incomplete response to retry.");
}

async function retrySessionFromFailure(targetSession: PiWebSession) {
  assertCanRetryFromFailure(targetSession);
  if (typeof targetSession.retryFromFailure === "function") {
    await targetSession.retryFromFailure();
    return;
  }

  const target = trailingRetryTarget(targetSession);
  if (!target) throw new Error("There is no failed or incomplete response to retry.");

  const internal = targetSession as any;
  if (!internal.agent || typeof internal.agent.continue !== "function") throw new Error("Continuing is not available in this session.");

  if (target.kind === "failure") {
    const branched = branchBeforeTrailingMessages(targetSession, isAssistantFailureMessage);
    if (!branched || !syncAgentMessagesToSessionContext(targetSession)) {
      while (target.messages.length > 0 && isAssistantFailureMessage(target.messages[target.messages.length - 1])) target.messages.pop();
    }
  } else if (target.kind === "aborted") {
    const branched = branchBeforeTrailingMessages(targetSession, isAssistantAbortedMessage);
    if (!branched || !syncAgentMessagesToSessionContext(targetSession)) {
      if (isAssistantAbortedMessage(target.messages[target.messages.length - 1])) target.messages.pop();
    }
  }

  try {
    await internal.agent.continue();
    while (typeof internal._handlePostAgentRun === "function" && await internal._handlePostAgentRun()) {
      await internal.agent.continue();
    }
  } finally {
    internal._systemPromptOverride = undefined;
    if (typeof internal._flushPendingBashMessages === "function") internal._flushPendingBashMessages();
  }
}

function sessionIsRetrying(live: PiWebSession | undefined) {
  return Boolean(live?.isRetrying);
}

function runtimeForPath(path: string, overrides: { isRetrying?: boolean } = {}) {
  const live = liveSessions.get(path)?.session;
  const isStreaming = Boolean(live?.isStreaming);
  const isRetrying = overrides.isRetrying ?? sessionIsRetrying(live);
  const isCompacting = Boolean(live?.isCompacting);
  const isRunning = isStreaming || isRetrying || isCompacting;
  const startedAt = activity.runtimeStartedAtForPath(path, isRunning, live);
  const lastActivityAt = activity.runtimeLastActivityAtForPath(path, isRunning, live);
  return {
    loaded: Boolean(live),
    isRunning,
    isStreaming,
    isRetrying,
    isCompacting,
    startedAt,
    lastActivityAt,
    pendingMessageCount: Number(live?.pendingMessageCount || 0),
    model: simplifyModel(live?.model),
  };
}

function stoppedRuntimeForPath(path: string) {
  const live = liveSessions.get(path)?.session;
  return {
    loaded: Boolean(live),
    isRunning: false,
    isStreaming: false,
    isRetrying: false,
    isCompacting: false,
    startedAt: undefined,
    lastActivityAt: undefined,
    pendingMessageCount: Number(live?.pendingMessageCount || 0),
    model: simplifyModel(live?.model),
  };
}

function runtimeForEvent(path: string, event: unknown) {
  const value = event && typeof event === "object" ? event as Record<string, unknown> : undefined;
  if ((value?.type === "agent_end" || value?.type === "compaction_end") && value.willRetry) {
    return runtimeForPath(path, { isRetrying: true });
  }
  return value?.type === "agent_end" || value?.type === "compaction_end"
    ? stoppedRuntimeForPath(path)
    : runtimeForPath(path);
}

function simplifySessionInfo(info: Awaited<ReturnType<typeof SessionManager.list>>[number], cwd = piCwd) {
  return {
    id: info.id,
    name: info.name,
    firstMessage: info.firstMessage,
    created: info.created.toISOString(),
    modified: info.modified.toISOString(),
    messageCount: info.messageCount,
    cwd: info.cwd || cwd,
    isCurrent: false,
    runtime: runtimeForPath(info.path),
  };
}

function applySessionUnreadState<T extends { id: string }>(sessions: T[], sessionUiState: { sessionUnreadStates?: Array<{ sessionId: string; unreadAt: string }> }) {
  const unreadById = new Map((sessionUiState.sessionUnreadStates || []).map((item) => [item.sessionId, item]));
  return sessions.map((item) => {
    const unread = unreadById.get(item.id);
    return unread ? { ...item, unread: true, unreadAt: unread.unreadAt } : { ...item, unread: false };
  });
}

async function listSessionInfos(extraCwds: string[] = []) {
  if (noSession) return [];
  if (mockMode) return mockSessions.map((info) => simplifySessionInfo(info as any, info.cwd || piCwd));
  const cwds = new Set<string>(knownCwds);
  for (const cwd of extraCwds) {
    if (typeof cwd !== "string" || !cwd.trim()) continue;
    cwds.add(resolve(cwd));
  }
  const groups = await Promise.all(Array.from(cwds).map(async (cwd) => {
    try {
      const sessions = await SessionManager.list(cwd);
      return sessions.map((info) => simplifySessionInfo(info, cwd));
    } catch {
      return [];
    }
  }));
  return groups.flat().sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
}

function sessionDisplayName(targetSession: PiWebSession) {
  return targetSession.getSessionName?.()?.trim()
    || targetSession.sessionName?.trim()
    || targetSession.sessionManager.getSessionName?.()?.trim()
    || undefined;
}

function liveSessionTitle(targetSession: PiWebSession) {
  return projectSessionTitle(sessionDisplayName(targetSession), targetSession.messages);
}

function sessionStats(targetSession: PiWebSession) {
  const branch = targetSession.sessionManager.getBranch?.();
  const entries = Array.isArray(branch) && branch.length > 0
    ? branch.map((entry: any) => entry?.message ?? entry)
    : targetSession.messages;
  return projectSessionStats(entries, targetSession.getContextUsage?.() || undefined);
}

function currentState(targetSession: PiWebSession) {
  const isRetrying = sessionIsRetrying(targetSession);
  const isRunning = Boolean(targetSession.isStreaming || isRetrying || targetSession.isCompacting);
  const runtime = runtimeForPath(targetSession.sessionFile);
  return projectSessionState({
    cwd: sessionCwd(targetSession),
    sessionFile: targetSession.sessionFile,
    sessionId: targetSession.sessionId,
    sessionName: sessionDisplayName(targetSession),
    sessionTitle: liveSessionTitle(targetSession),
    isStreaming: targetSession.isStreaming,
    isRetrying,
    isCompacting: Boolean(targetSession.isCompacting),
    runtimeStartedAt: typeof targetSession.runtimeStartedAt === "string"
      ? targetSession.runtimeStartedAt
      : activity.runtimeStartedAtForPath(targetSession.sessionFile, isRunning, targetSession),
    runtimeLastActivityAt: typeof targetSession.runtimeLastActivityAt === "string"
      ? targetSession.runtimeLastActivityAt
      : activity.runtimeLastActivityAtForPath(targetSession.sessionFile, isRunning, targetSession),
    runtime,
    model: targetSession.model,
    thinkingLevel: targetSession.thinkingLevel,
    stats: sessionStats(targetSession),
    webFooters: webUi.footerEntries(targetSession),
    webHeaderActions: webUi.headerActionEntries(targetSession),
    webGitTabs: webUi.gitTabEntries(targetSession),
  });
}

function currentStateWithThinkingLevels(targetSession: PiWebSession) {
  return {
    ...currentState(targetSession),
    thinkingLevels: targetSession.getAvailableThinkingLevels(),
  };
}

function getSessionSlashCommands(value: any): WebSlashCommandInfo[] {
  const commands: WebSlashCommandInfo[] = [];

  for (const command of value.extensionRunner?.getRegisteredCommands?.() || []) {
    commands.push({
      name: command.invocationName || command.name,
      description: command.description,
      source: "extension",
      sourceInfo: command.sourceInfo,
    });
  }

  for (const template of value.promptTemplates || value.resourceLoader?.getPrompts?.().prompts || []) {
    commands.push({
      name: template.name,
      description: template.description,
      source: "prompt",
      sourceInfo: template.sourceInfo,
    });
  }

  for (const skill of value.resourceLoader?.getSkills?.().skills || []) {
    commands.push({
      name: `skill:${skill.name}`,
      description: skill.description,
      source: "skill",
      sourceInfo: skill.sourceInfo,
    });
  }

  return commands.filter((command) => typeof command.name === "string" && command.name.length > 0);
}

function getSlashCommands(value: any = session): WebSlashCommandInfo[] {
  return [...webSlashCommands, ...getSessionSlashCommands(value)];
}

function formatSlashCommandList(commands: WebSlashCommandInfo[]) {
  const groups: Array<[string, string]> = [["web", "Web"], ["extension", "Extensions"], ["prompt", "Prompts"], ["skill", "Skills"]];
  const lines: string[] = ["Available slash commands:"];
  for (const [source, label] of groups) {
    const matching = commands.filter((command) => command.source === source);
    if (!matching.length) continue;
    lines.push("", `${label}:`);
    for (const command of matching) {
      lines.push(`/${command.name}${command.description ? ` - ${command.description}` : ""}`);
    }
  }
  return lines.join("\n");
}

function slashHelp(targetSession: PiWebSession = session) {
  return [
    "Type / in the composer to browse available commands.",
    "",
    "Web commands run in pi-web; extension, prompt, and skill commands are discovered from pi's extension/resource system.",
    "",
    formatSlashCommandList(getSlashCommands(targetSession)),
  ].join("\n");
}

function formatModelList(targetSession: PiWebSession = session) {
  return getAvailableModels(targetSession)
    .map((model: any) => `${model.provider}/${model.id}${model.name && model.name !== model.id ? ` (${model.name})` : ""}`)
    .join("\n");
}

async function executeSlashCommand(input: string, targetSession: PiWebSession = session) {
  const trimmed = input.trim();
  const [rawName = "", ...rest] = trimmed.replace(/^\/+/, "").split(/\s+/);
  const name = rawName.toLowerCase();
  const args = rest.join(" ").trim();

  switch (name) {
    case "help":
    case "?":
      return { message: slashHelp(targetSession), state: currentStateWithThinkingLevels(targetSession) };

    case "commands":
      return { message: formatSlashCommandList(getSlashCommands(targetSession)), state: currentStateWithThinkingLevels(targetSession) };

    case "reload": {
      if (targetSession.isStreaming) throw new Error("Wait for the current response to finish before reloading.");
      if (targetSession.isCompacting) throw new Error("Wait for compaction to finish before reloading.");
      if (typeof targetSession.reload !== "function") throw new Error("Reload is not available in this session.");
      await targetSession.reload();
      return { message: "Reloaded pi resources, extensions, and models.", state: currentStateWithThinkingLevels(targetSession) };
    }

    case "model": {
      if (!args) {
        return { message: formatModelList(targetSession) || "No models available.", state: currentStateWithThinkingLevels(targetSession) };
      }
      const slashIndex = args.indexOf("/");
      if (slashIndex <= 0) throw new Error("Usage: /model <provider/model-id>");
      const provider = args.slice(0, slashIndex);
      const id = args.slice(slashIndex + 1);
      const model = targetSession.modelRegistry.find(provider, id);
      if (!model) throw new Error(`Model not found: ${args}`);
      await targetSession.setModel(model);
      return { message: `Model set to ${provider}/${id}.`, state: currentStateWithThinkingLevels(targetSession) };
    }

    case "models":
      return { message: formatModelList(targetSession) || "No models available.", state: currentStateWithThinkingLevels(targetSession) };

    case "thinking": {
      if (!args) {
        return { message: `Thinking level: ${targetSession.thinkingLevel}\nAvailable: ${targetSession.getAvailableThinkingLevels().join(", ")}`, state: currentStateWithThinkingLevels(targetSession) };
      }
      const levels = targetSession.getAvailableThinkingLevels();
      if (!levels.includes(args as any)) throw new Error(`Unknown thinking level: ${args}. Available: ${levels.join(", ")}`);
      targetSession.setThinkingLevel(args as any);
      return { message: `Thinking level set to ${targetSession.thinkingLevel}.`, state: currentStateWithThinkingLevels(targetSession) };
    }

    case "new": {
      const newSession = await createNewLiveSession(sessionCwd(targetSession), targetSession.sessionFile);
      return { message: "New session.", state: currentStateWithThinkingLevels(newSession) };
    }

    case "clear": {
      if (targetSession.isStreaming) throw new Error("Wait for the current response to finish before clearing.");
      if (targetSession.isCompacting) throw new Error("Wait for compaction to finish before clearing.");
      const oldSessionId = targetSession.sessionId;
      const newSession = await createNewLiveSession(sessionCwd(targetSession), targetSession.sessionFile);
      const state = currentStateWithThinkingLevels(newSession);
      const sessionUiState = await transferCurrentTabUiState(oldSessionId, newSession.sessionId, state.sessionTitle || "New session", state.cwd);
      return { message: "Cleared tab. Previous session remains in history.", state: { ...state, sessionUiState } };
    }

    case "compact": {
      if (targetSession.isStreaming) throw new Error("Wait for the current response to finish before compacting.");
      if (targetSession.isCompacting) throw new Error("Compaction is already running.");
      if (typeof targetSession.compact !== "function") throw new Error("Compaction is not available in this session.");
      ensureRuntimeStartedAt(targetSession);
      const releaseWorkLease = acquireWorkLease(targetSession);
      void targetSession.compact(args || undefined).catch((error: unknown) => {
        clearRuntimeStartedAt(targetSession);
        broadcast({
          type: "server_error",
          sessionId: targetSession.sessionId,
          sessionFile: targetSession.sessionFile,
          error: error instanceof Error ? error.message : String(error),
        });
      }).finally(releaseWorkLease);
      return { message: "Compaction started.", state: currentStateWithThinkingLevels(targetSession) };
    }

    case "abort":
    case "stop":
      await targetSession.abort();
      return { message: "Aborted.", state: currentStateWithThinkingLevels(targetSession) };

    default:
      throw new Error(`Unknown slash command: /${name}. Try /help.`);
  }
}

async function findSessionInfoById(id: string, cwd?: string) {
  if (!id) return undefined;
  if (noSession) return undefined;
  if (mockMode) return mockSessions.find((info) => info.id === id);

  if (cwd && cwd.trim()) {
    const resolvedCwd = resolve(cwd);
    const sessionInfo = (await SessionManager.list(resolvedCwd)).find((info) => info.id === id);
    if (sessionInfo?.cwd) knownCwds.add(sessionInfo.cwd);
    if (sessionInfo) return sessionInfo;
  }

  for (const knownCwd of knownCwds) {
    const sessionInfo = (await SessionManager.list(knownCwd)).find((info) => info.id === id);
    if (sessionInfo?.cwd) knownCwds.add(sessionInfo.cwd);
    if (sessionInfo) return sessionInfo;
  }

  const sessionInfo = (await SessionManager.listAll()).find((info) => info.id === id);
  if (sessionInfo?.cwd) knownCwds.add(sessionInfo.cwd);
  return sessionInfo;
}

async function trashOrRemoveSessionFile(path: string) {
  try {
    await execFileAsync("trash", [path], { timeout: 15_000 });
    return "trashed" as const;
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
    await rm(path, { force: true });
    return "deleted" as const;
  }
}

async function deleteSessionById(id: string, cwd?: string) {
  if (noSession) throw new Error("Sessions are disabled.");

  const info = await findSessionInfoById(id, cwd);
  if (!info) {
    const error = new Error("Session not found");
    (error as any).status = 404;
    throw error;
  }

  const live = liveSessions.get(info.path);
  if (live?.session?.isStreaming || live?.session?.isCompacting) {
    const error = new Error("Wait for the session to finish before deleting it.");
    (error as any).status = 409;
    throw error;
  }

  if (live) await disposeLiveSession(info.path, "delete", true);

  if (mockMode) {
    const index = mockSessions.findIndex((item) => item.id === id);
    if (index >= 0) mockSessions.splice(index, 1);
    return { id, disposition: "deleted" as const };
  }

  return { id, disposition: await trashOrRemoveSessionFile(info.path) };
}

async function getOrCreateLiveSessionById(id: string, cwd?: string) {
  if (id === session.sessionId) return session;
  for (const entry of liveSessions.values()) {
    if (entry.session.sessionId === id) return entry.session;
  }
  const info = await findSessionInfoById(id, cwd);
  return info ? getOrCreateLiveSession(info.path) : undefined;
}

async function switchToSessionId(id: string, cwd?: string) {
  const target = await getOrCreateLiveSessionById(id, cwd);
  if (!target) throw new Error("Session not found");
  return target;
}

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const settingsStore = createSettingsStore(process.env.PI_WEB_SETTINGS_FILE || join(getAgentDir(), "pi-web-settings.json"));
const sessionUiStateStore = createSessionUiStateStore(process.env.PI_WEB_SESSION_UI_STATE_FILE || join(getAgentDir(), "pi-web-session-ui-state.json"));
type LiveSessionEntry = {
  session: PiWebSession;
  unsubscribe?: () => void;
  viewerClientIds: Set<string>;
  workLeases: number;
  disposeTimer?: ReturnType<typeof setTimeout>;
  disposing?: boolean;
};

function envMs(name: string, fallback: number) {
  const raw = Number(process.env[name] || fallback);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

const defaultSessionIdleGraceMs = 24 * 60 * 60 * 1000;
const sessionIdleGraceMs = envMs("PI_WEB_SESSION_IDLE_GRACE_MS", defaultSessionIdleGraceMs);
const viewerLeaseGraceMs = envMs("PI_WEB_VIEWER_LEASE_GRACE_MS", Math.min(30_000, sessionIdleGraceMs));
const websocketHeartbeatMs = envMs("PI_WEB_WS_HEARTBEAT_MS", 30_000);
const websocketMaxMissedHeartbeats = Math.max(1, Math.floor(envMs("PI_WEB_WS_MAX_MISSED_HEARTBEATS", 3)));
const liveSessions = new Map<string, LiveSessionEntry>();
let session: PiWebSession;
let modelFallbackMessage: string | undefined;

const activity = new SessionActivityTracker();
const viewerLeases = new ViewerLeaseBookkeeper(
  viewerLeaseGraceMs,
  (sessionKey, clientId) => {
    const entry = liveSessions.get(sessionKey);
    if (!entry) return;
    entry.viewerClientIds.add(clientId);
    cancelLiveSessionCleanup(entry);
  },
  (sessionKey, clientId) => {
    const entry = liveSessions.get(sessionKey);
    if (!entry) return;
    entry.viewerClientIds.delete(clientId);
    scheduleLiveSessionCleanup(sessionKey);
  },
);
const unreadEvents = new UnreadEventBookkeeper({
  notePiEvent: (sessionFile, event) => activity.noteEventForUnreadRecovery(sessionFile, event),
  clearUnread: (sessionId) => clearSessionUnread(sessionId),
  markUnread: (sessionId, unreadAt) => markSessionUnreadCompleted(sessionId, unreadAt),
});
const realtime = new RealtimeHub(1000, (value) => unreadEvents.handleBroadcast(value));

function broadcast(value: unknown) {
  realtime.broadcast(value);
}

if (websocketHeartbeatMs > 0) {
  const realtimeHeartbeat = setInterval(() => realtime.checkHeartbeats(websocketMaxMissedHeartbeats), websocketHeartbeatMs);
  realtimeHeartbeat.unref?.();
}

function broadcastSessionUiStateUpdate(operation: Promise<unknown>, warning: string) {
  void operation
    .then((sessionUiState) => broadcast({ type: "session_ui_state_changed", sessionUiState }))
    .catch((error) => console.warn(warning, error));
}

function markSessionUnreadCompleted(sessionId: string, unreadAt = new Date().toISOString()) {
  broadcastSessionUiStateUpdate(sessionUiStateStore.markUnread(sessionId, unreadAt), "Could not mark session unread:");
}

function clearSessionUnread(sessionId: string) {
  broadcastSessionUiStateUpdate(sessionUiStateStore.markRead(sessionId), "Could not clear session unread state:");
}

// Browser transport remains a thin adapter around serializable extension UI service events.
const webUi: WebUiExtensionService = new WebUiExtensionService({
  broadcast,
  emitExtensionUiEvent: (event) => broadcast(event),
  clientCount: () => realtime.clientCount,
  acquireWorkLease: (value) => acquireWorkLease(value),
  sessionCwd: (value) => sessionCwd(value as unknown as PiWebSession),
  createNewSession: async (cwd, previousSessionFile) => createNewLiveSession(cwd, previousSessionFile) as unknown as WebUiSession,
  currentStateWithThinkingLevels: (value) => currentStateWithThinkingLevels(value as unknown as PiWebSession),
}, randomUUID);

const mockHarness = createMockHarness({
  piCwd,
  broadcast,
  isCurrentSession: (value: PiWebSession) => value === session,
  currentState: () => currentState(session),
});
const { mockSessions, createMockSession, resetMockSessions, getMockLifecycle } = mockHarness;

function sessionPathKey(value: Pick<PiWebSession, "sessionFile" | "sessionId">) {
  return String(value.sessionFile || value.sessionId || "");
}

function ensureRuntimeStartedAt(targetSession: PiWebSession, startedAt?: string) {
  return activity.ensureRuntimeStartedAt(targetSession, sessionPathKey(targetSession), startedAt);
}

function clearRuntimeStartedAt(targetSession: PiWebSession, sessionFile = sessionPathKey(targetSession)) {
  activity.clearRuntimeStartedAt(targetSession, sessionFile);
}

function cleanClientId(value: unknown) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, 120).replace(/[^a-zA-Z0-9_.:-]/g, "");
}

function clientIdFromRequest(req: IncomingMessage, fallback?: unknown) {
  const raw = req.headers["x-pi-web-client-id"];
  const headerValue = Array.isArray(raw) ? raw[0] : raw;
  return cleanClientId(headerValue) || cleanClientId(fallback);
}

function clearTimer(timer: ReturnType<typeof setTimeout> | undefined) {
  if (timer) clearTimeout(timer);
}

function cancelLiveSessionCleanup(entry: LiveSessionEntry) {
  clearTimer(entry.disposeTimer);
  entry.disposeTimer = undefined;
}

function isLiveSessionBusy(entry: LiveSessionEntry) {
  return Boolean(entry.session?.isStreaming || entry.session?.isCompacting || entry.workLeases > 0);
}

function shouldKeepLiveSession(entry: LiveSessionEntry) {
  return entry.session === session || entry.viewerClientIds.size > 0 || isLiveSessionBusy(entry);
}

function scheduleLiveSessionCleanup(key: string) {
  const entry = liveSessions.get(key);
  if (!entry || entry.disposing) return;
  if (shouldKeepLiveSession(entry)) {
    cancelLiveSessionCleanup(entry);
    return;
  }
  if (entry.disposeTimer) return;
  entry.disposeTimer = setTimeout(() => {
    entry.disposeTimer = undefined;
    void disposeLiveSession(key, "idle");
  }, sessionIdleGraceMs);
}

async function emitSessionShutdown(value: any) {
  const runner = value?.extensionRunner;
  if (!runner?.hasHandlers?.("session_shutdown")) return;
  await runner.emit({ type: "session_shutdown", reason: "quit" });
}

function clearSessionRuntimeMaps(key: string, value: PiWebSession) {
  activity.clearSessionPaths(key, value.sessionFile);
}

async function disposeLiveSession(key: string, reason: "idle" | "delete" | "reset" = "idle", force = false) {
  const entry = liveSessions.get(key);
  if (!entry || entry.disposing) return;
  if (!force && shouldKeepLiveSession(entry)) return;

  entry.disposing = true;
  cancelLiveSessionCleanup(entry);
  const value = entry.session;
  const sessionId = String(value.sessionId || "");
  const sessionFile = String(value.sessionFile || key || "");
  viewerLeases.releaseSession(key);

  try {
    await emitSessionShutdown(value);
  } catch (error) {
    console.warn(`Could not emit session shutdown before ${reason}:`, error);
  }

  try {
    entry.unsubscribe?.();
  } catch (error) {
    console.warn(`Could not unsubscribe session before ${reason}:`, error);
  }

  try {
    value.dispose?.();
  } catch (error) {
    console.warn(`Could not dispose session after ${reason}:`, error);
  }

  liveSessions.delete(key);
  clearSessionRuntimeMaps(key, value);

  if (sessionId) {
    broadcast({ type: "session_runtime_changed", sessionId, sessionFile, runtime: runtimeForPath(sessionFile) });
  }
}

function acquireViewerLease(clientId: string, value: PiWebSession | undefined) {
  if (!clientId || !value) return undefined;
  const key = sessionPathKey(value);
  if (!key || !liveSessions.has(key)) return undefined;
  return viewerLeases.acquire(clientId, key);
}

function bindViewerSocket(clientId: string, ws: RealtimeSocket) {
  viewerLeases.bindSocket(clientId, ws);
}

function noteViewerLeaseFromRequest(req: IncomingMessage, value: PiWebSession | undefined, fallbackClientId?: unknown) {
  const clientId = clientIdFromRequest(req, fallbackClientId);
  if (clientId) acquireViewerLease(clientId, value);
}

function acquireWorkLease(value: any) {
  const key = sessionPathKey(value);
  const entry = liveSessions.get(key);
  if (!entry) return () => undefined;
  entry.workLeases++;
  cancelLiveSessionCleanup(entry);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.workLeases = Math.max(0, entry.workLeases - 1);
    scheduleLiveSessionCleanup(key);
  };
}

function sessionEventRecord(event: unknown): Record<string, unknown> | undefined {
  return event && typeof event === "object" ? event as Record<string, unknown> : undefined;
}

// Session reads are deliberately isolated from host timestamp enrichment for the later event-service conversion.
function broadcastSessionReadFollowUps(value: PiWebSession, event: unknown, sessionId: string, sessionFile: string) {
  const source = sessionEventRecord(event);
  if (!source) return;
  if (source.type === "session_info_changed") {
    broadcast({ type: "state_changed", ...currentState(value) });
  }

  if (source.type === "message_end" || source.type === "agent_end" || source.type === "compaction_end") {
    broadcast({ type: "session_stats_changed", sessionId, sessionFile, stats: sessionStats(value) });
  }

  if (source.type !== "message_end" && source.type !== "turn_end") return;
  const toolResults = Array.isArray(source.toolResults) ? source.toolResults : [];
  const message = sessionEventRecord(source.message ?? toolResults[0]);
  const nestedMessage = sessionEventRecord(message?.message);
  const error = String(message?.errorMessage || nestedMessage?.errorMessage || "");
  const modelId = String(message?.model || nestedMessage?.model || "");
  if (!modelId || (!error.includes("model_not_supported") && !error.includes("model_not_available"))) return;
  if (blockedModelIds.has(modelId)) return;
  blockedModelIds.add(modelId);
  broadcast({ type: "models_updated", sessionId, models: getAvailableModels(value).map(simplifyModel) });
}

function registerLiveSession(value: PiWebSession) {
  const key = sessionPathKey(value);
  if (!key || liveSessions.get(key)?.session === value) return value;

  const unsubscribe = value.subscribe?.((event: unknown) => {
    const eventSessionFile = value.sessionFile;
    const eventSessionId = value.sessionId;
    // Host-only maps decorate outbound events before any session-reading follow-ups.
    const eventForClient = activity.decorateSessionEvent(value, key, event);

    broadcast({ type: "pi_event", sessionId: eventSessionId, sessionFile: eventSessionFile, event: eventForClient });
    broadcast({
      type: "session_runtime_changed",
      sessionId: eventSessionId,
      sessionFile: eventSessionFile,
      runtime: runtimeForEvent(eventSessionFile, event),
    });
    broadcastSessionReadFollowUps(value, event, eventSessionId, eventSessionFile);
  });
  liveSessions.set(key, { session: value, unsubscribe, viewerClientIds: new Set(), workLeases: 0 });
  queueMicrotask(() => scheduleLiveSessionCleanup(key));
  return value;
}

function additionalExtensionPaths(cwd = piCwd) {
  return [
    ...resolveBundledExtensionPaths({ piCwd: cwd, appDir, bundledExtensionsDir }),
    ...resolvePiWebExtensionPaths(cwd),
  ];
}

async function makeAgentSession(path?: string, sessionStartEvent?: SessionStartEvent, cwd = piCwd) {
  if (mockMode) {
    const session = createMockSession(path);
    await webUi.bindWebExtensions(session as unknown as WebUiSession);
    return { session, modelFallbackMessage: undefined };
  }

  const targetCwd = await assertDirectory(cwd);
  const sessionManager = noSession
    ? SessionManager.inMemory(targetCwd)
    : path
      ? SessionManager.open(path)
      : SessionManager.create(targetCwd);
  if (!path && !noSession && sessionStartEvent?.reason === "new") sessionManager.newSession();

  const resolvedCwd = sessionCwd({ sessionManager });
  knownCwds.add(resolvedCwd);
  await ensurePiWebStorage(resolvedCwd);

  const webUiContext = existsSync(webUiContextFile) ? readFileSync(webUiContextFile, "utf-8") : "";

  const loader = new DefaultResourceLoader({
    cwd: resolvedCwd,
    agentDir: getAgentDir(),
    additionalExtensionPaths: additionalExtensionPaths(resolvedCwd),
    appendSystemPromptOverride: (base) => [
      ...base,
      webUiContext,
    ].filter(Boolean),
  });
  await loader.reload();

  const result = await createAgentSession({
    cwd: resolvedCwd,
    sessionManager,
    authStorage,
    modelRegistry,
    resourceLoader: loader,
    sessionStartEvent,
  });
  await webUi.bindWebExtensions(result.session as unknown as WebUiSession);
  return result;
}

async function getOrCreateLiveSession(path: string) {
  const existing = liveSessions.get(path)?.session;
  if (existing) {
    scheduleLiveSessionCleanup(path);
    return existing;
  }
  const created = await makeAgentSession(path);
  if (created.modelFallbackMessage) console.warn(created.modelFallbackMessage);
  return registerLiveSession(created.session as PiWebSession);
}

async function applyDefaultSessionSettings(value: any) {
  const settings = await settingsStore.read();
  const modelSetting = settings.defaults.model;
  if (modelSetting) {
    const model = value.modelRegistry.find(modelSetting.provider, modelSetting.id);
    if (model) await value.setModel(model);
  }
  const thinkingLevel = settings.defaults.thinkingLevel;
  if (thinkingLevel && value.getAvailableThinkingLevels().includes(thinkingLevel as any)) {
    value.setThinkingLevel(thinkingLevel as any);
  }
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

async function createNewLiveSession(cwd?: string, previousSessionFile?: string) {
  const targetCwd = cwd ? await assertDirectory(cwd) : piCwd;
  knownCwds.add(targetCwd);
  await ensurePiWebStorage(targetCwd);
  const created = await makeAgentSession(undefined, { type: "session_start", reason: "new", previousSessionFile }, targetCwd);
  if (created.modelFallbackMessage) console.warn(created.modelFallbackMessage);
  const value = created.session;
  if (mockMode) {
    value.sessionManager.newSession();
    value.agent.state.messages = value.sessionManager.buildSessionContext().messages;
  }
  await applyDefaultSessionSettings(value);
  const liveSession = registerLiveSession(value as PiWebSession);
  await applyDefaultSessionBucket(liveSession.sessionId);
  return liveSession;
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

async function switchEmptySessionCwd(targetSession: PiWebSession, cwd: string) {
  if (targetSession.isStreaming) throw new Error("Wait for the current response to finish before changing the working directory.");
  if (targetSession.isCompacting) throw new Error("Wait for compaction to finish before changing the working directory.");
  if (hasUserMessages(targetSession.messages)) throw new Error("Working directory can only be changed before the first message.");
  const newSession = await createNewLiveSession(cwd, targetSession.sessionFile);
  return currentStateWithThinkingLevels(newSession);
}

await ensurePiWebStorage();

const createdSession = await makeAgentSession();
session = registerLiveSession(createdSession.session as PiWebSession);
modelFallbackMessage = createdSession.modelFallbackMessage;

if (modelFallbackMessage) {
  console.warn(modelFallbackMessage);
}

let viteDevServer: ViteDevServer | undefined;

const server = createServer(async (req, res) => {
  try {
    const method = req.method || "GET";
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname.startsWith("/api/")) {
      if (method === "GET" && url.pathname.startsWith("/api/artifacts/")) {
        return serveArtifact(req, res);
      }

      if (!isAuthorized(req)) return unauthorized(res);

      if (mockMode && method === "POST" && url.pathname === "/api/mock/reset") {
        await Promise.all(Array.from(liveSessions.keys()).map((key) => disposeLiveSession(key, "reset", true)));
        resetMockSessions();
        await sessionUiStateStore.write(defaultSessionUiState);
        const mockSession = createMockSession();
        await webUi.bindWebExtensions(mockSession as unknown as WebUiSession);
        session = registerLiveSession(mockSession);
        broadcast({ type: "session_ui_state_changed", sessionUiState: defaultSessionUiState });
        broadcast({ type: "state_changed", ...currentState(session) });
        return sendJson(res, 200, { ok: true });
      }

      if (mockMode && method === "GET" && url.pathname === "/api/mock/live-sessions") {
        return sendJson(res, 200, {
          ok: true,
          liveSessions: Array.from(liveSessions.values()).map((entry) => ({
            sessionId: String(entry.session?.sessionId || ""),
            sessionFile: String(entry.session?.sessionFile || ""),
            viewerLeases: entry.viewerClientIds.size,
            workLeases: entry.workLeases,
            hasDisposeTimer: Boolean(entry.disposeTimer),
            isStreaming: Boolean(entry.session?.isStreaming),
            isCompacting: Boolean(entry.session?.isCompacting),
          })),
          viewerLeases: viewerLeases.snapshots(),
          lifecycle: getMockLifecycle(),
        });
      }

      if (method === "GET" && url.pathname === "/api/fs/dirs") {
        try {
          return sendJson(res, 200, await listDirectories(url.searchParams.get("path") || piCwd));
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "POST" && url.pathname === "/api/fs/dirs") {
        const body = await readBody(req) as { parent?: unknown; name?: unknown };
        try {
          return sendJson(res, 201, await createDirectory(String(body.parent || piCwd), String(body.name || "")));
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
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
          return sendJson(res, 200, await gitDiff({ cwd, path: url.searchParams.get("path") || "", staged: url.searchParams.get("staged") === "1" }));
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "GET" && url.pathname === "/api/git/image") {
        try {
          const baseCwd = await requestCwdFromSessionId(url.searchParams.get("sessionId"));
          const cwd = await gitCwdFromRepoParam(url.searchParams.get("repo"), baseCwd);
          if (!await isGitRepo(cwd)) return sendJson(res, 404, { ok: false, error: "Not a Git repository" });
          await sendGitImage(res, {
            cwd,
            path: url.searchParams.get("path") || "",
            oldPath: url.searchParams.get("oldPath") || undefined,
            version: url.searchParams.get("version") || "",
            staged: url.searchParams.get("staged") === "1",
          });
          return;
        } catch (error) {
          return sendJson(res, 404, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "POST" && url.pathname === "/api/git/sync") {
        try {
          const baseCwd = await requestCwdFromSessionId(url.searchParams.get("sessionId"));
          const cwd = await gitCwdFromRepoParam(url.searchParams.get("repo"), baseCwd);
          return sendJson(res, 200, await gitSync(cwd));
        } catch (error: any) {
          return sendJson(res, Number(error?.status) || 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "GET" && url.pathname === "/api/state") {
        const requestedSessionId = url.searchParams.get("sessionId") || session.sessionId;
        const targetSession = requestedSessionId === session.sessionId ? session : await getOrCreateLiveSessionById(requestedSessionId);
        if (!targetSession) return sendJson(res, 404, { ok: false, error: "Session not found" });
        noteViewerLeaseFromRequest(req, targetSession, url.searchParams.get("clientId"));
        return sendJson(res, 200, {
          ok: true,
          ...currentStateWithThinkingLevels(targetSession),
          sessionUiState: await sessionUiStateStore.read(),
          tokenRequired: Boolean(token),
        });
      }

      if (method === "POST" && url.pathname === "/api/web-header-action/invoke") {
        const body = await readBody(req) as { sessionId?: unknown; key?: unknown };
        const requestedSessionId = typeof body.sessionId === "string" ? body.sessionId : session.sessionId;
        const targetSession = requestedSessionId === session.sessionId ? session : await getOrCreateLiveSessionById(requestedSessionId);
        if (!targetSession) return sendJson(res, 404, { ok: false, error: "Session not found" });
        const actionKey = cleanWebUiKey(body.key);
        if (!actionKey) return sendJson(res, 400, { ok: false, error: "key is required" });
        if (!webUi.hasHeaderAction(targetSession, actionKey)) return sendJson(res, 404, { ok: false, error: "Header action not found" });
        try {
          const result = await webUi.invokeHeaderAction(targetSession, actionKey);
          if (!result) return sendJson(res, 400, { ok: false, error: "Header action returned no markdown" });
          return sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "POST" && url.pathname === "/api/web-git-tab/invoke") {
        const body = await readBody(req) as { sessionId?: unknown; key?: unknown; action?: unknown; payload?: unknown; repo?: unknown };
        const requestedSessionId = typeof body.sessionId === "string" ? body.sessionId : session.sessionId;
        const targetSession = requestedSessionId === session.sessionId ? session : await getOrCreateLiveSessionById(requestedSessionId);
        if (!targetSession) return sendJson(res, 404, { ok: false, error: "Session not found" });
        const tabKey = cleanWebUiKey(body.key);
        if (!tabKey) return sendJson(res, 400, { ok: false, error: "key is required" });
        if (!webUi.hasGitTab(targetSession, tabKey)) return sendJson(res, 404, { ok: false, error: "Git tab not found" });
        try {
          const repo = body.repo && typeof body.repo === "object" ? body.repo as Record<string, unknown> : undefined;
          const result = await webUi.invokeGitTab(targetSession, tabKey, {
            action: typeof body.action === "string" ? body.action : undefined,
            payload: body.payload,
            repo: repo ? {
              path: typeof repo.path === "string" ? repo.path : undefined,
              root: typeof repo.root === "string" ? repo.root : undefined,
              branch: typeof repo.branch === "string" ? repo.branch : undefined,
            } : undefined,
          });
          if (!result) return sendJson(res, 400, { ok: false, error: "Git tab returned no HTML" });
          return sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "GET" && url.pathname === "/api/session/stats") {
        const requestedSessionId = url.searchParams.get("sessionId") || session.sessionId;
        const targetSession = requestedSessionId === session.sessionId ? session : await getOrCreateLiveSessionById(requestedSessionId);
        if (!targetSession) return sendJson(res, 404, { ok: false, error: "Session not found" });
        return sendJson(res, 200, { ok: true, sessionId: targetSession.sessionId, stats: sessionStats(targetSession) });
      }

      if (method === "GET" && url.pathname === "/api/session/tree") {
        const requestedSessionId = url.searchParams.get("sessionId") || session.sessionId;
        const targetSession = requestedSessionId === session.sessionId ? session : await getOrCreateLiveSessionById(requestedSessionId);
        if (!targetSession) return sendJson(res, 404, { ok: false, error: "Session not found" });
        try {
          return sendJson(res, 200, conversationTreeForSession(targetSession));
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "POST" && url.pathname === "/api/session/tree/navigate") {
        const body = await readBody(req) as { sessionId?: unknown; targetId?: unknown; summarize?: unknown; customInstructions?: unknown; replaceInstructions?: unknown; label?: unknown };
        const requestedSessionId = typeof body.sessionId === "string" ? body.sessionId : session.sessionId;
        const targetSession = requestedSessionId === session.sessionId ? session : await getOrCreateLiveSessionById(requestedSessionId);
        if (!targetSession) return sendJson(res, 404, { ok: false, error: "Session not found" });
        if (targetSession.isStreaming) return sendJson(res, 409, { ok: false, error: "Wait for the current response to finish before navigating the tree" });
        if (targetSession.isCompacting) return sendJson(res, 409, { ok: false, error: "Wait for the current compaction to finish before navigating the tree" });
        if (typeof targetSession.navigateTree !== "function") return sendJson(res, 400, { ok: false, error: "Tree navigation is not available" });

        const targetId = String(body.targetId || "").trim();
        if (!targetId) return sendJson(res, 400, { ok: false, error: "targetId is required" });

        const releaseWorkLease = acquireWorkLease(targetSession);
        try {
          const navigation = targetSession.navigateTree(targetId, {
            summarize: Boolean(body.summarize),
            customInstructions: typeof body.customInstructions === "string" && body.customInstructions.trim() ? body.customInstructions.trim() : undefined,
            replaceInstructions: Boolean(body.replaceInstructions),
            label: typeof body.label === "string" && body.label.trim() ? body.label.trim() : undefined,
          });
          broadcast({ type: "session_runtime_changed", sessionId: targetSession.sessionId, sessionFile: targetSession.sessionFile, runtime: runtimeForPath(targetSession.sessionFile) });
          const result = await navigation;
          const state = currentStateWithThinkingLevels(targetSession);
          broadcast({ type: "state_changed", ...state });
          return sendJson(res, 200, { ok: true, ...result, leafId: targetSession.sessionManager.getLeafId?.() || null, state });
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        } finally {
          releaseWorkLease();
          broadcast({ type: "session_runtime_changed", sessionId: targetSession.sessionId, sessionFile: targetSession.sessionFile, runtime: runtimeForPath(targetSession.sessionFile) });
        }
      }

      if (method === "POST" && url.pathname === "/api/session/tree/abort-summary") {
        const body = await readBody(req) as { sessionId?: unknown };
        const requestedSessionId = typeof body.sessionId === "string" ? body.sessionId : session.sessionId;
        const targetSession = requestedSessionId === session.sessionId ? session : await getOrCreateLiveSessionById(requestedSessionId);
        if (!targetSession) return sendJson(res, 404, { ok: false, error: "Session not found" });
        targetSession.abortBranchSummary?.();
        return sendJson(res, 202, { ok: true, sessionId: targetSession.sessionId });
      }

      if (method === "GET" && url.pathname === "/api/messages") {
        const requestedSessionId = url.searchParams.get("sessionId") || session.sessionId;
        const targetSession = requestedSessionId === session.sessionId ? session : await getOrCreateLiveSessionById(requestedSessionId);
        if (!targetSession) return sendJson(res, 404, { ok: false, error: "Session not found" });
        const msgs = targetSession.messages;
        // Build toolCallId -> args map from assistant messages
        const toolCallArgs = new Map<string, Record<string, unknown>>();
        for (const m of msgs) {
          const msg = m as any;
          if (msg.role === "assistant" && Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if (part?.type === "toolCall" && part.id) {
                toolCallArgs.set(part.id, part.arguments || {});
              }
            }
          }
        }
        const refs = messageEntryRefs(targetSession);
        return sendJson(res, 200, { ok: true, messages: msgs.map((m: unknown, index: number) => simplifyMessage(m, toolCallArgs, targetSession.sessionFile, refs[index]?.entryId)) });
      }

      if (method === "GET" && url.pathname === "/api/sessions") {
        const extraCwds = url.searchParams.getAll("cwd");
        const sessionUiState = await sessionUiStateStore.read();
        return sendJson(res, 200, { ok: true, sessions: applySessionUnreadState(await listSessionInfos(extraCwds), sessionUiState) });
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
          const result = await deleteSessionById(requestedId, typeof body.cwd === "string" && body.cwd.trim() ? body.cwd : undefined);
          const sessionUiState = await sessionUiStateStore.removeSession(result.id);
          broadcast({ type: "session_deleted", sessionId: result.id, disposition: result.disposition });
          broadcast({ type: "session_ui_state_changed", sessionUiState });
          return sendJson(res, 200, { ok: true, ...result });
        } catch (error: any) {
          return sendJson(res, Number(error?.status) || 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }


      if (method === "GET" && url.pathname === "/api/settings") {
        return sendJson(res, 200, { ok: true, settings: await settingsStore.read() });
      }

      if (method === "PATCH" && url.pathname === "/api/settings") {
        const settings = await settingsStore.patch(await readBody(req));
        broadcast({ type: "settings_updated", settings });
        return sendJson(res, 200, { ok: true, settings });
      }

      if (method === "GET" && url.pathname === "/api/commands") {
        const requestedSessionId = url.searchParams.get("sessionId") || session.sessionId;
        const targetSession = requestedSessionId === session.sessionId ? session : await getOrCreateLiveSessionById(requestedSessionId);
        if (!targetSession) return sendJson(res, 404, { ok: false, error: "Session not found" });
        return sendJson(res, 200, { ok: true, commands: getSlashCommands(targetSession) });
      }

      if (method === "GET" && url.pathname === "/api/models") {
        const requestedSessionId = url.searchParams.get("sessionId") || session.sessionId;
        const targetSession = requestedSessionId === session.sessionId ? session : await getOrCreateLiveSessionById(requestedSessionId);
        if (!targetSession) return sendJson(res, 404, { ok: false, error: "Session not found" });
        return sendJson(res, 200, {
          ok: true,
          cwd: sessionCwd(targetSession),
          current: simplifyModel(targetSession.model),
          thinkingLevel: targetSession.thinkingLevel,
          thinkingLevels: targetSession.getAvailableThinkingLevels(),
          models: getAvailableModels(targetSession).map(simplifyModel),
        });
      }

      if (method === "POST" && url.pathname === "/api/model") {
        const body = await readBody(req) as { sessionId?: unknown; provider?: unknown; id?: unknown; thinkingLevel?: unknown };
        const requestedSessionId = typeof body.sessionId === "string" ? body.sessionId : session.sessionId;
        const targetSession = requestedSessionId === session.sessionId ? session : await getOrCreateLiveSessionById(requestedSessionId);
        if (!targetSession) return sendJson(res, 404, { ok: false, error: "Session not found" });
        const provider = String(body.provider || "").trim();
        const id = String(body.id || "").trim();
        if (!provider || !id) return sendJson(res, 400, { ok: false, error: "provider and id are required" });

        const model = targetSession.modelRegistry.find(provider, id);
        if (!model) return sendJson(res, 404, { ok: false, error: "Model not found" });

        await targetSession.setModel(model);
        if (typeof body.thinkingLevel === "string") targetSession.setThinkingLevel(body.thinkingLevel as any);

        const state = currentStateWithThinkingLevels(targetSession);
        broadcast({ type: "state_changed", ...state });
        return sendJson(res, 200, { ok: true, ...state });
      }

      if (method === "POST" && url.pathname === "/api/command") {
        const body = await readBody(req) as { sessionId?: unknown; command?: unknown };
        const requestedSessionId = typeof body.sessionId === "string" ? body.sessionId : session.sessionId;
        const targetSession = requestedSessionId === session.sessionId ? session : await getOrCreateLiveSessionById(requestedSessionId);
        if (!targetSession) return sendJson(res, 404, { ok: false, error: "Session not found" });
        const command = String(body.command || "").trim();
        if (!command.startsWith("/")) return sendJson(res, 400, { ok: false, error: "Slash command is required" });

        const result = await executeSlashCommand(command, targetSession);
        const stateSessionId = (result as any)?.state?.sessionId;
        const stateSession = typeof stateSessionId === "string" ? await getOrCreateLiveSessionById(stateSessionId) : undefined;
        noteViewerLeaseFromRequest(req, stateSession || targetSession);
        return sendJson(res, 200, { ok: true, ...result });
      }

      if (method === "POST" && url.pathname === "/api/shell") {
        const body = await readBody(req) as { sessionId?: unknown; command?: unknown; excludeFromContext?: unknown };
        const requestedSessionId = typeof body.sessionId === "string" ? body.sessionId : session.sessionId;
        const targetSession = requestedSessionId === session.sessionId ? session : await getOrCreateLiveSessionById(requestedSessionId);
        if (!targetSession) return sendJson(res, 404, { ok: false, error: "Session not found" });
        const command = String(body.command || "").trim();
        if (!command) return sendJson(res, 400, { ok: false, error: "command is required" });
        if (typeof targetSession.executeBash !== "function") return sendJson(res, 400, { ok: false, error: "Bash execution is not available in this session." });
        const excludeFromContext = Boolean(body.excludeFromContext);
        const result = await targetSession.executeBash(command, undefined, { excludeFromContext });
        return sendJson(res, 200, { ok: true, command, cwd: sessionCwd(targetSession), ...result, excludeFromContext });
      }

      if (method === "POST" && url.pathname === "/api/extension-ui/respond") {
        const body = await readBody(req) as { id?: unknown } & Record<string, unknown>;
        const id = String(body.id || "").trim();
        if (!id) return sendJson(res, 400, { ok: false, error: "id is required" });
        if (!webUi.respondExtensionUi({ ...body, id })) return sendJson(res, 404, { ok: false, error: "Extension UI request not found" });
        return sendJson(res, 200, { ok: true });
      }

      if (method === "POST" && url.pathname === "/api/prompt") {
        const body = await readBody(req) as { sessionId?: unknown; message?: unknown; mode?: unknown; images?: unknown };
        const message = String(body.message || "").trim();
        const images = Array.isArray(body.images)
          ? body.images.filter((image): image is { type: "image"; data: string; mimeType: string; name?: string } => {
            if (!image || typeof image !== "object") return false;
            const value = image as Record<string, unknown>;
            return value.type === "image"
              && typeof value.data === "string"
              && typeof value.mimeType === "string"
              && value.mimeType.startsWith("image/");
          })
          : [];
        if (!message && images.length === 0) return sendJson(res, 400, { ok: false, error: "message or image is required" });

        const mode = body.mode === "followUp" ? "followUp" : "steer";
        const requestedSessionId = typeof body.sessionId === "string" ? body.sessionId : session.sessionId;
        const targetSession = requestedSessionId === session.sessionId ? session : await getOrCreateLiveSessionById(requestedSessionId);
        if (!targetSession) return sendJson(res, 404, { ok: false, error: "Session not found" });
        const imageFileNote = await persistPromptImages(images, sessionCwd(targetSession));
        const promptText = `${message || "Please review the attached image."}${imageFileNote}`;
        const wasAlreadyRunning = Boolean(targetSession.isStreaming || targetSession.isCompacting);
        if (!wasAlreadyRunning) ensureRuntimeStartedAt(targetSession);
        const promptSessionFile = targetSession.sessionFile;
        const releaseWorkLease = acquireWorkLease(targetSession);
        void targetSession.prompt(promptText, {
          ...(targetSession.isStreaming ? { streamingBehavior: mode } : {}),
          ...(images.length ? { images: images.map(({ type, data, mimeType }) => ({ type, data, mimeType })) } : {}),
        })
          .catch((error: unknown) => {
            broadcast({
              type: "server_error",
              sessionId: targetSession.sessionId,
              sessionFile: targetSession.sessionFile,
              error: error instanceof Error ? error.message : String(error),
            });
          })
          .finally(() => {
            const isRunning = Boolean(targetSession.isStreaming || targetSession.isCompacting);
            const missedTerminalEvent = Boolean(promptSessionFile && activity.hasRuntimeStartedAt(promptSessionFile) && !isRunning);
            if (missedTerminalEvent) {
              clearRuntimeStartedAt(targetSession, promptSessionFile);
              markSessionUnreadCompleted(targetSession.sessionId);
            }
            broadcast({
              type: "session_runtime_changed",
              sessionId: targetSession.sessionId,
              sessionFile: targetSession.sessionFile,
              runtime: runtimeForPath(targetSession.sessionFile),
            });
            releaseWorkLease();
          });

        return sendJson(res, 202, { ok: true, sessionId: targetSession.sessionId });
      }

      if (method === "POST" && url.pathname === "/api/session/retry") {
        const body = await readBody(req) as { sessionId?: unknown };
        const requestedSessionId = typeof body.sessionId === "string" ? body.sessionId : session.sessionId;
        const targetSession = requestedSessionId === session.sessionId ? session : await getOrCreateLiveSessionById(requestedSessionId);
        if (!targetSession) return sendJson(res, 404, { ok: false, error: "Session not found" });
        try {
          assertCanRetryFromFailure(targetSession);
        } catch (error) {
          return sendJson(res, 409, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }

        ensureRuntimeStartedAt(targetSession);
        const retrySessionFile = targetSession.sessionFile;
        const releaseWorkLease = acquireWorkLease(targetSession);
        void retrySessionFromFailure(targetSession)
          .catch((error: unknown) => {
            clearRuntimeStartedAt(targetSession, retrySessionFile);
            broadcast({
              type: "server_error",
              sessionId: targetSession.sessionId,
              sessionFile: targetSession.sessionFile,
              error: error instanceof Error ? error.message : String(error),
            });
          })
          .finally(() => {
            const isRunning = Boolean(targetSession.isStreaming || targetSession.isCompacting);
            const missedTerminalEvent = Boolean(retrySessionFile && activity.hasRuntimeStartedAt(retrySessionFile) && !isRunning);
            if (missedTerminalEvent) {
              clearRuntimeStartedAt(targetSession, retrySessionFile);
              markSessionUnreadCompleted(targetSession.sessionId);
            }
            broadcast({
              type: "session_runtime_changed",
              sessionId: targetSession.sessionId,
              sessionFile: targetSession.sessionFile,
              runtime: runtimeForPath(targetSession.sessionFile),
            });
            releaseWorkLease();
          });

        return sendJson(res, 202, { ok: true, sessionId: targetSession.sessionId });
      }

      if (method === "POST" && url.pathname === "/api/abort") {
        const body = await readBody(req) as { sessionId?: unknown };
        const requestedSessionId = typeof body.sessionId === "string" ? body.sessionId : session.sessionId;
        const targetSession = requestedSessionId === session.sessionId ? session : await getOrCreateLiveSessionById(requestedSessionId);
        if (!targetSession) return sendJson(res, 404, { ok: false, error: "Session not found" });
        void targetSession.abort().catch((error: unknown) => broadcast({
          type: "server_error",
          sessionId: targetSession.sessionId,
          sessionFile: targetSession.sessionFile,
          error: error instanceof Error ? error.message : String(error),
        }));
        return sendJson(res, 202, { ok: true, sessionId: targetSession.sessionId });
      }

      if (method === "POST" && url.pathname === "/api/compaction/abort") {
        const body = await readBody(req) as { sessionId?: unknown };
        const requestedSessionId = typeof body.sessionId === "string" ? body.sessionId : session.sessionId;
        const targetSession = requestedSessionId === session.sessionId ? session : await getOrCreateLiveSessionById(requestedSessionId);
        if (!targetSession) return sendJson(res, 404, { ok: false, error: "Session not found" });
        if (typeof targetSession.abortCompaction !== "function") return sendJson(res, 400, { ok: false, error: "Compaction cancellation is not available" });
        targetSession.abortCompaction();
        return sendJson(res, 202, { ok: true, sessionId: targetSession.sessionId });
      }

      if (method === "POST" && url.pathname === "/api/session/name") {
        const body = await readBody(req) as { sessionId?: unknown; name?: unknown };
        const requestedSessionId = typeof body.sessionId === "string" ? body.sessionId : session.sessionId;
        const targetSession = requestedSessionId === session.sessionId ? session : await getOrCreateLiveSessionById(requestedSessionId);
        if (!targetSession) return sendJson(res, 404, { ok: false, error: "Session not found" });
        if (typeof targetSession.setSessionName !== "function") return sendJson(res, 400, { ok: false, error: "Renaming sessions is not available" });

        const name = String(body.name || "").trim();
        targetSession.setSessionName(name);
        const state = currentStateWithThinkingLevels(targetSession);
        return sendJson(res, 200, { ok: true, ...state });
      }

      if (method === "POST" && (url.pathname === "/api/new-chat" || url.pathname === "/api/sessions/new")) {
        const body = await readBody(req) as { cwd?: unknown; sessionId?: unknown };
        const previousSession = typeof body.sessionId === "string" ? await getOrCreateLiveSessionById(body.sessionId) : session;
        const targetCwd = typeof body.cwd === "string" ? body.cwd : previousSession ? sessionCwd(previousSession) : undefined;
        const newSession = await createNewLiveSession(targetCwd, previousSession?.sessionFile);
        noteViewerLeaseFromRequest(req, newSession);
        const state = currentStateWithThinkingLevels(newSession);
        broadcast({ type: "state_changed", ...state });
        return sendJson(res, 200, { ok: true, ...state });
      }

      if (method === "POST" && url.pathname === "/api/session/cwd") {
        const body = await readBody(req) as { sessionId?: unknown; cwd?: unknown };
        const cwd = String(body.cwd || "").trim();
        if (!cwd) return sendJson(res, 400, { ok: false, error: "cwd is required" });
        const requestedSessionId = typeof body.sessionId === "string" ? body.sessionId : session.sessionId;
        const targetSession = requestedSessionId === session.sessionId ? session : await getOrCreateLiveSessionById(requestedSessionId);
        if (!targetSession) return sendJson(res, 404, { ok: false, error: "Session not found" });
        try {
          const state = await switchEmptySessionCwd(targetSession, cwd);
          const stateSession = state.sessionId ? await getOrCreateLiveSessionById(state.sessionId) : undefined;
          if (stateSession) noteViewerLeaseFromRequest(req, stateSession);
          broadcast({ type: "state_changed", ...state });
          return sendJson(res, 200, { ok: true, ...state });
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "POST" && url.pathname === "/api/sessions/open") {
        const body = await readBody(req) as { id?: unknown; sessionId?: unknown; cwd?: unknown; clientId?: unknown };
        const requestedId = typeof body.sessionId === "string" ? body.sessionId : typeof body.id === "string" ? body.id : "";
        if (!requestedId) return sendJson(res, 400, { ok: false, error: "sessionId is required" });

        let targetSession: PiWebSession | undefined;
        try {
          targetSession = await switchToSessionId(requestedId, typeof body.cwd === "string" && body.cwd.trim() ? body.cwd : undefined);
        } catch {
          return sendJson(res, 404, { ok: false, error: "Session not found" });
        }
        noteViewerLeaseFromRequest(req, targetSession, body.clientId);
        const state = currentStateWithThinkingLevels(targetSession || session);
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
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
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
  const realtimeWs = ws as RealtimeSocket;
  realtime.attach(realtimeWs);
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const replay = realtime.replaySince(Number(url.searchParams.get("lastSeq") || 0));
  const latestSeq = replay.latestSeq;

  if (replay.syncRequired) {
    ws.send(JSON.stringify({ type: "sync_required", latestSeq }));
  } else {
    for (const event of replay.events) ws.send(JSON.stringify(event));
  }

  const requestedSessionId = url.searchParams.get("sessionId") || session.sessionId;
  const targetSession = requestedSessionId === session.sessionId ? session : await getOrCreateLiveSessionById(requestedSessionId);
  const clientId = cleanClientId(url.searchParams.get("clientId") || "");
  if (clientId) {
    acquireViewerLease(clientId, targetSession || session);
    bindViewerSocket(clientId, realtimeWs);
  }
  const helloState = currentState(targetSession || session);
  realtimeWs.send(JSON.stringify({
    type: "hello",
    seq: latestSeq,
    ...helloState,
  }));
  realtimeWs.on("close", () => realtime.detach(realtimeWs));
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
