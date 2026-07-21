import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitFileStatus {
  path: string;
  oldPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  label: string;
  staged: boolean;
}

export async function git(args: string[], timeout = 15_000, cwd = process.cwd()) {
  return execFileAsync("git", args, { cwd, timeout, maxBuffer: 10 * 1024 * 1024 });
}

export async function gitBuffer(args: string[], timeout = 15_000, cwd = process.cwd()) {
  return new Promise<Buffer>((resolvePromise, reject) => {
    execFile("git", args, { cwd, timeout, maxBuffer: 50 * 1024 * 1024, encoding: "buffer" }, (error, stdout) => {
      if (error) {
        (error as Error & { stdout?: Buffer }).stdout = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
        reject(error);
        return;
      }
      resolvePromise(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
    });
  });
}

export async function isGitRepo(cwd = process.cwd()) {
  try {
    await git(["rev-parse", "--is-inside-work-tree"], 15_000, cwd);
    return true;
  } catch {
    return false;
  }
}

export function gitLabel(indexStatus: string, worktreeStatus: string) {
  if (indexStatus === "?" && worktreeStatus === "?") return "untracked";
  if (indexStatus === "U" || worktreeStatus === "U" || indexStatus === "A" && worktreeStatus === "A" || indexStatus === "D" && worktreeStatus === "D") return "conflicted";
  if (indexStatus === "R" || worktreeStatus === "R") return "renamed";
  if (indexStatus === "A" || worktreeStatus === "A") return "added";
  if (indexStatus === "D" || worktreeStatus === "D") return "deleted";
  if (indexStatus !== " " && indexStatus !== "?") return "staged";
  return "modified";
}

export function parseStatusLine(line: string): GitFileStatus {
  const indexStatus = line[0] || " ";
  const worktreeStatus = line[1] || " ";
  const rawPath = line.slice(3);
  const renamed = rawPath.includes(" -> ");
  const [oldPath, path] = renamed ? rawPath.split(" -> ") : [undefined, rawPath];
  return { path: path || rawPath, oldPath, indexStatus, worktreeStatus, label: gitLabel(indexStatus, worktreeStatus), staged: indexStatus !== " " && indexStatus !== "?" };
}

export async function gitStatus(cwd = process.cwd(), fetchRemote = false) {
  if (!await isGitRepo(cwd)) return { ok: true as const, isRepo: false as const, ahead: 0, behind: 0, files: [] as GitFileStatus[] };
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
  const untrackedFiles: GitFileStatus[] = untrackedOut.split("\n").map((path) => path.trim()).filter(Boolean).map((path) => ({
    path,
    indexStatus: "?",
    worktreeStatus: "?",
    label: "untracked",
    staged: false,
  }));
  return {
    ok: true as const,
    isRepo: true as const,
    root: root.trim(),
    branch: branchOut.trim(),
    upstream: upstreamResult.stdout.trim(),
    defaultRemoteBranch: defaultResult.stdout.trim(),
    ahead,
    behind,
    files: [...trackedFiles, ...untrackedFiles],
  };
}

export function safeGitPath(path: string) {
  if (!path || path.startsWith("/") || path.includes("..") || path.includes("\0")) throw new Error("Invalid path");
  return path;
}

export function isImageGitPath(path: string) {
  return [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(extname(path).toLowerCase());
}

export async function readGitImage(options: { cwd: string; path: string; oldPath?: string; version: string; staged: boolean }) {
  const filePath = safeGitPath(options.path);
  const oldPath = options.oldPath ? safeGitPath(options.oldPath) : undefined;
  const displayPath = options.version === "before" ? oldPath || filePath : filePath;
  if (!isImageGitPath(displayPath)) return undefined;

  if (options.version === "before") {
    return { data: await gitBuffer(["show", `HEAD:${oldPath || filePath}`], 15_000, options.cwd), displayPath };
  }
  if (options.version !== "after") throw new Error("Invalid image version");
  if (options.staged) {
    return { data: await gitBuffer(["show", `:${filePath}`], 15_000, options.cwd), displayPath };
  }

  const resolved = resolve(options.cwd, filePath);
  const rel = relative(options.cwd, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Image path is outside the repository");
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error("Image not found");
  return { file: resolved, displayPath };
}

export async function gitCwdFromRepoParam(repo: string | null, baseCwd: string) {
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
  const status = await gitStatus(cwd);
  return {
    path,
    root: status.isRepo ? status.root : cwd,
    branch: status.isRepo ? status.branch : "",
    upstream: status.isRepo ? status.upstream : "",
    ahead: status.ahead,
    behind: status.behind,
    dirtyCount: status.files.length,
    isCurrent: path === ".",
  };
}

export async function listGitRepos(cwd = process.cwd()) {
  const repos: Array<Awaited<ReturnType<typeof gitRepoSummary>>> = [];
  const seenRoots = new Set<string>();
  async function addRepo(path: string, repoCwd: string) {
    if (!await isGitRepo(repoCwd)) return;
    const { stdout } = await git(["rev-parse", "--show-toplevel"], 15_000, repoCwd);
    const root = resolve(stdout.trim());
    if (seenRoots.has(root)) return;
    seenRoots.add(root);
    repos.push(await gitRepoSummary(path, repoCwd));
  }

  await addRepo(".", cwd);
  const entries = await readdir(cwd, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || ignoredGitRepoDirs.has(entry.name)) continue;
    const repoCwd = join(cwd, entry.name);
    if (!existsSync(join(repoCwd, ".git"))) continue;
    await addRepo(entry.name, repoCwd);
  }
  return { ok: true as const, cwd, depth: 1, repos };
}

function parseCommit(entry: string) {
  const [hash = "", shortHash = "", parents = "", author = "", date = "", refs = "", subject = ""] = entry.split("\x1f");
  return { hash, shortHash, parents: parents ? parents.split(" ").filter(Boolean) : [], author, date, refs: refs ? refs.split(", ").filter(Boolean) : [], subject };
}

export async function gitLog(cwd = process.cwd()) {
  if (!await isGitRepo(cwd)) return { ok: true as const, isRepo: false as const, commits: [] };
  const { stdout } = await git(["log", "--all", "-n", "200", "--date=iso-strict", "--pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%ad%x1f%D%x1f%s%x1e"], 15_000, cwd);
  const commits = stdout.split("\x1e").map((entry) => entry.trim()).filter(Boolean).map(parseCommit);
  return { ok: true as const, isRepo: true as const, commits };
}

export async function gitCommitDetails(hash: string, cwd = process.cwd()) {
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
  return { ok: true as const, commit: parseCommit(commitOut.trim()), files, diff };
}

export async function gitDiff(options: { cwd: string; path: string; staged: boolean }) {
  const filePath = safeGitPath(options.path);
  const args = options.staged ? ["diff", "--cached", "--", filePath] : ["diff", "--", filePath];
  let { stdout } = await git(args, 15_000, options.cwd);
  if (!stdout) {
    const status = await gitStatus(options.cwd);
    const file = status.files.find((entry) => entry.path === filePath);
    if (file?.label === "untracked") {
      stdout = (await git(["diff", "--no-index", "--", "/dev/null", filePath], 15_000, options.cwd).catch((error: Error & { stdout?: string }) => ({ stdout: error.stdout || "" }))).stdout;
    }
  }
  return { ok: true as const, path: filePath, staged: options.staged, diff: stdout };
}

export async function gitSync(cwd: string) {
  const status = await gitStatus(cwd);
  const branch = status.isRepo ? status.branch : "";
  if (!branch) throw new Error("Cannot sync detached HEAD");
  const fetchResult = await git(["fetch", "--prune", "origin"], 60_000, cwd);
  const pullResult = await git(["pull", "--rebase", "--autostash", "origin", branch], 120_000, cwd);
  return { ok: true as const, output: `${fetchResult.stdout}${fetchResult.stderr}${pullResult.stdout}${pullResult.stderr}`, status: await gitStatus(cwd) };
}
