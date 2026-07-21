import { execFileSync } from "node:child_process";
import type { PiWebExtensionAPI, PiWebExtensionContext } from "@ashwin-pc/pi-web/extensions";

const FOOTER_KEY = "local-git-footer";
const REFRESH_MS = 2_500;

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
  lastHtml?: string;
};

const sessions = new Map<string, SessionState>();

function git(args: string[], cwd: string) {
  try {
    return execFileSync("git", ["--no-optional-locks", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
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

function readSnapshot(cwd: string): GitSnapshot | undefined {
  if (git(["rev-parse", "--is-inside-work-tree"], cwd) !== "true") return undefined;

  const branch = git(["branch", "--show-current"], cwd)
    || git(["rev-parse", "--short", "HEAD"], cwd)
    || "detached";
  const lines = git(["status", "--porcelain=v1", "--untracked-files=normal"], cwd).split("\n").filter(Boolean);
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

function renderFooter(cwd: string) {
  const snapshot = readSnapshot(cwd);
  if (!snapshot) {
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

function refresh(ctx: PiWebExtensionContext) {
  const key = sessionKey(ctx);
  const state = sessions.get(key);
  const latestCtx = state?.ctx || ctx;
  const html = renderFooter(sessionCwd(latestCtx));
  if (state?.lastHtml === html) return;
  if (state) state.lastHtml = html;
  latestCtx.ui.web.setFooter(FOOTER_KEY, { kind: "html", html });
}

function startRefreshing(ctx: PiWebExtensionContext) {
  const key = sessionKey(ctx);
  const existing = sessions.get(key);
  if (existing) {
    const runtimeChanged = existing.sessionManager !== ctx.sessionManager;
    existing.ctx = ctx;
    existing.sessionManager = ctx.sessionManager;
    if (runtimeChanged) existing.lastHtml = undefined;
    refresh(ctx);
    return;
  }

  const state: SessionState = {
    ctx,
    sessionManager: ctx.sessionManager,
    interval: setInterval(() => refresh(state.ctx), REFRESH_MS),
  };
  sessions.set(key, state);
  refresh(ctx);
}

function stopRefreshing(ctx: PiWebExtensionContext) {
  const key = sessionKey(ctx);
  const state = sessions.get(key);
  if (!state || state.sessionManager !== ctx.sessionManager) return;
  clearInterval(state.interval);
  sessions.delete(key);
  ctx.ui.web.setFooter(FOOTER_KEY, undefined);
}

export default function (pi: PiWebExtensionAPI) {
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
}
