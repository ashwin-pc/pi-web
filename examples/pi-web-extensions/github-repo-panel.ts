import type { PiWebExtensionAPI, PiWebExtensionContext, PiWebGitTabEvent } from "@ashwin-pc/pi-web/extensions";

const GIT_TAB_KEY = "github";
const LIST_LIMIT = 50;
const COMMAND_TIMEOUT_MS = 15_000;
const MARKDOWN_TIMEOUT_MS = 20_000;

type RepoInfo = {
  remote: string;
  owner: string;
  name: string;
  host: string;
  ghRepo: string;
  nameWithOwner: string;
  url: string;
};

type GhUser = { login?: string; name?: string };
type GhLabel = { name?: string; color?: string };
type GhComment = { author?: GhUser; body?: string; createdAt?: string; url?: string };
type RenderedGhComment = GhComment & { bodyHtml: string };

type GhIssue = {
  number?: number;
  title?: string;
  url?: string;
  author?: GhUser;
  body?: string;
  labels?: GhLabel[];
  assignees?: GhUser[];
  comments?: GhComment[];
  createdAt?: string;
  updatedAt?: string;
  state?: string;
};

type GhPullRequest = GhIssue & {
  headRefName?: string;
  baseRefName?: string;
  isDraft?: boolean;
  reviewDecision?: string | null;
  mergeStateStatus?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
};

type ListResult<T> = {
  items: T[];
  error?: string;
};

type Tab = "prs" | "issues";
type ItemKind = "pr" | "issue";

const installedSessions = new Set<string>();

function sessionKey(ctx: PiWebExtensionContext) {
  return ctx.sessionManager.getSessionId?.() || ctx.sessionManager.getSessionFile?.() || ctx.cwd;
}

function sessionCwd(ctx: PiWebExtensionContext) {
  return ctx.sessionManager.getCwd?.() || ctx.cwd;
}

function stripAnsi(value: string) {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function compactError(value: string) {
  const cleaned = stripAnsi(value).replace(/\s+/g, " ").trim();
  return cleaned.length > 260 ? `${cleaned.slice(0, 257)}…` : cleaned;
}

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]!));
}

function attr(value: unknown) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function actionPayload(value: unknown) {
  return attr(JSON.stringify(value));
}

function relativeTime(value?: string) {
  if (!value) return "";
  const then = Date.parse(value);
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(1, Math.floor((Date.now() - then) / 1000));
  const units: Array<[number, string]> = [
    [365 * 24 * 60 * 60, "y"],
    [30 * 24 * 60 * 60, "mo"],
    [7 * 24 * 60 * 60, "w"],
    [24 * 60 * 60, "d"],
    [60 * 60, "h"],
    [60, "m"],
  ];
  for (const [unitSeconds, suffix] of units) {
    if (seconds >= unitSeconds) return `${Math.floor(seconds / unitSeconds)}${suffix} ago`;
  }
  return `${seconds}s ago`;
}

async function exec(pi: PiWebExtensionAPI, cwd: string, command: string, args: string[], timeout = COMMAND_TIMEOUT_MS) {
  return pi.exec(command, args, { cwd, timeout });
}

async function git(pi: PiWebExtensionAPI, cwd: string, args: string[]) {
  const result = await exec(pi, cwd, "git", ["--no-optional-locks", ...args], 5_000);
  return result.code === 0 ? result.stdout.trim() : "";
}

function parseGithubRemoteUrl(remote: string, url: string): RepoInfo | undefined {
  const raw = url.trim();
  if (!raw) return undefined;

  let host = "";
  let owner = "";
  let repo = "";

  const scpLike = raw.match(/^(?:[^@\s]+@)?([^:\s]+):([^\s/]+)\/(.+?)\/?(?:\.git)?$/);
  if (scpLike && !raw.includes("://")) {
    host = scpLike[1] || "";
    owner = scpLike[2] || "";
    repo = scpLike[3] || "";
  } else {
    try {
      const parsed = new URL(raw);
      host = parsed.hostname;
      const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
      owner = parts[0] || "";
      repo = parts[1] || "";
    } catch {
      return undefined;
    }
  }

  host = host.toLowerCase();
  repo = repo.replace(/\.git$/i, "");
  if (host !== "github.com") return undefined;
  if (!owner || !repo) return undefined;

  const nameWithOwner = `${owner}/${repo}`;
  return {
    remote,
    owner,
    name: repo,
    host,
    ghRepo: nameWithOwner,
    nameWithOwner,
    url: `https://${host}/${nameWithOwner}`,
  };
}

async function findGithubRepo(pi: PiWebExtensionAPI, cwd: string): Promise<RepoInfo | undefined> {
  if ((await git(pi, cwd, ["rev-parse", "--is-inside-work-tree"])) !== "true") return undefined;

  const remoteConfig = await git(pi, cwd, ["config", "--get-regexp", "^remote\\..*\\.url$"]);
  const remotes = remoteConfig.split("\n")
    .map((line) => {
      const match = line.match(/^remote\.([^.]+)\.url\s+(.+)$/);
      if (!match) return undefined;
      return parseGithubRemoteUrl(match[1], match[2]);
    })
    .filter((repo): repo is RepoInfo => Boolean(repo));

  return remotes.find((repo) => repo.remote === "origin") || remotes[0];
}

async function ghJson<T>(pi: PiWebExtensionAPI, cwd: string, args: string[]): Promise<{ items?: T; error?: string }> {
  try {
    const result = await exec(pi, cwd, "gh", args);
    if (result.code !== 0) {
      return { error: compactError(result.stderr || result.stdout || `gh ${args.join(" ")} failed`) };
    }
    return { items: JSON.parse(result.stdout || "null") as T };
  } catch (error) {
    return { error: compactError(error instanceof Error ? error.message : String(error)) };
  }
}

async function listIssues(pi: PiWebExtensionAPI, cwd: string, repo: RepoInfo): Promise<ListResult<GhIssue>> {
  const result = await ghJson<GhIssue[]>(pi, cwd, [
    "issue", "list",
    "--repo", repo.ghRepo,
    "--state", "open",
    "--limit", String(LIST_LIMIT),
    "--json", "number,title,url,author,labels,assignees,comments,updatedAt,createdAt",
  ]);
  return { items: result.items || [], error: result.error };
}

async function listPullRequests(pi: PiWebExtensionAPI, cwd: string, repo: RepoInfo): Promise<ListResult<GhPullRequest>> {
  const result = await ghJson<GhPullRequest[]>(pi, cwd, [
    "pr", "list",
    "--repo", repo.ghRepo,
    "--state", "open",
    "--limit", String(LIST_LIMIT),
    "--json", "number,title,url,author,headRefName,baseRefName,isDraft,reviewDecision,comments,updatedAt,createdAt",
  ]);
  return { items: result.items || [], error: result.error };
}

async function viewIssue(pi: PiWebExtensionAPI, cwd: string, repo: RepoInfo, number: number) {
  return ghJson<GhIssue>(pi, cwd, [
    "issue", "view", String(number),
    "--repo", repo.ghRepo,
    "--json", "number,title,url,author,body,labels,assignees,comments,createdAt,updatedAt,state",
  ]);
}

async function viewPullRequest(pi: PiWebExtensionAPI, cwd: string, repo: RepoInfo, number: number) {
  return ghJson<GhPullRequest>(pi, cwd, [
    "pr", "view", String(number),
    "--repo", repo.ghRepo,
    "--json", "number,title,url,author,body,labels,assignees,comments,createdAt,updatedAt,state,headRefName,baseRefName,isDraft,reviewDecision,mergeStateStatus,additions,deletions,changedFiles",
  ]);
}

const markdownCache = new Map<string, string>();

function fallbackMarkdownHtml(markdown: string) {
  return `<div class="ghMarkdownFallback">${escapeHtml(markdown)}</div>`;
}

function normalizeMarkdownText(markdown: string | undefined) {
  const text = String(markdown || "");
  return !text.includes("\n") && text.includes("\\n")
    ? text.replace(/\\r\\n|\\n/g, "\n")
    : text;
}

async function renderGithubMarkdown(pi: PiWebExtensionAPI, cwd: string, repo: RepoInfo, markdown: string | undefined) {
  const text = normalizeMarkdownText(markdown);
  if (!text.trim()) return "";

  const cacheKey = `${repo.ghRepo}\0${text}`;
  const cached = markdownCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let html = "";
  try {
    const result = await exec(pi, cwd, "gh", [
      "api", "markdown",
      "--method", "POST",
      "-f", `text=${text}`,
      "-f", "mode=gfm",
      "-f", `context=${repo.ghRepo}`,
    ], MARKDOWN_TIMEOUT_MS);
    html = result.code === 0 && result.stdout.trim()
      ? result.stdout.trim()
      : fallbackMarkdownHtml(text);
  } catch {
    html = fallbackMarkdownHtml(text);
  }

  if (markdownCache.size > 200) markdownCache.clear();
  markdownCache.set(cacheKey, html);
  return html;
}

function styles() {
  return `<style>
    .ghPanel { --ghPanePad:12px; display:flex; flex-direction:column; gap:8px; min-height:100%; min-width:0; max-width:100%; font-size:13px; line-height:1.32; }
    .ghPanel, .ghPanel * { box-sizing:border-box; }
    .ghTop { display:flex; justify-content:space-between; gap:8px; align-items:flex-start; min-width:0; }
    .ghRepo { min-width:0; }
    .ghRepoName { font-weight:700; color:var(--text); overflow-wrap:anywhere; word-break:break-word; }
    .ghRepoMeta { color:var(--muted); font-size:11px; margin-top:1px; }
    .ghOpenLink { color:var(--accent); text-decoration:none; font-size:11px; white-space:nowrap; }
    .ghPanel button { border:1px solid var(--border); border-radius:7px; background:color-mix(in srgb, var(--panel) 82%, var(--text) 8%); color:var(--text); cursor:pointer; font:inherit; }
    .ghPanel button:hover { border-color:color-mix(in srgb, var(--accent) 55%, var(--border)); }
    .ghTabs { display:grid; grid-template-columns:1fr 1fr; gap:5px; min-width:0; }
    .ghTab { padding:6px 8px; color:var(--muted); min-width:0; white-space:normal; }
    .ghTab.active { color:var(--text); border-color:color-mix(in srgb, var(--accent) 60%, var(--border)); background:color-mix(in srgb, var(--accent) 14%, transparent); }
    .ghToolbar { display:flex; justify-content:space-between; align-items:center; gap:8px; color:var(--muted); font-size:11px; min-width:0; }
    .ghToolbar > span { min-width:0; overflow-wrap:anywhere; }
    .ghRefresh, .ghBack { padding:4px 7px; color:var(--muted); }
    .ghTableWrap { margin:0 calc(-1 * var(--ghPanePad)); border-top:1px solid var(--border); border-bottom:1px solid var(--border); overflow:hidden; min-width:0; }
    .ghTable { width:100%; table-layout:fixed; border-collapse:collapse; border-spacing:0; }
    .ghTable th, .ghTable td { min-width:0; padding:6px 8px; border-bottom:1px solid var(--border); vertical-align:top; text-align:left; white-space:normal; overflow-wrap:anywhere; word-break:break-word; }
    .ghTable th:first-child, .ghTable td:first-child { padding-left:var(--ghPanePad); }
    .ghTable th:last-child, .ghTable td:last-child { padding-right:var(--ghPanePad); }
    .ghTable tbody tr:last-child td { border-bottom:0; }
    .ghTable thead th { color:var(--muted); font-size:10px; font-weight:650; letter-spacing:.06em; text-transform:uppercase; background:color-mix(in srgb, var(--panel) 88%, var(--text) 4%); }
    .ghRow { cursor:pointer; }
    .ghRow:hover td { background:var(--panel-2); }
    .ghColNumber { width:48px; }
    .ghColWho { width:84px; }
    .ghColUpdated { width:68px; }
    .ghNumberCell { color:var(--muted); font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:11px; }
    .ghPanel .ghNumberButton { border:0; background:transparent; border-radius:4px; padding:1px 2px; color:var(--accent); font-family:inherit; font-size:inherit; }
    .ghPanel .ghNumberButton:hover { border:0; background:color-mix(in srgb, var(--accent) 14%, transparent); text-decoration:underline; }
    .ghTitleCell { width:auto; }
    .ghWhoCell, .ghUpdatedCell { color:var(--muted); font-size:11px; }
    .ghRowTitle { display:block; max-width:100%; font-weight:650; color:var(--text); overflow-wrap:anywhere; word-break:break-word; }
    .ghRowSub { margin-top:2px; display:flex; flex-wrap:wrap; gap:3px 5px; min-width:0; color:var(--muted); font-size:10px; }
    .ghRowSub > span, .ghDetailMeta > span { min-width:0; max-width:100%; overflow-wrap:anywhere; word-break:break-word; }
    .ghDetailMeta { display:flex; flex-wrap:wrap; gap:4px 6px; min-width:0; color:var(--muted); font-size:11px; }
    .ghPill { display:inline-flex; align-items:center; max-width:100%; border:1px solid var(--border); border-radius:999px; padding:0 5px; font-size:10px; color:var(--muted); white-space:normal; overflow-wrap:anywhere; }
    .ghPill.draft { color:#fde68a; border-color:color-mix(in srgb, #facc15 45%, transparent); }
    .ghPill.review { color:#bfdbfe; border-color:color-mix(in srgb, #60a5fa 45%, transparent); }
    .ghLabel { color:#c4b5fd; border-color:color-mix(in srgb, #a78bfa 45%, transparent); }
    .ghEmpty, .ghError { border:1px dashed var(--border); border-radius:9px; padding:10px; color:var(--muted); }
    .ghError { color:var(--danger); border-color:color-mix(in srgb, var(--danger) 45%, transparent); background:color-mix(in srgb, var(--danger) 8%, transparent); }
    .ghDetail { display:flex; flex-direction:column; gap:9px; min-width:0; }
    .ghDetailHeader { display:flex; flex-direction:column; gap:5px; min-width:0; }
    .ghDetailTitle { margin:0; font-size:16px; line-height:1.25; overflow-wrap:anywhere; word-break:break-word; }
    .ghDetailActions { display:flex; justify-content:space-between; gap:8px; align-items:center; min-width:0; }
    .ghBody, .ghComment { overflow-wrap:anywhere; border:1px solid var(--border); border-radius:9px; padding:9px; background:color-mix(in srgb, var(--panel) 90%, var(--text) 5%); }
    .ghBody.empty { color:var(--muted); font-style:italic; white-space:pre-wrap; }
    .ghComments { display:flex; flex-direction:column; gap:6px; min-width:0; }
    .ghComments h3 { margin:4px 0 0; font-size:13px; }
    .ghCommentHeader { color:var(--muted); font-size:11px; margin-bottom:4px; }
    .ghCommentBody { min-width:0; }
    .ghMarkdown { color:var(--text); white-space:normal; }
    .ghMarkdown > :first-child { margin-top:0; }
    .ghMarkdown > :last-child { margin-bottom:0; }
    .ghMarkdown p, .ghMarkdown ul, .ghMarkdown ol, .ghMarkdown pre, .ghMarkdown blockquote, .ghMarkdown table { margin:0 0 8px; }
    .ghMarkdown h1, .ghMarkdown h2, .ghMarkdown h3, .ghMarkdown h4, .ghMarkdown h5, .ghMarkdown h6 { margin:10px 0 6px; line-height:1.2; }
    .ghMarkdown h1 { font-size:18px; }
    .ghMarkdown h2 { font-size:16px; }
    .ghMarkdown h3 { font-size:14px; }
    .ghMarkdown ul, .ghMarkdown ol { padding-left:20px; }
    .ghMarkdown li + li { margin-top:2px; }
    .ghMarkdown blockquote { padding-left:10px; border-left:3px solid var(--border); color:var(--muted); }
    .ghMarkdown pre { max-width:100%; overflow:auto; white-space:pre; padding:8px; border-radius:8px; background:color-mix(in srgb, var(--panel) 84%, black); }
    .ghMarkdown code { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:.92em; overflow-wrap:anywhere; }
    .ghMarkdown :not(pre) > code { padding:1px 4px; border-radius:4px; background:color-mix(in srgb, var(--panel) 82%, var(--text) 8%); }
    .ghMarkdown pre code { padding:0; background:transparent; white-space:pre; overflow-wrap:normal; }
    .ghMarkdown table { display:block; max-width:100%; overflow:auto; border-collapse:collapse; }
    .ghMarkdown th, .ghMarkdown td { border:1px solid var(--border); padding:4px 6px; }
    .ghMarkdown img { max-width:100%; height:auto; }
    .ghMarkdown a { color:var(--accent); }
    .ghMarkdownFallback { white-space:pre-wrap; overflow-wrap:anywhere; }
    @media (max-width:760px) {
      .ghPanel { --ghPanePad:10px; }
      .ghDetailActions { flex-wrap:wrap; }
    }
  </style>`;
}

function tabButton(tab: Tab, active: Tab, label: string, count?: number) {
  return `<button type="button" class="ghTab${tab === active ? " active" : ""}" data-web-git-tab-action="tab" data-web-git-tab-payload="${actionPayload({ tab })}">${escapeHtml(label)}${typeof count === "number" ? ` <span class="ghCount">${count}</span>` : ""}</button>`;
}

function shell(repo: RepoInfo, active: Tab, body: string, counts?: { prs?: number; issues?: number }) {
  return `${styles()}<div class="ghPanel">
    <div class="ghTop">
      <div class="ghRepo">
        <div class="ghRepoName">${escapeHtml(repo.nameWithOwner)}</div>
        <div class="ghRepoMeta">remote ${escapeHtml(repo.remote)} · fetched with gh</div>
      </div>
      <a class="ghOpenLink" href="${attr(repo.url)}" target="_blank" rel="noreferrer">Open GitHub ↗</a>
    </div>
    <div class="ghTabs" role="tablist" aria-label="GitHub views">
      ${tabButton("prs", active, "Pull requests", counts?.prs)}
      ${tabButton("issues", active, "Issues", counts?.issues)}
    </div>
    ${body}
  </div>`;
}

function userLabel(user?: GhUser) {
  return user?.login ? `@${escapeHtml(user.login)}` : "unknown";
}

function labelsHtml(labels?: GhLabel[]) {
  return (labels || []).slice(0, 4).map((label) => label.name ? `<span class="ghPill ghLabel">${escapeHtml(label.name)}</span>` : "").join("");
}

function issueRow(issue: GhIssue) {
  const number = Number(issue.number || 0);
  const payload = actionPayload({ kind: "issue", number, tab: "issues" });
  const updated = relativeTime(issue.updatedAt);
  const assignees = (issue.assignees || []).map((user) => user.login).filter(Boolean).slice(0, 3).map((login) => `@${escapeHtml(login)}`).join(", ");
  const sub = [
    assignees ? `<span>assigned ${assignees}</span>` : "",
    labelsHtml(issue.labels),
  ].filter(Boolean).join("");
  return `<tr class="ghRow" role="button" tabindex="0" data-web-git-tab-action="open" data-web-git-tab-payload="${payload}">
    <td class="ghNumberCell"><button type="button" class="ghNumberButton" title="Add issue #${number} to composer context" aria-label="Add issue #${number} to composer context" data-web-git-tab-action="attach-context" data-web-git-tab-payload="${payload}">#${number}</button></td>
    <td class="ghTitleCell"><span class="ghRowTitle">${escapeHtml(issue.title || "Untitled issue")}</span>${sub ? `<div class="ghRowSub">${sub}</div>` : ""}</td>
    <td class="ghWhoCell">${userLabel(issue.author)}</td>
    <td class="ghUpdatedCell">${updated ? escapeHtml(updated) : ""}</td>
  </tr>`;
}

function prRow(pr: GhPullRequest) {
  const number = Number(pr.number || 0);
  const payload = actionPayload({ kind: "pr", number, tab: "prs" });
  const updated = relativeTime(pr.updatedAt);
  const branch = pr.headRefName && pr.baseRefName ? `${pr.headRefName} → ${pr.baseRefName}` : "";
  const review = pr.reviewDecision ? pr.reviewDecision.toLowerCase().replace(/_/g, " ") : "";
  const sub = [
    branch ? `<span>${escapeHtml(branch)}</span>` : "",
    pr.isDraft ? `<span class="ghPill draft">draft</span>` : "",
    review ? `<span class="ghPill review">${escapeHtml(review)}</span>` : "",
  ].filter(Boolean).join("");
  return `<tr class="ghRow" role="button" tabindex="0" data-web-git-tab-action="open" data-web-git-tab-payload="${payload}">
    <td class="ghNumberCell"><button type="button" class="ghNumberButton" title="Add pull request #${number} to composer context" aria-label="Add pull request #${number} to composer context" data-web-git-tab-action="attach-context" data-web-git-tab-payload="${payload}">#${number}</button></td>
    <td class="ghTitleCell"><span class="ghRowTitle">${escapeHtml(pr.title || "Untitled pull request")}</span>${sub ? `<div class="ghRowSub">${sub}</div>` : ""}</td>
    <td class="ghWhoCell">${userLabel(pr.author)}</td>
    <td class="ghUpdatedCell">${updated ? escapeHtml(updated) : ""}</td>
  </tr>`;
}

function listHeader(tab: Tab) {
  return `<thead><tr>
    <th class="ghColNumber" scope="col">#</th>
    <th scope="col">${tab === "prs" ? "Pull request" : "Issue"}</th>
    <th class="ghColWho" scope="col">Author</th>
    <th class="ghColUpdated" scope="col">Updated</th>
  </tr></thead>`;
}

function listBody<T>(tab: Tab, result: ListResult<T>, formatter: (item: T) => string) {
  const title = tab === "prs" ? "Open pull requests" : "Open issues";
  const refreshPayload = actionPayload({ tab });
  return `<div class="ghToolbar">
      <span>${title}</span>
      <button type="button" class="ghRefresh" data-web-git-tab-action="tab" data-web-git-tab-payload="${refreshPayload}">Refresh</button>
    </div>
    ${result.error ? `<div class="ghError">${escapeHtml(result.error)}</div>` : ""}
    ${result.items.length ? `<div class="ghTableWrap"><table class="ghTable">${listHeader(tab)}<tbody>${result.items.map(formatter).join("")}</tbody></table></div>` : `<div class="ghEmpty">No open ${tab === "prs" ? "pull requests" : "issues"} found.</div>`}`;
}

function commentsHtml(comments?: RenderedGhComment[]) {
  if (!comments?.length) return "";
  return `<section class="ghComments"><h3>Comments</h3>${comments.map((comment) => `<article class="ghComment">
    <div class="ghCommentHeader">${userLabel(comment.author)}${comment.createdAt ? ` · ${escapeHtml(relativeTime(comment.createdAt))}` : ""}</div>
    <div class="ghCommentBody ghMarkdown">${comment.bodyHtml || fallbackMarkdownHtml(comment.body || "")}</div>
  </article>`).join("")}</section>`;
}

async function detailBody(pi: PiWebExtensionAPI, cwd: string, repo: RepoInfo, kind: ItemKind, item: GhIssue | GhPullRequest, previousTab: Tab) {
  const number = Number(item.number || 0);
  const isPr = kind === "pr";
  const pr = item as GhPullRequest;
  const meta = [
    item.state ? escapeHtml(item.state) : "open",
    userLabel(item.author),
    item.createdAt ? `created ${escapeHtml(relativeTime(item.createdAt))}` : "",
    item.updatedAt ? `updated ${escapeHtml(relativeTime(item.updatedAt))}` : "",
    isPr && pr.headRefName && pr.baseRefName ? escapeHtml(`${pr.headRefName} → ${pr.baseRefName}`) : "",
    isPr && pr.isDraft ? `<span class="ghPill draft">draft</span>` : "",
    isPr && pr.reviewDecision ? `<span class="ghPill review">${escapeHtml(pr.reviewDecision.toLowerCase().replace(/_/g, " "))}</span>` : "",
    isPr && typeof pr.changedFiles === "number" ? `${pr.changedFiles} files` : "",
    isPr && typeof pr.additions === "number" && typeof pr.deletions === "number" ? `+${pr.additions} −${pr.deletions}` : "",
  ].filter(Boolean).join("<span>·</span>");

  const hasBody = Boolean(item.body?.trim());
  const [bodyHtml, renderedComments] = await Promise.all([
    hasBody ? renderGithubMarkdown(pi, cwd, repo, item.body) : Promise.resolve(""),
    Promise.all((item.comments || []).map(async (comment) => ({
      ...comment,
      bodyHtml: await renderGithubMarkdown(pi, cwd, repo, comment.body),
    }))),
  ]);

  return `<div class="ghDetail">
    <div class="ghDetailActions">
      <button type="button" class="ghBack" data-web-git-tab-action="tab" data-web-git-tab-payload="${actionPayload({ tab: previousTab })}">← Back</button>
      ${item.url ? `<a class="ghOpenLink" href="${attr(item.url)}" target="_blank" rel="noreferrer">Open on GitHub ↗</a>` : ""}
    </div>
    <header class="ghDetailHeader">
      <h2 class="ghDetailTitle">#${number} ${escapeHtml(item.title || (isPr ? "Pull request" : "Issue"))}</h2>
      <div class="ghDetailMeta">${meta}</div>
      <div class="ghDetailMeta">${labelsHtml(item.labels)}</div>
    </header>
    <section class="ghBody ${hasBody ? "ghMarkdown" : "empty"}">${hasBody ? bodyHtml : "No description."}</section>
    ${commentsHtml(renderedComments)}
  </div>`;
}

function requestedTab(event?: PiWebGitTabEvent): Tab {
  const payload = event?.payload && typeof event.payload === "object" ? event.payload as { tab?: unknown } : {};
  return payload.tab === "issues" ? "issues" : "prs";
}

function itemRequest(event: PiWebGitTabEvent | undefined, action: "open" | "attach-context"): { kind: ItemKind; number: number; tab: Tab } | undefined {
  if (event?.action !== action || !event.payload || typeof event.payload !== "object") return undefined;
  const payload = event.payload as { kind?: unknown; number?: unknown; tab?: unknown };
  const kind: ItemKind | undefined = payload.kind === "issue" ? "issue" : payload.kind === "pr" ? "pr" : undefined;
  const number = typeof payload.number === "number" ? payload.number : Number(payload.number);
  if (!kind || !Number.isInteger(number) || number <= 0) return undefined;
  return { kind, number, tab: payload.tab === "issues" ? "issues" : "prs" };
}

function composerContext(repo: RepoInfo, kind: ItemKind, item: GhIssue | GhPullRequest) {
  const number = Number(item.number || 0);
  const isPr = kind === "pr";
  return {
    type: "reference" as const,
    id: `github:${repo.nameWithOwner}:${kind}:${number}`,
    label: `${isPr ? "GitHub PR" : "GitHub issue"} #${number}`,
    title: item.title || (isPr ? "Untitled pull request" : "Untitled issue"),
    reference: {
      provider: "github" as const,
      repository: repo.nameWithOwner,
      resource: isPr ? "pull-request" as const : "issue" as const,
      number,
      url: `https://github.com/${repo.nameWithOwner}/${isPr ? "pull" : "issues"}/${number}`,
    },
  };
}

async function renderGitTab(pi: PiWebExtensionAPI, ctx: PiWebExtensionContext, event?: PiWebGitTabEvent) {
  const cwd = event?.repo?.root || sessionCwd(ctx);
  const repo = await findGithubRepo(pi, cwd);
  if (!repo) return { title: "GitHub", html: `${styles()}<div class="ghEmpty">No GitHub remote was found for this repository.</div>` };

  const request = itemRequest(event, "open") || itemRequest(event, "attach-context");
  if (request) {
    const result = request.kind === "pr"
      ? await viewPullRequest(pi, cwd, repo, request.number)
      : await viewIssue(pi, cwd, repo, request.number);
    if (result.error || !result.items) {
      return { title: "GitHub", html: shell(repo, request.tab, `<div class="ghError">${escapeHtml(result.error || "Item not found")}</div>`) };
    }
    if (event?.action === "attach-context") {
      return { composerContext: composerContext(repo, request.kind, result.items) };
    }
    const title = `${request.kind === "pr" ? "PR" : "Issue"} #${request.number}`;
    return { title, html: shell(repo, request.tab, await detailBody(pi, cwd, repo, request.kind, result.items, request.tab)) };
  }

  const tab = event?.action === "tab" ? requestedTab(event) : "prs";
  const [prs, issues] = await Promise.all([
    listPullRequests(pi, cwd, repo),
    listIssues(pi, cwd, repo),
  ]);
  const body = tab === "prs" ? listBody("prs", prs, prRow) : listBody("issues", issues, issueRow);
  return {
    title: "GitHub",
    html: shell(repo, tab, body, { prs: prs.items.length, issues: issues.items.length }),
  };
}

async function updateGitTab(pi: PiWebExtensionAPI, ctx: PiWebExtensionContext) {
  const key = sessionKey(ctx);
  const repo = await findGithubRepo(pi, sessionCwd(ctx)).catch(() => undefined);
  const web = ctx.ui.web;

  if (!repo) {
    if (installedSessions.has(key)) {
      web.contribute(GIT_TAB_KEY, undefined);
      installedSessions.delete(key);
    }
    return;
  }

  installedSessions.add(key);
  web.contribute(GIT_TAB_KEY, {
    slot: "git-tab",
    kind: "rendered",
    title: `GitHub issues and pull requests for ${repo.nameWithOwner}`,
    label: "GitHub",
    render: (event) => renderGitTab(pi, ctx, {
      action: event?.action,
      payload: event?.payload,
      repo: event?.context as PiWebGitTabEvent["repo"],
    }),
  });
}

function scheduleStartupUpdate(pi: PiWebExtensionAPI, ctx: PiWebExtensionContext) {
  void updateGitTab(pi, ctx);
  setTimeout(() => void updateGitTab(pi, ctx), 0);
}

export default function githubRepoPanel(pi: PiWebExtensionAPI) {
  const startup = (_event: unknown, ctx: PiWebExtensionContext) => scheduleStartupUpdate(pi, ctx);
  const touch = (_event: unknown, ctx: PiWebExtensionContext) => void updateGitTab(pi, ctx);

  pi.on("session_start", startup);
  pi.on("input", touch);
  pi.on("user_bash", touch);
  pi.on("turn_end", touch);
  pi.on("session_compact", touch);

  pi.on("session_shutdown", (_event, ctx) => {
    const key = sessionKey(ctx);
    if (installedSessions.has(key)) {
      ctx.ui.web.contribute(GIT_TAB_KEY, undefined);
      installedSessions.delete(key);
    }
  });
}
