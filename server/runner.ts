import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { AuthStorage, createAgentSession, DefaultResourceLoader, getAgentDir, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";
import { encodeRuntimeMessage, parseRuntimeLine, type RuntimeRequest, type RuntimeResponse } from "./runtime/protocol.js";
import { artifactDirForCwd, artifactFileForCwd, readArtifactBase64, safeArtifactName } from "./shared/artifacts.js";
import { listDirectories } from "./shared/fsList.js";
import { gitDiff, gitStatus } from "./shared/git.js";
const rootCwd = resolve(process.env.PI_RUNNER_CWD || process.cwd());
const maxArtifactBytes = Number(process.env.PI_RUNNER_MAX_ARTIFACT_BYTES || 20 * 1024 * 1024);
const maxLiveSessions = Math.max(1, Number(process.env.PI_RUNNER_MAX_LIVE_SESSIONS || 50));
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const liveSessions = new Map<string, any>();
const subscriptions = new Map<string, () => void>();
const sessionActivityAt = new Map<string, string>();

function releaseRunnerSession(sessionId: string) {
  const session = liveSessions.get(sessionId);
  const unsubscribe = subscriptions.get(sessionId);
  try { unsubscribe?.(); } catch { /* ignore cleanup errors */ }
  try { session?.dispose?.(); } catch { /* ignore cleanup errors */ }
  subscriptions.delete(sessionId);
  liveSessions.delete(sessionId);
  sessionActivityAt.delete(sessionId);
}

function rememberLiveSession(session: any) {
  const sessionId = String(session?.sessionId || "");
  if (!sessionId) return session;
  if (liveSessions.has(sessionId)) liveSessions.delete(sessionId);
  liveSessions.set(sessionId, session);
  while (liveSessions.size > maxLiveSessions) {
    const oldest = liveSessions.keys().next().value as string | undefined;
    if (!oldest || oldest === sessionId && liveSessions.size <= 1) break;
    releaseRunnerSession(oldest);
  }
  return session;
}

function touchLiveSession(sessionId: string) {
  const session = liveSessions.get(sessionId);
  if (session) rememberLiveSession(session);
  return session;
}

async function loadSessionFromFile(sessionFile: string, fallbackCwd = rootCwd) {
  for (const session of liveSessions.values()) {
    if (session.sessionFile === sessionFile) return rememberLiveSession(session);
  }
  const sessionManager = SessionManager.open(sessionFile, undefined, fallbackCwd);
  const cwd = fallbackCwd;
  const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
  await loader.reload();
  const result = await createAgentSession({ cwd, sessionManager, authStorage, modelRegistry, resourceLoader: loader });
  rememberLiveSession(result.session);
  return result.session;
}

async function resolveSession(params: Record<string, unknown>) {
  const sessionId = String(params.sessionId || "");
  const existing = touchLiveSession(sessionId);
  if (existing) return existing;
  const sessionFile = typeof params.sessionFile === "string" ? params.sessionFile : "";
  if (sessionFile) return loadSessionFromFile(sessionFile, typeof params.cwd === "string" ? params.cwd : rootCwd);
  throw new Error("Session not found");
}

function send(value: RuntimeResponse | { event: string; data?: unknown }) {
  process.stdout.write(encodeRuntimeMessage(value));
}

function asPath(value: unknown, fallback = rootCwd): string {
  if (!value || typeof value !== "string") return fallback;
  return resolve(value);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object" && typeof (part as any).text === "string") return (part as any).text;
    return "";
  }).join("\n").trim();
}

function firstUserMessage(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages as any[]) {
    if (message?.role !== "user") continue;
    const text = textFromContent(message.content).trim();
    if (text) return text.slice(0, 160);
  }
  return undefined;
}

function simplifyModel(model: any) {
  if (!model) return undefined;
  return {
    provider: model.provider,
    id: model.id,
    name: model.name || model.id,
    reasoning: Boolean(model.reasoning),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

function modelState(session: any) {
  return {
    ok: true,
    cwd: String(session.sessionManager?.cwd || session.cwd || rootCwd),
    current: simplifyModel(session.model) || null,
    thinkingLevel: session.thinkingLevel || "off",
    thinkingLevels: typeof session.getAvailableThinkingLevels === "function" ? session.getAvailableThinkingLevels() : ["off"],
    models: typeof session.modelRegistry?.getAvailable === "function" ? session.modelRegistry.getAvailable().map(simplifyModel) : [],
  };
}

function sessionState(session: any) {
  const sessionName = session.getSessionName?.()?.trim()
    || session.sessionName?.trim?.()
    || session.sessionManager?.getSessionName?.()?.trim?.()
    || undefined;
  const firstMessage = firstUserMessage(session.messages);
  return {
    ok: true,
    sessionId: String(session.sessionId || ""),
    sessionFile: String(session.sessionFile || ""),
    cwd: String(session.sessionManager?.cwd || session.cwd || rootCwd),
    sessionName,
    firstMessage,
    isStreaming: Boolean(session.isStreaming),
    isCompacting: Boolean(session.isCompacting),
    model: simplifyModel(session.model) || null,
    thinkingLevel: session.thinkingLevel || "off",
    thinkingLevels: typeof session.getAvailableThinkingLevels === "function" ? session.getAvailableThinkingLevels() : ["off"],
    messages: Array.isArray(session.messages) ? session.messages.length : 0,
  };
}

function listedSessionState(info: Awaited<ReturnType<typeof SessionManager.listAll>>[number]) {
  const live = liveSessions.get(info.id);
  return {
    sessionId: info.id,
    sessionFile: info.path,
    cwd: info.cwd || rootCwd,
    sessionName: info.name,
    firstMessage: info.firstMessage || undefined,
    created: info.created.toISOString(),
    modified: info.modified.toISOString(),
    messages: info.messageCount,
    isStreaming: Boolean(live?.isStreaming),
    isCompacting: Boolean(live?.isCompacting),
  };
}

function listedLiveSessionState(session: any) {
  const state = sessionState(session);
  const headerTimestamp = session.sessionManager?.getHeader?.()?.timestamp;
  const timestamp = typeof headerTimestamp === "string" ? headerTimestamp : new Date().toISOString();
  return {
    sessionId: state.sessionId,
    sessionFile: state.sessionFile,
    cwd: state.cwd,
    sessionName: state.sessionName,
    firstMessage: state.firstMessage,
    created: timestamp,
    modified: sessionActivityAt.get(state.sessionId) || timestamp,
    messages: state.messages,
    isStreaming: state.isStreaming,
    isCompacting: state.isCompacting,
  };
}

function subscribeSession(session: any) {
  const sessionId = String(session.sessionId || "");
  if (!sessionId || subscriptions.has(sessionId)) return;
  const unsubscribe = session.subscribe?.((event: unknown) => {
    sessionActivityAt.set(sessionId, new Date().toISOString());
    send({ event: "session.event", data: { sessionId, sessionFile: String(session.sessionFile || ""), event } });
  });
  if (typeof unsubscribe === "function") subscriptions.set(sessionId, unsubscribe);
}

async function createRunnerSession(cwdValue: unknown) {
  const cwd = asPath(cwdValue || rootCwd);
  const sessionManager = SessionManager.create(cwd);
  const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
  await loader.reload();
  const result = await createAgentSession({ cwd, sessionManager, authStorage, modelRegistry, resourceLoader: loader });
  rememberLiveSession(result.session);
  sessionActivityAt.set(String(result.session.sessionId || ""), new Date().toISOString());
  subscribeSession(result.session);
  send({ event: "session.created", data: sessionState(result.session) });
  return sessionState(result.session);
}

function entryText(entry: any): string {
  const message = entry?.message || entry;
  return textFromContent(message?.content || entry?.summary || entry?.text || "");
}

function conversationTree(session: any) {
  const manager = session.sessionManager;
  if (typeof manager?.getTree !== "function") throw new Error("Session tree is not available");
  const leafId = typeof manager.getLeafId === "function" ? manager.getLeafId() : null;
  const activePath = typeof manager.getBranch === "function" ? manager.getBranch() : [];
  const activePathIds = new Set(activePath.map((entry: any) => String(entry?.id || "")).filter(Boolean));
  const nodes: any[] = [];
  const stack = [...manager.getTree()].reverse();
  while (stack.length) {
    const node = stack.pop();
    const entry = node?.entry || node;
    const children = Array.isArray(node?.children) ? node.children : [];
    const id = String(entry?.id || "");
    nodes.push({
      id,
      parentId: typeof entry?.parentId === "string" ? entry.parentId : null,
      type: String(entry?.type || "entry"),
      role: String(entry?.message?.role || entry?.role || entry?.type || "entry"),
      preview: entryText(entry).replace(/\s+/g, " ").trim().slice(0, 180),
      timestamp: String(entry?.timestamp || ""),
      label: typeof node?.label === "string" ? node.label : undefined,
      labelTimestamp: typeof node?.labelTimestamp === "string" ? node.labelTimestamp : undefined,
      childCount: children.length,
      isOnActivePath: activePathIds.has(id),
      isCurrentLeaf: Boolean(leafId && id === leafId),
      children: [],
    });
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
  }
  return { ok: true, sessionId: String(session.sessionId || ""), leafId, activePathIds: [...activePathIds], entryCount: nodes.length, branchPointCount: nodes.filter((node) => node.childCount > 1).length, nodes };
}

function promptImages(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((image): image is { type: "image"; data: string; mimeType: string } => {
    if (!image || typeof image !== "object") return false;
    const item = image as Record<string, unknown>;
    return item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string" && item.mimeType.startsWith("image/");
  });
}

async function handle(request: RuntimeRequest): Promise<unknown> {
  const params = (request.params || {}) as Record<string, unknown>;
  switch (request.method) {
    case "health":
      return { ok: true, cwd: rootCwd, pid: process.pid, protocol: "pi-runner-v1" };
    case "sessions.create":
      return createRunnerSession(params.cwd);
    case "sessions.list": {
      const requestedLimit = Number(params.limit || 100);
      const limit = Math.max(1, Math.min(500, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 100));
      const requestedCursor = Number(params.cursor || 0);
      const cursor = Math.max(0, Number.isFinite(requestedCursor) ? Math.floor(requestedCursor) : 0);
      const persisted = (await SessionManager.listAll()).map(listedSessionState);
      const sessionsById = new Map(persisted.map((item) => [item.sessionId, item]));
      for (const session of liveSessions.values()) {
        const live = listedLiveSessionState(session);
        const existing = sessionsById.get(live.sessionId);
        sessionsById.set(live.sessionId, existing ? { ...existing, ...live, created: existing.created, modified: sessionActivityAt.get(live.sessionId) || existing.modified } : live);
      }
      const sessions = Array.from(sessionsById.values()).sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
      const page = sessions.slice(cursor, cursor + limit);
      const nextCursor = cursor + page.length < sessions.length ? String(cursor + page.length) : undefined;
      return { ok: true, sessions: page, nextCursor, total: sessions.length };
    }
    case "sessions.subscribe": {
      const session = await resolveSession(params);
      subscribeSession(session);
      return { ok: true, sessionId: String(params.sessionId || session.sessionId) };
    }
    case "sessions.state": {
      const session = await resolveSession(params);
      subscribeSession(session);
      const state = sessionState(session);
      if (typeof params.sessionId === "string" && params.sessionId) state.sessionId = params.sessionId;
      return state;
    }
    case "sessions.messages": {
      const session = await resolveSession(params);
      return { ok: true, sessionId: String(params.sessionId || session.sessionId), messages: session.messages || [] };
    }
    case "sessions.prompt": {
      const session = await resolveSession(params);
      subscribeSession(session);
      const images = promptImages(params.images);
      const message = String(params.message || "").trim();
      if (!message && images.length === 0) throw new Error("message or image is required");
      send({ event: "session.prompt.start", data: { ...sessionState(session), isStreaming: true } });
      void session.prompt(message || "Please review the attached image.", images.length ? { images } : undefined).then(() => {
        send({ event: "session.prompt.done", data: sessionState(session) });
      }).catch((error: unknown) => {
        send({ event: "session.prompt.error", data: { sessionId: session.sessionId, error: error instanceof Error ? error.message : String(error) } });
      });
      return { ok: true, sessionId: String(params.sessionId || session.sessionId) };
    }
    case "sessions.abort": {
      const session = await resolveSession(params);
      await session.abort?.();
      return { ok: true, sessionId: String(params.sessionId || session.sessionId) };
    }
    case "sessions.tree": {
      return conversationTree(await resolveSession(params));
    }
    case "sessions.tree.navigate": {
      const session = await resolveSession(params);
      if (session.isStreaming || session.isCompacting) throw new Error("Wait for the current response to finish before navigating the tree");
      if (typeof session.navigateTree !== "function") throw new Error("Tree navigation is not available");
      const targetId = String(params.targetId || "").trim();
      if (!targetId) throw new Error("targetId is required");
      const result = await session.navigateTree(targetId, {
        summarize: Boolean(params.summarize),
        customInstructions: typeof params.customInstructions === "string" && params.customInstructions.trim() ? params.customInstructions.trim() : undefined,
        replaceInstructions: Boolean(params.replaceInstructions),
        label: typeof params.label === "string" && params.label.trim() ? params.label.trim() : undefined,
      });
      return { ok: true, ...result, leafId: session.sessionManager?.getLeafId?.() || null, state: sessionState(session) };
    }
    case "sessions.tree.abortSummary": {
      const session = await resolveSession(params);
      session.abortBranchSummary?.();
      return { ok: true, sessionId: String(params.sessionId || session.sessionId) };
    }
    case "models.list": {
      const session = await resolveSession(params);
      return modelState(session);
    }
    case "models.set": {
      const session = await resolveSession(params);
      const provider = String(params.provider || "").trim();
      const id = String(params.id || "").trim();
      if (!provider || !id) throw new Error("provider and id are required");
      const model = session.modelRegistry?.find?.(provider, id);
      if (!model) throw new Error("Model not found");
      const ok = await session.setModel?.(model);
      if (ok === false) throw new Error("No API key is available for this model");
      if (typeof params.thinkingLevel === "string") session.setThinkingLevel?.(params.thinkingLevel);
      return { ...sessionState(session), models: modelState(session) };
    }
    case "sessions.release": {
      const sessionId = String(params.sessionId || "");
      if (sessionId) releaseRunnerSession(sessionId);
      return { ok: true, sessionId };
    }
    case "sessions.delete": {
      const sessionId = String(params.sessionId || "");
      const live = sessionId ? liveSessions.get(sessionId) : undefined;
      const sessionFile = String(live?.sessionFile || params.sessionFile || "");
      if (sessionId) releaseRunnerSession(sessionId);
      if (sessionFile) {
        await unlink(sessionFile).catch((error: any) => {
          if (error?.code !== "ENOENT") throw error;
        });
      }
      return { ok: true, sessionId, deleted: Boolean(sessionFile) };
    }
    case "fs.list":
      return listDirectories(params.path, rootCwd);
    case "fs.mkdir": {
      const parent = asPath(params.parent);
      const name = String(params.name || "").trim();
      if (!name || name.includes("/") || name.includes("..")) throw new Error("Invalid directory name");
      const path = join(parent, name);
      await mkdir(path, { recursive: false });
      return listDirectories(parent, rootCwd);
    }
    case "git.status":
      return gitStatus(asPath(params.cwd || rootCwd), Boolean(params.fetchRemote));
    case "git.diff": {
      return gitDiff({ cwd: asPath(params.cwd || rootCwd), path: String(params.path || ""), staged: Boolean(params.staged) });
    }
    case "artifacts.write": {
      const cwd = asPath(params.cwd || rootCwd);
      const name = safeArtifactName(params.name);
      if (!name) throw new Error("Artifact name is required");
      const text = typeof params.text === "string" ? params.text : "";
      const artifactDir = artifactDirForCwd(cwd);
      await mkdir(artifactDir, { recursive: true });
      await writeFile(join(artifactDir, name), text, "utf-8");
      return { ok: true, name };
    }
    case "artifacts.read": {
      const cwd = asPath(params.cwd || rootCwd);
      const name = safeArtifactName(params.name);
      if (!name) throw new Error("Artifact name is required");
      return { ok: true, name, text: await readFile(artifactFileForCwd(cwd, name), "utf-8") };
    }
    case "artifacts.readBase64": {
      const cwd = asPath(params.cwd || rootCwd);
      const name = safeArtifactName(params.name);
      if (!name) throw new Error("Artifact name is required");
      return readArtifactBase64(cwd, name, maxArtifactBytes);
    }
    default:
      throw new Error(`Unknown runtime method: ${request.method}`);
  }
}

const rl = createInterface({ input: process.stdin });
setTimeout(() => send({ event: "ready", data: { cwd: rootCwd, pid: process.pid } }), 0);
rl.on("line", async (line) => {
  let request: RuntimeRequest | undefined;
  try {
    request = parseRuntimeLine(line) as RuntimeRequest | undefined;
    if (!request?.id || !request.method) throw new Error("Invalid request");
    const result = await handle(request);
    send({ id: request.id, ok: true, result });
  } catch (error) {
    send({ id: request?.id || "unknown", ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
