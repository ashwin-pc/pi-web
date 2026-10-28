import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  gitConfigEnv,
  gitConfigHardeningOverrides,
  loadGitExecution,
  type GitConfigEntry,
  type GitExecution,
} from "./gitExecution.js";

const execFileAsync = promisify(execFile);
export { gitConfigEnv, gitConfigHardeningOverrides };
export type { GitConfigEntry };

export interface GitFileStatus {
  path: string;
  oldPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  label: string;
  staged: boolean;
}

export async function git(args: string[], timeout = 15_000, cwd = process.cwd()) {
  const execution = await loadGitExecution(cwd);
  return execFileAsync("git", execution.args(args), { cwd, timeout, maxBuffer: 10 * 1024 * 1024, env: execution.env });
}

export async function gitBuffer(args: string[], timeout = 15_000, cwd = process.cwd()) {
  const execution = await loadGitExecution(cwd);
  return new Promise<Buffer>((resolvePromise, reject) => {
    execFile("git", execution.args(args), {
      cwd,
      timeout,
      maxBuffer: 50 * 1024 * 1024,
      encoding: "buffer",
      env: execution.env,
    }, (error, stdout) => {
      if (error) {
        (error as Error & { stdout?: Buffer }).stdout = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
        reject(error);
        return;
      }
      resolvePromise(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
    });
  });
}

function runGitExecution(execution: GitExecution, args: string[], cwd: string, timeout = 15_000, maxBuffer = 10 * 1024 * 1024) {
  return execFileAsync("git", execution.args(args), { cwd, timeout, maxBuffer, env: execution.env });
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

function parseNumstat(output: string) {
  let additions = 0;
  let deletions = 0;
  for (const line of output.split("\n").filter(Boolean)) {
    const [added = "0", deleted = "0"] = line.split("\t");
    additions += Number(added) || 0;
    deletions += Number(deleted) || 0;
  }
  return { additions, deletions };
}

export async function gitStatus(cwd = process.cwd(), fetchRemote = false) {
  const emptyDiffStats = { staged: { files: 0, additions: 0, deletions: 0 }, unstaged: { files: 0, additions: 0, deletions: 0 } };
  if (!await isGitRepo(cwd)) return { ok: true as const, isRepo: false as const, ahead: 0, behind: 0, files: [] as GitFileStatus[], diffStats: emptyDiffStats };
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
  const [{ stdout: untrackedOut }, { stdout: stagedNumstat }, { stdout: unstagedNumstat }] = await Promise.all([
    git(["ls-files", "--others", "--exclude-standard"], 15_000, cwd).catch(() => ({ stdout: "" })),
    git(["diff", "--cached", "--numstat"], 15_000, cwd).catch(() => ({ stdout: "" })),
    git(["diff", "--numstat"], 15_000, cwd).catch(() => ({ stdout: "" })),
  ]);
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
    diffStats: {
      staged: { files: trackedFiles.filter((file) => file.indexStatus !== " " && file.indexStatus !== "?").length, ...parseNumstat(stagedNumstat) },
      unstaged: { files: trackedFiles.filter((file) => file.worktreeStatus !== " ").length + untrackedFiles.length, ...parseNumstat(unstagedNumstat) },
    },
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
  const rootReal = await realpath(options.cwd);
  const targetReal = await realpath(resolved).catch(() => undefined);
  if (!targetReal) throw new Error("Image not found");
  const realRel = relative(rootReal, targetReal);
  if (realRel === ".." || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) {
    throw new Error("Image path is outside the repository");
  }
  const info = await stat(targetReal);
  if (!info.isFile()) throw new Error("Image not found");
  return { file: targetReal, displayPath };
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
  const { stdout } = await git(["log", "--branches", "--remotes", "--tags", "--topo-order", "-n", "200", "--date=iso-strict", "--pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%ad%x1f%D%x1f%s%x1e"], 15_000, cwd);
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

const syncFilterConfigPattern = /^filter\..+\.(?:clean|smudge|process)$/i;

function assertSyncConfigSafe(entries: GitConfigEntry[]) {
  const filter = entries.find((entry) =>
    (entry.scope === "local" || entry.scope === "worktree") && syncFilterConfigPattern.test(entry.key));
  if (filter) {
    throw new Error(
      `Sync refused: repository-scoped filter driver config (${filter.key}) could run during autostash or rebase. ` +
      "Remove the repository filter command or sync this checkout outside pi-web.",
    );
  }
}

export function assertNoGitlinks(output: string, source: string, format: "tree" | "raw") {
  let hasGitlink = false;
  if (format === "tree") {
    hasGitlink = output.split("\0").some((record) => /^160000[ \t]/.test(record));
  } else {
    let expectPath = false;
    for (const record of output.split("\0")) {
      if (expectPath) {
        expectPath = false;
        continue;
      }
      const metadata = record.trimStart();
      if (!metadata) continue;
      const modes = metadata.match(/^:(\d{6}) (\d{6}) /);
      if (!modes) continue;
      if (modes[1] === "160000" || modes[2] === "160000") {
        hasGitlink = true;
        break;
      }
      expectPath = true;
    }
  }
  if (hasGitlink) {
    throw new Error(
      `Sync refused: submodule gitlinks are present in ${source} and could enter autostash or rebase. ` +
      "Preserve local changes and sync this repository outside pi-web.",
    );
  }
}

export async function gitSync(cwd: string) {
  const execution = await loadGitExecution(cwd);
  assertSyncConfigSafe(execution.entries);
  const { stdout: rootOut } = await runGitExecution(execution, ["rev-parse", "--show-toplevel"], cwd);
  const root = rootOut.trim();
  const { stdout: branchOut } = await runGitExecution(execution, ["branch", "--show-current"], root);
  const branch = branchOut.trim();
  if (!branch) throw new Error("Cannot sync detached HEAD");

  const [indexBefore, headBefore] = await Promise.all([
    runGitExecution(execution, ["ls-files", "--stage", "-z"], root),
    runGitExecution(execution, ["ls-tree", "-r", "-z", "HEAD"], root),
  ]);
  assertNoGitlinks(indexBefore.stdout, "the index", "tree");
  assertNoGitlinks(headBefore.stdout, "HEAD", "tree");

  const targetRef = `refs/remotes/origin/${branch}`;
  const fetchResult = await runGitExecution(
    execution,
    ["fetch", "--prune", "origin", `+refs/heads/${branch}:${targetRef}`],
    root,
    60_000,
  );
  const { stdout: targetOut } = await runGitExecution(execution, ["rev-parse", "--verify", `${targetRef}^{commit}`], root);
  const target = targetOut.trim();
  if (!/^[a-f0-9]{40,64}$/i.test(target)) throw new Error("Sync refused: fetched branch did not resolve to one commit");

  const [indexResult, headResult, targetResult, replayResult] = await Promise.all([
    runGitExecution(execution, ["ls-files", "--stage", "-z"], root),
    runGitExecution(execution, ["ls-tree", "-r", "-z", "HEAD"], root),
    runGitExecution(execution, ["ls-tree", "-r", "-z", target], root),
    runGitExecution(execution, ["log", "--no-color", "--format=", "--raw", "--no-renames", "-z", `${target}..HEAD`], root),
  ]);
  assertNoGitlinks(indexResult.stdout, "the index", "tree");
  assertNoGitlinks(headResult.stdout, "HEAD", "tree");
  assertNoGitlinks(targetResult.stdout, "the fetched target", "tree");
  assertNoGitlinks(replayResult.stdout, "local commits that would be replayed", "raw");

  const rebaseResult = await runGitExecution(execution, ["rebase", "--autostash", target], root, 120_000);
  return {
    ok: true as const,
    output: `${fetchResult.stdout}${fetchResult.stderr}${rebaseResult.stdout}${rebaseResult.stderr}`,
    status: await gitStatus(root),
  };
}
