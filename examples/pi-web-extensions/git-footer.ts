import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PiWebExtensionAPI, PiWebExtensionContext } from "@ashwin-pc/pi-web/extensions";

const FOOTER_KEY = "local-git-footer";
const REFRESH_MS = 2_500;
const GIT_TIMEOUT_MS = 1_000;
const CACHE_TTL_MS = 1_000;
const COMPARISON_COOLDOWN_MS = 30_000;
const MAX_CACHE_ENTRIES = 128;
const FETCH_INTERVAL_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const execFileAsync = promisify(execFile);

type GitResult = {
  ok: boolean;
  output: string;
  notRepo?: boolean;
};

type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

type GitSnapshot = {
  branch: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
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

type CacheEntry = { pending?: Promise<string | undefined>; html?: string; expires: number };
type FooterCache = Map<string, CacheEntry>;
// Extension modules can be loaded separately for each runtime. Keep the default
// runner's cache process-wide, including across those independent module loads.
const cacheKey = Symbol.for("pi-web.git-footer.cache.v1");
const sharedGlobal = globalThis as typeof globalThis & {
  [cacheKey]?: { default: FooterCache; custom: WeakMap<GitRunner, FooterCache>; fallbackUntil?: Map<string, number> };
};
const caches = sharedGlobal[cacheKey] ??= { default: new Map(), custom: new WeakMap(), fallbackUntil: new Map<string, number>() };
const fallbackUntil = caches.fallbackUntil ??= new Map<string, number>();

function cacheFor(git: GitRunner): FooterCache {
  if (git === runGit) return caches.default;
  let cache = caches.custom.get(git);
  if (!cache) caches.custom.set(git, cache = new Map());
  return cache;
}

async function runGit(args: string[], cwd: string): Promise<GitResult> {
  const skipComparison = (fallbackUntil.get(cwd) ?? 0) > Date.now();
  if (!skipComparison) fallbackUntil.delete(cwd);
  try {
    const { stdout } = await execFileAsync("git", ["--no-optional-locks", ...args, ...(skipComparison ? ["--no-ahead-behind"] : [])], {
      cwd,
      env: { ...process.env, LC_ALL: "C" },
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, output: stdout };
  } catch (error) {
    const failure = error as { stderr?: string; killed?: boolean; signal?: string };
    if (!skipComparison && (failure.killed || failure.signal === "SIGKILL")) {
      // Keep one subprocess per refresh: the next refresh recovers branch/dirty
      // state without the expensive commit walk, then retry counts after a pause.
      for (const [key, until] of fallbackUntil) {
        if (until <= Date.now() || fallbackUntil.size >= MAX_CACHE_ENTRIES) fallbackUntil.delete(key);
      }
      fallbackUntil.set(cwd, Date.now() + COMPARISON_COOLDOWN_MS);
    }
    const stderr = failure.stderr || "";
    return { ok: false, output: "", notRepo: stderr.includes("not a git repository") || stderr.includes("must be run in a work tree") };
  }
}

// Separate from status: network work must never block a footer refresh or enter
// the status timeout/comparison fallback path. Symbol state survives /reload.
type FetchEntry = { pending?: Promise<void>; next: number; failures: number };
type FetchState = { cwd: Map<string, FetchEntry>; repositories: Map<string, FetchEntry>; active?: number };
const fetchKey = Symbol.for("pi-web.git-footer.fetch.v1");
const fetchGlobal = globalThis as typeof globalThis & {
  [fetchKey]?: { default: FetchState; custom: WeakMap<GitRunner, FetchState> };
};
const fetchStates: { default: FetchState; custom: WeakMap<GitRunner, FetchState> } = fetchGlobal[fetchKey] ??= {
  default: { cwd: new Map(), repositories: new Map() }, custom: new WeakMap(),
};

async function runFetchGit(args: string[], cwd: string): Promise<GitResult> {
  try {
    let defaultSsh = false;
    if (args.includes("fetch") && !process.env.GIT_SSH_COMMAND && !process.env.GIT_SSH) {
      try {
        const configured = await execFileAsync("git", ["config", "--get", "core.sshCommand"], {
          cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: 65536,
        });
        defaultSsh = !configured.stdout.trim();
      } catch (error) {
        // Exit 1 means no configured value; other failures abort this attempt.
        if ((error as { code?: number }).code !== 1) throw error;
        defaultSsh = true;
      }
    }
    const { stdout } = await execFileAsync("git", args, {
      cwd, encoding: "utf8", timeout: FETCH_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
      env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never",
        GIT_ASKPASS: "", SSH_ASKPASS: "",
        // Respect trusted custom identities/proxies/wrappers. Default OpenSSH
        // is bounded and batch-only; custom transports retain the process timeout.
        ...(defaultSsh ? { GIT_SSH_COMMAND: "ssh -oBatchMode=yes -oConnectTimeout=10" } : {}) },
    });
    return { ok: true, output: stdout };
  } catch { return { ok: false, output: "" }; }
}

function scheduleFetch(cwd: string, branch: string, upstream: string, git: GitRunner, statusGit: GitRunner) {
  let state = git === runFetchGit ? fetchStates.default : fetchStates.custom.get(git);
  if (!state) fetchStates.custom.set(git, state = { cwd: new Map(), repositories: new Map() });
  const reserve = (map: Map<string, FetchEntry>, key: string) => {
    const existing = map.get(key);
    if (existing?.pending || (existing && existing.next > Date.now())) return;
    // Preserve consecutive failure history across cooldown expiry. Evict only
    // when full, and never evict active requests or unexpired cooldowns.
    if (!existing && map.size >= MAX_CACHE_ENTRIES) {
      const candidate = [...map].find(([, entry]) => !entry.pending && entry.next <= Date.now());
      if (!candidate) return;
      map.delete(candidate[0]);
    }
    const entry = existing ?? { next: 0, failures: 0 };
    map.set(key, entry);
    return entry;
  };
  // At most two discovery/fetch jobs process-wide; skip rather than queue work
  // from inactive sessions. A later ordinary refresh will retry admission.
  if ((state.active ?? 0) >= 2) return;
  const entry = reserve(state.cwd, `${cwd}\0${branch}\0${upstream}`);
  if (!entry) return;
  const repositories = state.repositories;
  state.active = (state.active ?? 0) + 1;
  const fetchState = state;
  entry.next = Date.now() + FETCH_INTERVAL_MS;
  entry.pending = (async () => {
    const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
    const remote = await git(["for-each-ref", "--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)", `refs/heads/${branch}`], cwd);
    const [name, source, destination] = remote.output.trim().split("\0");
    if (!common.ok || !common.output.trim() || !remote.ok || !name || name === "." || /[\s\0]/.test(name)
      || !source?.startsWith("refs/heads/") || !destination?.startsWith("refs/remotes/")
      || /[\s:*?\[\\]/.test(source + destination)) return;
    const repositoryKey = `${common.output.trim()}\0${name}\0${source}\0${destination}`;
    const repository = reserve(repositories, repositoryKey);
    if (!repository) {
      // A sibling cwd may arrive just before fetch-completion's cooldown ends.
      // Recheck when it expires rather than imposing another full minute.
      entry.next = Math.max(Date.now() + REFRESH_MS, repositories.get(repositoryKey)?.next ?? 0);
      return;
    }
    repository.pending = (async () => {
      let success = false;
      try {
        // No pull, tags, submodules, pruning, maintenance, or configured refspecs
        // targeting local branches. Only remote-tracking refs may be updated.
        const result = await git(["-c", "credential.interactive=false", "-c", "core.askPass=",
          "fetch", "--refmap=", "--no-tags", "--no-recurse-submodules", "--no-auto-maintenance", "--no-write-fetch-head",
          "--", name, `+${source}:${destination}`], cwd);
        success = result.ok;
        if (success) cacheFor(statusGit).clear(); // Includes sibling cwd/worktree caches.
      } finally {
        repository.failures = success ? 0 : Math.min(repository.failures + 1, 4);
        repository.next = Date.now() + FETCH_INTERVAL_MS * 2 ** repository.failures;
      }
    })().catch(() => undefined).finally(() => { repository.pending = undefined; });
    await repository.pending;
    // Align discovery admission with completion-based success/failure cooldown.
    entry.next = repository.next;
  })().catch(() => undefined).finally(() => {
    entry.pending = undefined;
    fetchState.active = Math.max(0, (fetchState.active ?? 1) - 1);
  });
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
  const result = await git(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"], cwd);
  if (!result.ok) return result.notRepo ? null : undefined;
  let branch = "";
  let oid = "";
  let upstream: string | undefined;
  let ahead: number | undefined;
  let behind: number | undefined;
  let dirty = false;
  const counts = { added: 0, modified: 0, deleted: 0, untracked: 0 };
  const records = result.output.split("\0");
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record.startsWith("# branch.head ")) branch = record.slice(14);
    else if (record.startsWith("# branch.oid ")) oid = record.slice(13);
    else if (record.startsWith("# branch.upstream ")) upstream = record.slice(18);
    else if (record.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
      if (match) { ahead = Number(match[1]); behind = Number(match[2]); }
    } else if (record.startsWith("? ")) {
      dirty = true;
      counts.untracked += 1;
    } else if (/^[12u] /.test(record)) {
      dirty = true;
      const code = record.slice(2, 4);
      if (code.includes("A")) counts.added += 1;
      if (code.includes("M") || code.includes("R") || code.includes("C")) counts.modified += 1;
      if (code.includes("D")) counts.deleted += 1;
      // Renames/copies have a second NUL-delimited pathname, not another record.
      if (record[0] === "2") i += 1;
    }
  }
  if (!branch) return undefined; // Incomplete/unexpected output must not replace a good footer.
  if (branch === "(detached)") branch = oid && oid !== "(initial)" ? oid.slice(0, 7) : "detached";
  return { branch, upstream, ahead, behind, dirty, ...counts };
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

async function renderFooter(cwd: string, git: GitRunner, fetchGit?: GitRunner) {
  const snapshot = await readSnapshot(cwd, git);
  if (snapshot === undefined) return undefined;
  if (snapshot === null) {
    return `<div style="display:flex;justify-content:space-between;gap:16px;align-items:center;font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;color:#93a4b8">
      <span>🌿 <strong style="color:#e7edf5">no git repo</strong></span>
    </div>`;
  }

  if (snapshot.upstream && fetchGit) scheduleFetch(cwd, snapshot.branch, snapshot.upstream, fetchGit, git);

  const status = snapshot.dirty ? `dirty${formatDetails(snapshot)}` : "clean";
  const dirtyColor = snapshot.dirty ? "#facc15" : "#86efac";
  const comparisonKnown = snapshot.ahead !== undefined && snapshot.behind !== undefined;
  const divergence = !comparisonKnown
    ? "⇅?"
    : snapshot.ahead === 0 && snapshot.behind === 0
      ? "✓"
      : [snapshot.ahead ? `↑${snapshot.ahead}` : "", snapshot.behind ? `↓${snapshot.behind}` : ""].filter(Boolean).join(" ");
  const upstreamDetails = escapeHtml(`${snapshot.upstream}: ${comparisonKnown
    ? `${snapshot.ahead} ahead, ${snapshot.behind} behind`
    : "comparison unavailable"}. Last fetched local ref; upstream remote checked automatically about every 60 seconds (failures back off). Never pulls or changes working files.`);
  const upstream = snapshot.upstream
    ? ` <span title="${upstreamDetails}" aria-label="${upstreamDetails}">${divergence}</span>`
    : "";

  return `<div style="display:flex;justify-content:space-between;gap:16px;align-items:center;font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;color:#93a4b8">
    <span>🌿 <strong style="color:#e7edf5">${escapeHtml(snapshot.branch)}</strong>${upstream}</span>
    <span title="${escapeHtml(status)}" aria-label="${escapeHtml(status)}" style="color:${dirtyColor}">●${escapeHtml(formatDetails(snapshot))}</span>
  </div>`;
}

function cachedFooter(cwd: string, git: GitRunner, fetchGit?: GitRunner) {
  const cache = cacheFor(git);
  const now = Date.now();
  const existing = cache.get(cwd);
  if (existing?.pending) return existing.pending;
  if (existing && existing.expires > now) return Promise.resolve(existing.html);
  // Bound retained cwd entries without evicting work still in flight.
  for (const [key, entry] of cache) {
    if (!entry.pending && (entry.expires <= now || cache.size >= MAX_CACHE_ENTRIES)) cache.delete(key);
  }
  const entry: CacheEntry = { expires: 0 };
  cache.set(cwd, entry);
  entry.pending = renderFooter(cwd, git, fetchGit).catch(() => undefined).then((html) => {
    entry.pending = undefined;
    if (html === undefined) cache.delete(cwd); // Failures retry on the next refresh.
    else { entry.html = html; entry.expires = Date.now() + CACHE_TTL_MS; }
    return html;
  });
  return entry.pending;
}

export function createGitFooterExtension(options: {
  git?: GitRunner;
  refreshMs?: number;
  fetchGit?: GitRunner;
} = {}) {
  const git = options.git || runGit;
  const fetchGit = options.fetchGit ?? (options.git ? undefined : runFetchGit);
  const refreshMs = options.refreshMs ?? REFRESH_MS;

  function refresh(state: SessionState) {
    if (state.stopped || state.refreshing) return;
    const revision = state.revision;
    const ctx = state.ctx;
    const key = sessionKey(ctx);
    state.refreshing = cachedFooter(sessionCwd(ctx), git, fetchGit)
      .catch(() => undefined)
      .then((html) => {
        if (html === undefined
          || state.stopped
          || state.revision !== revision
          || sessions.get(key) !== state
          || state.lastHtml === html) return;
        state.lastHtml = html;
        ctx.ui.web.contribute(FOOTER_KEY, {
          slot: "footer",
          kind: "static",
          view: { kind: "html", html },
        });
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
    ctx.ui.web.contribute(FOOTER_KEY, undefined);
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
