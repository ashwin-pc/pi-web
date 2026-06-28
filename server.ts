import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
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
  type ExtensionUIDialogOptions,
  type ExtensionUIContext,
  type SessionStartEvent,
  type SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import { createMockHarness } from "./server/mock.js";
import { resolveBundledExtensionPaths, resolvePiWebExtensionPaths } from "./server/extensions.js";
import { createSessionUiStateStore, defaultSessionUiState } from "./server/sessionUiState.js";
import { createSettingsStore } from "./server/settings.js";
import type { PiWebFooter, PiWebHeaderAction, PiWebUi } from "./src/extensions.js";
import type { PiWebSession } from "./server/types.js";

const appDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const distDir = join(appDir, "dist");
const staticDir = distDir;

const isDev = process.env.PI_WEB_DEV === "1" || process.env.NODE_ENV === "development";
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8787);
const token = process.env.PI_WEB_TOKEN || "";
let piCwd = resolve(process.env.PI_WEB_CWD || process.cwd());
let artifactDir = join(piCwd, ".pi", "web", "artifacts");
let legacyArtifactDir = join(piCwd, ".pi-web-uploads", "artifacts");
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

function safeArtifactName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 160);
}

function serveArtifact(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const rawName = decodeURIComponent(url.pathname.slice("/api/artifacts/".length));
  const name = safeArtifactName(rawName);
  if (!name || rawName.includes("..") || rawName.includes("/") || name !== rawName) return sendJson(res, 400, { ok: false, error: "Invalid artifact name" });

  let resolvedFile = "";
  const artifactRoots = Array.from(new Set([piCwd, ...knownCwds]));
  for (const cwd of artifactRoots) {
    const currentArtifactDir = join(cwd, ".pi", "web", "artifacts");
    const currentLegacyArtifactDir = join(cwd, ".pi-web-uploads", "artifacts");
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

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const p = part as Record<string, unknown>;
    if (p.type === "text" && typeof p.text === "string") return p.text;
    if (p.type === "image") return "[image]";
    // toolCall parts are rendered as tool cards in the UI — omit from text
    return "";
  }).filter(Boolean).join("\n");
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

async function git(args: string[], timeout = 15_000, cwd = piCwd) {
  return execFileAsync("git", args, { cwd, timeout, maxBuffer: 10 * 1024 * 1024 });
}

async function gitBuffer(args: string[], timeout = 15_000, cwd = piCwd) {
  return new Promise<Buffer>((resolvePromise, reject) => {
    execFile("git", args, { cwd, timeout, maxBuffer: 50 * 1024 * 1024, encoding: "buffer" }, (error, stdout) => {
      if (error) {
        (error as any).stdout = stdout;
        reject(error);
        return;
      }
      resolvePromise(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
    });
  });
}

async function isGitRepo(cwd = piCwd) {
  try { await git(["rev-parse", "--is-inside-work-tree"], 15_000, cwd); return true; } catch { return false; }
}

async function assertDirectory(path: string) {
  const resolved = resolve(path || piCwd);
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new Error("Path is not a directory");
  return resolved;
}

async function listDirectories(path: string) {
  const resolved = await assertDirectory(path);
  const entries = await readdir(resolved, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: join(resolved, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, path: resolved, parent: resolve(resolved, ".."), dirs };
}

async function createDirectory(parent: string, name: string) {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error("Folder name is required");
  if (isAbsolute(trimmedName) || trimmedName === "." || trimmedName === ".." || trimmedName.includes("/") || trimmedName.includes("\\")) {
    throw new Error("Folder name must be a single directory name");
  }
  const parentDir = await assertDirectory(parent);
  const target = resolve(parentDir, trimmedName);
  const rel = relative(parentDir, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Folder name must stay inside the selected directory");
  await mkdir(target);
  return listDirectories(target);
}

function hasUserMessages(value: PiWebSession) {
  return value.messages.some((message: any) => message?.role === "user");
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
  artifactDir = join(piCwd, ".pi", "web", "artifacts");
  legacyArtifactDir = join(piCwd, ".pi-web-uploads", "artifacts");
  await ensurePiWebStorage(piCwd);
}

function gitLabel(indexStatus: string, worktreeStatus: string) {
  if (indexStatus === "?" && worktreeStatus === "?") return "untracked";
  if (indexStatus === "U" || worktreeStatus === "U" || indexStatus === "A" && worktreeStatus === "A" || indexStatus === "D" && worktreeStatus === "D") return "conflicted";
  if (indexStatus === "R" || worktreeStatus === "R") return "renamed";
  if (indexStatus === "A" || worktreeStatus === "A") return "added";
  if (indexStatus === "D" || worktreeStatus === "D") return "deleted";
  if (indexStatus !== " " && indexStatus !== "?") return "staged";
  return "modified";
}

function parseStatusLine(line: string) {
  const indexStatus = line[0] || " ";
  const worktreeStatus = line[1] || " ";
  const rawPath = line.slice(3);
  const renamed = rawPath.includes(" -> ");
  const [oldPath, path] = renamed ? rawPath.split(" -> ") : [undefined, rawPath];
  return { path: path || rawPath, oldPath, indexStatus, worktreeStatus, label: gitLabel(indexStatus, worktreeStatus), staged: indexStatus !== " " && indexStatus !== "?" };
}

async function gitStatus(cwd = piCwd, fetchRemote = false) {
  if (!await isGitRepo(cwd)) return { ok: true, isRepo: false, ahead: 0, behind: 0, files: [] };
  if (fetchRemote) await git(["fetch", "--prune"], 60_000, cwd).catch(() => undefined);
  const [{ stdout: root }, { stdout: branchOut }, { stdout: porcelain }, upstreamResult, defaultResult] = await Promise.all([
    git(["rev-parse", "--show-toplevel"], 15_000, cwd),
    git(["branch", "--show-current"], 15_000, cwd).catch(() => ({ stdout: "" })),
    git(["status", "--porcelain=v1", "-b"], 15_000, cwd),
    git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], 15_000, cwd).catch(() => ({ stdout: "" })),
    git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], 15_000, cwd).catch(() => ({ stdout: "" })),
  ]);
  const lines = porcelain.trimEnd().split("\n").filter(Boolean);
  const header = lines[0] || "";
  const ahead = Number(header.match(/ahead (\d+)/)?.[1] || 0);
  const behind = Number(header.match(/behind (\d+)/)?.[1] || 0);
  const trackedFiles = lines.slice(1).map(parseStatusLine).filter((file) => file.label !== "untracked");
  const { stdout: untrackedOut } = await git(["ls-files", "--others", "--exclude-standard"], 15_000, cwd).catch(() => ({ stdout: "" }));
  const untrackedFiles = untrackedOut.split("\n").map((path) => path.trim()).filter(Boolean).map((path) => ({
    path,
    indexStatus: "?",
    worktreeStatus: "?",
    label: "untracked",
    staged: false,
  }));
  return {
    ok: true,
    isRepo: true,
    root: root.trim(),
    branch: branchOut.trim(),
    upstream: upstreamResult.stdout.trim(),
    defaultRemoteBranch: defaultResult.stdout.trim(),
    ahead,
    behind,
    files: [...trackedFiles, ...untrackedFiles],
  };
}

function safeGitPath(path: string) {
  if (!path || path.startsWith("/") || path.includes("..") || path.includes("\0")) throw new Error("Invalid path");
  return path;
}

function isImageGitPath(path: string) {
  return [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(extname(path).toLowerCase());
}

async function sendGitImage(res: ServerResponse, options: { cwd: string; path: string; oldPath?: string; version: string; staged: boolean }) {
  const filePath = safeGitPath(options.path);
  const oldPath = options.oldPath ? safeGitPath(options.oldPath) : undefined;
  const displayPath = options.version === "before" ? oldPath || filePath : filePath;
  if (!isImageGitPath(displayPath)) return sendJson(res, 415, { ok: false, error: "Not an image file" });

  const contentType = contentTypes[extname(displayPath).toLowerCase()] || "application/octet-stream";
  if (options.version === "before") {
    const data = await gitBuffer(["show", `HEAD:${oldPath || filePath}`], 15_000, options.cwd);
    res.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
    res.end(data);
    return;
  }

  if (options.version !== "after") throw new Error("Invalid image version");
  if (options.staged) {
    const data = await gitBuffer(["show", `:${filePath}`], 15_000, options.cwd);
    res.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
    res.end(data);
    return;
  }

  const resolved = resolve(options.cwd, filePath);
  const rel = relative(options.cwd, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Image path is outside the repository");
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error("Image not found");
  res.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
  pipeReadStream(res, resolved);
}

async function gitCwdFromRepoParam(repo: string | null, baseCwd = piCwd) {
  if (!repo || repo === ".") return baseCwd;
  if (repo.includes("\0") || isAbsolute(repo)) throw new Error("Invalid repository path");
  const resolved = resolve(baseCwd, repo);
  const rel = relative(baseCwd, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Repository path is outside the workspace");
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new Error("Repository path is not a directory");
  return resolved;
}

const ignoredGitRepoDirs = new Set([".git", ".pi", ".pi-web-uploads", "node_modules", "dist", "build", ".cache", ".next", "target", "vendor"]);

async function gitRepoSummary(path: string, cwd: string) {
  const status = await gitStatus(cwd) as any;
  return {
    path,
    root: status.root || cwd,
    branch: status.branch || "",
    upstream: status.upstream || "",
    ahead: status.ahead || 0,
    behind: status.behind || 0,
    dirtyCount: status.files?.length || 0,
    isCurrent: path === ".",
  };
}

async function listGitRepos(cwd = piCwd) {
  const repos: Array<Awaited<ReturnType<typeof gitRepoSummary>>> = [];
  const seenRoots = new Set<string>();
  async function addRepo(path: string, cwd: string) {
    if (!await isGitRepo(cwd)) return;
    const { stdout } = await git(["rev-parse", "--show-toplevel"], 15_000, cwd);
    const root = resolve(stdout.trim());
    if (seenRoots.has(root)) return;
    seenRoots.add(root);
    repos.push(await gitRepoSummary(path, cwd));
  }

  await addRepo(".", cwd);
  const entries = await readdir(cwd, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || ignoredGitRepoDirs.has(entry.name)) continue;
    const repoCwd = join(cwd, entry.name);
    if (!existsSync(join(repoCwd, ".git"))) continue;
    await addRepo(entry.name, repoCwd);
  }
  return { ok: true, cwd, depth: 1, repos };
}

function parseCommit(entry: string) {
  const [hash = "", shortHash = "", parents = "", author = "", date = "", refs = "", subject = ""] = entry.split("\x1f");
  return { hash, shortHash, parents: parents ? parents.split(" ").filter(Boolean) : [], author, date, refs: refs ? refs.split(", ").filter(Boolean) : [], subject };
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

async function gitLog(cwd = piCwd) {
  if (!await isGitRepo(cwd)) return { ok: true, isRepo: false, commits: [] };
  const { stdout } = await git(["log", "--all", "-n", "200", "--date=iso-strict", "--pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%ad%x1f%D%x1f%s%x1e"], 15_000, cwd);
  const commits = stdout.split("\x1e").map((entry) => entry.trim()).filter(Boolean).map(parseCommit);
  return { ok: true, isRepo: true, commits };
}

async function gitCommitDetails(hash: string, cwd = piCwd) {
  if (!await isGitRepo(cwd)) throw new Error("Not a Git repository");
  if (!/^[a-f0-9]{7,40}$/i.test(hash)) throw new Error("Invalid commit hash");
  const [{ stdout: commitOut }, { stdout: nameOut }, { stdout: numstatOut }, { stdout: diff }] = await Promise.all([
    git(["show", "-s", "--date=iso-strict", "--pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%ad%x1f%D%x1f%s", hash], 15_000, cwd),
    git(["show", "--name-status", "--format=", hash], 15_000, cwd),
    git(["show", "--numstat", "--format=", hash], 15_000, cwd),
    git(["show", "--format=", "--patch", "--find-renames", hash], 15_000, cwd),
  ]);
  const stats = new Map<string, { additions?: number; deletions?: number }>();
  for (const line of numstatOut.split("\n").filter(Boolean)) {
    const [add, del, ...pathParts] = line.split("\t");
    const path = pathParts.join("\t");
    stats.set(path, { additions: Number(add) || 0, deletions: Number(del) || 0 });
  }
  const files = nameOut.split("\n").filter(Boolean).map((line) => {
    const [status, ...parts] = line.split("\t");
    const path = parts.at(-1) || "";
    return { path, status, ...(stats.get(path) || {}) };
  });
  return { ok: true, commit: parseCommit(commitOut.trim()), files, diff };
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

function toolRuntimeKey(toolCallId: unknown, toolName: unknown) {
  const id = typeof toolCallId === "string" ? toolCallId.trim() : "";
  if (id) return id;
  return typeof toolName === "string" && toolName.trim() ? toolName.trim() : "";
}

function toolStartedAtFor(sessionFile: string | undefined, toolCallId: unknown, toolName: unknown) {
  const key = toolRuntimeKey(toolCallId, toolName);
  return sessionFile && key ? toolStartedAts.get(sessionFile)?.get(key) : undefined;
}

function contentWithToolStartedAts(content: unknown, sessionFile?: string) {
  if (!sessionFile || !Array.isArray(content)) return content;
  return content.map((part) => {
    if (!part || typeof part !== "object") return part;
    const value = part as Record<string, unknown>;
    if (value.type !== "toolCall") return part;
    const toolName = value.toolName || value.name;
    const startedAt = toolStartedAtFor(sessionFile, value.id, toolName);
    return startedAt && !value.startedAt ? { ...value, startedAt } : part;
  });
}

function appendMessageEntryRef(refs: Array<{ entryId?: string }>, entry: any) {
  if (!entry || typeof entry !== "object") return;
  if (entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary" && entry.summary) {
    const entryId = typeof entry.id === "string" && entry.id.trim() ? entry.id : undefined;
    refs.push({ entryId });
  }
}

function messageEntryRefs(targetSession: PiWebSession): Array<{ entryId?: string }> {
  const getBranch = targetSession.sessionManager?.getBranch;
  if (typeof getBranch !== "function") return [];

  let branch: any[];
  try {
    branch = getBranch.call(targetSession.sessionManager);
  } catch {
    return [];
  }
  if (!Array.isArray(branch)) return [];

  const refs: Array<{ entryId?: string }> = [];
  let compaction: any | undefined;
  for (const entry of branch) {
    if (entry?.type === "compaction") compaction = entry;
  }

  if (!compaction) {
    for (const entry of branch) appendMessageEntryRef(refs, entry);
    return refs;
  }

  const compactionId = typeof compaction.id === "string" && compaction.id.trim() ? compaction.id : undefined;
  refs.push({ entryId: compactionId });
  const compactionIndex = branch.findIndex((entry) => entry?.type === "compaction" && entry?.id === compaction.id);
  let foundFirstKept = false;
  for (let index = 0; index < compactionIndex; index += 1) {
    const entry = branch[index];
    if (entry?.id === compaction.firstKeptEntryId) foundFirstKept = true;
    if (foundFirstKept) appendMessageEntryRef(refs, entry);
  }
  for (let index = compactionIndex + 1; index < branch.length; index += 1) appendMessageEntryRef(refs, branch[index]);
  return refs;
}

function simplifyMessage(message: unknown, toolCallArgs?: Map<string, Record<string, unknown>>, sessionFile?: string, entryId?: string) {
  if (!message || typeof message !== "object") return message;
  const m = message as Record<string, unknown>;
  const content = contentWithToolStartedAts(m.content, sessionFile);
  const entry = entryId ? { entryId } : {};
  if (m.role === "bashExecution") {
    return {
      ...entry,
      role: "bashExecution",
      command: m.command,
      output: m.output,
      exitCode: m.exitCode,
      cancelled: Boolean(m.cancelled),
      truncated: Boolean(m.truncated),
      fullOutputPath: m.fullOutputPath,
      excludeFromContext: Boolean(m.excludeFromContext),
      timestamp: m.timestamp,
      raw: m,
    };
  }
  if (m.role === "toolResult") {
    const args = toolCallArgs?.get(m.toolCallId as string);
    return {
      ...entry,
      role: "toolResult",
      toolCallId: m.toolCallId,
      toolName: m.toolName,
      toolArgs: args,
      isError: Boolean(m.isError),
      text: textFromContent(m.content),
      timestamp: m.timestamp,
      raw: m,
    };
  }
  const text = textFromContent(content);
  const errorText = m.role === "assistant" && m.errorMessage ? assistantErrorPreview(m) : "";
  const stopReasonText = m.role === "assistant" && !errorText ? assistantStopReasonPreview(m) : "";
  const displayText = errorText || (text && stopReasonText ? `${text}\n\n${stopReasonText}` : stopReasonText || text);
  const toolCalls = m.role === "assistant" && Array.isArray(content)
    ? content.filter((part: any) => part?.type === "toolCall").map((part: any) => ({
      id: part.id,
      toolName: part.toolName || part.name || "tool",
      args: part.arguments || part.args || {},
      startedAt: part.startedAt,
    }))
    : undefined;
  return {
    ...entry,
    role: m.role,
    text: displayText,
    toolCalls,
    isError: Boolean(m.errorMessage || m.stopReason === "error" || stopReasonText),
    timestamp: m.timestamp,
    raw: content === m.content ? m : { ...m, content },
  };
}

function truncatePreview(value: string, max = 220) {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function entryMessage(entry: any) {
  if (entry?.type === "message") return entry.message;
  if (entry?.type === "custom_message") return { role: "custom", content: entry.content, timestamp: entry.timestamp };
  return undefined;
}

function messageToolCalls(message: any) {
  return Array.isArray(message?.content)
    ? message.content.filter((part: any) => part?.type === "toolCall")
    : [];
}

function toolCallName(part: any) {
  return String(part?.toolName || part?.name || "tool");
}

function toolCallArgs(part: any) {
  const args = part?.arguments || part?.args;
  return args && typeof args === "object" ? args as Record<string, unknown> : {};
}

function shortArg(value: unknown, max = 90) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function toolCallPreview(part: any) {
  const name = toolCallName(part);
  const args = toolCallArgs(part);
  if (name === "bash" && typeof args.command === "string") return `Tool call: bash ${shortArg(args.command, 120)}`;
  if (typeof args.path === "string") return `Tool call: ${name} ${shortArg(args.path, 120)}`;
  if (typeof args.query === "string") return `Tool call: ${name} ${shortArg(args.query, 120)}`;
  if (typeof args.pattern === "string") return `Tool call: ${name} ${shortArg(args.pattern, 120)}`;
  const first = Object.entries(args).find(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean");
  return first ? `Tool call: ${name} ${first[0]}=${shortArg(first[1], 90)}` : `Tool call: ${name}`;
}

function toolCallsPreview(message: any) {
  const calls = messageToolCalls(message);
  if (calls.length === 0) return "";
  const [first] = calls;
  const suffix = calls.length > 1 ? ` + ${calls.length - 1} more` : "";
  return `${toolCallPreview(first)}${suffix}`;
}

function messageTextPreview(message: any) {
  return textFromContent(message?.content || "");
}

function assistantErrorPreview(message: any) {
  const raw = String(message?.errorMessage || "").trim();
  if (!raw) return "";
  const jsonText = raw.replace(/^Codex error:\s*/, "");
  try {
    const parsed = JSON.parse(jsonText);
    const detail = parsed?.error?.message || parsed?.message || raw;
    return `Error: ${detail}`;
  } catch {
    return raw.length > 180 ? `${raw.slice(0, 179)}…` : raw;
  }
}

function assistantStopReasonPreview(message: any) {
  const reason = String(message?.stopReason || "").trim();
  if (!reason || reason === "stop" || reason === "toolUse") return "";
  if (reason === "length") return "Response stopped because the model hit its output length limit.";
  if (reason === "aborted") return "Response was aborted.";
  return `Response stopped unexpectedly: ${reason}`;
}

function entryRole(entry: any) {
  const message = entryMessage(entry);
  if (message?.role === "assistant" && !messageTextPreview(message).trim()) {
    if (messageToolCalls(message).length > 0) return "toolCall";
    if (message.errorMessage || assistantStopReasonPreview(message)) return "error";
  }
  if (message?.role) return String(message.role);
  switch (entry?.type) {
    case "branch_summary": return "branchSummary";
    case "compaction": return "compaction";
    case "model_change": return "model";
    case "thinking_level_change": return "thinking";
    case "session_info": return "session";
    case "label": return "label";
    case "custom": return "custom";
    default: return String(entry?.type || "entry");
  }
}

function entryPreview(entry: any) {
  const message = entryMessage(entry);
  if (message) {
    if (message.role === "toolResult") {
      const text = textFromContent(message.content);
      return `Tool result: ${message.toolName || "tool"}${text ? ` — ${text}` : ""}`;
    }
    const text = messageTextPreview(message);
    if (text.trim()) return text;
    const calls = toolCallsPreview(message);
    if (calls) return calls;
    const error = assistantErrorPreview(message);
    if (error) return error;
    const stopReason = assistantStopReasonPreview(message);
    if (stopReason) return stopReason;
    return message.role === "assistant" ? "Empty assistant message" : `${message.role || "Message"} message`;
  }
  switch (entry?.type) {
    case "branch_summary": return entry.summary || "Branch summary";
    case "compaction": return entry.summary || "Compaction summary";
    case "model_change": return `Model changed to ${entry.provider || "provider"}/${entry.modelId || "model"}`;
    case "thinking_level_change": return `Thinking level changed to ${entry.thinkingLevel || "unknown"}`;
    case "session_info": return entry.name ? `Session named ${entry.name}` : "Session name cleared";
    case "label": return entry.label ? `Label ${entry.targetId || "entry"} as ${entry.label}` : `Clear label on ${entry.targetId || "entry"}`;
    case "custom": return `Custom entry${entry.customType ? `: ${entry.customType}` : ""}`;
    default: return String(entry?.type || "Entry");
  }
}

function countTreeNodes(nodes: any[]): number {
  let count = 0;
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop();
    count += 1;
    const children = Array.isArray(node?.children) ? node.children : [];
    for (const child of children) stack.push(child);
  }
  return count;
}

function countBranchPoints(nodes: any[]): number {
  let count = 0;
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop();
    const children = Array.isArray(node?.children) ? node.children : [];
    if (children.length > 1) count += 1;
    for (const child of children) stack.push(child);
  }
  return count;
}

function simpleTreeNode(node: any, activePathIds: Set<string>, leafId: string | null, childCount: number): any {
  const entry = node?.entry || node;
  const id = String(entry?.id || "");
  return {
    id,
    parentId: typeof entry?.parentId === "string" ? entry.parentId : null,
    type: String(entry?.type || "entry"),
    role: entryRole(entry),
    preview: truncatePreview(entryPreview(entry)),
    timestamp: String(entry?.timestamp || ""),
    label: typeof node?.label === "string" ? node.label : undefined,
    labelTimestamp: typeof node?.labelTimestamp === "string" ? node.labelTimestamp : undefined,
    childCount,
    isOnActivePath: activePathIds.has(id),
    isCurrentLeaf: Boolean(leafId && id === leafId),
    children: [],
  };
}

function simplifyTreeNodesFlat(roots: any[], activePathIds: Set<string>, leafId: string | null): any[] {
  const nodes: any[] = [];
  const stack = [...roots].reverse();
  while (stack.length > 0) {
    const node = stack.pop();
    const children = Array.isArray(node?.children) ? node.children : [];
    nodes.push(simpleTreeNode(node, activePathIds, leafId, children.length));
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
  }
  return nodes;
}

function conversationTreeForSession(targetSession: PiWebSession) {
  const manager = targetSession.sessionManager;
  if (typeof manager.getTree !== "function") throw new Error("Session tree is not available");
  const leafId = typeof manager.getLeafId === "function" ? manager.getLeafId() : null;
  const activePath = typeof manager.getBranch === "function" ? manager.getBranch() : [];
  const activePathIds = new Set(activePath.map((entry: any) => String(entry?.id || "")).filter(Boolean));
  const roots = manager.getTree();
  const nodes = simplifyTreeNodesFlat(roots, activePathIds, leafId);
  return {
    ok: true,
    sessionId: targetSession.sessionId,
    leafId,
    activePathIds: Array.from(activePathIds),
    entryCount: nodes.length,
    branchPointCount: nodes.filter((node: any) => node.childCount > 1).length,
    nodes,
  };
}

function sessionCwd(targetSession: PiWebSession | any = session) {
  return String(targetSession?.sessionManager?.getCwd?.() || targetSession?.cwd || piCwd);
}

function runtimeStartedAtForPath(path: string, isRunning: boolean) {
  if (!isRunning) return undefined;
  const liveStartedAt = liveSessions.get(path)?.session?.runtimeStartedAt;
  return typeof liveStartedAt === "string" && liveStartedAt.trim() ? liveStartedAt : runtimeStartedAts.get(path);
}

function runtimeLastActivityAtForPath(path: string, isRunning: boolean) {
  if (!isRunning) return undefined;
  const liveLastActivityAt = liveSessions.get(path)?.session?.runtimeLastActivityAt;
  return typeof liveLastActivityAt === "string" && liveLastActivityAt.trim()
    ? liveLastActivityAt
    : runtimeLastActivityAts.get(path) || runtimeStartedAtForPath(path, isRunning);
}

function ensureRuntimeStartedAt(targetSession: any, startedAt = new Date().toISOString()) {
  const key = sessionPathKey(targetSession);
  const existing = key ? runtimeStartedAts.get(key) : undefined;
  const value = typeof targetSession?.runtimeStartedAt === "string" ? targetSession.runtimeStartedAt : existing || startedAt;
  if (key) {
    runtimeStartedAts.set(key, value);
    if (!runtimeLastActivityAts.has(key)) runtimeLastActivityAts.set(key, value);
  }
  if (targetSession && typeof targetSession === "object") {
    targetSession.runtimeStartedAt = value;
    if (typeof targetSession.runtimeLastActivityAt !== "string") targetSession.runtimeLastActivityAt = value;
  }
  return value;
}

function markRuntimeActivity(targetSession: any, activityAt = new Date().toISOString(), sessionFile = sessionPathKey(targetSession)) {
  if (sessionFile) runtimeLastActivityAts.set(sessionFile, activityAt);
  if (targetSession && typeof targetSession === "object") targetSession.runtimeLastActivityAt = activityAt;
  return activityAt;
}

function clearRuntimeStartedAt(targetSession: any, sessionFile = sessionPathKey(targetSession)) {
  if (sessionFile) {
    runtimeStartedAts.delete(sessionFile);
    runtimeLastActivityAts.delete(sessionFile);
  }
  if (targetSession && typeof targetSession === "object") {
    delete targetSession.runtimeStartedAt;
    delete targetSession.runtimeLastActivityAt;
  }
}

function runtimeForPath(path: string) {
  const live = liveSessions.get(path)?.session;
  const isStreaming = Boolean(live?.isStreaming);
  const isCompacting = Boolean(live?.isCompacting);
  const isRunning = isStreaming || isCompacting;
  const startedAt = runtimeStartedAtForPath(path, isRunning);
  const lastActivityAt = runtimeLastActivityAtForPath(path, isRunning);
  return {
    loaded: Boolean(live),
    isRunning,
    isStreaming,
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
    isCompacting: false,
    startedAt: undefined,
    lastActivityAt: undefined,
    pendingMessageCount: Number(live?.pendingMessageCount || 0),
    model: simplifyModel(live?.model),
  };
}

function runtimeForEvent(path: string, event: any) {
  return event?.type === "agent_end" || event?.type === "compaction_end"
    ? stoppedRuntimeForPath(path)
    : runtimeForPath(path);
}

function isRuntimeActivityEvent(event: any) {
  switch (event?.type) {
    case "agent_start":
    case "compaction_start":
    case "message_update":
    case "message_end":
    case "turn_end":
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
      return true;
    default:
      return false;
  }
}

function runtimeActivityTimestamp(event: any, fallback = new Date().toISOString()) {
  for (const value of [event?.lastActivityAt, event?.timestamp, event?.startedAt]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback;
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

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sessionDisplayName(targetSession: PiWebSession) {
  return targetSession.getSessionName?.()?.trim()
    || targetSession.sessionName?.trim()
    || targetSession.sessionManager.getSessionName?.()?.trim()
    || undefined;
}

function liveSessionTitle(targetSession: PiWebSession) {
  const name = sessionDisplayName(targetSession);
  if (name) return name;

  for (const message of targetSession.messages as any[]) {
    const text = textFromContent(message?.content).trim();
    if (message?.role === "user" && text) return truncatePreview(text, 80);
  }
  return "New session";
}

function sessionStats(targetSession: PiWebSession) {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let toolResults = 0;

  const branch = targetSession.sessionManager.getBranch?.();
  const entries = Array.isArray(branch) && branch.length > 0
    ? branch.map((entry: any) => entry?.message ?? entry)
    : targetSession.messages;

  for (const message of entries as any[]) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "user") userMessages++;
    if (message.role === "toolResult") toolResults++;
    if (message.role !== "assistant") continue;
    assistantMessages++;
    const usage = message.usage || {};
    input += finiteNumber(usage.input);
    output += finiteNumber(usage.output);
    cacheRead += finiteNumber(usage.cacheRead);
    cacheWrite += finiteNumber(usage.cacheWrite);
    const usageCost = usage.cost || {};
    const totalCost = finiteNumber(usageCost.total);
    cost += totalCost || finiteNumber(usageCost.input) + finiteNumber(usageCost.output) + finiteNumber(usageCost.cacheRead) + finiteNumber(usageCost.cacheWrite);
  }

  const contextUsage = targetSession.getContextUsage?.() || undefined;
  return {
    userMessages,
    assistantMessages,
    toolResults,
    totalMessages: entries.length,
    tokens: {
      input,
      output,
      cacheRead,
      cacheWrite,
      total: input + output + cacheRead + cacheWrite,
    },
    cost,
    contextUsage,
  };
}

function currentState(targetSession: PiWebSession = session) {
  const isRunning = Boolean(targetSession.isStreaming || targetSession.isCompacting);
  const runtime = runtimeForPath(targetSession.sessionFile);
  return {
    cwd: sessionCwd(targetSession),
    sessionFile: targetSession.sessionFile,
    sessionId: targetSession.sessionId,
    sessionName: sessionDisplayName(targetSession),
    sessionTitle: liveSessionTitle(targetSession),
    isStreaming: targetSession.isStreaming,
    isCompacting: Boolean(targetSession.isCompacting),
    runtimeStartedAt: typeof (targetSession as any).runtimeStartedAt === "string"
      ? (targetSession as any).runtimeStartedAt
      : runtimeStartedAtForPath(targetSession.sessionFile, isRunning),
    runtimeLastActivityAt: typeof (targetSession as any).runtimeLastActivityAt === "string"
      ? (targetSession as any).runtimeLastActivityAt
      : runtimeLastActivityAtForPath(targetSession.sessionFile, isRunning),
    runtime,
    model: simplifyModel(targetSession.model),
    thinkingLevel: targetSession.thinkingLevel,
    stats: sessionStats(targetSession),
    webFooters: webFooterEntries(targetSession),
    webHeaderActions: webHeaderActionEntries(targetSession),
  };
}

function currentStateWithThinkingLevels(targetSession: PiWebSession = session) {
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
  session: any;
  unsubscribe?: () => void;
  viewerClientIds: Set<string>;
  workLeases: number;
  disposeTimer?: ReturnType<typeof setTimeout>;
  disposing?: boolean;
};

type ViewerLease = {
  sessionKey: string;
  sockets: Set<WebSocket>;
  releaseTimer?: ReturnType<typeof setTimeout>;
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
const viewerLeases = new Map<string, ViewerLease>();
const runtimeStartedAts = new Map<string, string>();
const runtimeLastActivityAts = new Map<string, string>();
const toolStartedAts = new Map<string, Map<string, string>>();
let session: PiWebSession;
let modelFallbackMessage: string | undefined;

type RealtimeSocket = WebSocket & { missedPongs?: number };
const clients = new Set<RealtimeSocket>();
type RealtimeEnvelope = Record<string, unknown> & { seq: number };
const realtimeEventLog: RealtimeEnvelope[] = [];
const maxRealtimeEventLogSize = 1000;
let nextRealtimeSeq = 1;

function recordRealtimeMessage(value: unknown): RealtimeEnvelope {
  const envelope = { ...(typeof value === "object" && value !== null ? value as Record<string, unknown> : { value }), seq: nextRealtimeSeq++ };
  realtimeEventLog.push(envelope);
  if (realtimeEventLog.length > maxRealtimeEventLogSize) realtimeEventLog.splice(0, realtimeEventLog.length - maxRealtimeEventLogSize);
  return envelope;
}

function broadcast(value: unknown) {
  const envelope = recordRealtimeMessage(value);
  const data = JSON.stringify(envelope);
  for (const client of clients) {
    if (client.readyState === client.OPEN) client.send(data);
  }
  queueUnreadStateFromBroadcast(value);
}

function checkRealtimeHeartbeats() {
  for (const client of clients) {
    if (client.readyState === client.CLOSED || client.readyState === client.CLOSING) {
      clients.delete(client);
      continue;
    }
    if (client.readyState !== client.OPEN) continue;
    const missedPongs = client.missedPongs || 0;
    if (missedPongs >= websocketMaxMissedHeartbeats) {
      client.terminate();
      continue;
    }
    client.missedPongs = missedPongs + 1;
    try {
      client.ping();
    } catch {
      client.terminate();
    }
  }
}

if (websocketHeartbeatMs > 0) {
  const realtimeHeartbeat = setInterval(checkRealtimeHeartbeats, websocketHeartbeatMs);
  realtimeHeartbeat.unref?.();
}

function shouldClearSessionUnreadEvent(event: any) {
  switch (event?.type) {
    case "agent_start":
    case "compaction_start":
      return true;
    default:
      return false;
  }
}

function noteRuntimeEventForUnreadRecovery(data: Record<string, any>) {
  const sessionFile = typeof data.sessionFile === "string" ? data.sessionFile.trim() : "";
  if (!sessionFile) return;
  const event = data.event;
  switch (event?.type) {
    case "agent_start":
    case "compaction_start": {
      const startedAt = typeof event.startedAt === "string" && event.startedAt.trim() ? event.startedAt.trim() : new Date().toISOString();
      runtimeStartedAts.set(sessionFile, startedAt);
      runtimeLastActivityAts.set(sessionFile, runtimeActivityTimestamp(event, startedAt));
      return;
    }
    case "agent_end":
    case "compaction_end":
      runtimeStartedAts.delete(sessionFile);
      runtimeLastActivityAts.delete(sessionFile);
      return;
    default:
      if (isRuntimeActivityEvent(event)) runtimeLastActivityAts.set(sessionFile, runtimeActivityTimestamp(event));
      return;
  }
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

function shouldMarkSessionUnreadEvent(event: any) {
  // Unread means a background session completed and may need attention.
  // Do not mark on message_end: pi can emit it for the user's submitted
  // message before the assistant response has finished.
  if (!event || event.aborted) return false;
  switch (event.type) {
    case "agent_end":
    case "compaction_end":
      return true;
    default:
      return false;
  }
}

function unreadTimestampForEvent(event: any) {
  for (const value of [event?.timestamp, event?.endedAt, event?.startedAt]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return new Date().toISOString();
}

function queueUnreadStateFromBroadcast(value: unknown) {
  if (!value || typeof value !== "object") return;
  const data = value as Record<string, any>;
  if (data.type !== "pi_event") return;
  noteRuntimeEventForUnreadRecovery(data);
  const sessionId = typeof data.sessionId === "string" ? data.sessionId.trim() : "";
  if (!sessionId) return;
  if (shouldClearSessionUnreadEvent(data.event)) {
    clearSessionUnread(sessionId);
    return;
  }
  if (!shouldMarkSessionUnreadEvent(data.event)) return;
  markSessionUnreadCompleted(sessionId, unreadTimestampForEvent(data.event));
}

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

type WebFooterState = {
  footers: Map<string, PiWebFooter>;
};

type WebHeaderActionState = {
  actions: Map<string, PiWebHeaderAction>;
};

const webFooterStates = new WeakMap<object, WebFooterState>();
const webHeaderActionStates = new WeakMap<object, WebHeaderActionState>();

function getWebFooterState(value: any): WebFooterState {
  const key = value as object;
  let state = webFooterStates.get(key);
  if (!state) {
    state = { footers: new Map() };
    webFooterStates.set(key, state);
  }
  return state;
}

function cleanFooterKey(value: unknown) {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim().slice(0, 80).replace(/[^a-zA-Z0-9_.:-]/g, "-");
  return cleaned || undefined;
}

const cleanHeaderActionKey = cleanFooterKey;

function cleanHeaderActionText(value: unknown, maxLength = 200) {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001F\u007F]/g, "").trim();
  return cleaned ? cleaned.slice(0, maxLength) : undefined;
}

function getWebHeaderActionState(value: any): WebHeaderActionState {
  const key = value as object;
  let state = webHeaderActionStates.get(key);
  if (!state) {
    state = { actions: new Map() };
    webHeaderActionStates.set(key, state);
  }
  return state;
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
    const html = cleanFooterText(footer.html, 20_000);
    return html ? { kind: "html", html } : undefined;
  }
  return undefined;
}

function webFooterEntries(value: any) {
  return Array.from(getWebFooterState(value).footers.entries()).map(([key, footer]) => ({ key, footer }));
}

function broadcastWebFooters(value: any) {
  const webFooters = webFooterEntries(value);
  broadcast({
    type: "web_footer_changed",
    sessionId: value.sessionId,
    sessionFile: value.sessionFile,
    webFooters,
  });
  return webFooters;
}

function webHeaderActionEntries(value: any) {
  return Array.from(getWebHeaderActionState(value).actions.entries()).map(([key, action]) => ({
    key,
    icon: cleanHeaderActionText(action.icon, 80),
    title: cleanHeaderActionText(action.title) || key,
    label: cleanHeaderActionText(action.label),
  }));
}

function broadcastWebHeaderActions(value: any) {
  const webHeaderActions = webHeaderActionEntries(value);
  broadcast({
    type: "web_header_actions_changed",
    sessionId: value.sessionId,
    sessionFile: value.sessionFile,
    webHeaderActions,
  });
  return webHeaderActions;
}

function createPiWebUi(value: any): PiWebUi {
  return {
    setFooter(key, footer) {
      const footerKey = cleanFooterKey(key);
      if (!footerKey) return;
      const footerState = getWebFooterState(value);
      const normalized = normalizePiWebFooter(footer);
      if (normalized) footerState.footers.set(footerKey, normalized);
      else footerState.footers.delete(footerKey);
      broadcastWebFooters(value);
    },
    setHeaderAction(key, action) {
      const actionKey = cleanHeaderActionKey(key);
      if (!actionKey) return;
      const actionState = getWebHeaderActionState(value);
      if (action && typeof action === "object" && typeof action.invoke === "function") {
        actionState.actions.set(actionKey, action);
      } else {
        actionState.actions.delete(actionKey);
      }
      broadcastWebHeaderActions(value);
    },
  };
}

function broadcastExtensionUiRequest(value: any, method: string, payload: Record<string, unknown>) {
  const id = randomUUID();
  broadcast({
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
  if (opts?.signal?.aborted || clients.size === 0) return Promise.resolve(defaultValue);

  return new Promise<T>((resolvePromise) => {
    const id = randomUUID();
    const releaseWorkLease = acquireWorkLease(value);
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

    broadcast({
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
        const newSession = await createNewLiveSession(sessionCwd(value), value.sessionFile);
        const state = currentStateWithThinkingLevels(newSession);
        broadcast({ type: "state_changed", ...state });
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
      broadcast({ type: "server_error", sessionId: value.sessionId, sessionFile: value.sessionFile, error: "An extension requested shutdown; pi-web ignored the request." });
    },
    onError: (error: any) => {
      broadcast({ type: "server_error", sessionId: value.sessionId, sessionFile: value.sessionFile, error: `Extension error (${error.extensionPath}): ${error.error}` });
    },
  });
}

const mockHarness = createMockHarness({
  piCwd,
  broadcast,
  isCurrentSession: (value: PiWebSession) => value === session,
  currentState,
});
const { mockSessions, createMockSession, resetMockSessions, getMockLifecycle } = mockHarness;

function sessionPathKey(value: any) {
  return String(value.sessionFile || value.sessionId || "");
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

function clearSessionRuntimeMaps(key: string, value: any) {
  runtimeStartedAts.delete(key);
  runtimeLastActivityAts.delete(key);
  toolStartedAts.delete(key);
  const file = typeof value?.sessionFile === "string" ? value.sessionFile : "";
  if (file && file !== key) {
    runtimeStartedAts.delete(file);
    runtimeLastActivityAts.delete(file);
    toolStartedAts.delete(file);
  }
}

async function disposeLiveSession(key: string, reason: "idle" | "delete" | "reset" = "idle", force = false) {
  const entry = liveSessions.get(key);
  if (!entry || entry.disposing) return;
  if (!force && shouldKeepLiveSession(entry)) return;

  entry.disposing = true;
  cancelLiveSessionCleanup(entry);
  const value = entry.session;
  const sessionId = String(value?.sessionId || "");
  const sessionFile = String(value?.sessionFile || key || "");

  for (const [clientId, lease] of viewerLeases) {
    if (lease.sessionKey !== key) continue;
    clearTimer(lease.releaseTimer);
    viewerLeases.delete(clientId);
  }

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
    value?.dispose?.();
  } catch (error) {
    console.warn(`Could not dispose session after ${reason}:`, error);
  }

  liveSessions.delete(key);
  clearSessionRuntimeMaps(key, value);

  if (sessionId) {
    broadcast({ type: "session_runtime_changed", sessionId, sessionFile, runtime: runtimeForPath(sessionFile) });
  }
}

function scheduleViewerLeaseRelease(clientId: string) {
  const lease = viewerLeases.get(clientId);
  if (!lease || lease.sockets.size > 0) return;
  clearTimer(lease.releaseTimer);
  lease.releaseTimer = setTimeout(() => releaseViewerLease(clientId), viewerLeaseGraceMs);
}

function releaseViewerLease(clientId: string) {
  const lease = viewerLeases.get(clientId);
  if (!lease) return;
  clearTimer(lease.releaseTimer);
  viewerLeases.delete(clientId);
  const entry = liveSessions.get(lease.sessionKey);
  if (entry) {
    entry.viewerClientIds.delete(clientId);
    scheduleLiveSessionCleanup(lease.sessionKey);
  }
}

function acquireViewerLease(clientId: string, value: any) {
  if (!clientId || !value) return undefined;
  const key = sessionPathKey(value);
  const entry = liveSessions.get(key);
  if (!key || !entry) return undefined;

  let lease = viewerLeases.get(clientId);
  const sockets = lease?.sockets || new Set<WebSocket>();
  clearTimer(lease?.releaseTimer);
  if (lease && lease.sessionKey !== key) {
    const previous = liveSessions.get(lease.sessionKey);
    previous?.viewerClientIds.delete(clientId);
    scheduleLiveSessionCleanup(lease.sessionKey);
  }

  lease = { sessionKey: key, sockets };
  viewerLeases.set(clientId, lease);
  entry.viewerClientIds.add(clientId);
  cancelLiveSessionCleanup(entry);
  if (sockets.size === 0) scheduleViewerLeaseRelease(clientId);
  return lease;
}

function bindViewerSocket(clientId: string, ws: WebSocket) {
  const lease = viewerLeases.get(clientId);
  if (!lease) return;
  clearTimer(lease.releaseTimer);
  lease.releaseTimer = undefined;
  lease.sockets.add(ws);
  ws.on("close", () => {
    const current = viewerLeases.get(clientId);
    current?.sockets.delete(ws);
    if (!current || current.sockets.size > 0) return;
    releaseViewerLease(clientId);
  });
}

function noteViewerLeaseFromRequest(req: IncomingMessage, value: any, fallbackClientId?: unknown) {
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

function registerLiveSession(value: any) {
  const key = sessionPathKey(value);
  if (!key || liveSessions.get(key)?.session === value) return value;

  const unsubscribe = value.subscribe?.((event: unknown) => {
    const eventSessionFile = value.sessionFile;
    const eventSessionId = value.sessionId;

    // Track models that fail with model_not_supported and remove them from the list.
    const e = event as any;
    let eventForClient = e;
    if (e?.type === "agent_start" || e?.type === "compaction_start") {
      const startedAt = ensureRuntimeStartedAt(value, typeof e.startedAt === "string" ? e.startedAt : undefined);
      eventForClient = { ...e, startedAt };
    } else if (e?.type === "agent_end" || e?.type === "compaction_end") {
      clearRuntimeStartedAt(value, eventSessionFile);
    }

    if (e?.type === "tool_execution_start") {
      const toolKey = toolRuntimeKey(e.toolCallId, e.toolName);
      const startedAt = typeof e.startedAt === "string" ? e.startedAt : new Date().toISOString();
      if (toolKey) {
        let sessionToolStarts = toolStartedAts.get(eventSessionFile);
        if (!sessionToolStarts) {
          sessionToolStarts = new Map();
          toolStartedAts.set(eventSessionFile, sessionToolStarts);
        }
        sessionToolStarts.set(toolKey, startedAt);
      }
      eventForClient = { ...e, startedAt };
    } else if (e?.type === "tool_execution_update" || e?.type === "tool_execution_end") {
      const toolKey = toolRuntimeKey(e.toolCallId, e.toolName);
      const startedAt = toolKey ? toolStartedAts.get(eventSessionFile)?.get(toolKey) : undefined;
      if (startedAt) eventForClient = { ...e, startedAt };
      if (e?.type === "tool_execution_end" && toolKey) toolStartedAts.get(eventSessionFile)?.delete(toolKey);
    }

    if (isRuntimeActivityEvent(e)) {
      const lastActivityAt = markRuntimeActivity(value, runtimeActivityTimestamp(eventForClient), eventSessionFile);
      eventForClient = { ...eventForClient, lastActivityAt };
    }

    broadcast({ type: "pi_event", sessionId: eventSessionId, sessionFile: eventSessionFile, event: eventForClient });
    broadcast({
      type: "session_runtime_changed",
      sessionId: eventSessionId,
      sessionFile: eventSessionFile,
      runtime: runtimeForEvent(eventSessionFile, e),
    });

    // Broadcast state update when session name changes
    if (e?.type === "session_info_changed") {
      broadcast({ type: "state_changed", ...currentState(value) });
    }

    if (e?.type === "message_end" || e?.type === "agent_end" || e?.type === "compaction_end") {
      broadcast({ type: "session_stats_changed", sessionId: eventSessionId, sessionFile: eventSessionFile, stats: sessionStats(value) });
    }

    if (e?.type === "message_end" || e?.type === "turn_end") {
      const msg = e?.message ?? e?.toolResults?.[0];
      const err: string = msg?.errorMessage || msg?.message?.errorMessage || "";
      const modelId: string = msg?.model || msg?.message?.model || "";
      if (modelId && (err.includes("model_not_supported") || err.includes("model_not_available"))) {
        if (!blockedModelIds.has(modelId)) {
          blockedModelIds.add(modelId);
          broadcast({ type: "models_updated", sessionId: eventSessionId, models: getAvailableModels(value).map(simplifyModel) });
        }
      }
    }
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
  if (mockMode) return { session: createMockSession(path), modelFallbackMessage: undefined };

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
  await bindWebExtensions(result.session);
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
  return registerLiveSession(created.session);
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
  const liveSession = registerLiveSession(value);
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
  if (hasUserMessages(targetSession)) throw new Error("Working directory can only be changed before the first message.");
  const newSession = await createNewLiveSession(cwd, targetSession.sessionFile);
  return currentStateWithThinkingLevels(newSession);
}

await ensurePiWebStorage();

const createdSession = await makeAgentSession();
session = registerLiveSession(createdSession.session);
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
        session = registerLiveSession(createMockSession());
        broadcast({ type: "session_ui_state_changed", sessionUiState: defaultSessionUiState });
        broadcast({ type: "state_changed", ...currentState() });
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
          viewerLeases: Array.from(viewerLeases.entries()).map(([clientId, lease]) => ({
            clientId,
            sessionKey: lease.sessionKey,
            sockets: lease.sockets.size,
            hasReleaseTimer: Boolean(lease.releaseTimer),
          })),
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
          const filePath = safeGitPath(url.searchParams.get("path") || "");
          const staged = url.searchParams.get("staged") === "1";
          const args = staged ? ["diff", "--cached", "--", filePath] : ["diff", "--", filePath];
          let { stdout } = await git(args, 15_000, cwd);
          if (!stdout) {
            const status = await gitStatus(cwd) as any;
            const file = status.files?.find((f: any) => f.path === filePath);
            if (file?.label === "untracked") stdout = (await git(["diff", "--no-index", "--", "/dev/null", filePath], 15_000, cwd).catch((error: any) => ({ stdout: error.stdout || "" }))).stdout;
          }
          return sendJson(res, 200, { ok: true, path: filePath, staged, diff: stdout });
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
          if (!await isGitRepo(cwd)) return sendJson(res, 404, { ok: false, error: "Not a Git repository" });
          const status = await gitStatus(cwd) as any;
          const branch = status.branch;
          if (!branch) return sendJson(res, 400, { ok: false, error: "Cannot sync detached HEAD" });
          const fetchResult = await git(["fetch", "--prune", "origin"], 60_000, cwd);
          const pullResult = await git(["pull", "--rebase", "--autostash", "origin", branch], 120_000, cwd);
          return sendJson(res, 200, { ok: true, output: `${fetchResult.stdout}${fetchResult.stderr}${pullResult.stdout}${pullResult.stderr}`, status: await gitStatus(cwd) });
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
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
        const actionKey = cleanHeaderActionKey(body.key);
        if (!actionKey) return sendJson(res, 400, { ok: false, error: "key is required" });
        const action = getWebHeaderActionState(targetSession).actions.get(actionKey);
        if (!action) return sendJson(res, 404, { ok: false, error: "Header action not found" });
        try {
          const result = await action.invoke();
          const markdown = cleanFooterText(result?.markdown, 200_000);
          if (!markdown) return sendJson(res, 400, { ok: false, error: "Header action returned no markdown" });
          return sendJson(res, 200, { ok: true, label: cleanHeaderActionText(action.label) || cleanHeaderActionText(action.title) || actionKey, markdown });
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
        const pending = pendingExtensionUiRequests.get(id);
        if (!pending) return sendJson(res, 404, { ok: false, error: "Extension UI request not found" });
        pending.resolve(body);
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
            const missedTerminalEvent = Boolean(promptSessionFile && runtimeStartedAts.has(promptSessionFile) && !isRunning);
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
        const state = currentStateWithThinkingLevels(targetSession);
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
  realtimeWs.missedPongs = 0;
  realtimeWs.on("pong", () => {
    realtimeWs.missedPongs = 0;
  });
  clients.add(realtimeWs);
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const lastSeq = Number(url.searchParams.get("lastSeq") || 0);
  const latestSeq = nextRealtimeSeq - 1;
  const oldestSeq = realtimeEventLog[0]?.seq || nextRealtimeSeq;

  if (Number.isFinite(lastSeq) && lastSeq > 0) {
    if (lastSeq > latestSeq || lastSeq < oldestSeq - 1) {
      ws.send(JSON.stringify({ type: "sync_required", latestSeq }));
    } else {
      for (const event of realtimeEventLog) {
        if (event.seq > lastSeq) ws.send(JSON.stringify({ ...event, replay: true }));
      }
    }
  }

  const requestedSessionId = url.searchParams.get("sessionId") || session.sessionId;
  const targetSession = requestedSessionId === session.sessionId ? session : await getOrCreateLiveSessionById(requestedSessionId);
  const clientId = cleanClientId(url.searchParams.get("clientId") || "");
  if (clientId) {
    acquireViewerLease(clientId, targetSession || session);
    bindViewerSocket(clientId, realtimeWs);
  }
  const helloState = targetSession ? currentState(targetSession) : currentState();
  realtimeWs.send(JSON.stringify({
    type: "hello",
    seq: latestSeq,
    ...helloState,
  }));
  realtimeWs.on("close", () => clients.delete(realtimeWs));
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
