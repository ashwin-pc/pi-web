import { createElement, GitPullRequestArrow } from "lucide";
import type { GitFileStatus, GitRepo, GitStatusResponse } from "./types.js";

function statusCode(file: GitFileStatus) {
  if (file.label === "untracked") return "U";
  if (file.label === "modified") return "M";
  if (file.label === "added") return "A";
  if (file.label === "deleted") return "D";
  if (file.label === "renamed") return "R";
  if (file.label === "conflicted") return "!";
  return `${file.indexStatus || " "}${file.worktreeStatus || " "}`.trim() || file.label[0].toUpperCase();
}

type TreeNode = {
  name: string;
  children: Map<string, TreeNode>;
  file?: GitFileStatus;
};

function buildTree(files: GitFileStatus[]) {
  const root: TreeNode = { name: "", children: new Map() };
  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let node = root;
    for (const part of parts) {
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    }
    node.file = file;
  }
  return root;
}

function sortedChildren(node: TreeNode) {
  return [...node.children.values()].sort((a, b) => {
    const aDir = a.children.size > 0 && !a.file;
    const bDir = b.children.size > 0 && !b.file;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function baseName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

function repoDisplayName(repo: GitRepo) {
  return baseName(repo.root || repo.path) || "Repository";
}

function repoCounts(repo: GitRepo, status?: GitStatusResponse) {
  return {
    branch: status?.branch || repo.branch || "detached",
    upstream: status?.upstream || repo.upstream,
    ahead: status?.ahead ?? repo.ahead,
    behind: status?.behind ?? repo.behind,
    dirtyCount: status?.files.length ?? repo.dirtyCount,
  };
}

function appendMetaItem(container: HTMLElement, text: string) {
  const item = document.createElement("span");
  item.className = "gitRepoMetaItem";
  item.textContent = text;
  container.append(item);
}

function appendRepoMeta(container: HTMLElement, repo: GitRepo, status?: GitStatusResponse) {
  const counts = repoCounts(repo, status);
  appendMetaItem(container, counts.branch);
  if (counts.upstream) appendMetaItem(container, `⇄ ${counts.upstream}`);
  if (counts.ahead > 0) appendMetaItem(container, `↑${counts.ahead}`);
  if (counts.behind > 0) appendMetaItem(container, `↓${counts.behind}`);
  appendMetaItem(container, counts.dirtyCount ? `${counts.dirtyCount} changed` : "clean");
}

function shouldShowRebase(repo: GitRepo, status?: GitStatusResponse) {
  const counts = repoCounts(repo, status);
  return Boolean(counts.upstream && counts.behind > 0);
}

function createRebaseButton(repo: GitRepo, status: GitStatusResponse | undefined, syncingRepo: string | undefined, gitSyncSupported: boolean, onRebase: (repo: GitRepo) => void) {
  if (!shouldShowRebase(repo, status)) return undefined;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "gitRebaseButton";
  button.title = gitSyncSupported ? "Fetch and rebase onto upstream" : "Git sync is not supported by this runtime";
  button.setAttribute("aria-label", `Fetch and rebase ${repoDisplayName(repo)} onto upstream`);
  button.disabled = !gitSyncSupported || syncingRepo === repo.path;
  button.append(createElement(GitPullRequestArrow, { "aria-hidden": "true" }));
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onRebase(repo);
  });
  return button;
}

function createFileRow(file: GitFileStatus, repo: GitRepo, selectedPath: string | undefined, selectedRepoPath: string | undefined, onSelectFile: (file: GitFileStatus, repo: GitRepo) => void) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `gitFileItem gitTreeFile${file.path === selectedPath && repo.path === selectedRepoPath ? " selected" : ""}`;
  const badge = document.createElement("span");
  badge.className = `gitStatusBadge ${file.label}`;
  badge.textContent = statusCode(file);
  const name = document.createElement("span");
  name.className = "gitFilePath";
  name.textContent = file.oldPath ? `${file.oldPath} → ${file.path}` : baseName(file.path);
  button.append(badge, name);
  button.addEventListener("click", () => onSelectFile(file, repo));
  return button;
}

function renderTreeNode(options: {
  container: HTMLElement;
  node: TreeNode;
  repo: GitRepo;
  selectedPath?: string;
  selectedRepoPath?: string;
  onSelectFile: (file: GitFileStatus, repo: GitRepo) => void;
}) {
  const { container, node, repo, selectedPath, selectedRepoPath, onSelectFile } = options;
  for (const child of sortedChildren(node)) {
    if (child.file && child.children.size === 0) {
      container.append(createFileRow(child.file, repo, selectedPath, selectedRepoPath, onSelectFile));
      continue;
    }

    const details = document.createElement("details");
    details.className = "gitTreeDir";
    details.open = true;
    const summary = document.createElement("summary");
    const label = document.createElement("span");
    label.className = "gitTreeDirName";
    label.textContent = child.name;
    summary.append(label);
    details.append(summary);
    const children = document.createElement("div");
    children.className = "gitTreeChildren";
    renderTreeNode({ container: children, node: child, repo, selectedPath, selectedRepoPath, onSelectFile });
    details.append(children);
    container.append(details);
  }
}

function createRepoAccordion(options: {
  repo: GitRepo;
  status?: GitStatusResponse;
  selectedPath?: string;
  selectedRepoPath?: string;
  syncingRepo?: string;
  gitSyncSupported: boolean;
  onSelectFile: (file: GitFileStatus, repo: GitRepo) => void;
  onRebase: (repo: GitRepo) => void;
}) {
  const { repo, status, selectedPath, selectedRepoPath, syncingRepo, gitSyncSupported, onSelectFile, onRebase } = options;
  const files = status?.files || [];
  const details = document.createElement("details");
  details.className = "gitRepoChangesAccordion";
  details.open = files.length > 0 || repo.path === selectedRepoPath;

  const summary = document.createElement("summary");
  const disclosure = document.createElement("span");
  disclosure.className = "gitRepoDisclosure";
  disclosure.textContent = "›";

  const label = document.createElement("span");
  label.className = "gitRepoHeaderText";
  const name = document.createElement("span");
  name.className = "gitRepoName";
  name.textContent = repoDisplayName(repo);
  name.title = repo.path === "." ? repo.root : repo.path;
  const meta = document.createElement("span");
  meta.className = "gitRepoMeta";
  appendRepoMeta(meta, repo, status);
  label.append(name, meta);

  summary.append(disclosure, label);
  const rebase = createRebaseButton(repo, status, syncingRepo, gitSyncSupported, onRebase);
  if (rebase) summary.append(rebase);
  details.append(summary);

  const body = document.createElement("div");
  body.className = "gitRepoChangesBody";
  if (!status) {
    const empty = document.createElement("div");
    empty.className = "gitEmpty";
    empty.textContent = "Loading status…";
    body.append(empty);
  } else if (!files.length) {
    const empty = document.createElement("div");
    empty.className = "gitEmpty";
    empty.textContent = "Working tree clean.";
    body.append(empty);
  } else {
    renderTreeNode({ container: body, node: buildTree(files), repo, selectedPath, selectedRepoPath, onSelectFile });
  }
  details.append(body);
  return details;
}

export function renderStatusView(options: {
  container: HTMLElement;
  repos: GitRepo[];
  statusesByRepo: Record<string, GitStatusResponse | undefined>;
  selectedPath?: string;
  selectedRepoPath?: string;
  syncingRepo?: string;
  gitSyncSupported: boolean;
  onSelectFile: (file: GitFileStatus, repo: GitRepo) => void;
  onRebase: (repo: GitRepo) => void;
}) {
  const { container, repos, statusesByRepo, selectedPath, selectedRepoPath, syncingRepo, gitSyncSupported, onSelectFile, onRebase } = options;
  container.textContent = "";

  const section = document.createElement("section");
  section.className = "gitChangesOverview";
  const heading = document.createElement("h3");
  heading.textContent = "Repositories";
  section.append(heading);

  const list = document.createElement("div");
  list.className = "gitRepoChangesList";
  for (const repo of repos) {
    list.append(createRepoAccordion({ repo, status: statusesByRepo[repo.path], selectedPath, selectedRepoPath, syncingRepo, gitSyncSupported, onSelectFile, onRebase }));
  }
  section.append(list);
  container.append(section);
}
