import { blurActiveEditableOnMobile } from "../app/focus.js";
import { fetchGitCommit, fetchGitDiff, fetchGitLog, fetchGitRepos, fetchGitStatus, syncGit } from "./api.js";
import { renderCommitView } from "./commitView.js";
import { renderDiffView } from "./diffView.js";
import { renderGraphView } from "./graphView.js";
import { renderStatusView } from "./statusView.js";
import type { GitCommit, GitFileStatus, GitPrimaryView, GitRepo, GitState, GitStatusResponse } from "./types.js";
import type { RightPanelManager } from "../layout/rightPanel.js";

export function initGitPanel(options: { button: HTMLButtonElement; panel: HTMLElement; rightPanels?: RightPanelManager; apiHeaders: () => HeadersInit; getSessionId?: () => string }) {
  const { button, panel, apiHeaders, getSessionId } = options;
  const primary = panel.querySelector<HTMLElement>("#gitPrimaryPane")!;
  const detail = panel.querySelector<HTMLElement>("#gitDetailPane")!;
  const statusTab = panel.querySelector<HTMLButtonElement>("#gitStatusTab")!;
  const graphTab = panel.querySelector<HTMLButtonElement>("#gitGraphTab")!;
  const close = panel.querySelector<HTMLButtonElement>("#gitCloseButton")!;

  const state: GitState = {
    isOpen: false,
    loading: false,
    syncing: false,
    statusesByRepo: {},
    commits: [],
    repos: [],
    repoPickerOpen: false,
    primaryView: "status",
    mobileView: "status",
    diffLoading: false,
    commitLoading: false,
  };

  function repoStorageKey(cwd = state.repoCwd) {
    return cwd ? `pi-web.git.selectedRepo:${cwd}` : "pi-web.git.selectedRepo";
  }

  function storedRepo(cwd: string) {
    try { return localStorage.getItem(repoStorageKey(cwd)); } catch { return undefined; }
  }

  function storeRepo(repo: GitRepo) {
    try { localStorage.setItem(repoStorageKey(), repo.path); } catch { /* ignore */ }
  }

  function selectedRepoPath() {
    return state.selectedRepo?.path;
  }

  function setOpen(open: boolean) {
    if (open) blurActiveEditableOnMobile();
    state.isOpen = open;
    panel.hidden = !open;
    button.classList.toggle("active", open);
    if (open) void refresh();
  }

  function chooseRepo(repos: GitRepo[], cwd: string) {
    const previous = state.selectedRepo?.path || storedRepo(cwd);
    return repos.find((repo) => repo.path === previous) || repos.find((repo) => repo.isCurrent) || repos[0];
  }

  async function loadStatuses(repos: GitRepo[]) {
    const entries = await Promise.all(repos.map(async (repo) => [repo.path, await fetchGitStatus(apiHeaders(), repo.path, true, getSessionId?.())] as const));
    return Object.fromEntries(entries) as Record<string, GitStatusResponse>;
  }

  function firstChangedFile(statuses = state.statusesByRepo) {
    const selected = state.selectedRepo ? statuses[state.selectedRepo.path]?.files[0] : undefined;
    if (selected && state.selectedRepo) return { repo: state.selectedRepo, file: selected };
    for (const repo of state.repos) {
      const file = statuses[repo.path]?.files[0];
      if (file) return { repo, file };
    }
    return undefined;
  }

  async function loadSelectedRepoData() {
    if (!state.selectedRepo) {
      state.status = { ok: true, isRepo: false, ahead: 0, behind: 0, files: [] };
      state.statusesByRepo = {};
      state.commits = [];
      state.selectedFile = undefined;
      state.selectedFileRepo = undefined;
      state.selectedCommit = undefined;
      state.diff = undefined;
      state.commitDiff = undefined;
      return;
    }

    const repo = selectedRepoPath();
    const [statuses, log] = await Promise.all([loadStatuses(state.repos), fetchGitLog(apiHeaders(), repo, getSessionId?.())]);
    state.statusesByRepo = statuses;
    state.status = repo ? statuses[repo] : undefined;
    state.commits = log.commits || [];
    state.selectedCommit = state.commits[0];
    state.diff = undefined;
    state.commitDiff = undefined;
    state.commitFiles = undefined;

    const preservedRepo = state.selectedFileRepo ? state.repos.find((item) => item.path === state.selectedFileRepo) : undefined;
    const preservedFile = preservedRepo && state.selectedFile ? statuses[preservedRepo.path]?.files.find((file) => file.path === state.selectedFile?.path) : undefined;
    const initial = preservedRepo && preservedFile ? { repo: preservedRepo, file: preservedFile } : firstChangedFile(statuses);
    if (initial) await selectFile(initial.file, initial.repo, false);
    else {
      state.selectedFile = undefined;
      state.selectedFileRepo = undefined;
      state.diff = undefined;
    }
  }

  async function refresh() {
    state.loading = true; state.error = undefined; render();
    try {
      const repoList = await fetchGitRepos(apiHeaders(), getSessionId?.());
      state.repos = repoList.repos;
      state.repoCwd = repoList.cwd;
      state.selectedRepo = chooseRepo(repoList.repos, repoList.cwd);
      await loadSelectedRepoData();
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.loading = false; render();
    }
  }

  async function selectRepo(repo: GitRepo) {
    state.selectedRepo = repo;
    state.repoPickerOpen = false;
    state.loading = true;
    state.error = undefined;
    state.selectedFile = undefined;
    state.selectedFileRepo = undefined;
    state.selectedCommit = undefined;
    state.diff = undefined;
    state.commitDiff = undefined;
    storeRepo(repo);
    render();
    try {
      const [status, log] = await Promise.all([
        state.statusesByRepo[repo.path] ? Promise.resolve(state.statusesByRepo[repo.path]!) : fetchGitStatus(apiHeaders(), repo.path, true, getSessionId?.()),
        fetchGitLog(apiHeaders(), repo.path, getSessionId?.()),
      ]);
      state.statusesByRepo = { ...state.statusesByRepo, [repo.path]: status };
      state.status = status;
      state.commits = log.commits || [];
      state.selectedCommit = state.commits[0];
      if (status.files[0]) await selectFile(status.files[0], repo, false);
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.loading = false;
      render();
    }
  }

  async function selectFile(file: GitFileStatus, repo: GitRepo, navigate = true) {
    state.selectedRepo = repo;
    state.status = state.statusesByRepo[repo.path];
    state.selectedFile = file;
    state.selectedFileRepo = repo.path;
    state.diffLoading = true;
    state.diff = undefined;
    if (navigate) state.mobileView = "diff";
    render();
    try {
      const diff = await fetchGitDiff(apiHeaders(), file.path, file.staged && file.worktreeStatus === " ", repo.path, getSessionId?.());
      state.diff = diff.diff;
    } catch (error) {
      state.diff = error instanceof Error ? error.message : String(error);
    } finally {
      state.diffLoading = false; render();
    }
  }

  async function selectCommit(commit: GitCommit, navigate = true) {
    state.selectedCommit = commit;
    state.commitLoading = true;
    state.commitFiles = undefined;
    state.commitDiff = undefined;
    if (navigate) state.mobileView = "commit";
    render();
    try {
      const details = await fetchGitCommit(apiHeaders(), commit.hash, selectedRepoPath(), getSessionId?.());
      state.commitFiles = details.files;
      state.commitDiff = details.diff;
    } catch (error) {
      state.commitDiff = error instanceof Error ? error.message : String(error);
    } finally {
      state.commitLoading = false;
      render();
    }
  }

  function setPrimary(view: GitPrimaryView) {
    state.primaryView = view;
    state.mobileView = view;
    render();
  }

  async function runRebase(repo: GitRepo) {
    state.syncing = true;
    state.syncingRepo = repo.path;
    state.error = undefined;
    render();
    try {
      await syncGit(apiHeaders(), repo.path, getSessionId?.());
      const repoList = await fetchGitRepos(apiHeaders(), getSessionId?.());
      state.repos = repoList.repos;
      state.repoCwd = repoList.cwd;
      state.selectedRepo = state.repos.find((item) => item.path === state.selectedRepo?.path) || state.repos.find((item) => item.path === repo.path) || chooseRepo(state.repos, repoList.cwd);
      await loadSelectedRepoData();
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.syncing = false;
      state.syncingRepo = undefined;
      render();
    }
  }

  function repoDisplayPath(repo: GitRepo) {
    return repo.path === "." ? "." : repo.path;
  }

  function renderRepoPicker(container: HTMLElement) {
    if (state.repos.length <= 1) return;
    const details = document.createElement("details");
    details.className = "gitRepoAccordion";
    details.open = state.repoPickerOpen || (!state.selectedRepo && state.repos.length > 0);
    details.addEventListener("toggle", () => { state.repoPickerOpen = details.open; });

    const summary = document.createElement("summary");
    summary.textContent = state.selectedRepo ? `Repository: ${repoDisplayPath(state.selectedRepo)}` : "Repository: none found";
    details.append(summary);

    const list = document.createElement("div");
    list.className = "gitRepoList";
    if (!state.repos.length) {
      const empty = document.createElement("div");
      empty.className = "gitRepoEmpty";
      empty.textContent = "No repos at the current folder or one level down.";
      list.append(empty);
    } else {
      for (const repo of state.repos) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = `gitRepoItem${repo.path === state.selectedRepo?.path ? " selected" : ""}`;
        item.disabled = state.loading || state.syncing;
        item.addEventListener("click", () => void selectRepo(repo));

        const name = document.createElement("span");
        name.className = "gitRepoName";
        name.textContent = repoDisplayPath(repo);
        item.append(name);

        const meta = document.createElement("span");
        meta.className = "gitRepoMeta";
        const dirty = repo.dirtyCount ? `${repo.dirtyCount} changed` : "clean";
        const upstream = repo.upstream ? ` ⇄ ${repo.upstream}` : "";
        meta.textContent = `${repo.branch || "detached"}${upstream} · ↑${repo.ahead} ↓${repo.behind} · ${dirty}`;
        item.append(meta);

        list.append(item);
      }
    }
    details.append(list);
    container.append(details);
  }

  function render() {
    panel.dataset.view = state.mobileView;
    panel.dataset.primaryView = state.primaryView;
    statusTab.classList.toggle("active", state.primaryView === "status");
    graphTab.classList.toggle("active", state.primaryView === "graph");
    primary.textContent = "";
    if (state.primaryView === "graph") renderRepoPicker(primary);
    const primaryContent = document.createElement("div");
    primaryContent.className = "gitPrimaryContent";
    primary.append(primaryContent);

    if (state.loading) {
      primaryContent.textContent = "Loading Git data…";
    } else if (state.error) {
      primaryContent.textContent = state.error;
    } else if (!state.repos.length) {
      primaryContent.textContent = "No Git repositories found in the current folder or one level down.";
    } else if (state.primaryView === "status") {
      renderStatusView({
        container: primaryContent,
        repos: state.repos,
        statusesByRepo: state.statusesByRepo,
        selectedPath: state.selectedFile?.path,
        selectedRepoPath: state.selectedFileRepo || state.selectedRepo?.path,
        syncingRepo: state.syncingRepo,
        onSelectFile: (file, repo) => void selectFile(file, repo),
        onRebase: (repo) => void runRebase(repo),
      });
    } else if (!state.status?.isRepo) {
      primaryContent.textContent = "Selected folder is not a Git repository.";
    } else {
      renderGraphView({ container: primaryContent, commits: state.commits, selectedHash: state.selectedCommit?.hash, onSelectCommit: (commit) => void selectCommit(commit) });
    }

    if (state.mobileView === "commit") renderCommitView({ container: detail, commit: state.selectedCommit, files: state.commitFiles, diff: state.commitDiff, loading: state.commitLoading, onBack: () => setPrimary("graph") });
    else renderDiffView({ container: detail, file: state.selectedFile, repo: state.selectedFileRepo, diff: state.diff, loading: state.diffLoading, apiHeaders, sessionId: getSessionId?.(), onBack: () => setPrimary("status") });
  }

  button.addEventListener("click", () => setOpen(!state.isOpen));
  close.addEventListener("click", () => setOpen(false));
  statusTab.addEventListener("click", () => setPrimary("status"));
  graphTab.addEventListener("click", () => setPrimary("graph"));
  render();
}
