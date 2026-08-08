// Uses typed compatibility wrappers; see notepad.ts for the current contribute() API.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PiWebExtensionAPI, PiWebExtensionContext } from "@ashwin-pc/pi-web/extensions";

const FOOTER_KEY = "local-git-footer";
const REFRESH_MS = 2_500;
const GIT_TIMEOUT_MS = 1_000;
const execFileAsync = promisify(execFile);

type GitResult = {
  ok: boolean;
  output: string;
};

type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

type GitSnapshot = {
  branch: string;
  dirty: boolean;
  added: number;
  modified: number;
  deleted: number;
  untracked: number;
};

type SessionState = {
  ctx: PiWebExtensionContext;
  sessionManager: PiWebExtensionContext["sessionManager"];
  interval: ReturnType<typeof setInterval>;
  refreshing?: Promise<void>;
  lastHtml?: string;
  revision: number;
  stopped: boolean;
};

const sessions = new Map<string, SessionState>();

async function runGit(args: string[], cwd: string): Promise<GitResult> {
  try {
    const { stdout } = await execFileAsync("git", ["--no-optional-locks", ...args], {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    return { ok: true, output: stdout.trim() };
  } catch {
    return { ok: false, output: "" };
  }
}

function sessionKey(ctx: PiWebExtensionContext) {
  return ctx.sessionManager.getSessionId?.() || ctx.sessionManager.getSessionFile?.() || ctx.cwd;
}

function sessionCwd(ctx: PiWebExtensionContext) {
  return ctx.sessionManager.getCwd?.() || ctx.cwd;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]!));
}

async function readSnapshot(cwd: string, git: GitRunner): Promise<GitSnapshot | null | undefined> {
  const repo = await git(["rev-parse", "--is-inside-work-tree"], cwd);
  if (!repo.ok) return undefined;
  if (repo.output !== "true") return null;

  const branchResult = await git(["branch", "--show-current"], cwd);
  if (!branchResult.ok) return undefined;
  let branch = branchResult.output;
  if (!branch) {
    const headResult = await git(["rev-parse", "--short", "HEAD"], cwd);
    if (!headResult.ok) return undefined;
    branch = headResult.output || "detached";
  }

  const statusResult = await git(["status", "--porcelain=v1", "--untracked-files=normal"], cwd);
  if (!statusResult.ok) return undefined;
  const lines = statusResult.output.split("\n").filter(Boolean);
  const counts = { added: 0, modified: 0, deleted: 0, untracked: 0 };

  for (const line of lines) {
    const code = line.slice(0, 2);
    if (code === "??") counts.untracked += 1;
    else {
      if (code.includes("A")) counts.added += 1;
      if (code.includes("M") || code.includes("R") || code.includes("C")) counts.modified += 1;
      if (code.includes("D")) counts.deleted += 1;
    }
  }

  return { branch, dirty: lines.length > 0, ...counts };
}

function formatDetails(snapshot: GitSnapshot) {
  const parts = [
    snapshot.added ? `+${snapshot.added}` : "",
    snapshot.modified ? `~${snapshot.modified}` : "",
    snapshot.deleted ? `-${snapshot.deleted}` : "",
    snapshot.untracked ? `?${snapshot.untracked}` : "",
  ].filter(Boolean);
  return parts.length ? ` (${parts.join(" ")})` : "";
}

async function renderFooter(cwd: string, git: GitRunner) {
  const snapshot = await readSnapshot(cwd, git);
  if (snapshot === undefined) return undefined;
  if (snapshot === null) {
    return `<div style="display:flex;justify-content:space-between;gap:16px;align-items:center;font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;color:#93a4b8">
      <span>🌿 <strong style="color:#e7edf5">no git repo</strong></span>
    </div>`;
  }

  const status = snapshot.dirty ? `dirty${formatDetails(snapshot)}` : "clean";
  const dirtyColor = snapshot.dirty ? "#facc15" : "#86efac";

  return `<div style="display:flex;justify-content:space-between;gap:16px;align-items:center;font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;color:#93a4b8">
    <span>🌿 <strong style="color:#e7edf5">${escapeHtml(snapshot.branch)}</strong></span>
    <span style="color:${dirtyColor}">● ${escapeHtml(status)}</span>
  </div>`;
}

export function createGitFooterExtension(options: {
  git?: GitRunner;
  refreshMs?: number;
} = {}) {
  const git = options.git || runGit;
  const refreshMs = options.refreshMs ?? REFRESH_MS;

  function refresh(state: SessionState) {
    if (state.stopped || state.refreshing) return;
    const revision = state.revision;
    const ctx = state.ctx;
    const key = sessionKey(ctx);
    state.refreshing = renderFooter(sessionCwd(ctx), git)
      .catch(() => undefined)
      .then((html) => {
        if (html === undefined
          || state.stopped
          || state.revision !== revision
          || sessions.get(key) !== state
          || state.lastHtml === html) return;
        state.lastHtml = html;
        ctx.ui.web.setFooter(FOOTER_KEY, { kind: "html", html });
      })
      .finally(() => {
        state.refreshing = undefined;
        if (!state.stopped && state.revision !== revision) refresh(state);
      });
  }

  function startRefreshing(ctx: PiWebExtensionContext) {
    const key = sessionKey(ctx);
    const existing = sessions.get(key);
    if (existing) {
      const runtimeChanged = existing.sessionManager !== ctx.sessionManager;
      existing.ctx = ctx;
      existing.sessionManager = ctx.sessionManager;
      if (runtimeChanged) {
        existing.lastHtml = undefined;
        existing.revision += 1;
      }
      refresh(existing);
      return;
    }

    const state: SessionState = {
      ctx,
      sessionManager: ctx.sessionManager,
      interval: setInterval(() => refresh(state), refreshMs),
      revision: 0,
      stopped: false,
    };
    sessions.set(key, state);
    refresh(state);
  }

  function stopRefreshing(ctx: PiWebExtensionContext) {
    const key = sessionKey(ctx);
    const state = sessions.get(key);
    if (!state || state.sessionManager !== ctx.sessionManager) return;
    state.stopped = true;
    clearInterval(state.interval);
    sessions.delete(key);
    ctx.ui.web.setFooter(FOOTER_KEY, undefined);
  }

  return function gitFooterExtension(pi: PiWebExtensionAPI) {
    const touch = (_event: unknown, ctx: PiWebExtensionContext) => startRefreshing(ctx);

    pi.on("session_start", touch);
    pi.on("turn_start", touch);
    pi.on("turn_end", touch);
    pi.on("input", touch);
    pi.on("user_bash", touch);
    pi.on("session_before_compact", touch);
    pi.on("session_compact", touch);
    pi.on("session_before_switch", touch);
    pi.on("session_shutdown", (_event, ctx) => stopRefreshing(ctx));
  };
}

export default createGitFooterExtension();
