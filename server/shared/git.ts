import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

export async function git(args: string[], timeout = 15_000, cwd = process.cwd()) {
  return execFileAsync("git", args, { cwd, timeout, maxBuffer: 10 * 1024 * 1024 });
}

export async function gitBuffer(args: string[], timeout = 15_000, cwd = process.cwd()) {
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

export function parseStatusLine(line: string) {
  const indexStatus = line[0] || " ";
  const worktreeStatus = line[1] || " ";
  const rawPath = line.slice(3);
  const renamed = rawPath.includes(" -> ");
  const [oldPath, path] = renamed ? rawPath.split(" -> ") : [undefined, rawPath];
  return { path: path || rawPath, oldPath, indexStatus, worktreeStatus, label: gitLabel(indexStatus, worktreeStatus), staged: indexStatus !== " " && indexStatus !== "?" };
}

export async function gitStatus(cwd = process.cwd(), fetchRemote = false) {
  if (!await isGitRepo(cwd)) return { ok: true as const, cwd, isRepo: false, ahead: 0, behind: 0, files: [] as Array<ReturnType<typeof parseStatusLine>> };
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
  const trackedFiles = lines.slice(header.startsWith("##") ? 1 : 0).map(parseStatusLine).filter((file) => file.label !== "untracked");
  const { stdout: untrackedOut } = await git(["ls-files", "--others", "--exclude-standard"], 15_000, cwd).catch(() => ({ stdout: "" }));
  const untrackedFiles = untrackedOut.split("\n").map((path) => path.trim()).filter(Boolean).map((path) => ({
    path,
    oldPath: undefined,
    indexStatus: "?",
    worktreeStatus: "?",
    label: "untracked",
    staged: false,
  }));
  return {
    ok: true as const,
    cwd,
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

export function safeGitPath(path: string) {
  if (!path || path.startsWith("/") || path.includes("..") || path.includes("\0")) throw new Error("Invalid path");
  return path;
}

export async function gitDiff(options: { cwd?: string; path: string; staged?: boolean }) {
  const cwd = options.cwd || process.cwd();
  const filePath = safeGitPath(options.path || "");
  const staged = Boolean(options.staged);
  const args = staged ? ["diff", "--cached", "--", filePath] : ["diff", "--", filePath];
  let { stdout } = await git(args, 15_000, cwd).catch((error: any) => ({ stdout: error?.stdout || "" }));
  if (!stdout) {
    const status = await gitStatus(cwd) as any;
    const file = status.files?.find((f: any) => f.path === filePath);
    if (file?.label === "untracked") stdout = (await git(["diff", "--no-index", "--", "/dev/null", filePath], 15_000, cwd).catch((error: any) => ({ stdout: error.stdout || "" }))).stdout;
  }
  return { ok: true as const, path: filePath, staged, diff: stdout };
}
