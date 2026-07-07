import { readdir, stat, mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AuthStorage, createAgentSession, DefaultResourceLoader, getAgentDir, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";
import { encodeRuntimeMessage, parseRuntimeLine, type DirectoryListing, type RuntimeRequest, type RuntimeResponse } from "./runtime/protocol.js";

const execFileAsync = promisify(execFile);
const rootCwd = resolve(process.env.PI_RUNNER_CWD || process.cwd());
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const liveSessions = new Map<string, any>();

async function loadSessionFromFile(sessionFile: string, fallbackCwd = rootCwd) {
  for (const session of liveSessions.values()) {
    if (session.sessionFile === sessionFile) return session;
  }
  const sessionManager = SessionManager.open(sessionFile, undefined, fallbackCwd);
  const cwd = fallbackCwd;
  const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
  await loader.reload();
  const result = await createAgentSession({ cwd, sessionManager, authStorage, modelRegistry, resourceLoader: loader });
  liveSessions.set(result.session.sessionId, result.session);
  return result.session;
}

async function resolveSession(params: Record<string, unknown>) {
  const sessionId = String(params.sessionId || "");
  const existing = liveSessions.get(sessionId);
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

async function listDirectories(pathValue: unknown): Promise<DirectoryListing> {
  const path = asPath(pathValue);
  const entries = await readdir(path, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({ name: entry.name, path: join(path, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { path, parent: dirname(path), dirs };
}

async function gitStatus(cwdValue: unknown) {
  const cwd = asPath(cwdValue);
  try {
    await stat(cwd);
    const branch = (await execFileAsync("git", ["branch", "--show-current"], { cwd, timeout: 10_000 }).catch(() => ({ stdout: "" }))).stdout.trim();
    const porcelain = (await execFileAsync("git", ["status", "--porcelain=v1"], { cwd, timeout: 10_000 })).stdout;
    return { ok: true, cwd, isRepo: true, branch, porcelain };
  } catch {
    return { ok: true, cwd, isRepo: false, branch: "", porcelain: "" };
  }
}

function safeArtifactName(name: unknown): string {
  return String(name || "").replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 160);
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
    model: session.model ? { provider: session.model.provider, id: session.model.id, name: session.model.name } : null,
    messages: Array.isArray(session.messages) ? session.messages.length : 0,
  };
}

async function createRunnerSession(cwdValue: unknown) {
  const cwd = asPath(cwdValue || rootCwd);
  const sessionManager = SessionManager.create(cwd);
  const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
  await loader.reload();
  const result = await createAgentSession({ cwd, sessionManager, authStorage, modelRegistry, resourceLoader: loader });
  liveSessions.set(result.session.sessionId, result.session);
  send({ event: "session.created", data: sessionState(result.session) });
  return sessionState(result.session);
}

async function handle(request: RuntimeRequest): Promise<unknown> {
  const params = (request.params || {}) as Record<string, unknown>;
  switch (request.method) {
    case "health":
      return { ok: true, cwd: rootCwd, pid: process.pid, protocol: "pi-runner-v1" };
    case "sessions.create":
      return createRunnerSession(params.cwd);
    case "sessions.state": {
      const session = await resolveSession(params);
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
      const message = String(params.message || "").trim();
      if (!message) throw new Error("message is required");
      send({ event: "session.prompt.start", data: { ...sessionState(session), isStreaming: true } });
      void session.prompt(message).then(() => {
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
    case "fs.list":
      return listDirectories(params.path);
    case "fs.mkdir": {
      const parent = asPath(params.parent);
      const name = String(params.name || "").trim();
      if (!name || name.includes("/") || name.includes("..")) throw new Error("Invalid directory name");
      const path = join(parent, name);
      await mkdir(path, { recursive: false });
      return listDirectories(parent);
    }
    case "git.status":
      return gitStatus(params.cwd || rootCwd);
    case "git.diff": {
      const cwd = asPath(params.cwd || rootCwd);
      const filePath = String(params.path || "");
      const staged = Boolean(params.staged);
      const args = staged ? ["diff", "--cached", "--", filePath] : ["diff", "--", filePath];
      const result = await execFileAsync("git", args, { cwd, timeout: 15_000 }).catch((error: any) => ({ stdout: error?.stdout || "", stderr: error?.stderr || "" }));
      return { ok: true, path: filePath, staged, diff: result.stdout || "" };
    }
    case "artifacts.write": {
      const cwd = asPath(params.cwd || rootCwd);
      const name = safeArtifactName(params.name);
      if (!name) throw new Error("Artifact name is required");
      const text = typeof params.text === "string" ? params.text : "";
      const artifactDir = join(cwd, ".pi", "web", "artifacts");
      await mkdir(artifactDir, { recursive: true });
      await writeFile(join(artifactDir, name), text, "utf-8");
      return { ok: true, name };
    }
    case "artifacts.read": {
      const cwd = asPath(params.cwd || rootCwd);
      const name = safeArtifactName(params.name);
      if (!name) throw new Error("Artifact name is required");
      return { ok: true, name, text: await readFile(join(cwd, ".pi", "web", "artifacts", name), "utf-8") };
    }
    case "artifacts.readBase64": {
      const cwd = asPath(params.cwd || rootCwd);
      const name = safeArtifactName(params.name);
      if (!name) throw new Error("Artifact name is required");
      const bytes = await readFile(join(cwd, ".pi", "web", "artifacts", name));
      return { ok: true, name, base64: bytes.toString("base64") };
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
