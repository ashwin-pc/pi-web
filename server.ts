import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
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
} from "@mariozechner/pi-coding-agent";
import { createMockHarness } from "./server/mock.js";
import { resolveBundledExtensionPaths } from "./server/extensions.js";
import { createSettingsStore } from "./server/settings.js";
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

  const file = resolve(artifactDir, name);
  const legacyFile = resolve(legacyArtifactDir, name);
  const resolvedFile = file.startsWith(artifactDir) && existsSync(file)
    ? file
    : legacyFile.startsWith(legacyArtifactDir) && existsSync(legacyFile)
      ? legacyFile
      : "";
  if (!resolvedFile) return sendJson(res, 404, { ok: false, error: "Artifact not found" });

  res.writeHead(200, {
    "content-type": contentTypes[extname(resolvedFile).toLowerCase()] || "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(resolvedFile).pipe(res);
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
  createReadStream(file).pipe(res);
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
  createReadStream(resolved).pipe(res);
}

async function gitCwdFromRepoParam(repo: string | null) {
  if (!repo || repo === ".") return piCwd;
  if (repo.includes("\0") || isAbsolute(repo)) throw new Error("Invalid repository path");
  const resolved = resolve(piCwd, repo);
  const rel = relative(piCwd, resolved);
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

async function listGitRepos() {
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

  await addRepo(".", piCwd);
  const entries = await readdir(piCwd, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || ignoredGitRepoDirs.has(entry.name)) continue;
    const cwd = join(piCwd, entry.name);
    if (!existsSync(join(cwd, ".git"))) continue;
    await addRepo(entry.name, cwd);
  }
  return { ok: true, cwd: piCwd, depth: 1, repos };
}

type RepoPrInfo = { number: number; url: string; title?: string };
type RepoInfo = {
  ok: true;
  cwd: string;
  isRepo: boolean;
  root?: string;
  rootName?: string;
  cwdRel?: string;
  branch?: string;
  upstream?: string;
  shortHash?: string;
  hash?: string;
  pr?: RepoPrInfo | null;
};

const repoInfoCache = new Map<string, { value: RepoInfo; expiresAt: number }>();
const repoInfoCacheTtlMs = 4_000;

async function detectGithubPr(cwd: string, branch: string): Promise<RepoPrInfo | null> {
  if (!branch) return null;
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["pr", "view", branch, "--json", "number,url,title"],
      { cwd, timeout: 5_000, maxBuffer: 1024 * 1024 },
    );
    const data = JSON.parse(stdout) as { number?: number; url?: string; title?: string };
    if (typeof data.number === "number" && typeof data.url === "string") {
      return { number: data.number, url: data.url, title: data.title };
    }
    return null;
  } catch {
    return null;
  }
}

async function getRepoInfo(cwd: string): Promise<RepoInfo> {
  const now = Date.now();
  const cached = repoInfoCache.get(cwd);
  if (cached && cached.expiresAt > now) return cached.value;

  const base: RepoInfo = { ok: true, cwd, isRepo: false };
  if (!(await isGitRepo(cwd))) {
    repoInfoCache.set(cwd, { value: base, expiresAt: now + repoInfoCacheTtlMs });
    return base;
  }

  const [rootRes, branchRes, upstreamRes, hashRes, shortHashRes] = await Promise.all([
    git(["rev-parse", "--show-toplevel"], 15_000, cwd).catch(() => ({ stdout: "" })),
    git(["branch", "--show-current"], 15_000, cwd).catch(() => ({ stdout: "" })),
    git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], 15_000, cwd).catch(() => ({ stdout: "" })),
    git(["rev-parse", "HEAD"], 15_000, cwd).catch(() => ({ stdout: "" })),
    git(["rev-parse", "--short", "HEAD"], 15_000, cwd).catch(() => ({ stdout: "" })),
  ]);

  const root = rootRes.stdout.trim();
  const branch = branchRes.stdout.trim();
  const rel = root ? relative(root, cwd) : "";

  const info: RepoInfo = {
    ok: true,
    cwd,
    isRepo: true,
    root: root || undefined,
    rootName: root ? basename(root) : undefined,
    cwdRel: rel.startsWith("..") ? "" : rel,
    branch: branch || undefined,
    upstream: upstreamRes.stdout.trim() || undefined,
    hash: hashRes.stdout.trim() || undefined,
    shortHash: shortHashRes.stdout.trim() || undefined,
    pr: null,
  };

  // Cache base info briefly so concurrent renders share results
  repoInfoCache.set(cwd, { value: info, expiresAt: now + repoInfoCacheTtlMs });

  // Try to fetch PR info; update the cache once it resolves so a follow-up
  // request returns enriched data without making the user wait now.
  if (branch) {
    detectGithubPr(cwd, branch).then((pr) => {
      const enriched: RepoInfo = { ...info, pr: pr ?? null };
      repoInfoCache.set(cwd, { value: enriched, expiresAt: Date.now() + repoInfoCacheTtlMs });
    }).catch(() => undefined);
  }

  return info;
}

function parseCommit(entry: string) {
  const [hash = "", shortHash = "", parents = "", author = "", date = "", refs = "", subject = ""] = entry.split("\x1f");
  return { hash, shortHash, parents: parents ? parents.split(" ").filter(Boolean) : [], author, date, refs: refs ? refs.split(", ").filter(Boolean) : [], subject };
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
function copilotAllowedIdsFromSession(): Set<string> | null {
  const entries = session.messages;
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

function getAvailableModels() {
  const all = session.modelRegistry.getAvailable();
  const allowed = copilotAllowedIdsFromSession();
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

async function persistPromptImages(images: Array<{ data: string; mimeType: string; name?: string }>) {
  if (!images.length) return "";
  await ensurePiWebStorage();
  const uploadDir = join(piCwd, ".pi", "web", "uploads");
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

function simplifyMessage(message: unknown, toolCallArgs?: Map<string, Record<string, unknown>>) {
  if (!message || typeof message !== "object") return message;
  const m = message as Record<string, unknown>;
  if (m.role === "toolResult") {
    const args = toolCallArgs?.get(m.toolCallId as string);
    return {
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
  const text = textFromContent(m.content);
  const errorText = m.role === "assistant" && !text && m.errorMessage ? assistantErrorPreview(m) : "";
  const toolCalls = m.role === "assistant" && Array.isArray(m.content)
    ? m.content.filter((part: any) => part?.type === "toolCall").map((part: any) => ({
      id: part.id,
      toolName: part.toolName || part.name || "tool",
      args: part.arguments || part.args || {},
    }))
    : undefined;
  return {
    role: m.role,
    text: errorText || text,
    toolCalls,
    isError: Boolean(m.errorMessage || m.stopReason === "error"),
    timestamp: m.timestamp,
    raw: m,
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

function entryRole(entry: any) {
  const message = entryMessage(entry);
  if (message?.role === "assistant" && !messageTextPreview(message).trim()) {
    if (messageToolCalls(message).length > 0) return "toolCall";
    if (message.errorMessage) return "error";
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
  return nodes.reduce((sum, node) => sum + 1 + countTreeNodes(Array.isArray(node.children) ? node.children : []), 0);
}

function countBranchPoints(nodes: any[]): number {
  return nodes.reduce((sum, node) => {
    const children = Array.isArray(node.children) ? node.children : [];
    return sum + (children.length > 1 ? 1 : 0) + countBranchPoints(children);
  }, 0);
}

function simplifyTreeNode(node: any, activePathIds: Set<string>, leafId: string | null): any {
  const entry = node?.entry || node;
  const children = Array.isArray(node?.children) ? node.children.map((child: any) => simplifyTreeNode(child, activePathIds, leafId)) : [];
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
    childCount: children.length,
    isOnActivePath: activePathIds.has(id),
    isCurrentLeaf: Boolean(leafId && id === leafId),
    children,
  };
}

function conversationTreeForSession(targetSession: PiWebSession) {
  const manager = targetSession.sessionManager;
  if (typeof manager.getTree !== "function") throw new Error("Session tree is not available");
  const leafId = typeof manager.getLeafId === "function" ? manager.getLeafId() : null;
  const activePath = typeof manager.getBranch === "function" ? manager.getBranch() : [];
  const activePathIds = new Set(activePath.map((entry: any) => String(entry?.id || "")).filter(Boolean));
  const roots = manager.getTree();
  const nodes = roots.map((node: any) => simplifyTreeNode(node, activePathIds, leafId));
  return {
    ok: true,
    sessionId: targetSession.sessionId,
    leafId,
    activePathIds: Array.from(activePathIds),
    entryCount: countTreeNodes(nodes),
    branchPointCount: countBranchPoints(nodes),
    nodes,
  };
}

function runtimeForPath(path: string) {
  const live = liveSessions.get(path)?.session;
  const isStreaming = Boolean(live?.isStreaming);
  const isCompacting = Boolean(live?.isCompacting);
  return {
    loaded: Boolean(live),
    isRunning: isStreaming || isCompacting,
    isStreaming,
    isCompacting,
    pendingMessageCount: Number(live?.pendingMessageCount || 0),
    model: simplifyModel(live?.model),
  };
}

function simplifySessionInfo(info: Awaited<ReturnType<typeof SessionManager.list>>[number], cwd = piCwd) {
  return {
    id: info.id,
    name: info.name,
    firstMessage: info.firstMessage,
    created: info.created.toISOString(),
    modified: info.modified.toISOString(),
    messageCount: info.messageCount,
    cwd,
    isCurrent: cwd === piCwd && info.id === session.sessionId,
    runtime: runtimeForPath(info.path),
  };
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

function currentState() {
  return {
    cwd: piCwd,
    sessionFile: session.sessionFile,
    sessionId: session.sessionId,
    sessionName: sessionDisplayName(session),
    sessionTitle: liveSessionTitle(session),
    isStreaming: session.isStreaming,
    model: simplifyModel(session.model),
    thinkingLevel: session.thinkingLevel,
    stats: sessionStats(session),
  };
}

function currentStateWithThinkingLevels() {
  return {
    ...currentState(),
    thinkingLevels: session.getAvailableThinkingLevels(),
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

function slashHelp() {
  return [
    "Type / in the composer to browse available commands.",
    "",
    "Web commands run in pi-web; extension, prompt, and skill commands are discovered from pi's extension/resource system.",
    "",
    formatSlashCommandList(getSlashCommands()),
  ].join("\n");
}

function formatModelList() {
  return getAvailableModels()
    .map((model: any) => `${model.provider}/${model.id}${model.name && model.name !== model.id ? ` (${model.name})` : ""}`)
    .join("\n");
}

async function executeSlashCommand(input: string) {
  const trimmed = input.trim();
  const [rawName = "", ...rest] = trimmed.replace(/^\/+/, "").split(/\s+/);
  const name = rawName.toLowerCase();
  const args = rest.join(" ").trim();

  switch (name) {
    case "help":
    case "?":
      return { message: slashHelp(), state: currentStateWithThinkingLevels() };

    case "commands":
      return { message: formatSlashCommandList(getSlashCommands()), state: currentStateWithThinkingLevels() };

    case "reload": {
      if (session.isStreaming) throw new Error("Wait for the current response to finish before reloading.");
      if (session.isCompacting) throw new Error("Wait for compaction to finish before reloading.");
      if (typeof session.reload !== "function") throw new Error("Reload is not available in this session.");
      await session.reload();
      return { message: "Reloaded pi resources, extensions, and models.", state: currentStateWithThinkingLevels() };
    }

    case "model": {
      if (!args) {
        return { message: formatModelList() || "No models available.", state: currentStateWithThinkingLevels() };
      }
      const slashIndex = args.indexOf("/");
      if (slashIndex <= 0) throw new Error("Usage: /model <provider/model-id>");
      const provider = args.slice(0, slashIndex);
      const id = args.slice(slashIndex + 1);
      const model = session.modelRegistry.find(provider, id);
      if (!model) throw new Error(`Model not found: ${args}`);
      await session.setModel(model);
      return { message: `Model set to ${provider}/${id}.`, state: currentStateWithThinkingLevels() };
    }

    case "models":
      return { message: formatModelList() || "No models available.", state: currentStateWithThinkingLevels() };

    case "thinking": {
      if (!args) {
        return { message: `Thinking level: ${session.thinkingLevel}\nAvailable: ${session.getAvailableThinkingLevels().join(", ")}`, state: currentStateWithThinkingLevels() };
      }
      const levels = session.getAvailableThinkingLevels();
      if (!levels.includes(args as any)) throw new Error(`Unknown thinking level: ${args}. Available: ${levels.join(", ")}`);
      session.setThinkingLevel(args as any);
      return { message: `Thinking level set to ${session.thinkingLevel}.`, state: currentStateWithThinkingLevels() };
    }

    case "new": {
      session = await createNewLiveSession();
      return { message: "New session.", state: currentStateWithThinkingLevels() };
    }

    case "compact": {
      if (session.isStreaming) throw new Error("Wait for the current response to finish before compacting.");
      if (session.isCompacting) throw new Error("Compaction is already running.");
      if (typeof session.compact !== "function") throw new Error("Compaction is not available in this session.");
      void session.compact(args || undefined).catch((error: unknown) => broadcast({
        type: "server_error",
        sessionId: session.sessionId,
        sessionFile: session.sessionFile,
        error: error instanceof Error ? error.message : String(error),
      }));
      return { message: "Compaction started.", state: currentStateWithThinkingLevels() };
    }

    case "abort":
    case "stop":
      await session.abort();
      return { message: "Aborted.", state: currentStateWithThinkingLevels() };

    default:
      throw new Error(`Unknown slash command: /${name}. Try /help.`);
  }
}

async function findSessionInfoById(id: string, cwd = piCwd) {
  if (!id) return undefined;
  const sessions = noSession ? [] : mockMode ? mockSessions : await SessionManager.list(cwd);
  return sessions.find((info) => info.id === id);
}

async function getOrCreateLiveSessionById(id: string) {
  if (id === session.sessionId) return session;
  for (const entry of liveSessions.values()) {
    if (entry.session.sessionId === id) return entry.session;
  }
  const info = await findSessionInfoById(id);
  return info ? getOrCreateLiveSession(info.path) : undefined;
}

async function switchToSessionId(id: string) {
  const target = await getOrCreateLiveSessionById(id);
  if (!target) throw new Error("Session not found");
  session = target;
}

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const settingsStore = createSettingsStore(process.env.PI_WEB_SETTINGS_FILE || join(getAgentDir(), "pi-web-settings.json"));
const liveSessions = new Map<string, { session: any; unsubscribe?: () => void }>();
let session: PiWebSession;
let modelFallbackMessage: string | undefined;

const clients = new Set<WebSocket>();
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
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      opts?.signal?.removeEventListener("abort", onAbort);
      pendingExtensionUiRequests.delete(id);
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

function createWebExtensionUiContext(value: any): ExtensionUIContext {
  return {
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
        session = await createNewLiveSession();
        const state = currentStateWithThinkingLevels();
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
const { mockSessions, createMockSession, resetMockSessions } = mockHarness;

function sessionPathKey(value: any) {
  return String(value.sessionFile || value.sessionId || "");
}

function registerLiveSession(value: any) {
  const key = sessionPathKey(value);
  if (!key || liveSessions.get(key)?.session === value) return value;

  const unsubscribe = value.subscribe?.((event: unknown) => {
    const eventSessionFile = value.sessionFile;
    const eventSessionId = value.sessionId;
    broadcast({ type: "pi_event", sessionId: eventSessionId, sessionFile: eventSessionFile, event });
    broadcast({
      type: "session_runtime_changed",
      sessionId: eventSessionId,
      sessionFile: eventSessionFile,
      runtime: runtimeForPath(eventSessionFile),
    });

    // Track models that fail with model_not_supported and remove them from the list.
    const e = event as any;

    // Broadcast state update when session name changes
    if (e?.type === "session_info_changed") {
      broadcast({ type: "state_changed", ...currentState() });
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
          broadcast({ type: "models_updated", models: getAvailableModels().map(simplifyModel) });
        }
      }
    }
  });
  liveSessions.set(key, { session: value, unsubscribe });
  return value;
}

function bundledExtensionPaths() {
  return resolveBundledExtensionPaths({ piCwd, appDir, bundledExtensionsDir });
}

async function makeAgentSession(path?: string, sessionStartEvent?: SessionStartEvent) {
  if (mockMode) return { session: createMockSession(path), modelFallbackMessage: undefined };

  const sessionManager = noSession ? SessionManager.inMemory() : SessionManager.create(piCwd);
  if (path && !noSession) sessionManager.setSessionFile(path);
  if (!path && !noSession && sessionStartEvent?.reason === "new") sessionManager.newSession();

  const webUiContext = existsSync(webUiContextFile) ? readFileSync(webUiContextFile, "utf-8") : "";

  const loader = new DefaultResourceLoader({
    cwd: piCwd,
    agentDir: getAgentDir(),
    additionalExtensionPaths: bundledExtensionPaths(),
    appendSystemPromptOverride: (base) => [
      ...base,
      webUiContext,
    ].filter(Boolean),
  });
  await loader.reload();

  const result = await createAgentSession({
    cwd: piCwd,
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
  if (existing) return existing;
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

async function createNewLiveSession(cwd?: string) {
  if (cwd) await setPiCwd(cwd);
  const previousSessionFile = session?.sessionFile;
  const created = await makeAgentSession(undefined, { type: "session_start", reason: "new", previousSessionFile });
  if (created.modelFallbackMessage) console.warn(created.modelFallbackMessage);
  const value = created.session;
  if (mockMode) {
    value.sessionManager.newSession();
    value.agent.state.messages = value.sessionManager.buildSessionContext().messages;
  }
  await applyDefaultSessionSettings(value);
  return registerLiveSession(value);
}

async function switchEmptySessionCwd(cwd: string) {
  if (session.isStreaming) throw new Error("Wait for the current response to finish before changing the working directory.");
  if (session.isCompacting) throw new Error("Wait for compaction to finish before changing the working directory.");
  if (hasUserMessages(session)) throw new Error("Working directory can only be changed before the first message.");
  session = await createNewLiveSession(cwd);
  return currentStateWithThinkingLevels();
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
        for (const entry of liveSessions.values()) entry.unsubscribe?.();
        liveSessions.clear();
        resetMockSessions();
        session = registerLiveSession(createMockSession());
        broadcast({ type: "state_changed", ...currentState() });
        return sendJson(res, 200, { ok: true });
      }

      if (method === "GET" && url.pathname === "/api/fs/dirs") {
        try {
          return sendJson(res, 200, await listDirectories(url.searchParams.get("path") || piCwd));
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "GET" && url.pathname === "/api/git/repos") {
        return sendJson(res, 200, await listGitRepos());
      }

      if (method === "GET" && url.pathname === "/api/git/status") {
        try {
          return sendJson(res, 200, await gitStatus(await gitCwdFromRepoParam(url.searchParams.get("repo")), url.searchParams.get("fetch") === "1"));
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "GET" && url.pathname === "/api/repo-info") {
        try {
          return sendJson(res, 200, await getRepoInfo(await gitCwdFromRepoParam(url.searchParams.get("repo"))));
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "GET" && url.pathname === "/api/git/log") {
        try {
          return sendJson(res, 200, await gitLog(await gitCwdFromRepoParam(url.searchParams.get("repo"))));
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "GET" && url.pathname === "/api/git/commit") {
        try {
          return sendJson(res, 200, await gitCommitDetails(url.searchParams.get("hash") || "", await gitCwdFromRepoParam(url.searchParams.get("repo"))));
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "GET" && url.pathname === "/api/git/diff") {
        try {
          const cwd = await gitCwdFromRepoParam(url.searchParams.get("repo"));
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
          const cwd = await gitCwdFromRepoParam(url.searchParams.get("repo"));
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
          const cwd = await gitCwdFromRepoParam(url.searchParams.get("repo"));
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
        return sendJson(res, 200, {
          ok: true,
          ...currentStateWithThinkingLevels(),
          tokenRequired: Boolean(token),
        });
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
        if (targetSession !== session) return sendJson(res, 400, { ok: false, error: "Open the session before navigating its tree" });
        if (targetSession.isStreaming) return sendJson(res, 409, { ok: false, error: "Wait for the current response to finish before navigating the tree" });
        if (targetSession.isCompacting) return sendJson(res, 409, { ok: false, error: "Wait for the current compaction to finish before navigating the tree" });
        if (typeof targetSession.navigateTree !== "function") return sendJson(res, 400, { ok: false, error: "Tree navigation is not available" });

        const targetId = String(body.targetId || "").trim();
        if (!targetId) return sendJson(res, 400, { ok: false, error: "targetId is required" });

        try {
          const navigation = targetSession.navigateTree(targetId, {
            summarize: Boolean(body.summarize),
            customInstructions: typeof body.customInstructions === "string" && body.customInstructions.trim() ? body.customInstructions.trim() : undefined,
            replaceInstructions: Boolean(body.replaceInstructions),
            label: typeof body.label === "string" && body.label.trim() ? body.label.trim() : undefined,
          });
          broadcast({ type: "session_runtime_changed", sessionId: targetSession.sessionId, sessionFile: targetSession.sessionFile, runtime: runtimeForPath(targetSession.sessionFile) });
          const result = await navigation;
          const state = currentStateWithThinkingLevels();
          broadcast({ type: "state_changed", ...state });
          return sendJson(res, 200, { ok: true, ...result, leafId: targetSession.sessionManager.getLeafId?.() || null, state });
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        } finally {
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
        return sendJson(res, 200, { ok: true, messages: msgs.map((m: unknown) => simplifyMessage(m, toolCallArgs)) });
      }

      if (method === "GET" && url.pathname === "/api/sessions") {
        const extraCwds = url.searchParams.getAll("cwd");
        return sendJson(res, 200, { ok: true, sessions: await listSessionInfos(extraCwds) });
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
        return sendJson(res, 200, {
          ok: true,
          cwd: piCwd,
          current: simplifyModel(session.model),
          thinkingLevel: session.thinkingLevel,
          thinkingLevels: session.getAvailableThinkingLevels(),
          models: getAvailableModels().map(simplifyModel),
        });
      }

      if (method === "POST" && url.pathname === "/api/model") {
        const body = await readBody(req) as { provider?: unknown; id?: unknown; thinkingLevel?: unknown };
        const provider = String(body.provider || "").trim();
        const id = String(body.id || "").trim();
        if (!provider || !id) return sendJson(res, 400, { ok: false, error: "provider and id are required" });

        const model = session.modelRegistry.find(provider, id);
        if (!model) return sendJson(res, 404, { ok: false, error: "Model not found" });

        await session.setModel(model);
        if (typeof body.thinkingLevel === "string") session.setThinkingLevel(body.thinkingLevel as any);

        const state = {
          cwd: piCwd,
          sessionFile: session.sessionFile,
          sessionId: session.sessionId,
          model: simplifyModel(session.model),
          thinkingLevel: session.thinkingLevel,
          thinkingLevels: session.getAvailableThinkingLevels(),
        };
        broadcast({ type: "state_changed", ...state });
        return sendJson(res, 200, { ok: true, ...state });
      }

      if (method === "POST" && url.pathname === "/api/command") {
        const body = await readBody(req) as { command?: unknown };
        const command = String(body.command || "").trim();
        if (!command.startsWith("/")) return sendJson(res, 400, { ok: false, error: "Slash command is required" });

        const result = await executeSlashCommand(command);
        return sendJson(res, 200, { ok: true, ...result });
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

        const imageFileNote = await persistPromptImages(images);
        const promptText = `${message || "Please review the attached image."}${imageFileNote}`;
        const mode = body.mode === "followUp" ? "followUp" : "steer";
        const requestedSessionId = typeof body.sessionId === "string" ? body.sessionId : session.sessionId;
        const targetSession = requestedSessionId === session.sessionId ? session : await getOrCreateLiveSessionById(requestedSessionId);
        if (!targetSession) return sendJson(res, 404, { ok: false, error: "Session not found" });
        void targetSession.prompt(promptText, {
          ...(targetSession.isStreaming ? { streamingBehavior: mode } : {}),
          ...(images.length ? { images: images.map(({ type, data, mimeType }) => ({ type, data, mimeType })) } : {}),
        })
          .catch((error: unknown) => broadcast({
            type: "server_error",
            sessionId: targetSession.sessionId,
            sessionFile: targetSession.sessionFile,
            error: error instanceof Error ? error.message : String(error),
          }));

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
        const state = targetSession === session ? currentStateWithThinkingLevels() : { sessionId: targetSession.sessionId, sessionName: sessionDisplayName(targetSession) };
        return sendJson(res, 200, { ok: true, ...state });
      }

      if (method === "POST" && (url.pathname === "/api/new-chat" || url.pathname === "/api/sessions/new")) {
        const body = await readBody(req) as { cwd?: unknown };
        session = await createNewLiveSession(typeof body.cwd === "string" ? body.cwd : undefined);
        const state = currentStateWithThinkingLevels();
        broadcast({ type: "state_changed", ...state });
        return sendJson(res, 200, { ok: true, ...state });
      }

      if (method === "POST" && url.pathname === "/api/session/cwd") {
        const body = await readBody(req) as { cwd?: unknown };
        const cwd = String(body.cwd || "").trim();
        if (!cwd) return sendJson(res, 400, { ok: false, error: "cwd is required" });
        try {
          const state = await switchEmptySessionCwd(cwd);
          broadcast({ type: "state_changed", ...state });
          return sendJson(res, 200, { ok: true, ...state });
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "POST" && url.pathname === "/api/sessions/open") {
        const body = await readBody(req) as { id?: unknown; sessionId?: unknown; cwd?: unknown };
        const requestedId = typeof body.sessionId === "string" ? body.sessionId : typeof body.id === "string" ? body.id : "";
        if (!requestedId) return sendJson(res, 400, { ok: false, error: "sessionId is required" });

        try {
          if (typeof body.cwd === "string" && body.cwd.trim()) await setPiCwd(body.cwd);
          await switchToSessionId(requestedId);
        } catch {
          return sendJson(res, 404, { ok: false, error: "Session not found" });
        }
        const state = currentStateWithThinkingLevels();
        broadcast({ type: "state_changed", ...state });
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

wss.on("connection", (ws, req) => {
  clients.add(ws);
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

  ws.send(JSON.stringify({
    type: "hello",
    seq: latestSeq,
    cwd: piCwd,
    sessionFile: session.sessionFile,
    sessionId: session.sessionId,
    model: simplifyModel(session.model),
    thinkingLevel: session.thinkingLevel,
    isStreaming: session.isStreaming,
  }));
  ws.on("close", () => clients.delete(ws));
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
