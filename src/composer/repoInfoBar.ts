import type { ApiClient } from "../app/api.js";
import type { AppElements } from "../app/elements.js";
import type { AppState } from "../app/types.js";

type RepoPrInfo = { number: number; url: string; title?: string };

type RepoInfo = {
  ok?: boolean;
  isRepo?: boolean;
  cwd?: string;
  root?: string;
  rootName?: string;
  cwdRel?: string;
  branch?: string;
  upstream?: string;
  hash?: string;
  shortHash?: string;
  pr?: RepoPrInfo | null;
};

export type RepoInfoBarController = {
  init: () => void;
  refresh: () => Promise<void>;
  scheduleRefresh: () => void;
};

export function createRepoInfoBar(options: {
  state: AppState;
  elements: AppElements;
  api: ApiClient;
}): RepoInfoBarController {
  const { state, elements, api } = options;
  const bar = elements.repoInfoBarEl;

  let lastCwd: string | undefined;
  let inFlight: Promise<void> | undefined;
  let pendingTimer: number | undefined;

  function setHidden(hidden: boolean) {
    bar.hidden = hidden;
    if (hidden) bar.replaceChildren();
  }

  function appendSeparator() {
    const sep = document.createElement("span");
    sep.className = "repoInfoSep";
    sep.textContent = "·";
    bar.append(sep);
  }

  function render(info: RepoInfo) {
    bar.replaceChildren();
    bar.classList.remove("notRepo");

    if (!info.isRepo) {
      // No git repo — show the cwd path so users still see where pi is rooted.
      if (!info.cwd) { setHidden(true); return; }
      bar.classList.add("notRepo");
      const path = document.createElement("span");
      path.className = "repoInfoPath";
      path.textContent = info.cwd;
      path.title = info.cwd;
      bar.append(path);
      setHidden(false);
      return;
    }

    const pathEl = document.createElement("span");
    pathEl.className = "repoInfoPath";
    const pieces: string[] = [];
    if (info.rootName) pieces.push(info.rootName);
    if (info.cwdRel) pieces.push(info.cwdRel);
    pathEl.textContent = pieces.join("/") || info.root || info.cwd || "";
    pathEl.title = info.root && info.cwdRel ? `${info.root}/${info.cwdRel}` : info.root || info.cwd || "";
    bar.append(pathEl);

    if (info.branch) {
      const branchEl = document.createElement("span");
      branchEl.className = "repoInfoBranch";
      branchEl.textContent = `(${info.branch})`;
      if (info.upstream) branchEl.title = `tracking ${info.upstream}`;
      bar.append(branchEl);
    }

    if (info.shortHash) {
      const hashEl = document.createElement("span");
      hashEl.className = "repoInfoHash";
      hashEl.textContent = info.shortHash;
      if (info.hash) hashEl.title = info.hash;
      bar.append(hashEl);
    }

    if (info.pr && info.pr.url) {
      appendSeparator();
      const prEl = document.createElement("a");
      prEl.className = "repoInfoPr";
      prEl.href = info.pr.url;
      prEl.target = "_blank";
      prEl.rel = "noopener noreferrer";
      prEl.textContent = `PR #${info.pr.number}`;
      prEl.title = info.pr.title ? `${info.pr.title} — ${info.pr.url}` : info.pr.url;
      bar.append(prEl);
    }

    setHidden(false);
  }

  async function fetchInfo(): Promise<RepoInfo | undefined> {
    try {
      const res = await fetch("/api/repo-info", { headers: api.headers() });
      if (!res.ok) return undefined;
      const data = (await res.json()) as RepoInfo;
      return data;
    } catch {
      return undefined;
    }
  }

  async function refresh() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const info = await fetchInfo();
      if (info) render(info);
      else setHidden(true);
    })();
    try {
      await inFlight;
    } finally {
      inFlight = undefined;
    }
  }

  function scheduleRefresh() {
    // Coalesce bursts of state_changed events into a single fetch.
    if (pendingTimer !== undefined) return;
    pendingTimer = window.setTimeout(() => {
      pendingTimer = undefined;
      const cwd = state.currentCwd || "";
      // Always refresh — branch/PR/hash may have changed even if cwd didn't.
      lastCwd = cwd;
      void refresh();
    }, 200);
  }

  function init() {
    lastCwd = state.currentCwd || "";
    void refresh();
  }

  return { init, refresh, scheduleRefresh };
}
